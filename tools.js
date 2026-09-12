/**
 * Model-facing tools of `dsh-conversation-link`.
 *
 * Seven tools, none of them role-bearing: discover the conversations the user
 * opened, link one under a nickname, talk to it in both directions, watch its
 * progress without waking it, open new peer conversations, and declare standing
 * rules for your own tool calls.
 *
 * Schema dialect: a tool's `parameters` is written as a property map with a
 * per-property `required: true` flag and compiled here into the object-rooted
 * JSON Schema the model receives. An `output` schema is written directly in the
 * enforced raw subset, where `required` is an array of property names. The
 * first-party `defineTool` helper draws the same line; this package cannot use
 * it because that would pull a Harness module into a zero-dependency plugin.
 *
 * @module dsh-conversation-link/tools
 */

import { condense, deliver, frameBriefing, isAddressable, listConversations, openConversation, optional, projectStatus, resolveDelivery, spawnConversation } from './peers.js'

/** Shown when a conversation tries to address one it never linked and that never linked it. */
const AUTHORIZE_HINT = 'Link it first with conversation_link, pass name to conversation_send to link it in the same call, or wait for it to send you a message.'

/**
 * Compile an author-facing property map into the object schema the model sees.
 * @param spec - per-property schemas, each optionally flagged `required: true`.
 * @returns the compiled object schema.
 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...schema } = node
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/** Build one tool definition from a parameter property map, an output schema, and a runner. */
function defineTool(detail) {
  return {
    name: detail.name,
    description: detail.description,
    parameters: compileParameters(detail.parameters),
    output: {
      schema: detail.output,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: detail.run,
  }
}

/** Reject a caller that is not a live conversation. */
function requireAgent(exec) {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('conversation tools require an owning conversation')
  }
  return agent
}

/**
 * Decide whether `callerId` may address `reference`, and how to name it.
 *
 * Two relationships authorize a message: the caller linked the target (it holds
 * a nickname for it), or the target linked the caller (the reply path, which
 * needs no second link). Anything else is unaddressed — `conversation_send`
 * then links the target on first contact (see `linkPeer`), while the read-only
 * and rule tools still refuse.
 * @param store - link and rule store.
 * @param callerId - sending conversation session id.
 * @param reference - nickname, conversation handle, or session id.
 * @returns the addressing detail, or undefined when unlinked.
 */
function authorize(store, callerId, reference) {
  const byHandle = store.byHandle(reference)
  const resolved = byHandle ?? reference
  const outbound = store.find(callerId, resolved)
  if (outbound !== undefined) {
    return { sessionId: outbound.peer, senderName: undefined }
  }
  const inbound = store.inbound(callerId).find(link => link.owner === resolved)
  if (inbound !== undefined) {
    // The target named the caller, so the caller appears in it under that name.
    return { sessionId: inbound.owner, senderName: inbound.name }
  }
  return undefined
}

/** Batch-read conversation titles, tolerating a missing title service. */
async function readTitles(ctx, sessionIds) {
  const query = optional(ctx, 'sessionQuery')
  if (query === undefined || typeof query.readTitleSnapshots !== 'function' || sessionIds.length === 0) {
    return new Map()
  }
  try {
    const results = await query.readTitleSnapshots(sessionIds)
    const titles = new Map()
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return
      const title = result.value.title
      if (title !== undefined && typeof title.title === 'string') titles.set(sessionIds[index], title.title)
    })
    return titles
  } catch {
    // Titles are decoration for the listing; an unavailable title service must
    // not fail discovery of the conversations themselves.
    return new Map()
  }
}

/**
 * Build every tool definition this plugin registers.
 * @param ctx - host context carrying the agent registry, tools, and optional services.
 * @param store - durable link, rule, and handle store.
 * @param options - configurable behavior; see the README's configuration table.
 * @returns the tool definitions to register.
 */
export function createTools(ctx, store, options = {}) {
  const briefOnLink = options.briefOnLink !== false
  const messageForm = options.messageForm === 'notice' ? 'notice' : 'relay'
  // First contact links the target instead of refusing: see `linkPeer` for why
  // this widens no authority.
  const autoLink = options.autoLink !== false

  /**
   * Hand a newly linked peer a courtesy introduction, without waking it.
   *
   * The notice is advisory: it says which nickname the peer was given and who
   * gave it, so a first message never arrives from a stranger. Nothing in it is
   * enforced — a peer's own rules are the only enforcement, and they belong to
   * the peer.
   * @param ownerId - the conversation that made the link.
   * @param link - the link just stored.
   */
  function briefPeer(ownerId, link) {
    if (!briefOnLink) return
    const peer = ctx.agents.get(link.peer)
    if (peer === undefined) return
    const peerHandle = store.handleFor(ownerId)
    try {
      deliver(peer, {
        senderId: ownerId,
        form: messageForm,
        senderHandle: peerHandle,
        recipientHandle: store.handleFor(link.peer),
        body: frameBriefing({
          peerId: ownerId,
          peerHandle,
          name: link.name,
        }),
      }, 'inject')
    } catch (error) {
      optional(ctx, 'logger')?.warn?.(`conversation-link: cannot introduce peer "${link.peer}": ${String(error)}`)
    }
  }

  /**
   * Link one conversation to `ownerId`, or refuse it.
   *
   * Both `conversation_link` and first contact in `conversation_send` come
   * through here, so the visibility fence, the default nickname, and the
   * introduction cannot drift apart between the two entry points.
   *
   * This is not a permission gate and was never one: a conversation may link
   * any conversation the human can see, asking the target nothing. What the
   * link buys is an explicit, durable, auditable nickname — a name to say out
   * loud — which is why linking on first contact widens no authority, it only
   * removes a second call.
   * @param ownerId - the conversation making the link.
   * @param peer - peer session id, already resolved from any handle.
   * @param detail - nickname (defaults to the peer's handle) and optional note.
   * @returns the stored link.
   * @throws when the target is one this workspace does not show, or the nickname is taken.
   */
  async function linkPeer(ownerId, peer, detail) {
    if (!await isAddressable(ctx, peer)) {
      throw new Error(`conversation "${peer}" is not one this workspace shows: `
        + 'it is archived, still blank, or a subagent child. Ask the human to open it first.')
    }
    // The default nickname is minted only after the fence, so a refused target
    // leaves no handle behind in the state file.
    const name = typeof detail.name === 'string' && detail.name.length > 0
      ? detail.name
      : store.handleFor(peer)
    const link = store.link(ownerId, peer, { ...detail, name })
    briefPeer(ownerId, link)
    return link
  }

  return [
    defineTool({
      name: 'conversation_list',
      description: 'List the conversations you can address, with their stable handles: exactly the conversations this '
        + 'workspace shows the human — archived, empty, and subagent ones are excluded — plus the peers you linked and '
        + 'the peers that linked you. Closed conversations are listed too and are opened when you message them.',
      parameters: {
        scope: {
          type: 'string',
          enum: ['workspace', 'all'],
          description: 'workspace (default) lists this working directory; all lists every unarchived conversation on this machine.',
        },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['self', 'selfHandle', 'links', 'linkedBy', 'conversations'],
        properties: {
          self: { type: 'string' },
          selfHandle: { type: 'string', description: 'Your own stable handle; other conversations address you by it.' },
          links: {
            type: 'array',
            description: 'Peers you linked, under the nickname you chose.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'handle', 'sessionId', 'note', 'status', 'title'],
              properties: {
                name: { type: 'string' },
                handle: { type: 'string' },
                sessionId: { type: 'string' },
                note: { type: 'string' },
                status: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
          linkedBy: {
            type: 'array',
            description: 'Peers that linked you, with the nickname each of them will address you by.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['handle', 'sessionId', 'name'],
              properties: {
                handle: { type: 'string' },
                sessionId: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
          conversations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['handle', 'sessionId', 'title', 'cwd', 'status', 'live', 'pending', 'linkName', 'isSelf'],
              properties: {
                handle: { type: 'string' },
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                status: { type: 'string' },
                live: { type: 'boolean', description: 'False when the conversation is stored but nothing holds it open yet; messaging it opens it.' },
                pending: { type: 'integer' },
                linkName: { type: 'string' },
                isSelf: { type: 'boolean' },
              },
            },
          },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const conversations = await listConversations(ctx, {
          cwd: self.session.header.cwd ?? '',
          scope: args.scope === 'all' ? 'all' : 'workspace',
        })
        const titles = await readTitles(ctx, conversations.map(entry => entry.sessionId))
        const links = store.outbound(selfId)
        const byTarget = new Map(links.map(link => [link.peer, link]))
        const statusOf = sessionId =>
          conversations.find(entry => entry.sessionId === sessionId)?.status ?? 'unknown'
        return {
          self: selfId,
          selfHandle: store.handleFor(selfId),
          links: links.map(link => ({
            name: link.name,
            handle: store.handleFor(link.peer),
            sessionId: link.peer,
            note: link.note,
            status: statusOf(link.peer),
            title: titles.get(link.peer) ?? '',
          })),
          linkedBy: store.inbound(selfId).map(link => ({
            handle: store.handleFor(link.owner),
            sessionId: link.owner,
            name: link.name,
          })),
          conversations: conversations.map(entry => ({
            handle: store.handleFor(entry.sessionId),
            sessionId: entry.sessionId,
            title: titles.get(entry.sessionId) ?? '',
            cwd: entry.cwd,
            status: entry.status,
            live: entry.live,
            pending: entry.pending,
            linkName: byTarget.get(entry.sessionId)?.name ?? '',
            isSelf: entry.sessionId === selfId,
          })),
        }
      },
    }),

    defineTool({
      name: 'conversation_link',
      description: 'Link another conversation under a nickname you choose, so you can address it by that name and it is '
        + 'told who did. A link is durable across restarts and carries no authority in either direction: it is a name, '
        + 'not a permission. conversation_send links on first contact too, so link up front only to pick the nickname '
        + 'yourself.',
      parameters: {
        target: { type: 'string', required: true, description: 'Target conversation handle or session id, as returned by conversation_list.' },
        name: { type: 'string', required: true, description: 'Short nickname you will address it by, unique among your links (for example "frontend").' },
        note: { type: 'string', description: 'Optional note about this peer, for your own later reference.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'name', 'handle', 'sessionId', 'note', 'live'],
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          note: { type: 'string' },
          live: { type: 'boolean' },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const target = store.byHandle(String(args.target)) ?? String(args.target)
        if (target === selfId) throw new Error('a conversation cannot link itself')
        const link = await linkPeer(selfId, target, {
          name: String(args.name),
          ...(args.note === undefined ? {} : { note: String(args.note) }),
        })
        return {
          ok: true,
          name: link.name,
          handle: store.handleFor(link.peer),
          sessionId: link.peer,
          note: link.note,
          live: ctx.agents.get(link.peer) !== undefined,
        }
      },
    }),

    defineTool({
      name: 'conversation_unlink',
      description: 'Drop one nickname you gave a conversation. The conversation itself keeps running and any rule it '
        + 'declared for itself stays in force — a name is not what makes a rule real.',
      parameters: {
        target: { type: 'string', required: true, description: 'Nickname, conversation handle, or session id.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'removed'],
        properties: {
          ok: { type: 'boolean' },
          removed: { type: 'string' },
        },
      },
      run(args, exec) {
        const self = requireAgent(exec)
        const reference = String(args.target)
        const removed = store.unlink(String(self.id), store.byHandle(reference) ?? reference)
        if (removed === undefined) throw new Error(`no link named "${reference}"`)
        return Promise.resolve({ ok: true, removed: removed.name })
      },
    }),

    defineTool({
      name: 'conversation_send',
      description: 'Send a message to another conversation: any conversation this workspace shows the human, or a peer '
        + 'you linked, or a peer that linked you. On first contact the target is linked automatically (name it with '
        + '`name`, otherwise it is addressed by its handle afterwards). Delivery mode `auto` (the default) reaches a '
        + 'conversation that is running at its next step boundary instead of waiting for its turn to end, and gives an '
        + 'idle one a fresh turn; `queue` always starts a new turn, `steer` always joins the nearest step, `inject` adds '
        + 'context without waking the target. The returned `mode` is where the message actually landed.',
      parameters: {
        target: { type: 'string', required: true, description: 'Conversation handle or session id, a nickname you gave it, or the session id of a conversation that linked you.' },
        message: { type: 'string', required: true, description: 'The message body the target model will read.' },
        mode: { type: 'string', enum: ['auto', 'queue', 'steer', 'inject'], description: 'Delivery mode; defaults to auto.' },
        name: { type: 'string', description: 'Nickname to link the target under on first contact. Defaults to the target\'s handle; ignored when a link already exists.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'handle', 'sessionId', 'mode', 'messageId', 'targetStatus', 'opened', 'linked'],
        properties: {
          ok: { type: 'boolean' },
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          mode: { type: 'string', description: 'Where the message actually landed: `queue`, `steer`, or `inject` — `auto` is resolved before delivery.' },
          messageId: { type: 'string' },
          targetStatus: { type: 'string' },
          opened: { type: 'boolean', description: 'True when the conversation was stored but closed, so it was opened to receive this message.' },
          linked: { type: 'boolean', description: 'True when this call linked the target under a nickname on first contact.' },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const reference = String(args.target)
        let addressed = authorize(store, selfId, reference)
        let linked = false
        if (addressed === undefined) {
          if (!autoLink) {
            throw new Error(`conversation "${reference}" is neither a peer you linked nor a peer that linked you. ${AUTHORIZE_HINT}`)
          }
          // First contact: link, then send — one call instead of two.
          const target = store.byHandle(reference) ?? reference
          if (target === selfId) throw new Error('a conversation cannot message itself')
          const link = await linkPeer(selfId, target, {
            ...(args.name === undefined ? {} : { name: String(args.name) }),
          })
          linked = true
          addressed = { sessionId: link.peer, senderName: undefined }
        }
        if (!await isAddressable(ctx, addressed.sessionId)) {
          throw new Error(`conversation "${addressed.sessionId}" is not one this workspace shows: `
            + 'it is archived, still blank, or a subagent child. Ask the human to open it first.')
        }
        const opened = ctx.agents.get(addressed.sessionId) === undefined
        const agent = await openConversation(ctx, addressed.sessionId)
        // The status is read after opening, so a conversation that was cold is
        // classified by what it is now rather than by having had no agent.
        const mode = resolveDelivery(agent.status, args.mode === undefined ? 'auto' : String(args.mode))
        const messageId = deliver(agent, {
          senderId: selfId,
          form: messageForm,
          senderHandle: store.handleFor(selfId),
          recipientHandle: store.handleFor(addressed.sessionId),
          ...(addressed.senderName === undefined ? {} : { senderName: addressed.senderName }),
          body: String(args.message),
        }, mode)
        return {
          ok: true,
          handle: store.handleFor(addressed.sessionId),
          sessionId: addressed.sessionId,
          mode,
          messageId,
          targetStatus: agent.status === 'running' ? 'running' : 'idle',
          opened,
          linked,
        }
      },
    }),

    defineTool({
      name: 'conversation_status',
      description: 'Read another conversation\'s progress without waking it: current turn and step, the last human and '
        + 'assistant text, recent tool names, and pending queued work. Use it to follow along instead of interrupting.',
      parameters: {
        target: { type: 'string', required: true, description: 'Nickname you gave it, conversation handle, or the session id of a conversation that linked you.' },
        recent: { type: 'integer', description: 'How many recent messages to include (default 6, max 40).' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['handle', 'sessionId', 'live', 'status', 'cwd', 'pending', 'events', 'turn', 'step',
          'lastUserText', 'lastAssistantText', 'recentToolNames', 'recentMessages'],
        properties: {
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          live: { type: 'boolean' },
          status: { type: 'string' },
          cwd: { type: 'string' },
          pending: { type: 'integer' },
          events: { type: 'integer' },
          turn: { type: 'integer' },
          step: { type: 'integer' },
          lastUserText: { type: 'string' },
          lastAssistantText: { type: 'string' },
          recentToolNames: { type: 'array', items: { type: 'string' } },
          recentMessages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'text'],
              properties: {
                role: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const addressed = authorize(store, String(self.id), String(args.target))
        if (addressed === undefined) {
          throw new Error(`conversation "${String(args.target)}" is neither a peer you linked nor a peer that linked you. ${AUTHORIZE_HINT}`)
        }
        const recent = Math.min(Math.max(Number(args.recent ?? 6) || 6, 1), 40)
        const projection = await projectStatus(ctx, addressed.sessionId, recent)
        if (projection === undefined) {
          throw new Error(`conversation "${addressed.sessionId}" has no readable session log`)
        }
        return { handle: store.handleFor(addressed.sessionId), ...projection }
      },
    }),

    defineTool({
      name: 'conversation_spawn',
      description: 'Open a new conversation beside this one (a peer, not a subagent) and optionally link it under a '
        + 'nickname and hand it its first task. The new conversation appears in the user\'s conversation list immediately.',
      parameters: {
        name: { type: 'string', description: 'Nickname to link the new conversation under.' },
        cwd: { type: 'string', description: 'Working directory for the new conversation; defaults to the Harness default.' },
        preset: { type: 'string', description: 'Agent preset id for the new conversation; defaults to the deployment default.' },
        prompt: { type: 'string', description: 'First task to deliver, waking the new conversation immediately.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'handle', 'sessionId', 'name', 'linked', 'delivered'],
        properties: {
          ok: { type: 'boolean' },
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          name: { type: 'string' },
          linked: { type: 'boolean' },
          delivered: { type: 'boolean' },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const sessionId = await spawnConversation(ctx, {
          // A new peer joins the caller's own workspace unless the caller names
          // another one: someone working in one project must not scatter peers
          // across the deployment default.
          cwd: args.cwd === undefined ? (self.session.header.cwd ?? undefined) : String(args.cwd),
          ...(args.preset === undefined ? {} : { preset: String(args.preset) }),
          ...(self.options === undefined ? {} : { agentOptions: self.options }),
        })
        const handle = store.handleFor(sessionId)
        let linked = false
        const name = args.name === undefined ? '' : String(args.name)
        if (name.length > 0) {
          store.link(selfId, sessionId, { name })
          linked = true
        }
        let delivered = false
        if (args.prompt !== undefined && String(args.prompt).length > 0) {
          const agent = await openConversation(ctx, sessionId)
          deliver(agent, {
            senderId: selfId,
            form: messageForm,
            senderHandle: store.handleFor(selfId),
            recipientHandle: handle,
            body: String(args.prompt),
          }, 'queue')
          delivered = true
        }
        return { ok: true, handle, sessionId, name, linked, delivered }
      },
    }),

    defineTool({
      name: 'conversation_rule',
      description: 'Declare a standing rule for your OWN tool calls. Nothing here acts on another conversation: a rule '
        + 'binds the conversation that declares it, so every rule is a statement about yourself. Stage "before" refuses '
        + 'one of your matching calls before it runs (you see your reason). Stage "after" rejects a matching completed '
        + 'result and returns your reason as corrective feedback. Stage "input" restates a constraint to you before a '
        + 'step. Actions: add, remove, or list. Rules are durable and survive restarts.',
      parameters: {
        action: { type: 'string', required: true, enum: ['add', 'remove', 'list'], description: 'What to do.' },
        stage: { type: 'string', enum: ['before', 'after', 'input'], description: 'When the rule applies. Defaults to "before". Also narrows remove with id "all".' },
        tool: { type: 'string', description: 'Tool name the rule matches, or "*" for every tool. Defaults to "*". Ignored by stage "input".' },
        match: { type: 'string', description: 'For "before"/"after": matched against call arguments. For "input": matched against the messages entering the step; empty applies every turn. Case-insensitive substring, or /regex/flags.' },
        matchResult: { type: 'string', description: 'Stage "after" only: additionally matched against the completed result text.' },
        text: { type: 'string', description: 'Stage "input" only: the constraint you read before the step.' },
        once: { type: 'string', enum: ['turn', 'session'], description: 'Stage "input" only: restate each turn (default) or assert once per session.' },
        reason: { type: 'string', description: 'Why the call is refused or the result rejected; your own model reads this.' },
        notify: { type: 'string', enum: ['self', 'off'], description: 'Whether a fired rule reports to you (default "self", delivered without waking you) or stays silent ("off").' },
        id: { type: 'string', description: 'Rule id to remove, or "all" to remove every rule of that stage.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'changed', 'rules'],
        properties: {
          ok: { type: 'boolean' },
          changed: { type: 'integer' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'stage', 'tool', 'match', 'matchResult', 'text', 'reason', 'notify'],
              properties: {
                id: { type: 'string' },
                stage: { type: 'string' },
                tool: { type: 'string' },
                match: { type: 'string' },
                matchResult: { type: 'string' },
                text: { type: 'string' },
                reason: { type: 'string' },
                notify: { type: 'string' },
              },
            },
          },
        },
      },
      run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const action = String(args.action)
        const stage = args.stage === undefined ? 'before' : String(args.stage)
        if (action === 'list') {
          return Promise.resolve({
            ok: true,
            changed: 0,
            rules: store.rulesFor(selfId).map(publicRule),
          })
        }
        if (action === 'remove') {
          const removed = store.removeRule(selfId, String(args.id ?? 'all'), String(args.id ?? 'all') === 'all' ? stage : undefined)
          return Promise.resolve({ ok: true, changed: removed.length, rules: store.rulesFor(selfId).map(publicRule) })
        }
        if (stage === 'input' && (args.text === undefined || String(args.text).length === 0)) {
          throw new Error('conversation_rule stage "input" requires the constraint text')
        }
        store.addRule(selfId, {
          stage,
          tool: args.tool === undefined ? '*' : String(args.tool),
          match: args.match === undefined ? '' : String(args.match),
          matchResult: args.matchResult === undefined ? '' : String(args.matchResult),
          text: args.text === undefined ? '' : String(args.text),
          once: args.once === undefined ? 'turn' : String(args.once),
          notify: args.notify === undefined ? 'self' : String(args.notify),
          reason: args.reason === undefined
            ? `Refused by your own standing rule (${selfId}).`
            : String(args.reason),
        })
        return Promise.resolve({ ok: true, changed: 1, rules: store.rulesFor(selfId).map(publicRule) })
      },
    }),
  ]
}

/** Public projection of one rule. */
function publicRule(rule) {
  return {
    id: rule.id,
    stage: rule.stage,
    tool: rule.tool,
    match: rule.match,
    matchResult: rule.matchResult,
    text: condense(rule.text),
    reason: condense(rule.reason),
    notify: rule.notify,
  }
}
