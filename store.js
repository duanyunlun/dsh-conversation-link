/**
 * Durable binding and guard state for `dsh-conversation-link`.
 *
 * Bindings and guards are host-side facts about who may talk to whom and what a
 * supervisor has forbidden, so they live outside any one conversation's log:
 * one JSON file under the Harness home, rewritten atomically. A conversation
 * that is closed, resumed, or renamed keeps its place in the graph.
 *
 * @module dsh-conversation-link/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** On-disk state version; a mismatch on a newer file is refused rather than guessed. */
const STATE_VERSION = 1

/** First halves of a conversation handle. */
const HANDLE_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'daring', 'deft', 'eager', 'exact',
  'fair', 'fleet', 'gentle', 'glad', 'honest', 'humble', 'ivory', 'jolly',
  'keen', 'kind', 'lively', 'lucid', 'mellow', 'merry', 'noble', 'open',
  'plain', 'quick', 'ready', 'solid', 'tidy', 'vivid', 'warm', 'witty',
]

/** Second halves of a conversation handle. */
const HANDLE_NOUNS = [
  'anchor', 'badger', 'beacon', 'cedar', 'comet', 'delta', 'ember', 'falcon',
  'forge', 'garnet', 'harbor', 'heron', 'island', 'juniper', 'kestrel', 'lantern',
  'lumen', 'maple', 'meadow', 'nimbus', 'orchid', 'otter', 'pebble', 'quartz',
  'raven', 'summit', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
]

/**
 * Mint one unused handle.
 * @param taken - handles already assigned.
 * @returns a handle no live registry entry uses.
 */
function mintHandle(taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const adjective = HANDLE_ADJECTIVES[Math.floor(Math.random() * HANDLE_ADJECTIVES.length)]
    const noun = HANDLE_NOUNS[Math.floor(Math.random() * HANDLE_NOUNS.length)]
    const candidate = `${adjective}-${noun}`
    if (!taken.has(candidate)) return candidate
  }
  // A registry large enough to exhaust the word list still gets a stable,
  // unique handle rather than a duplicate.
  let suffix = 2
  while (taken.has(`peer-${suffix}`)) suffix += 1
  return `peer-${suffix}`
}

/** Normalize one persisted record, or return undefined when it is unusable. */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Read a non-empty string field. */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Stages a supervising conversation can intervene at, and the Harness event each one hooks. */
export const RULE_STAGES = Object.freeze({
  /** Refuse a pending tool call. */
  before: 'tools/pre-execute',
  /** Turn a completed tool result into corrective feedback. */
  after: 'tools/post-execute',
  /** Assert a standing constraint on the messages entering a step. */
  input: 'agent/pre-step',
})

const STAGES = new Set(Object.keys(RULE_STAGES))

/**
 * Normalize one persisted rule, defaulting fields added after the first release.
 * @param value - raw persisted record.
 * @returns the rule, or undefined when the record is unusable.
 */
function normalizeRule(value) {
  const record = asRecord(value)
  if (record === undefined) return undefined
  return {
    ...record,
    stage: STAGES.has(record.stage) ? record.stage : 'before',
    tool: text(record.tool) ?? '*',
    match: text(record.match) ?? '',
    matchResult: text(record.matchResult) ?? '',
    text: text(record.text) ?? '',
    once: record.once === 'session' ? 'session' : 'turn',
    reason: text(record.reason) ?? '',
  }
}

/**
 * Bindings and guards shared by every conversation in this process.
 */
export class BindingStore {
  #file
  #logger
  #state
  #loaded = false

  /**
   * @param options - store location and diagnostic sink.
   * @param options.file - absolute path of the JSON state file.
   * @param options.logger - host logger used for recoverable load failures.
   */
  constructor({ file, logger }) {
    this.#file = file
    this.#logger = logger
  }

  /** Absolute path of the backing JSON file; reported by `conversation_list`. */
  get file() {
    return this.#file
  }

  /** Load once, tolerating a missing or unreadable file as empty state. */
  #read() {
    if (this.#loaded) return this.#state
    this.#loaded = true
    this.#state = { version: STATE_VERSION, bindings: [], guards: [], handles: {} }
    let raw
    try {
      raw = readFileSync(this.#file, 'utf8')
    } catch {
      // A first run has no state file; an unreadable one is reported by the
      // write path if it persists, so a read failure alone stays non-fatal.
      return this.#state
    }
    let parsed
    try {
      parsed = asRecord(JSON.parse(raw))
    } catch (error) {
      this.#logger?.warn?.(`conversation-link: ignoring unreadable state file ${this.#file}: ${String(error)}`)
      return this.#state
    }
    if (parsed === undefined || parsed.version !== STATE_VERSION) {
      this.#logger?.warn?.(`conversation-link: ignoring state file ${this.#file} with an unsupported version`)
      return this.#state
    }
    const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : []
    const guards = Array.isArray(parsed.guards) ? parsed.guards : []
    const handles = asRecord(parsed.handles) ?? {}
    this.#state = {
      version: STATE_VERSION,
      bindings: bindings.filter(record => asRecord(record) !== undefined),
      guards: guards.map(normalizeRule).filter(record => record !== undefined),
      handles: Object.fromEntries(
        Object.entries(handles).filter(([, value]) => text(value) !== undefined),
      ),
    }
    return this.#state
  }

  /** Write the whole state atomically so a crash never exposes a partial file. */
  #write() {
    const state = this.#read()
    const temporary = `${this.#file}.tmp`
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.#file)
    } catch (error) {
      this.#logger?.warn?.(`conversation-link: cannot persist bindings to ${this.#file}: ${String(error)}`)
    }
  }

  /** Every binding in the graph. */
  bindings() {
    return [...this.#read().bindings]
  }

  /**
   * Stable short handle for one conversation, minted on first sight.
   *
   * The Harness's `SessionId` is already unique and durable; what it lacks is a
   * form a model or a human can say out loud. A handle is that alias. The
   * canonical identity stays the session id, so every core surface — the
   * conversation list, persistence, resume — keeps working unchanged.
   * @param sessionId - durable conversation identity.
   * @returns the conversation's handle, unchanged across restarts.
   */
  handleFor(sessionId) {
    const state = this.#read()
    const existing = text(state.handles[sessionId])
    if (existing !== undefined) return existing
    const taken = new Set(Object.values(state.handles))
    const handle = mintHandle(taken)
    state.handles[sessionId] = handle
    this.#write()
    return handle
  }

  /**
   * Resolve a handle back to its conversation.
   * @param handle - a value returned by {@link handleFor}.
   * @returns the session id, or undefined when no conversation holds that handle.
   */
  byHandle(handle) {
    for (const [sessionId, value] of Object.entries(this.#read().handles)) {
      if (value === handle) return sessionId
    }
    return undefined
  }

  /** Every assigned handle, keyed by session id. */
  handles() {
    return { ...this.#read().handles }
  }

  /** Bindings this conversation owns: conversations it supervises. */
  outbound(owner) {
    return this.#read().bindings.filter(binding => binding.owner === owner)
  }

  /** Bindings that name this conversation as their target: who supervises it. */
  inbound(target) {
    return this.#read().bindings.filter(binding => binding.target === target)
  }

  /** Every guard rule that applies to a call made by `target`. */
  guardsFor(target) {
    return this.#read().guards.filter(guard => guard.target === target)
  }

  /**
   * Rules one conversation owns that intervene at one pipeline stage.
   * @param target - the supervised conversation session id.
   * @param stage - `before`, `after`, or `input`.
   * @returns the matching rules, in creation order.
   */
  rulesFor(target, stage) {
    return this.#read().guards.filter(guard => guard.target === target && guard.stage === stage)
  }

  /** Every guard rule a conversation owns. */
  guardsOwnedBy(owner) {
    return this.#read().guards.filter(guard => guard.owner === owner)
  }

  /**
   * Resolve a conversation the owner already bound, by member name or by
   * session id.
   * @param owner - supervising conversation session id.
   * @param reference - member name or target session id.
   * @returns the binding, or undefined when the owner never bound that reference.
   */
  find(owner, reference) {
    return this.#read().bindings
      .find(binding => binding.owner === owner && (binding.name === reference || binding.target === reference))
  }

  /**
   * Bind or rebind one conversation under a member name unique to the owner.
   * @param owner - supervising conversation session id.
   * @param target - supervised conversation session id.
   * @param detail - member name, role, and optional note.
   * @returns the stored binding.
   * @throws when the name already belongs to a different conversation.
   */
  bind(owner, target, detail) {
    const state = this.#read()
    const clash = state.bindings.find(binding =>
      binding.owner === owner && binding.name === detail.name && binding.target !== target)
    if (clash !== undefined) {
      throw new Error(`member name "${detail.name}" already names conversation ${clash.target}`)
    }
    const existing = state.bindings.find(binding => binding.owner === owner && binding.target === target)
    if (existing !== undefined) {
      existing.name = detail.name
      existing.role = detail.role ?? existing.role
      existing.note = detail.note ?? existing.note
      this.#write()
      return { ...existing }
    }
    const binding = {
      owner,
      name: detail.name,
      target,
      role: detail.role ?? '',
      note: detail.note ?? '',
      createdAt: Date.now(),
    }
    state.bindings.push(binding)
    this.#write()
    return { ...binding }
  }

  /**
   * Remove one binding owned by `owner`.
   * @param owner - supervising conversation session id.
   * @param reference - member name or target session id.
   * @returns the removed binding, or undefined when nothing matched.
   */
  unbind(owner, reference) {
    const state = this.#read()
    const index = state.bindings
      .findIndex(binding => binding.owner === owner && (binding.name === reference || binding.target === reference))
    if (index < 0) return undefined
    const [removed] = state.bindings.splice(index, 1)
    state.guards = state.guards.filter(guard => !(guard.owner === owner && guard.target === removed.target))
    this.#write()
    return { ...removed }
  }

  /**
   * Add one policy rule and return its identity.
   *
   * A rule's `stage` picks where in the member's pipeline the supervising
   * conversation intervenes: `before` refuses a pending tool call, `after`
   * turns a completed result into corrective feedback, and `input` asserts a
   * standing constraint on the messages entering a step.
   * @param owner - supervising conversation session id.
   * @param rule - target conversation, selector, stage, and stage-specific payload.
   * @returns the stored rule.
   */
  addGuard(owner, rule) {
    const state = this.#read()
    const stored = {
      id: `rule-${Date.now().toString(36)}-${state.guards.length.toString(36)}`,
      owner,
      target: rule.target,
      stage: STAGES.has(rule.stage) ? rule.stage : 'before',
      tool: rule.tool ?? '*',
      match: rule.match ?? '',
      matchResult: rule.matchResult ?? '',
      text: rule.text ?? '',
      once: rule.once === 'session' ? 'session' : 'turn',
      reason: rule.reason ?? '',
      createdAt: Date.now(),
    }
    state.guards.push(stored)
    this.#write()
    return { ...stored }
  }

  /**
   * Remove one guard rule the owner owns.
   * @param owner - supervising conversation session id.
   * @param id - rule identity returned by {@link addGuard}, or `all` for every rule on that target.
   * @param target - optional target conversation when `id` is `all`.
   * @returns the removed rules.
   */
  removeGuard(owner, id, target) {
    const state = this.#read()
    const match = rule => rule.owner === owner
      && (id === 'all' ? rule.target === target : rule.id === id)
    const removed = state.guards.filter(match)
    state.guards = state.guards.filter(rule => !match(rule))
    if (removed.length > 0) this.#write()
    return removed.map(rule => ({ ...rule }))
  }
}
