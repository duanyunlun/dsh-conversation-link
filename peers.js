/**
 * Peer discovery, message framing, delivery, and read-only status projection
 * for `dsh-conversation-link`.
 *
 * Everything here works on conversations that are live in this process. The
 * Harness keeps an agent alive until the process exits, so a conversation the
 * user opened — and any conversation this plugin created — stays addressable
 * without resuming anything from storage.
 *
 * @module dsh-conversation-link/peers
 */

import { randomUUID } from 'node:crypto'

/** One transcript row header renders this summary without expanding, so it stays inside the bound. */
const NOTICE_SUMMARY_LIMIT = 118

/** Longest text kept from one projected message. */
const PROJECTION_TEXT_LIMIT = 400

/** Longest peer summary kept for one conversation. */
const SUMMARY_LIMIT = 240

/** Collapse whitespace and truncate for a model-facing one-line summary. */
export function condense(value, limit = SUMMARY_LIMIT) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Concatenate the text blocks of one message content array. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * Read one service this plugin can work without.
 *
 * Cordis resolves `ctx.<service>` through a proxy that throws
 * `cannot get property "x" without inject` for a service the plugin did not
 * declare, so a defensive `if (ctx.x === undefined)` never runs — reading the
 * property is itself the failure. `ctx.get` returns undefined instead, which is
 * the only correct probe for an optional seam. Every optional service this
 * plugin uses goes through here so the reason lives in one place.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or undefined when this composition does not mount it.
 */
export function optional(ctx, name) {
  return ctx.get(name)
}

/**
 * Every conversation the caller may address: the ones already live in this
 * process plus the ones this workspace has on disk, minus archived ones.
 *
 * Listing only live conversations would make a link useless after a restart —
 * every peer would stay invisible until a human clicked it open.
 * A conversation the user has not archived is addressable whether or not an
 * agent currently holds it; delivery opens it on demand.
 * @param ctx - host context carrying the agent registry, session query, and workspace registry.
 * @param options - caller workspace and listing scope.
 * @param options.cwd - the caller's working directory; the default scope is this workspace.
 * @param options.scope - `workspace` (default) or `all`.
 * @returns one record per addressable conversation, live ones first.
 */
export async function listConversations(ctx, options) {
  const archived = new Set((optional(ctx, 'workspaceRegistry')?.archivedSessionIds ?? []).map(id => String(id)))
  const found = new Map()

  /**
   * Record one conversation the human can see.
   *
   * Archived conversations, subagent children, and the blank placeholders a
   * workspace browser hides are all excluded: an agent that can address a
   * conversation the sidebar does not show would be talking to something the
   * human cannot see, and could not have meant.
   */
  const add = (record) => {
    if (record.sessionId.length === 0) return
    if (archived.has(record.sessionId)) return
    if (record.origin === 'subagent') return
    if (record.blank) return
    found.set(record.sessionId, record)
  }

  // The Host session controller is the authority the browser itself reads, so
  // preferring it makes this list and the sidebar one list by construction.
  // Session query is the fallback for compositions without that Host API; it
  // reports neither `blank` nor live status, so those rows are admitted as
  // non-blank and their liveness is read from the agent registry.
  const controller = optional(ctx, 'sessionController')
  if (controller !== undefined && typeof controller.list === 'function') {
    let items = []
    try {
      const value = await controller.list({}, new AbortController().signal)
      items = value?.items ?? []
    } catch (error) {
      optional(ctx, 'logger')?.warn?.(`conversation-link: cannot list sessions: ${String(error)}`)
    }
    for (const item of items) {
      const live = ctx.agents.get(String(item.sessionId))
      add({
        sessionId: String(item.sessionId),
        cwd: item.cwd ?? '',
        live: live !== undefined,
        status: live === undefined ? 'inactive' : (live.status === 'running' ? 'running' : 'idle'),
        pending: live === undefined ? 0 : pendingCount(live),
        origin: item.origin,
        blank: item.blank === true,
        createdAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
      })
    }
    return scopeAndSort(found, options)
  }

  for (const agent of ctx.agents.roots()) {
    const header = agent.session.header
    add({
      sessionId: String(agent.id),
      cwd: header.cwd ?? '',
      live: true,
      status: agent.status === 'running' ? 'running' : 'idle',
      pending: pendingCount(agent),
      origin: header.origin,
      blank: false,
      createdAt: header.createdAt ?? 0,
    })
  }

  const query = optional(ctx, 'sessionQuery')
  if (query !== undefined && typeof query.listSessions === 'function') {
    let records = []
    try {
      records = await query.listSessions()
    } catch (error) {
      // A corpus read failure narrows the listing to the live conversations
      // rather than failing the tool a conversation uses to find anyone at all.
      optional(ctx, 'logger')?.warn?.(`conversation-link: cannot list stored sessions: ${String(error)}`)
    }
    for (const record of records) {
      const header = record?.header
      if (header === undefined) continue
      const live = ctx.agents.get(String(header.id))
      add({
        sessionId: String(header.id),
        cwd: header.cwd ?? '',
        live: live !== undefined,
        status: live === undefined ? 'inactive' : (live.status === 'running' ? 'running' : 'idle'),
        pending: live === undefined ? 0 : pendingCount(live),
        origin: header.origin,
        blank: false,
        createdAt: header.createdAt ?? 0,
      })
    }
  }

  return scopeAndSort(found, options)
}

/** Apply the caller's scope and order live conversations before closed ones. */
function scopeAndSort(found, options) {
  const all = [...found.values()]
  const scoped = options?.scope === 'all'
    ? all
    : all.filter(record => record.cwd === options?.cwd)
  return scoped.sort((left, right) =>
    (Number(right.live) - Number(left.live)) || (right.createdAt - left.createdAt))
}

/**
 * Whether one conversation is addressable at all, in any workspace.
 *
 * Sending and linking consult this so a conversation the human cannot see is
 * never a target, whichever tool names it.
 * @param ctx - host context.
 * @param sessionId - durable conversation identity.
 * @returns whether the sidebar would show it.
 */
export async function isAddressable(ctx, sessionId) {
  const conversations = await listConversations(ctx, { scope: 'all' })
  return conversations.some(record => record.sessionId === sessionId)
}

/**
 * Resolve a conversation to a live agent, opening it when nothing holds it.
 *
 * The Host session controller owns preset composition and the subagent
 * ownership fence, so it is preferred whenever mounted — it is the same path
 * the user's own click takes, which is why an opened conversation reaches their
 * conversation list exactly as if they had opened it. The bare agent registry
 * is the fallback for compositions without it.
 * @param ctx - host context.
 * @param sessionId - durable conversation identity.
 * @returns the live agent.
 * @throws when the conversation cannot be opened.
 */
export async function openConversation(ctx, sessionId) {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live
  const controller = optional(ctx, 'sessionController')
  if (controller !== undefined && typeof controller.resolveAgent === 'function') {
    const result = await controller.resolveAgent(sessionId)
    if (result.agent !== undefined) return result.agent
    throw new Error(`cannot open conversation "${sessionId}": ${result.error?.message ?? 'unavailable'}`)
  }
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
  return resumed.agent
}

/** Pending inbox items, the cheapest available "has queued work" signal. */
function pendingCount(agent) {
  try {
    const inbox = agent.inbox
    return inbox.nextTurn.length + inbox.nextStep.length
  } catch {
    // A driver that exposes no readable inbox reports no pending work rather
    // than failing peer listing.
    return 0
  }
}

/**
 * Frame one conversation's message for the receiving model.
 *
 * The header is machine-readable so the receiver can address a reply without
 * guessing, and it repeats the durable attribution that already travels in the
 * message source. There is no role line: a peer is named by whoever linked it,
 * so the head carries that nickname when the recipient has one, and the
 * sender's handle otherwise — both of which `conversation_send` accepts.
 * @param detail - sender identity, both handles, and message body.
 * @returns the model-facing message text.
 */
export function frameMessage(detail) {
  const label = detail.senderName === undefined
    ? `${detail.senderHandle} (${detail.senderId})`
    : `${detail.senderName} (${detail.senderHandle})`
  const lines = [`[message from ${label}]`]
  if (detail.recipientHandle !== undefined) lines.push(`[your handle is ${detail.recipientHandle}]`)
  lines.push('', detail.body, '')
  lines.push(`[Reply with conversation_send target="${detail.senderHandle}" when a reply is needed.]`)
  return lines.join('\n')
}

/**
 * Build one durable, model-visible message a conversation addressed to another.
 *
 * Presentation drove this source choice. The Web transcript renders every
 * logged message whose `source.kind` is not `user` as a **collapsed context
 * row**, and only the `notice` form puts anything on that row's header without
 * expanding it (`relay` reports no summary). A cross-conversation message that
 * a human cannot read at a glance is a message they cannot follow, so the
 * Two presentations exist for the same durable message, chosen by `detail.form`:
 *
 * - `relay` (default) is what the bundled client half turns into a message card:
 *   it carries `senderSessionId`, which the Harness's own relay body renders,
 *   and the client half promotes the row out of its collapsed disclosure.
 * - `notice` is the fallback for a deployment running an older client: it puts a
 *   bounded one-line summary on the collapsed row's header, so the traffic stays
 *   readable even when no client half can restyle it.
 *
 * Either way the source is a plain plugin source: no `source.kind` the Session
 * format validator audits is invented here, and `senderSessionId` rides along
 * for the client half.
 * @param detail - sender identity, display summary, chosen form, and the exact model-facing text.
 * @returns the frozen user message to deliver.
 */
export function relayMessage(detail) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text: detail.text }]),
    source: Object.freeze({
      kind: 'plugin',
      plugin: 'dsh-conversation-link',
      form: detail.form === 'notice' ? 'notice' : 'relay',
      summary: detail.summary,
      senderSessionId: detail.senderId,
    }),
  })
}

/**
 * One line a human reads on the collapsed transcript row: who is speaking, and
 * what they said, bounded to the row's one-line budget.
 *
 * Language-neutral on purpose (`<sender> → <body>`): the plugin has no locale
 * seat of its own, and the sender's handle is already the name both the model
 * and the human use for that conversation.
 * @param detail - sender identity and the message body.
 * @returns the bounded row summary.
 */
export function relaySummary(detail) {
  const from = detail.senderName === undefined
    ? detail.senderHandle
    : `${detail.senderName} (${detail.senderHandle})`
  return condense(`${from} → ${detail.body}`, NOTICE_SUMMARY_LIMIT)
}

/**
 * Pick the inbox boundary one delivery should use.
 *
 * `auto` exists because a queued message waits for the target's whole turn to
 * end — the Harness delivers `followup` as the sole ordinary message of a fresh
 * turn. A conversation that is running a long orchestration would therefore
 * not see a peer's report until it finished, which is exactly when the report
 * stopped being useful. Steering reaches the target at its next step boundary
 * instead (the same choice the Harness's own `agent-team` mailbox makes for its
 * root), while an idle or closed target is better served by a real turn of its
 * own: steering an idle driver produces a claimed message rather than a turn
 * boundary, so the wake path keeps `queue`.
 * @param status - the target's live status.
 * @param mode - requested mode: `auto`, `queue`, `steer`, or `inject`.
 * @returns the mode to act on: `queue`, `steer`, or `inject`.
 */
export function resolveDelivery(status, mode) {
  if (mode !== 'auto') return mode
  return status === 'running' ? 'steer' : 'queue'
}

/**
 * Deliver one model-visible message into a live conversation.
 * @param agent - exact live target agent.
 * @param detail - sender identity and the body to frame.
 * @param mode - resolved mode: `queue` starts a turn, `steer` joins the next step, `inject` adds context without waking.
 * @returns the accepted message identity.
 */
export function deliver(agent, detail, mode) {
  const message = relayMessage({
    senderId: detail.senderId,
    summary: relaySummary(detail),
    form: detail.form,
    text: frameMessage(detail),
  })
  switch (mode) {
    case 'steer':
      agent.steer(message)
      break
    case 'inject':
      agent.inject(message)
      break
    default:
      agent.followup(message)
      break
  }
  return message.id
}

/**
 * Frame the introduction one conversation hands a peer whose link it just made.
 *
 * This is a courtesy notice, not an agreement about authority: it tells the
 * peer which name it was given, who gave it, and that asking costs less than
 * guessing. Nothing here is enforced — the rules that are belong to the peer
 * itself.
 * @param detail - the linking conversation's identity, the nickname it chose, and the reply address.
 * @returns the model-facing briefing text.
 */
export function frameBriefing(detail) {
  return [
    `[a peer conversation introduced itself: ${detail.peerHandle} (${detail.peerId})]`,
    '',
    `It will address you as "${detail.name}".`,
    '',
    'How to work with it:',
    '- When an interface, field name, file ownership, or cross-module change is unclear, ask first: '
      + `conversation_send target="${detail.peerHandle}". Guessing costs more than asking.`,
    '- Say what you intend before a change that reaches outside your own area.',
    '- When a stage of work is done, report the progress and how you verified it.',
    '- When it sends you something, act on it — and say so if it conflicts with what you know.',
    '',
    `[Reply with conversation_send target="${detail.peerHandle}".]`,
    '[Delivery is automatic: the message reaches a running conversation at its next step boundary, '
      + 'and an idle one as a fresh turn. Pass mode "queue" only when the message should wait for the '
      + 'conversation\'s current work to finish.]',
  ].join('\n')
}

/**
 * Read the tail of one conversation's log, live when possible.
 * @param ctx - host context.
 * @param sessionId - durable conversation identity.
 * @returns the events, or undefined when neither the live session nor persistence has it.
 */
async function readEvents(ctx, sessionId) {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live.session.ownEvents()
  const query = optional(ctx, 'sessionQuery')
  if (query === undefined || typeof query.readSession !== 'function') return undefined
  try {
    const snapshot = await query.readSession(sessionId)
    return snapshot.events
  } catch {
    // An unreadable session is reported by the caller as "not found" rather
    // than as a storage failure the model cannot act on.
    return undefined
  }
}

/**
 * Project one conversation's progress without waking it.
 * @param ctx - host context.
 * @param sessionId - durable conversation identity.
 * @param recent - how many projected messages to keep.
 * @returns the status projection, or undefined when the conversation is unknown.
 */
export async function projectStatus(ctx, sessionId, recent) {
  const live = ctx.agents.get(sessionId)
  const events = await readEvents(ctx, sessionId)
  if (events === undefined) return undefined
  let turn = 0
  let step = 0
  let lastUser = ''
  let lastAssistant = ''
  const tools = []
  const messages = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turn = event.data.turn
        break
      case 'step/start':
        step = event.data.step
        break
      case 'user/message': {
        const text = condense(contentText(event.data.content), PROJECTION_TEXT_LIMIT)
        if (text.length > 0) {
          lastUser = text
          messages.push({ role: 'user', text })
        }
        break
      }
      case 'assistant/message': {
        const text = condense(contentText(event.data.message.content), PROJECTION_TEXT_LIMIT)
        if (text.length > 0) {
          lastAssistant = text
          messages.push({ role: 'assistant', text })
        }
        break
      }
      case 'tool/result':
        tools.push(event.data.message.content
          .filter(block => typeof block === 'object' && block !== null && block.type === 'tool-result')
          .map(block => String(block.name ?? 'tool'))
          .join(','))
        break
      default:
        break
    }
  }
  const settled = messages.slice(-recent)
  return {
    sessionId,
    live: live !== undefined,
    status: live === undefined ? 'inactive' : (live.status === 'running' ? 'running' : 'idle'),
    cwd: live?.session.header.cwd ?? '',
    pending: live === undefined ? 0 : pendingCount(live),
    events: events.length,
    turn,
    step,
    lastUserText: lastUser,
    lastAssistantText: lastAssistant,
    recentToolNames: tools.slice(-8).filter(name => name.length > 0),
    recentMessages: settled,
  }
}

/**
 * Record a created conversation in the workspace that owns its directory.
 *
 * The Host session controller only attaches a session when it is created **by
 * workspace id** (`session-controller/src/commands.ts`): a creation that names
 * a `cwd` writes the log in the right directory but leaves the workspace
 * registry's durable session account without it. Registering the same session
 * afterwards closes that gap.
 *
 * This never invents a workspace. An unregistered directory, a path that no
 * longer exists, and a composition without the registry all resolve to a
 * no-op, so spawning stays exactly as available as it was.
 * @param ctx - host context.
 * @param sessionId - the conversation just created.
 * @param cwd - the working directory it was created with, when one was named.
 * @returns whether the session was attached to a workspace.
 */
async function attachToOwningWorkspace(ctx, sessionId, cwd) {
  if (cwd === undefined) return false
  const registry = optional(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.resolveByPath !== 'function') return false
  try {
    const workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) return false
    await workspace.attachSession(sessionId)
    return true
  } catch (error) {
    // Bookkeeping, not creation: a workspace that cannot account for the
    // session must not take the session — or the tool call — down with it.
    optional(ctx, 'logger')?.warn?.(
      `conversation-link: session "${sessionId}" was created but not attached to its workspace: ${String(error)}`)
    return false
  }
}

/**
 * Create a new top-level conversation beside the caller.
 *
 * The Host session controller owns preset composition and workspace
 * registration, so it is preferred when mounted; the bare agent registry is the
 * fallback for compositions without it.
 * @param ctx - host context.
 * @param options - working directory, optional preset, and the model route to inherit.
 * @returns the created conversation's session id.
 */
export async function spawnConversation(ctx, options) {
  const controller = optional(ctx, 'sessionController')
  if (controller !== undefined && typeof controller.create === 'function') {
    const value = await controller.create({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
    })
    const sessionId = String(value.sessionId)
    await attachToOwningWorkspace(ctx, sessionId, options.cwd)
    return sessionId
  }
  const sessionId = `session-${randomUUID()}`
  const created = await ctx.agents.create({
    sessionId,
    ...(options.cwd === undefined ? {} : { meta: { cwd: options.cwd } }),
    ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
  })
  const createdId = String(created.agent.id)
  await attachToOwningWorkspace(ctx, createdId, options.cwd)
  return createdId
}
