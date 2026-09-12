/**
 * Durable link and rule state for `dsh-conversation-link`.
 *
 * A conversation has no role here. A link is a peer relationship: the
 * conversation that made it chose a nickname for the other side, and the other
 * side sees who named it. A rule is a standing constraint a conversation
 * declares for itself — nothing another conversation can impose.
 *
 * All three facts (handles, links, rules) are host-side, so they live outside
 * any one conversation's log: one JSON file under the Harness home, rewritten
 * atomically. A conversation that is closed, resumed, or renamed keeps its
 * place in the graph.
 *
 * @module dsh-conversation-link/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * On-disk state version.
 *
 * Version 1 stored directed `bindings` (owner → target) and `guards` owned by a
 * supervising conversation. Version 2 is the role-free shape: `links` are
 * peer relationships and `rules` belong to the conversation they constrain.
 * A version 1 file is migrated on read; a newer file is refused rather than
 * guessed.
 */
const STATE_VERSION = 2

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

/** Stages a declared rule intervenes at, and the Harness event each one hooks. */
export const RULE_STAGES = Object.freeze({
  /** Refuse a pending tool call. */
  before: 'tools/pre-execute',
  /** Turn a completed tool result into corrective feedback. */
  after: 'tools/post-execute',
  /** Assert a standing constraint on the messages entering a step. */
  input: 'agent/pre-step',
})

const STAGES = new Set(Object.keys(RULE_STAGES))

/** Where a fired rule reports to. */
const NOTIFY_TARGETS = new Set(['self', 'off'])

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
    notify: NOTIFY_TARGETS.has(record.notify) ? record.notify : 'self',
  }
}

/**
 * Resolve the nicknames a migrated version 1 file left ambiguous.
 *
 * Version 1 allowed every owner to name the same conversation independently, so
 * one conversation could carry several member names. A link nickname is a
 * single global alias, so the earliest binding wins and later ones are
 * suffixed. The order is deterministic (creation time, then owner) so two runs
 * over the same file migrate identically.
 * @param bindings - version 1 binding records.
 * @param handles - session id → handle map, used for the default nickname.
 * @returns nickname → peer session id, in first-claim order.
 */
function migrateNames(bindings, handles) {
  const ordered = [...bindings].sort((left, right) =>
    (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
    || String(left.owner).localeCompare(String(right.owner)))
  const claimed = new Map()
  const taken = new Set()
  for (const binding of ordered) {
    const owner = text(binding.owner)
    const target = text(binding.target)
    if (owner === undefined || target === undefined || claimed.has(`${owner}\u0000${target}`)) continue
    const preferred = text(binding.name) ?? handles[target] ?? target
    let name = preferred
    let suffix = 2
    while (taken.has(name)) {
      name = `${preferred}-${suffix}`
      suffix += 1
    }
    taken.add(name)
    claimed.set(`${owner}\u0000${target}`, name)
  }
  return claimed
}

/**
 * Links and rules shared by every conversation in this process.
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
    this.#state = { version: STATE_VERSION, handles: {}, links: [], rules: [] }
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
    if (parsed === undefined) {
      this.#logger?.warn?.(`conversation-link: ignoring state file ${this.#file} with an unsupported version`)
      return this.#state
    }
    const handles = Object.fromEntries(
      Object.entries(asRecord(parsed.handles) ?? {}).filter(([, value]) => text(value) !== undefined),
    )
    if (parsed.version === 1) {
      this.#state = this.#migrate(parsed, handles)
      this.#logger?.warn?.(`conversation-link: migrating v1 state at ${this.#file} to version ${STATE_VERSION}`)
      // Land the migrated graph now. Waiting for the next ordinary write would
      // leave the file in the old shape — and the "old directory keeps being
      // used" fallback reads that shape — for as long as nothing else changes.
      this.#write()
      return this.#state
    }
    if (parsed.version !== STATE_VERSION) {
      this.#logger?.warn?.(`conversation-link: ignoring state file ${this.#file} with an unsupported version`)
      return this.#state
    }
    this.#state = {
      version: STATE_VERSION,
      handles,
      links: (Array.isArray(parsed.links) ? parsed.links : [])
        .map(value => asRecord(value))
        .filter(record => record !== undefined && text(record.owner) !== undefined && text(record.peer) !== undefined)
        .map(record => ({
          owner: String(record.owner),
          peer: String(record.peer),
          name: text(record.name) ?? String(record.peer),
          note: text(record.note) ?? '',
          createdAt: Number(record.createdAt) || 0,
        })),
      rules: (Array.isArray(parsed.rules) ? parsed.rules : [])
        .map(normalizeRule)
        .filter(record => record !== undefined && text(record.owner) !== undefined)
        .map(record => ({ ...record, owner: String(record.owner) })),
    }
    return this.#state
  }

  /**
   * Convert a version 1 graph into links and self-declared rules.
   *
   * A binding `owner → target` becomes a link owned by `owner`, so both sides
   * keep the relationship they had and the owner keeps the name it chose. A
   * guard that `owner` held over `target` becomes a rule the **target**
   * declares for itself: the constraint is preserved, the authority behind it
   * is not, which is the whole point of the migration.
   * @param parsed - version 1 state.
   * @param handles - session id → handle map from the same file.
   * @returns the migrated state.
   */
  #migrate(parsed, handles) {
    const bindings = (Array.isArray(parsed.bindings) ? parsed.bindings : []).filter(record => asRecord(record) !== undefined)
    const names = migrateNames(bindings, handles)
    const links = []
    const seen = new Set()
    for (const binding of bindings) {
      const owner = text(binding.owner)
      const peer = text(binding.target)
      if (owner === undefined || peer === undefined) continue
      const key = `${owner}\u0000${peer}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({
        owner,
        peer,
        name: names.get(key) ?? handles[peer] ?? peer,
        note: text(binding.note) ?? '',
        createdAt: Number(binding.createdAt) || 0,
      })
    }
    const rules = (Array.isArray(parsed.guards) ? parsed.guards : [])
      .filter(record => asRecord(record) !== undefined)
      .map(guard => {
        const target = text(guard.target)
        if (target === undefined) return undefined
        const rule = normalizeRule(guard)
        if (rule === undefined) return undefined
        const { id, owner: _owner, target: _target, memberName: _memberName, ...rest } = rule
        return { ...rest, id: `${target}:${String(guard.id ?? links.length)}`, owner: target, level: String(guard.owner ?? '') }
      })
      .filter(record => record !== undefined)
    return { version: STATE_VERSION, handles, links, rules }
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
      this.#logger?.warn?.(`conversation-link: cannot persist state to ${this.#file}: ${String(error)}`)
    }
  }

  /** Every link in the graph. */
  links() {
    return this.#read().links.map(link => ({ ...link }))
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

  /** Links this conversation made: the peers it named. */
  outbound(owner) {
    return this.#read().links.filter(link => link.owner === owner).map(link => ({ ...link }))
  }

  /** Links that name this conversation: the peers that named it. */
  inbound(peer) {
    return this.#read().links.filter(link => link.peer === peer).map(link => ({ ...link }))
  }

  /**
   * Resolve a conversation this owner already linked, by nickname or session id.
   * @param owner - the conversation holding the nickname.
   * @param reference - nickname or peer session id.
   * @returns the link, or undefined when the owner never linked that reference.
   */
  find(owner, reference) {
    const link = this.#read().links
      .find(entry => entry.owner === owner && (entry.name === reference || entry.peer === reference))
    return link === undefined ? undefined : { ...link }
  }

  /**
   * Link a conversation under a nickname unique to this owner.
   *
   * The nickname is a convenience, not a permission: `conversation_send` can
   * address any conversation the human can see. What the link buys is a stable
   * name to say out loud, and a record of who introduced whom.
   * @param owner - the conversation making the link.
   * @param peer - the conversation being linked.
   * @param detail - nickname and optional note.
   * @returns the stored link.
   * @throws when the nickname already belongs to a different conversation.
   */
  link(owner, peer, detail) {
    const state = this.#read()
    const clash = state.links.find(entry =>
      entry.owner === owner && entry.name === detail.name && entry.peer !== peer)
    if (clash !== undefined) {
      throw new Error(`nickname "${detail.name}" already names conversation ${clash.peer}`)
    }
    const existing = state.links.find(entry => entry.owner === owner && entry.peer === peer)
    if (existing !== undefined) {
      existing.name = detail.name
      existing.note = detail.note ?? existing.note
      this.#write()
      return { ...existing }
    }
    const stored = {
      owner,
      peer,
      name: detail.name,
      note: detail.note ?? '',
      createdAt: Date.now(),
    }
    state.links.push(stored)
    this.#write()
    return { ...stored }
  }

  /**
   * Remove one link this owner made.
   *
   * Rules do not come with it: they belong to the conversation that declares
   * them, and dropping a nickname is not a reason to drop a standing constraint.
   * @param owner - the conversation holding the nickname.
   * @param reference - nickname or peer session id.
   * @returns the removed link, or undefined when nothing matched.
   */
  unlink(owner, reference) {
    const state = this.#read()
    const index = state.links
      .findIndex(entry => entry.owner === owner && (entry.name === reference || entry.peer === reference))
    if (index < 0) return undefined
    const [removed] = state.links.splice(index, 1)
    this.#write()
    return { ...removed }
  }

  /** Every rule declared by one conversation. */
  rulesFor(owner, stage) {
    return this.#read().rules
      .filter(rule => rule.owner === owner && (stage === undefined || rule.stage === stage))
      .map(rule => ({ ...rule }))
  }

  /**
   * Add one rule a conversation declares for itself.
   *
   * A rule's `stage` picks where it intervenes in its own pipeline: `before`
   * refuses a pending tool call, `after` turns a completed result into
   * corrective feedback, and `input` asserts a standing constraint on the
   * messages entering a step.
   * @param owner - the conversation the rule constrains.
   * @param rule - stage, selector, and stage-specific payload.
   * @returns the stored rule.
   */
  addRule(owner, rule) {
    const state = this.#read()
    const stored = {
      id: `rule-${Date.now().toString(36)}-${state.rules.length.toString(36)}`,
      owner,
      stage: STAGES.has(rule.stage) ? rule.stage : 'before',
      tool: rule.tool ?? '*',
      match: rule.match ?? '',
      matchResult: rule.matchResult ?? '',
      text: rule.text ?? '',
      once: rule.once === 'session' ? 'session' : 'turn',
      reason: rule.reason ?? '',
      notify: NOTIFY_TARGETS.has(rule.notify) ? rule.notify : 'self',
      createdAt: Date.now(),
    }
    state.rules.push(stored)
    this.#write()
    return { ...stored }
  }

  /**
   * Remove rules this conversation declared.
   * @param owner - the conversation that declared them.
   * @param id - rule identity returned by {@link addRule}, or `all` for every rule of that stage.
   * @param stage - optional stage to narrow `all` to.
   * @returns the removed rules.
   */
  removeRule(owner, id, stage) {
    const state = this.#read()
    const match = rule => rule.owner === owner
      && (id === 'all' ? (stage === undefined || rule.stage === stage) : rule.id === id)
    const removed = state.rules.filter(match)
    state.rules = state.rules.filter(rule => !match(rule))
    if (removed.length > 0) this.#write()
    return removed.map(rule => ({ ...rule }))
  }
}
