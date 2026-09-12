/**
 * `dsh-conversation-bindings` — peer conversation communication, supervision,
 * and tool guardrails inside one Harness process.
 *
 * The Harness already keeps every conversation it opened alive in one process
 * and already lets any plugin address any live agent, but the only shipped
 * cross-conversation path is parent-to-child delegation. This plugin adds the
 * horizontal path: a supervisor conversation discovers its peers, registers
 * them as named members, exchanges messages in both directions, watches their
 * progress, opens new peers of its own, and refuses a member's tool calls that
 * violate a guardrail it set.
 *
 * Design rules this plugin holds to:
 *
 * - **Addressing leaves a record.** A conversation may message a member it
 *   bound, reply to a conversation that bound it, or reach any other
 *   conversation this workspace shows the human — that first contact registers
 *   it as a member, so every message still lands on a durable, auditable edge.
 * - **Audited message vocabulary.** Cross-conversation messages reuse the
 *   Harness's own `agent-message` source with the `relay` context form, so they
 *   carry a typed sender, render as a relay card, and need no Session format
 *   change.
 * - **No hidden loop.** Nothing is forwarded automatically. Every message is an
 *   explicit tool call, so two conversations cannot wake each other forever.
 * - **Guards fail open, loudly.** A guard decision is policy, not transport: a
 *   defect in this plugin must never break an unrelated conversation's work.
 *
 * @module dsh-conversation-bindings
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BindingStore } from './store.js'
import { condense, deliver, optional, relayMessage, relaySummary } from './peers.js'
import { createTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'conversation-bindings'

/** Services this plugin needs before it mounts. */
export const inject = ['agents', 'tools']

/** Guard notifications are quiet by default: they land in the next admitted step. */
const DEFAULT_NOTIFY = 'inject'

/** Minimum gap between two guard notifications for the same rule. */
const DEFAULT_NOTIFY_COOLDOWN_MS = 10_000

/** Expand a leading `~` in one configured path. */
function expandHome(value) {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/**
 * Resolve the durable state file for this deployment.
 * @param config - plugin config.
 * @returns the absolute state file path.
 */
function resolveStateFile(config) {
  if (typeof config.stateDir === 'string' && config.stateDir.length > 0) {
    return join(expandHome(config.stateDir), 'state.json')
  }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'conversation-bindings', 'state.json')
}

/**
 * Record that this plugin mounted, in its own state directory.
 *
 * A loader row that fails to resolve is silent from the outside: the tools
 * simply never appear, and nothing distinguishes "not installed" from
 * "installed but rejected". This record makes the difference observable from a
 * shell, and it is rewritten rather than appended so it cannot grow. It is
 * written only after every registration succeeded, so its presence also
 * witnesses that the Harness accepted every tool definition.
 * @param stateFile - the resolved state file path.
 * @param toolCount - how many tool definitions were registered.
 */
function recordMount(stateFile, toolCount) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(join(dirname(stateFile), 'mount.json'), `${JSON.stringify({
      mountedAt: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      tools: toolCount,
      plugin: 'dsh-conversation-bindings',
    }, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics must never fail the mount.
  }
}

/** Serialize call arguments for matching without letting a hostile value trap the guard. */
function serializeArguments(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    // A caller-supplied value with a throwing `toJSON` has no textual form;
    // a substring guard then simply cannot match it.
    return ''
  }
}

/** Test one configured guard selector against serialized call arguments. */
function matchArguments(selector, serialized) {
  if (selector.length === 0) return true
  if (selector.length > 2 && selector.startsWith('/')) {
    const end = selector.lastIndexOf('/')
    if (end > 0) {
      try {
        return new RegExp(selector.slice(1, end), selector.slice(end + 1)).test(serialized)
      } catch {
        // An unusable regular expression falls through to the literal test so a
        // typo narrows the guard instead of silently disabling it.
      }
    }
  }
  return serialized.toLowerCase().includes(selector.toLowerCase())
}

/** First rule that matches one pending or completed tool call. */
function selectCallRule(rules, toolName, serializedArguments, serializedResult) {
  return rules.find(rule =>
    (rule.tool === '*' || rule.tool === toolName)
    && matchArguments(rule.match, serializedArguments)
    && (rule.matchResult.length === 0 || matchArguments(rule.matchResult, serializedResult)))
}

/** Concatenated text of a tool result, for result matching. */
function serializeResult(result) {
  const content = result === undefined || result === null ? undefined : result.content
  if (!Array.isArray(content)) return serializeArguments(result)
  return serializeArguments(content
    .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n'))
}

/** Concatenated text of the messages entering one step. */
function serializeMessages(messages) {
  return serializeArguments((Array.isArray(messages) ? messages : [])
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n'))
}

/**
 * Mount the plugin.
 * @param ctx - host context carrying the agent registry and tool registry.
 * @param config - deployment configuration.
 */
export function apply(ctx, config = {}) {
  const stateFile = resolveStateFile(config)
  const store = new BindingStore({ file: stateFile, logger: optional(ctx, 'logger') })
  const notifyMode = typeof config.notify === 'string' ? config.notify : DEFAULT_NOTIFY
  const cooldownMs = Number.isFinite(config.notifyCooldownMs)
    ? Number(config.notifyCooldownMs)
    : DEFAULT_NOTIFY_COOLDOWN_MS
  const lastNotified = new Map()
  const constrainState = { sessions: new Set(), turns: new Map() }

  if (typeof config.mountLog === 'string' && config.mountLog.length > 0) {
    // Off by default: an operator turns this on to confirm that the loader row
    // mounted in a deployment whose logs are not reachable from the shell.
    try {
      appendFileSync(config.mountLog, `${new Date().toISOString()} mounting pid=${process.pid} state=${stateFile}\n`)
    } catch {
      // Diagnostics must never fail the mount.
    }
  }

  const messageForm = config.messageForm === 'notice' ? 'notice' : 'relay'
  const definitions = createTools(ctx, store, {
    briefOnBind: config.briefOnBind !== false,
    messageForm,
    autoBind: config.autoBind !== false,
  })
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }

  // Stage `before`: refuse a pending call. A rule that vetoes short-circuits the
  // chain on purpose — the Harness already vetoed the work, so running inner
  // policy (including a human approval prompt) would ask about a call that can
  // no longer happen.
  ctx.on('tools/pre-execute', async (exec, next) => {
    let rule
    try {
      const callerId = exec.agent === undefined ? undefined : String(exec.agent.id)
      if (callerId === undefined) return await next()
      rule = selectCallRule(store.rulesFor(callerId, 'before'), exec.name, serializeArguments(exec.arguments), '')
    } catch (error) {
      // Rules are policy on top of the pipeline; an internal defect must not
      // block a call the Harness would otherwise allow.
      optional(ctx, 'logger')?.warn?.(`conversation-bindings: rule check failed: ${String(error)}`)
      return next()
    }
    if (rule === undefined) return next()
    notifySupervisor(ctx, store, rule, exec, notifyMode, cooldownMs, lastNotified, 'blocked')
    return { kind: 'deny', reason: `Blocked by supervising conversation: ${rule.reason}` }
  })

  // Stage `after`: turn a completed result into corrective feedback. The inner
  // chain runs first so a defect here replaces one outcome instead of skipping
  // every other post-execute listener.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    let rule
    try {
      const callerId = exec.agent === undefined ? undefined : String(exec.agent.id)
      if (callerId === undefined) return decision
      rule = selectCallRule(
        store.rulesFor(callerId, 'after'),
        exec.name,
        serializeArguments(exec.arguments),
        serializeResult(result),
      )
    } catch (error) {
      optional(ctx, 'logger')?.warn?.(`conversation-bindings: result rule check failed: ${String(error)}`)
      return decision
    }
    if (rule === undefined) return decision
    notifySupervisor(ctx, store, rule, exec, notifyMode, cooldownMs, lastNotified, 'rejected the result of')
    return {
      kind: 'block',
      feedback: [{
        type: 'text',
        text: `Rejected by supervising conversation: ${rule.reason}\n`
          + 'The result above was discarded. Correct the problem and call the tool again.',
      }],
    }
  })

  // Stage `input`: assert a standing constraint on the messages entering a step.
  // A constraint is a real message with relay provenance, so the member's model
  // and the human reading that conversation both see who imposed it.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter') return decision
      const targetId = String(payload.agent.id)
      const rules = store.rulesFor(targetId, 'input')
      if (rules.length === 0) return decision
      const incoming = serializeMessages(decision.messages)
      const due = rules.filter(rule =>
        matchArguments(rule.match, incoming) && constraintDue(rule, payload.turn, constrainState))
      if (due.length === 0) return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          ...due.map(rule => {
            const senderHandle = store.handleFor(rule.owner)
            return relayMessage({
              senderId: rule.owner,
              form: messageForm,
              summary: relaySummary({
                senderId: rule.owner,
                senderHandle,
                body: `standing constraint: ${rule.text}`,
              }),
              text: `[standing constraint from your supervising conversation `
                + `${senderHandle} (${rule.owner})]\n\n${rule.text}`,
            })
          }),
        ],
      }
    } catch (error) {
      // A constraint is advisory context; failing to add it must never stop the
      // member's step from entering.
      optional(ctx, 'logger')?.warn?.(`conversation-bindings: constraint injection failed: ${String(error)}`)
      return decision
    }
  })

  if (typeof config.mountLog === 'string' && config.mountLog.length > 0) {
    try {
      appendFileSync(config.mountLog, `${new Date().toISOString()} mounted pid=${process.pid}\n`)
    } catch {
      // Diagnostics must never fail the mount.
    }
  }
  recordMount(stateFile, definitions.length)
}

/**
 * Whether one constraint rule may be asserted again now.
 *
 * A `turn` rule is restated once per turn so it stays near the end of the
 * member's context without repeating on every step; a `session` rule is
 * asserted once and then left in the transcript. This tracking is process-local,
 * so a restart restates each rule at most once more.
 * @param rule - the constraint rule.
 * @param turn - the turn whose step is being admitted.
 * @param state - per-rule assertion record.
 * @returns whether to inject the constraint for this step.
 */
function constraintDue(rule, turn, state) {
  if (rule.once === 'session') {
    if (state.sessions.has(rule.id)) return false
    state.sessions.add(rule.id)
    return true
  }
  if (state.turns.get(rule.id) === turn) return false
  state.turns.set(rule.id, turn)
  return true
}

/**
 * Tell the supervising conversation that one of its rules fired.
 *
 * The notification never wakes an idle supervisor unless `notify` selects
 * `queue`: a rule firing is information, not a reason to spend a turn.
 * @param ctx - host context.
 * @param store - rule and handle store, for sender addressing.
 * @param rule - the matched rule.
 * @param exec - the affected call.
 * @param mode - `inject`, `queue`, or `off`.
 * @param cooldownMs - minimum gap between notifications for the same rule.
 * @param lastNotified - per-rule notification clock.
 * @param verb - what happened, phrased for the supervisor.
 */
function notifySupervisor(ctx, store, rule, exec, mode, cooldownMs, lastNotified, verb) {
  if (mode === 'off') return
  const now = Date.now()
  const previous = lastNotified.get(rule.id) ?? 0
  if (now - previous < cooldownMs) return
  lastNotified.set(rule.id, now)
  const supervisor = ctx.agents.get(rule.owner)
  if (supervisor === undefined) return
  try {
    deliver(supervisor, {
      senderId: rule.target,
      senderHandle: store.handleFor(rule.target),
      recipientHandle: store.handleFor(rule.owner),
      relation: `you supervise this conversation as "${rule.memberName ?? rule.target}"`,
      body: `Rule fired: this conversation ${verb} tool "${exec.name}".\n`
        + `Rule: ${rule.stage}/${rule.tool}${rule.match.length > 0 ? ` matching ${rule.match}` : ''}\n`
        + `Reason given to it: ${condense(rule.reason)}\n`
        + `Arguments: ${condense(serializeArguments(exec.arguments), 300)}`,
    }, mode === 'queue' ? 'queue' : 'inject')
  } catch (error) {
    optional(ctx, 'logger')?.warn?.(`conversation-bindings: cannot notify supervisor "${rule.owner}": ${String(error)}`)
  }
}
