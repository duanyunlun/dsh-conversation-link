/**
 * Model-facing tools of `dsh-conversation-link`.
 *
 * Seven tools cover the supervisor workflow: discover the conversations the
 * user opened, register them as named members, talk to them in both directions,
 * watch their progress without waking them, open new peer conversations, and
 * put guardrails on a member's tool calls.
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

/** Shown when a conversation tries to address one it never bound and that never bound it. */
const AUTHORIZE_HINT = 'Bind it first with conversation_bind, pass name to conversation_send to register it in the same call, or wait for it to send you a message.'

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
 * Decide whether `callerId` may address `reference`, and how to frame it.
 *
 * Two relationships authorize a message: the caller supervises the target (an
 * outbound binding), or the target supervises the caller (the reply path, which
 * needs no second binding). Anything else is unaddressed — `conversation_send`
 * then registers the target on first contact (see `registerMember`), while the
 * read-only and rule tools still refuse.
 * @param store - binding store.
 * @param callerId - sending conversation session id.
 * @param reference - member name, conversation handle, or session id.
 * @returns the addressing detail, or undefined when unbound.
 */
function authorize(store, callerId, reference) {
  const byHandle = store.byHandle(reference)
  const resolved = byHandle ?? reference
  const outbound = store.find(callerId, resolved)
  if (outbound !== undefined) {
    return {
      sessionId: outbound.target,
      senderName: undefined,
      relation: `you are supervised by this conversation as "${outbound.name}"`
        + (outbound.role.length > 0 ? ` (${outbound.role})` : ''),
    }
  }
  const inbound = store.inbound(callerId).find(binding => binding.owner === resolved)
  if (inbound !== undefined) {
    // Phrased for whoever reads the delivered message — here the supervisor —
    // the same way `notifySupervisor` phrases its own notices.
    return {
      sessionId: inbound.owner,
      senderName: inbound.name,
      relation: `you supervise this conversation as "${inbound.name}"`
        + (inbound.role.length > 0 ? ` (${inbound.role})` : ''),
    }
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
 * @param store - durable binding, guard, and handle store.
 * @param options - configurable behavior; see the README's configuration table.
 * @returns the tool definitions to register.
 */
export function createTools(ctx, store, options = {}) {
  const briefOnBind = options.briefOnBind !== false
  const messageForm = options.messageForm === 'notice' ? 'notice' : 'relay'
  // First contact registers the target instead of refusing: see
  // `registerMember` for why this widens no authority.
  const autoBind = options.autoBind !== false

  /**
   * Hand one newly bound member the working agreement, without waking it.
   *
   * The briefing is advisory: it tells the member who supervises it and that
   * asking costs less than guessing. Enforcement stays in the rule stages, so a
   * member is a peer that was introduced to a coordinator rather than a process
   * under surveillance.
   * @param ownerId - supervising conversation session id.
   * @param binding - the binding just stored.
   */
  function briefMember(ownerId, binding) {
    if (!briefOnBind) return
    const member = ctx.agents.get(binding.target)
    if (member === undefined) return
    const supervisorHandle = store.handleFor(ownerId)
    try {
      deliver(member, {
        senderId: ownerId,
        form: messageForm,
        senderHandle: supervisorHandle,
        recipientHandle: store.handleFor(binding.target),
        body: frameBriefing({
          supervisorId: ownerId,
          supervisorHandle,
          name: binding.name,
          role: binding.role,
        }),
      }, 'inject')
    } catch (error) {
      optional(ctx, 'logger')?.warn?.(`conversation-link: cannot brief member "${binding.target}": ${String(error)}`)
    }
  }

  /**
   * Register one conversation as a member of `ownerId`, or refuse it.
   *
   * Both `conversation_bind` and first contact in `conversation_send` come
   * through here, so the visibility fence, the default name, and the briefing
   * cannot drift apart between the two entry points.
   *
   * This is not a permission gate and was never one: `conversation_bind` has
   * always let any conversation register any conversation the human can see,
   * asking the target nothing. What the edge buys is an explicit, durable,
   * auditable record of who is talking to whom and a name to address it by —
   * which is why registering on first contact widens no authority, it only
   * removes a second call.
   * @param ownerId - the conversation taking the member.
   * @param target - target session id, already resolved from any handle.
   * @param detail - member name (defaults to the target's handle), role, and note.
   * @returns the stored binding.
   * @throws when the target is one this workspace does not show, or the name is taken.
   */
  async function registerMember(ownerId, target, detail) {
    if (!await isAddressable(ctx, target)) {
      throw new Error(`conversation "${target}" is not one this workspace shows: `
        + 'it is archived, still blank, or a subagent child. Ask the human to open it first.')
    }
    // The default name is minted only after the fence, so a refused target
    // leaves no handle behind in the state file.
    const name = typeof detail.name === 'string' && detail.name.length > 0
      ? detail.name
      : store.handleFor(target)
    const binding = store.bind(ownerId, target, { ...detail, name })
    briefMember(ownerId, binding)
    return binding
  }

  return [
    defineTool({
      name: 'conversation_list',
      description: 'List the conversations you can address, with their stable handles: exactly the conversations this '
        + 'workspace shows the human — archived, empty, and subagent ones are excluded — plus the members you supervise '
        + 'and the supervisors that name you. Closed conversations are listed too and are opened when you message them.',
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
        required: ['self', 'selfHandle', 'members', 'supervisedBy', 'conversations'],
        properties: {
          self: { type: 'string' },
          selfHandle: { type: 'string', description: 'Your own stable handle; other conversations address you by it.' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'handle', 'sessionId', 'role', 'status', 'title'],
              properties: {
                name: { type: 'string' },
                handle: { type: 'string' },
                sessionId: { type: 'string' },
                role: { type: 'string' },
                status: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
          supervisedBy: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['handle', 'sessionId', 'name', 'role'],
              properties: {
                handle: { type: 'string' },
                sessionId: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
              },
            },
          },
          conversations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['handle', 'sessionId', 'title', 'cwd', 'status', 'live', 'pending', 'memberName', 'isSelf'],
              properties: {
                handle: { type: 'string' },
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                status: { type: 'string' },
                live: { type: 'boolean', description: 'False when the conversation is stored but nothing holds it open yet; messaging it opens it.' },
                pending: { type: 'integer' },
                memberName: { type: 'string' },
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
        const members = store.outbound(selfId)
        const byTarget = new Map(members.map(member => [member.target, member]))
        const statusOf = sessionId =>
          conversations.find(entry => entry.sessionId === sessionId)?.status ?? 'unknown'
        return {
          self: selfId,
          selfHandle: store.handleFor(selfId),
          members: members.map(member => ({
            name: member.name,
            handle: store.handleFor(member.target),
            sessionId: member.target,
            role: member.role,
            status: statusOf(member.target),
            title: titles.get(member.target) ?? '',
          })),
          supervisedBy: store.inbound(selfId).map(binding => ({
            handle: store.handleFor(binding.owner),
            sessionId: binding.owner,
            name: binding.name,
            role: binding.role,
          })),
          conversations: conversations.map(entry => ({
            handle: store.handleFor(entry.sessionId),
            sessionId: entry.sessionId,
            title: titles.get(entry.sessionId) ?? '',
            cwd: entry.cwd,
            status: entry.status,
            live: entry.live,
            pending: entry.pending,
            memberName: byTarget.get(entry.sessionId)?.name ?? '',
            isSelf: entry.sessionId === selfId,
          })),
        }
      },
    }),

    defineTool({
      name: 'conversation_bind',
      description: 'Register another conversation as a named member you supervise, so you can message it and set '
        + 'guardrails on it. Binding is durable across restarts. Rebinding the same conversation updates its role. '
        + 'conversation_send registers on first contact too, so bind up front only to choose the name and role.',
      parameters: {
        target: { type: 'string', required: true, description: 'Target conversation handle or session id, as returned by conversation_list.' },
        name: { type: 'string', required: true, description: 'Short member name you will address it by, unique among your members (for example "frontend").' },
        role: { type: 'string', description: 'What this member is responsible for, in one line.' },
        note: { type: 'string', description: 'Optional longer brief for this member.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'name', 'handle', 'sessionId', 'role', 'live'],
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          role: { type: 'string' },
          live: { type: 'boolean' },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const target = store.byHandle(String(args.target)) ?? String(args.target)
        if (target === selfId) throw new Error('a conversation cannot bind itself')
        const binding = await registerMember(selfId, target, {
          name: String(args.name),
          ...(args.role === undefined ? {} : { role: String(args.role) }),
          ...(args.note === undefined ? {} : { note: String(args.note) }),
        })
        return {
          ok: true,
          name: binding.name,
          handle: store.handleFor(binding.target),
          sessionId: binding.target,
          role: binding.role,
          live: ctx.agents.get(binding.target) !== undefined,
        }
      },
    }),

    defineTool({
      name: 'conversation_unbind',
      description: 'Drop one member you supervise. Its guardrails are removed with it. The conversation itself keeps running.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member name, conversation handle, or session id.' },
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
        const removed = store.unbind(String(self.id), store.byHandle(reference) ?? reference)
        if (removed === undefined) throw new Error(`no member named "${reference}"`)
        return Promise.resolve({ ok: true, removed: removed.name })
      },
    }),

    defineTool({
      name: 'conversation_send',
      description: 'Send a message to another conversation: any conversation this workspace shows the human, or a member '
        + 'of yours, or a supervisor of you. On first contact the target is registered as a member automatically (name it '
        + 'with `name`, otherwise it is addressed by its handle afterwards). Delivery mode `auto` (the default) reaches a '
        + 'conversation that is running at its next step boundary instead of waiting for its turn to end, and gives an '
        + 'idle one a fresh turn; `queue` always starts a new turn, `steer` always joins the nearest step, `inject` adds '
        + 'context without waking the target. The returned `mode` is where the message actually landed.',
      parameters: {
        target: { type: 'string', required: true, description: 'Conversation handle or session id, a member name you registered, or the session id of a conversation that supervises you.' },
        message: { type: 'string', required: true, description: 'The message body the target model will read.' },
        mode: { type: 'string', enum: ['auto', 'queue', 'steer', 'inject'], description: 'Delivery mode; defaults to auto.' },
        name: { type: 'string', description: 'Member name to register the target under on first contact. Defaults to the target\'s handle; ignored when a relationship already exists.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'handle', 'sessionId', 'mode', 'messageId', 'targetStatus', 'opened', 'bound'],
        properties: {
          ok: { type: 'boolean' },
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          mode: { type: 'string', description: 'Where the message actually landed: `queue`, `steer`, or `inject` — `auto` is resolved before delivery.' },
          messageId: { type: 'string' },
          targetStatus: { type: 'string' },
          opened: { type: 'boolean', description: 'True when the conversation was stored but closed, so it was opened to receive this message.' },
          bound: { type: 'boolean', description: 'True when this call registered the target as a member on first contact.' },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const reference = String(args.target)
        let addressed = authorize(store, selfId, reference)
        let bound = false
        if (addressed === undefined) {
          if (!autoBind) {
            throw new Error(`conversation "${reference}" is neither a member you supervise nor a supervisor of yours. ${AUTHORIZE_HINT}`)
          }
          // First contact: register, then send — one call instead of two.
          const target = store.byHandle(reference) ?? reference
          if (target === selfId) throw new Error('a conversation cannot message itself')
          const binding = await registerMember(selfId, target, {
            ...(args.name === undefined ? {} : { name: String(args.name) }),
          })
          bound = true
          addressed = {
            sessionId: binding.target,
            senderName: undefined,
            relation: `you are supervised by this conversation as "${binding.name}"`,
          }
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
          relation: addressed.relation,
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
          bound,
        }
      },
    }),

    defineTool({
      name: 'conversation_status',
      description: 'Read another conversation\'s progress without waking it: current turn and step, the last human and '
        + 'assistant text, recent tool names, and pending queued work. Use it to supervise instead of interrupting.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member name, conversation handle, or the session id of a conversation that supervises you.' },
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
          throw new Error(`conversation "${String(args.target)}" is neither a member you supervise nor a supervisor of yours. ${AUTHORIZE_HINT}`)
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
      description: 'Open a new conversation beside this one (a peer, not a subagent) and optionally bind it as a member '
        + 'and hand it its first task. The new conversation appears in the user\'s conversation list immediately.',
      parameters: {
        name: { type: 'string', description: 'Member name to bind the new conversation under.' },
        role: { type: 'string', description: 'What the new member is responsible for.' },
        cwd: { type: 'string', description: 'Working directory for the new conversation; defaults to the Harness default.' },
        preset: { type: 'string', description: 'Agent preset id for the new conversation; defaults to the deployment default.' },
        prompt: { type: 'string', description: 'First task to deliver, waking the new conversation immediately.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'handle', 'sessionId', 'name', 'bound', 'delivered'],
        properties: {
          ok: { type: 'boolean' },
          handle: { type: 'string' },
          sessionId: { type: 'string' },
          name: { type: 'string' },
          bound: { type: 'boolean' },
          delivered: { type: 'boolean' },
        },
      },
      async run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const sessionId = await spawnConversation(ctx, {
          // A new member joins the supervisor's own workspace unless the caller
          // names another one: a coordinator working in one project must not
          // scatter its members across the deployment default.
          cwd: args.cwd === undefined ? (self.session.header.cwd ?? undefined) : String(args.cwd),
          ...(args.preset === undefined ? {} : { preset: String(args.preset) }),
          ...(self.options === undefined ? {} : { agentOptions: self.options }),
        })
        const handle = store.handleFor(sessionId)
        let bound = false
        const name = args.name === undefined ? '' : String(args.name)
        if (name.length > 0) {
          store.bind(selfId, sessionId, {
            name,
            ...(args.role === undefined ? {} : { role: String(args.role) }),
          })
          bound = true
        }
        let delivered = false
        if (args.prompt !== undefined && String(args.prompt).length > 0) {
          const agent = await openConversation(ctx, sessionId)
          deliver(agent, {
            senderId: selfId,
            form: messageForm,
            senderHandle: store.handleFor(selfId),
            recipientHandle: handle,
            ...(bound ? { relation: `you are supervised by this conversation as "${name}"` } : {}),
            body: String(args.prompt),
          }, 'queue')
          delivered = true
        }
        return { ok: true, handle, sessionId, name, bound, delivered }
      },
    }),

    defineTool({
      name: 'conversation_guard',
      description: 'Set a rule on a member. Stage "before" refuses a matching tool call before it runs (the member sees '
        + 'your reason). Stage "after" rejects a matching completed result and returns your reason to the member as '
        + 'corrective feedback. Stage "input" asserts a standing constraint the member sees before each turn. Actions: '
        + 'add, remove, or list. Rules are durable and belong to the supervising conversation.',
      parameters: {
        action: { type: 'string', required: true, enum: ['add', 'remove', 'list'], description: 'What to do.' },
        target: { type: 'string', description: 'Member name, conversation handle, or session id. Required for add; required for remove with id "all".' },
        stage: { type: 'string', enum: ['before', 'after', 'input'], description: 'When the rule applies. Defaults to "before".' },
        tool: { type: 'string', description: 'Tool name the rule matches, or "*" for every tool. Defaults to "*". Ignored by stage "input".' },
        match: { type: 'string', description: 'For "before"/"after": matched against call arguments. For "input": matched against the messages entering the step; empty applies every turn. Case-insensitive substring, or /regex/flags.' },
        matchResult: { type: 'string', description: 'Stage "after" only: additionally matched against the completed result text.' },
        text: { type: 'string', description: 'Stage "input" only: the constraint the member reads before the step.' },
        once: { type: 'string', enum: ['turn', 'session'], description: 'Stage "input" only: restate each turn (default) or assert once per session.' },
        reason: { type: 'string', description: 'Why the call is refused or the result rejected; the member\'s model reads this.' },
        id: { type: 'string', description: 'Rule id to remove, or "all" to remove every rule on the target.' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'changed', 'guards'],
        properties: {
          ok: { type: 'boolean' },
          changed: { type: 'integer' },
          guards: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'stage', 'target', 'tool', 'match', 'matchResult', 'text', 'reason'],
              properties: {
                id: { type: 'string' },
                stage: { type: 'string' },
                target: { type: 'string' },
                tool: { type: 'string' },
                match: { type: 'string' },
                matchResult: { type: 'string' },
                text: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      run(args, exec) {
        const self = requireAgent(exec)
        const selfId = String(self.id)
        const action = String(args.action)
        if (action === 'list') {
          return Promise.resolve({
            ok: true,
            changed: 0,
            guards: store.guardsOwnedBy(selfId).map(publicGuard),
          })
        }
        const reference = args.target === undefined ? '' : String(args.target)
        if (reference.length === 0) throw new Error(`conversation_guard ${action} requires a target`)
        const member = store.find(selfId, store.byHandle(reference) ?? reference)
        if (member === undefined) {
          throw new Error(`conversation "${reference}" is not a member you supervise. ${AUTHORIZE_HINT}`)
        }
        if (action === 'remove') {
          const removed = store.removeGuard(selfId, String(args.id ?? 'all'), member.target)
          return Promise.resolve({ ok: true, changed: removed.length, guards: store.guardsOwnedBy(selfId).map(publicGuard) })
        }
        const stage = args.stage === undefined ? 'before' : String(args.stage)
        if (stage === 'input' && (args.text === undefined || String(args.text).length === 0)) {
          throw new Error('conversation_guard stage "input" requires the constraint text')
        }
        store.addGuard(selfId, {
          target: member.target,
          stage,
          tool: args.tool === undefined ? '*' : String(args.tool),
          match: args.match === undefined ? '' : String(args.match),
          matchResult: args.matchResult === undefined ? '' : String(args.matchResult),
          text: args.text === undefined ? '' : String(args.text),
          once: args.once === undefined ? 'turn' : String(args.once),
          reason: args.reason === undefined
            ? `Rejected by supervising conversation ${selfId}.`
            : String(args.reason),
        })
        return Promise.resolve({ ok: true, changed: 1, guards: store.guardsOwnedBy(selfId).map(publicGuard) })
      },
    }),
  ]
}

/** Public projection of one rule. */
function publicGuard(guard) {
  return {
    id: guard.id,
    stage: guard.stage,
    target: guard.target,
    tool: guard.tool,
    match: guard.match,
    matchResult: guard.matchResult,
    text: condense(guard.text),
    reason: condense(guard.reason),
  }
}
