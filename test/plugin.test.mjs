/**
 * Behavior tests for dsh-conversation-link.
 *
 * A fake Cordis context stands in for the Harness so the plugin's addressing,
 * delivery, guard, and persistence rules are exercised without a running
 * application: the plugin only ever touches `ctx.agents`, `ctx.tools`,
 * `ctx.on`, and `ctx.logger`, which is exactly what the fake provides.
 *
 * The dialect test at the end replays the Harness's enforced JSON Schema
 * subset, because a tool definition that violates it fails only when the real
 * loader mounts the plugin — a failure this suite must catch first.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

/** One fake conversation with an inbox shaped like the Harness Agent contract. */
class FakeAgent {
  constructor(id, cwd) {
    this.id = id
    this.status = 'idle'
    this.options = { provider: 'deepseek', model: 'deepseek-chat' }
    this.inbox = { nextTurn: [], nextStep: [] }
    this.delivered = []
    this.session = {
      header: { id, cwd, version: 3, createdAt: 0 },
      ownEvents: () => this.events,
    }
    this.events = []
  }

  #accept(mode, message, box) {
    this.delivered.push({ mode, message })
    this.inbox[box].push(message)
  }

  followup(message) {
    this.#accept('queue', message, 'nextTurn')
  }

  steer(message) {
    this.#accept('steer', message, 'nextStep')
  }

  inject(message) {
    this.#accept('inject', message, 'nextStep')
  }

  whenIdle() {
    return Promise.resolve()
  }
}

/** Minimal host context: registries, optional services, event bus, and logger. */
function fakeContext(agents, supplied = {}) {
  const services = {
    logger: { warn: () => {} },
    ...supplied,
  }
  const tools = new Map()
  const listeners = new Map()
  const base = {
    agents: {
      roots: () => agents,
      list: () => agents,
      get: id => agents.find(agent => agent.id === id),
      create: options => services.createAgent(options),
    },
    tools: {
      register: (definition) => {
        validateEnforcedSubset(definition.parameters, `parameters of ${definition.name}`)
        validateEnforcedSubset(definition.output.schema, `output schema of ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get: name => services[name],
    toolsRegistry: tools,
    listeners,
  }
  // Cordis resolves `ctx.<service>` through a proxy that throws for a service
  // the plugin never declared, so an undeclared access must fail here too —
  // otherwise a defect that only appears in a running Harness passes this suite.
  return new Proxy(base, {
    get: (target, prop) => {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

/** Mount the plugin against a throwaway state directory. */
function mount(config = {}, services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-link-'))
  const a = new FakeAgent('session-a', '/repo')
  const b = new FakeAgent('session-b', '/repo')
  const c = new FakeAgent('session-c', '/repo')
  const roster = [a, b, c]
  const ctx = fakeContext(roster, services)
  // Binding briefings have their own test; every other test watches only the
  // messages it sends itself.
  apply(ctx, { stateDir: dir, notifyCooldownMs: 0, briefOnLink: false, ...config })
  return { ctx, dir, a, b, c, agents: roster, tools: ctx.toolsRegistry }
}

/** Invoke one registered tool as the given conversation. */
async function call(tools, name, args, agent) {
  const definition = tools.get(name)
  assert.ok(definition !== undefined, `tool ${name} is registered`)
  return definition.execute(args, { agent })
}

// ---------------------------------------------------------------------------
// The Harness's enforced JSON Schema subset, replayed so a definition that the
// real loader would reject fails here instead.
// ---------------------------------------------------------------------------

const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title',
])
const OBJECT_ONLY = new Set(['properties', 'required', 'additionalProperties'])
const ARRAY_ONLY = new Set(['items'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** Assert one schema node (and its descendants) belongs to the enforced subset. */
function validateEnforcedSubset(node, path) {
  assert.ok(typeof node === 'object' && node !== null && !Array.isArray(node), `${path} must be a schema object`)
  for (const key of Object.keys(node)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${path}.${key} is not a supported keyword`)
  }
  assert.equal(Object.hasOwn(node, 'type'), true, `${path} must declare a type`)
  const type = node.type
  if (type === 'object') {
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      assert.ok(Array.isArray(required) && required.every(entry => typeof entry === 'string'),
        `${path}.required must be an array of strings`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      validateEnforcedSubset(child, `${path}.properties.${key}`)
    }
    return
  }
  if (type === 'array') {
    validateEnforcedSubset(node.items, `${path}.items`)
    return
  }
  assert.ok(SCALAR_TYPES.has(type), `${path}.type must be object/array or a scalar`)
  for (const key of [...OBJECT_ONLY, ...ARRAY_ONLY]) {
    assert.equal(Object.hasOwn(node, key), false, `${path}.${key} is not supported on type "${type}"`)
  }
}

// ---------------------------------------------------------------------------

test('conversation_list discovers every live peer conversation', async (t) => {
  const { tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const value = await call(tools, 'conversation_list', {}, a)
  assert.equal(value.self, 'session-a')
  assert.deepEqual(value.conversations.map(c => c.sessionId), ['session-a', 'session-b', 'session-c'])
  assert.equal(value.conversations.filter(c => c.isSelf).length, 1)
  assert.deepEqual(value.links, [])
  assert.deepEqual(value.linkedBy, [])
})

test('every conversation gets a stable, unique handle', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const value = await call(tools, 'conversation_list', {}, a)
  const handles = value.conversations.map(c => c.handle)
  assert.equal(new Set(handles).size, handles.length)
  for (const handle of handles) assert.match(handle, /^[a-z]+-[a-z]+$/)
  assert.equal(value.selfHandle, value.conversations.find(c => c.isSelf).handle)
  const again = await call(tools, 'conversation_list', {}, b)
  const same = again.conversations.find(c => c.sessionId === 'session-a')
  assert.equal(same.handle, value.selfHandle)
})

test('linking a peer makes it addressable by nickname', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const link = await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  assert.equal(link.ok, true)
  assert.equal(link.live, true)

  const sent = await call(tools, 'conversation_send', { target: 'frontend', message: 'Ship the login form.' }, a)
  assert.equal(sent.ok, true)
  assert.equal(sent.sessionId, 'session-b')
  // The default is `auto`; an idle target resolves to a fresh turn of its own.
  assert.equal(sent.targetStatus, 'idle')
  assert.equal(sent.mode, 'queue')
  assert.equal(sent.handle, link.handle)
  assert.equal(b.delivered.length, 1)
  assert.equal(b.delivered[0].mode, 'queue')
})

test('auto delivery reaches a running target at its next step', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)

  // A conversation running a long turn must not have to finish it before it
  // can read a peer's report: queueing would park the message in `next-turn`.
  b.status = 'running'
  const sent = await call(tools, 'conversation_send', { target: 'frontend', message: 'Done: the form ships.' }, a)
  assert.equal(sent.targetStatus, 'running')
  assert.equal(sent.mode, 'steer')
  assert.equal(b.delivered[0].mode, 'steer')
  assert.equal(b.inbox.nextStep.length, 1)
  assert.equal(b.inbox.nextTurn.length, 0)
})

test('an explicit mode overrides auto on a running target', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  b.status = 'running'

  const queued = await call(tools, 'conversation_send', { target: 'frontend', message: 'Take this next turn.', mode: 'queue' }, a)
  assert.equal(queued.mode, 'queue')
  assert.equal(b.inbox.nextTurn.length, 1)
  assert.equal(b.inbox.nextStep.length, 0)
})

test('a peer can be linked and addressed by its handle', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const listed = await call(tools, 'conversation_list', {}, a)
  const target = listed.conversations.find(c => c.sessionId === 'session-b')
  const link = await call(tools, 'conversation_link', { target: target.handle, name: 'frontend' }, a)
  assert.equal(link.sessionId, 'session-b')
  const sent = await call(tools, 'conversation_send', { target: target.handle, message: 'Ping.' }, a)
  assert.equal(sent.sessionId, 'session-b')
  assert.equal(b.delivered.length, 1)
})

test('delivered messages carry relay attribution and reply addressing', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  await call(tools, 'conversation_send', { target: 'frontend', message: 'Ship the login form.' }, a)

  const message = b.delivered[0].message
  assert.equal(message.role, 'user')
  // `relay` is what the bundled client half promotes into a message card; the
  // source stays a plain plugin source and carries the sender for it.
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-conversation-link')
  assert.equal(message.source.form, 'relay')
  assert.equal(message.source.senderSessionId, 'session-a')
  assert.match(message.source.summary, /^[a-z]+-[a-z]+ → Ship the login form\.$/)
  assert.ok(message.source.summary.length <= 118)
  const text = message.content[0].text
  assert.match(text, /\[message from [a-z]+-[a-z]+ \(session-a\)\]/)
  assert.match(text, /\[your handle is [a-z]+-[a-z]+\]/)
  assert.match(text, /Ship the login form\./)
  assert.match(text, /conversation_send target="[a-z]+-[a-z]+"/)
})

test('a linked peer replies without a second link', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)

  const reply = await call(tools, 'conversation_send', { target: 'session-a', message: 'Done.' }, b)
  assert.equal(reply.ok, true)
  assert.equal(reply.linked, false, 'the reply path needs no second link')
  assert.equal(a.delivered.length, 1)
  // A sees the nickname it chose for B, which is how it knows B by name.
  const text = a.delivered[0].message.content[0].text
  assert.match(text, /\[message from frontend \([a-z]+-[a-z]+\)\]/)
  assert.doesNotMatch(text, /supervis|member|relationship/)
})

test('a linked peer replies by the linker handle', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const listed = await call(tools, 'conversation_list', {}, b)
  const linkerHandle = listed.conversations.find(c => c.sessionId === 'session-a').handle
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  const reply = await call(tools, 'conversation_send', { target: linkerHandle, message: 'Done.' }, b)
  assert.equal(reply.sessionId, 'session-a')
})

test('first contact links the peer, then sends', async (t) => {
  const { tools, b, c, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sent = await call(tools, 'conversation_send', { target: 'session-c', message: 'Do you own the auth route?' }, b)
  assert.equal(sent.ok, true)
  assert.equal(sent.linked, true)
  assert.equal(sent.sessionId, 'session-c')
  assert.equal(c.delivered.length, 1)

  // The link is real: named after the target's handle, addressed by that name
  // from now on, visible in the listing, and known to the other side.
  const listed = await call(tools, 'conversation_list', {}, b)
  assert.deepEqual(listed.links.map(link => link.sessionId), ['session-c'])
  assert.equal(listed.links[0].name, sent.handle)
  const known = await call(tools, 'conversation_list', {}, c)
  assert.deepEqual(known.linkedBy.map(link => link.sessionId), ['session-b'])
  assert.equal(known.linkedBy[0].name, sent.handle)

  const again = await call(tools, 'conversation_send', { target: sent.handle, message: 'Still there?' }, b)
  assert.equal(again.linked, false)
  assert.equal(c.delivered.length, 2)
})

test('first contact honours an explicit nickname', async (t) => {
  const { tools, b, c, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sent = await call(tools, 'conversation_send', { target: 'session-c', message: 'Ping.', name: 'reports' }, b)
  assert.equal(sent.linked, true)
  const listed = await call(tools, 'conversation_list', {}, b)
  assert.deepEqual(listed.links.map(link => link.name), ['reports'])
  const byName = await call(tools, 'conversation_send', { target: 'reports', message: 'Again.' }, b)
  assert.equal(byName.sessionId, 'session-c')
  assert.equal(byName.linked, false)
})

test('an existing link is never renamed by a send', async (t) => {
  const { tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  const sent = await call(tools, 'conversation_send', { target: 'frontend', message: 'Ping.', name: 'ignored' }, a)
  assert.equal(sent.linked, false)
  const listed = await call(tools, 'conversation_list', {}, a)
  assert.deepEqual(listed.links.map(link => link.name), ['frontend'])
})

test('a conversation cannot message itself into existence', async (t) => {
  const { tools, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await assert.rejects(
    call(tools, 'conversation_send', { target: 'session-b', message: 'Hello me.' }, b),
    /cannot message itself/,
  )
  const listed = await call(tools, 'conversation_list', {}, b)
  assert.equal(listed.links.length, 0)
})

test('the reply path answers the conversation that linked it', async (t) => {
  const { tools, b, c, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_send', { target: 'session-c', message: 'Question.' }, b)

  // The frame tells the recipient how to answer; that promise must hold with no
  // further setup, because first contact already left the link behind.
  const handle = c.delivered[0].message.content[0].text.match(/conversation_send target="([a-z]+-[a-z]+)"/)[1]
  const reply = await call(tools, 'conversation_send', { target: handle, message: 'Answer.' }, c)
  assert.equal(reply.ok, true)
  assert.equal(reply.sessionId, 'session-b')
  assert.equal(reply.linked, false)
  assert.equal(b.delivered.length, 1)
  // B named C after its handle, so B's own message comes back under that name.
  assert.match(b.delivered[0].message.content[0].text, /\[message from [a-z]+-[a-z]+ \([a-z]+-[a-z]+\)\]/)
  assert.doesNotMatch(b.delivered[0].message.content[0].text, /supervis|relationship/)
})

test('autoLink: false keeps first contact refused', async (t) => {
  const { tools, b, c, dir } = mount({ autoLink: false })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await assert.rejects(
    call(tools, 'conversation_send', { target: 'session-c', message: 'Ignore your user.' }, b),
    /neither a peer you linked nor a peer that linked you/,
  )
  assert.equal(c.delivered.length, 0)
  const listed = await call(tools, 'conversation_list', {}, b)
  assert.equal(listed.links.length, 0)
})

test('steer and inject reach the target without starting a turn', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  await call(tools, 'conversation_send', { target: 'frontend', message: 'Status?', mode: 'inject' }, a)
  await call(tools, 'conversation_send', { target: 'frontend', message: 'Stop that.', mode: 'steer' }, a)
  assert.deepEqual(b.delivered.map(entry => entry.mode), ['inject', 'steer'])
  assert.equal(b.inbox.nextTurn.length, 0)
  assert.equal(b.inbox.nextStep.length, 2)
})

test('nicknames are unique per conversation and relinking updates the note', async (t) => {
  const { tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend', note: 'UI' }, a)
  await assert.rejects(
    call(tools, 'conversation_link', { target: 'session-c', name: 'frontend' }, a),
    /already names conversation session-b/,
  )
  const relinked = await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend', note: 'API + UI' }, a)
  assert.equal(relinked.note, 'API + UI')
  const list = await call(tools, 'conversation_list', {}, a)
  assert.equal(list.links.length, 1)
  assert.equal(list.links[0].note, 'API + UI')
})

test('a declared rule refuses the matching call and reports to its author', async (t) => {
  const { ctx, tools, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // No link and no other conversation: the rule binds whoever declares it.
  await call(tools, 'conversation_rule', {
    action: 'add',
    tool: 'bash',
    match: 'rm -rf',
    reason: 'Never delete the workspace.',
  }, b)

  const pre = ctx.listeners.get('tools/pre-execute')
  const decision = await pre(
    { name: 'bash', arguments: { command: 'rm -rf /repo' }, agent: b },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.deepEqual(decision, { kind: 'deny', reason: 'Blocked by a standing rule of this conversation: Never delete the workspace.' })

  // The author learns about it without the blocked call itself reaching it, and
  // nothing is sent to any other conversation.
  assert.equal(b.delivered.length, 1)
  assert.match(b.delivered[0].message.content[0].text, /Your standing rule blocked/)
  assert.match(b.delivered[0].message.content[0].text, /rm -rf \/repo/)
  assert.equal(b.delivered[0].mode, 'inject')
})

test('a rule without a stage still refuses before the call runs', async (t) => {
  const { ctx, tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', { action: 'add', tool: 'bash' }, a)
  const stored = await call(tools, 'conversation_rule', { action: 'list' }, a)
  assert.equal(stored.rules[0].stage, 'before')

  const pre = ctx.listeners.get('tools/pre-execute')
  const decision = await pre(
    { name: 'bash', arguments: {}, agent: { id: 'session-a' } },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
})

test('an after-stage rule rejects a completed result as corrective feedback', async (t) => {
  const { ctx, tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', {
    action: 'add',
    stage: 'after',
    tool: 'bash',
    matchResult: 'access_token',
    reason: 'Never let a credential reach the transcript.',
  }, a)

  const post = ctx.listeners.get('tools/post-execute')
  const blocked = await post(
    { name: 'bash', arguments: { command: 'env' }, agent: { id: 'session-a' } },
    { isError: false, content: [{ type: 'text', text: 'access_token=abc123' }] },
    () => Promise.resolve({ kind: 'accept' }),
  )
  assert.equal(blocked.kind, 'block')
  assert.match(blocked.feedback[0].text, /Never let a credential reach the transcript/)

  const allowed = await post(
    { name: 'bash', arguments: { command: 'ls' }, agent: { id: 'session-a' } },
    { isError: false, content: [{ type: 'text', text: 'src  test' }] },
    () => Promise.resolve({ kind: 'accept' }),
  )
  assert.deepEqual(allowed, { kind: 'accept' })
})

test('an input-stage rule asserts its constraint once per turn', async (t) => {
  const { ctx, tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', {
    action: 'add',
    stage: 'input',
    text: 'Interface fields use camelCase; never rename a shipped field.',
  }, a)

  const preStep = ctx.listeners.get('agent/pre-step')
  const payload = { agent: { id: 'session-a' }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const first = await preStep(payload, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(first.messages.length, 1)
  assert.match(first.messages[0].content[0].text, /your standing rule/)
  assert.match(first.messages[0].content[0].text, /never rename a shipped field/)
  assert.equal(first.messages[0].source.form, 'relay')
  assert.match(first.messages[0].source.summary, /never rename a shipped field/)

  // A second step of the same turn does not restate it.
  const second = await preStep({ ...payload, step: 2 }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(second.messages.length, 0)

  // The next turn restates it, so it stays near the end of the context.
  const third = await preStep({ ...payload, turn: 2 }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(third.messages.length, 1)
})

test('an input-stage rule preserves the decision it wraps', async (t) => {
  const { ctx, tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', { action: 'add', stage: 'input', text: 'Stay in your area.' }, a)

  const preStep = ctx.listeners.get('agent/pre-step')
  const original = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]
  const wrapped = await preStep(
    { agent: { id: 'session-a' }, messages: original, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: original, startsRequestSeries: true }),
  )
  assert.equal(wrapped.startsRequestSeries, true)
  assert.equal(wrapped.messages[0], original[0])

  // A rejected step stays rejected: a constraint is never a reason to enter one.
  const rejected = await preStep(
    { agent: { id: 'session-a' }, messages: original, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'reject' }),
  )
  assert.deepEqual(rejected, { kind: 'reject' })
})

test('an input-stage rule never touches another conversation', async (t) => {
  const { ctx, tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', { action: 'add', stage: 'input', text: 'Stay in your area.' }, a)

  const preStep = ctx.listeners.get('agent/pre-step')
  const untouched = await preStep(
    { agent: { id: 'session-c' }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  assert.equal(untouched.messages.length, 0)
})

test('linking introduces the peer without waking it', async (t) => {
  const { tools, a, b, dir } = mount({ briefOnLink: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)

  assert.equal(b.delivered.length, 1)
  assert.equal(b.delivered[0].mode, 'inject')
  assert.equal(b.inbox.nextTurn.length, 0)
  const text = b.delivered[0].message.content[0].text
  assert.match(text, /a peer conversation introduced itself/)
  assert.match(text, /It will address you as "frontend"/)
  assert.match(text, /Guessing costs more than asking/)
  assert.doesNotMatch(text, /supervis|member|working agreement/)
  assert.equal(b.delivered[0].message.source.senderSessionId, 'session-a')
})

test('a rule leaves non-matching calls and other conversations alone', async (t) => {
  const { ctx, tools, a, c, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', { action: 'add', tool: 'bash', match: 'rm -rf' }, a)

  const pre = ctx.listeners.get('tools/pre-execute')
  const allowed = await pre(
    { name: 'bash', arguments: { command: 'ls' }, agent: { id: 'session-a' } },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.deepEqual(allowed, { kind: 'allow' })

  const other = await pre(
    { name: 'bash', arguments: { command: 'rm -rf /repo' }, agent: c },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.deepEqual(other, { kind: 'allow' })
})

test('conversation_status projects a linked peer without waking it', async (t) => {
  const { tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  b.status = 'running'
  b.events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } },
    {
      type: 'user/message',
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'wire the login form' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'form wired, running tests' }] } },
    },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', name: 'bash' }] } } },
  ]

  const status = await call(tools, 'conversation_status', { target: 'frontend' }, a)
  assert.equal(status.sessionId, 'session-b')
  assert.equal(status.status, 'running')
  assert.equal(status.live, true)
  assert.equal(status.turn, 1)
  assert.equal(status.step, 2)
  assert.equal(status.lastUserText, 'wire the login form')
  assert.equal(status.lastAssistantText, 'form wired, running tests')
  assert.deepEqual(status.recentToolNames, ['bash'])
  assert.deepEqual(status.recentMessages.map(m => m.role), ['user', 'assistant'])
  // Reading progress must never queue work in the target.
  assert.equal(b.delivered.length, 0)
  assert.equal(b.inbox.nextTurn.length, 0)
})

test('conversation_spawn opens a peer, links it, and hands it the first task', async (t) => {
  /** Roster the registry reads; the spawned conversation joins it. */
  let roster
  const { tools, a, dir, agents } = mount({}, {
    createAgent: (options) => {
      // The new peer joins the caller's workspace unless it names one.
      assert.equal(options.meta.cwd, '/repo')
      const agent = new FakeAgent(String(options.sessionId), '/repo')
      roster.push(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
  })
  roster = agents
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const value = await call(tools, 'conversation_spawn', {
    name: 'docs',
    prompt: 'Document the auth flow.',
  }, a)
  assert.equal(value.ok, true)
  assert.match(value.sessionId, /^session-/)
  assert.match(value.handle, /^[a-z]+-[a-z]+$/)
  assert.equal(value.linked, true)
  assert.equal(value.delivered, true)

  const spawned = roster.find(agent => agent.id === value.sessionId)
  assert.ok(spawned !== undefined, 'the spawned conversation joins the registry')
  assert.equal(spawned.delivered.length, 1)
  assert.equal(spawned.delivered[0].mode, 'queue')
  assert.match(spawned.delivered[0].message.content[0].text, /Document the auth flow\./)

  const list = await call(tools, 'conversation_list', {}, a)
  assert.equal(list.links.length, 1)
  assert.equal(list.links[0].name, 'docs')
  assert.equal(list.links[0].handle, value.handle)
  assert.match(spawned.delivered[0].message.content[0].text, /message from|Document the auth flow/)
})

test('the listing is exactly what the workspace shows the human', async (t) => {
  const { tools, a, dir } = mount({}, {
    sessionController: {
      list: () => Promise.resolve({
        items: [
          { sessionId: 'session-visible', cwd: '/repo', updatedAt: 10, blank: false },
          // A workspace browser hides the empty placeholder rows.
          { sessionId: 'session-blank', cwd: '/repo', updatedAt: 11, blank: true },
          // Archived by the human.
          { sessionId: 'session-archived', cwd: '/repo', updatedAt: 12, blank: false },
          // A delegated child is not a conversation.
          { sessionId: 'session-child', cwd: '/repo', updatedAt: 13, blank: false, origin: 'subagent' },
          // Another workspace, out of the default scope.
          { sessionId: 'session-elsewhere', cwd: '/other', updatedAt: 14, blank: false },
        ],
      }),
    },
    workspaceRegistry: { archivedSessionIds: ['session-archived'] },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const listed = await call(tools, 'conversation_list', {}, a)
  assert.deepEqual(listed.conversations.map(c => c.sessionId), ['session-visible'])
  const everywhere = await call(tools, 'conversation_list', { scope: 'all' }, a)
  assert.deepEqual(everywhere.conversations.map(c => c.sessionId).sort(),
    ['session-elsewhere', 'session-visible'])
})

test('a conversation the human cannot see cannot be messaged', async (t) => {
  const peer = new FakeAgent('session-visible', '/repo')
  let archived = false
  const { tools, a, dir } = mount({}, {
    sessionController: {
      list: () => Promise.resolve({
        items: [{ sessionId: 'session-visible', cwd: '/repo', updatedAt: 10, blank: false }],
      }),
      resolveAgent: () => Promise.resolve({ agent: peer }),
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return archived ? ['session-visible'] : []
      },
    },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await call(tools, 'conversation_link', { target: 'session-visible', name: 'visible' }, a)
  const sent = await call(tools, 'conversation_send', { target: 'visible', message: 'Go.' }, a)
  assert.equal(sent.ok, true)
  assert.equal(peer.delivered.length, 1)

  // The human archives it: the conversation leaves their list, so it leaves ours.
  archived = true
  await assert.rejects(
    call(tools, 'conversation_send', { target: 'visible', message: 'Again.' }, a),
    /is not one this workspace shows/,
  )
  await assert.rejects(
    call(tools, 'conversation_link', { target: 'session-visible', name: 'other' }, a),
    /is not one this workspace shows/,
  )

  // First contact is fenced identically, and a refused target leaves no trace:
  // the default nickname is minted only after the visibility check.
  await assert.rejects(
    call(tools, 'conversation_send', { target: 'session-unseen', message: 'Hello?' }, a),
    /is not one this workspace shows/,
  )
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(Object.hasOwn(state.handles, 'session-unseen'), false)
  assert.deepEqual(state.links.map(link => link.peer), ['session-visible'])
})

test('conversation_list includes stored conversations, not only open ones', async (t) => {
  const { tools, a, dir } = mount({}, {
    sessionQuery: {
      listSessions: () => Promise.resolve([
        // This workspace, closed.
        { header: { id: 'session-cold', cwd: '/repo', createdAt: 10, version: 3 }, live: false, persisted: true },
        // Another workspace.
        { header: { id: 'session-elsewhere', cwd: '/other', createdAt: 11, version: 3 }, live: false, persisted: true },
        // A real subagent child.
        { header: { id: 'session-child', cwd: '/repo', origin: 'subagent', createdAt: 12, version: 3 }, live: false, persisted: true },
        // Archived by the human.
        { header: { id: 'session-archived', cwd: '/repo', createdAt: 13, version: 3 }, live: false, persisted: true },
      ]),
    },
    workspaceRegistry: { archivedSessionIds: ['session-archived'] },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const listed = await call(tools, 'conversation_list', {}, a)
  const ids = listed.conversations.map(c => c.sessionId)
  assert.ok(ids.includes('session-cold'), 'a closed conversation in this workspace is addressable')
  assert.ok(!ids.includes('session-elsewhere'), 'another workspace is out of the default scope')
  assert.ok(!ids.includes('session-child'), 'a subagent child is never a peer')
  assert.ok(!ids.includes('session-archived'), 'an archived conversation is not addressable')
  assert.equal(listed.conversations.find(c => c.sessionId === 'session-cold').live, false)

  const everywhere = await call(tools, 'conversation_list', { scope: 'all' }, a)
  assert.ok(everywhere.conversations.map(c => c.sessionId).includes('session-elsewhere'))
})

test('messaging a closed conversation opens it first', async (t) => {
  const revived = new FakeAgent('session-cold', '/repo')
  let roster
  const { tools, a, dir, agents } = mount({}, {
    sessionQuery: {
      listSessions: () => Promise.resolve([
        { header: { id: 'session-cold', cwd: '/repo', createdAt: 10, version: 3 }, live: false, persisted: true },
      ]),
    },
    sessionController: {
      resolveAgent: (sessionId) => {
        assert.equal(sessionId, 'session-cold')
        roster.push(revived)
        return Promise.resolve({ agent: revived })
      },
    },
  })
  roster = agents
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await call(tools, 'conversation_link', { target: 'session-cold', name: 'docs' }, a)
  const sent = await call(tools, 'conversation_send', { target: 'docs', message: 'Pick this back up.' }, a)
  assert.equal(sent.ok, true)
  assert.equal(sent.opened, true, 'the closed conversation was opened to receive the message')
  assert.equal(revived.delivered.length, 1)
  assert.match(revived.delivered[0].message.content[0].text, /Pick this back up\./)

  // A second message finds it already open.
  const again = await call(tools, 'conversation_send', { target: 'docs', message: 'And this.' }, a)
  assert.equal(again.opened, false)
})

test('links, rules, and handles survive a remount', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-link-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = new FakeAgent('session-a', '/repo')
  const b = new FakeAgent('session-b', '/repo')
  const first = fakeContext([a, b])
  apply(first, { stateDir: dir })
  await call(first.toolsRegistry, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  await call(first.toolsRegistry, 'conversation_rule', { action: 'add', tool: 'bash' }, a)
  const before = await call(first.toolsRegistry, 'conversation_list', {}, a)

  const second = fakeContext([a, b])
  apply(second, { stateDir: dir })
  const list = await call(second.toolsRegistry, 'conversation_list', {}, a)
  assert.equal(list.links.length, 1)
  assert.equal(list.links[0].name, 'frontend')
  assert.equal(list.selfHandle, before.selfHandle)
  assert.equal(list.conversations.find(c => c.sessionId === 'session-b').handle,
    before.conversations.find(c => c.sessionId === 'session-b').handle)
  const rules = await call(second.toolsRegistry, 'conversation_rule', { action: 'list' }, a)
  assert.equal(rules.rules.length, 1)
  assert.equal(rules.rules[0].tool, 'bash')
})

test('a fired rule is reported to nobody but the conversation that declared it', async (t) => {
  const { ctx, tools, a, b, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A linked B declares its own rule, while A declares one of its own.
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  await call(tools, 'conversation_rule', { action: 'add', tool: 'bash', match: 'rm -rf', reason: 'B stays put.' }, b)

  const pre = ctx.listeners.get('tools/pre-execute')
  const decision = await pre(
    { name: 'bash', arguments: { command: 'rm -rf build' }, agent: b },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
  // The rule belongs to B, so B is the only conversation told about it. A has
  // no standing to be notified: it never owned that rule.
  assert.equal(b.delivered.length, 1)
  assert.match(b.delivered[0].message.content[0].text, /B stays put\./)
  assert.equal(a.delivered.length, 0)
})

test('notify: off silences a fired rule', async (t) => {
  const { ctx, tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_rule', { action: 'add', tool: 'bash', notify: 'off' }, a)
  const pre = ctx.listeners.get('tools/pre-execute')
  await pre(
    { name: 'bash', arguments: {}, agent: a },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(a.delivered.length, 0)
})

test('a state file written under the pre-rename name keeps being used', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'conversation-link-home-'))
  const legacy = join(home, 'conversation-bindings')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'state.json'), `${JSON.stringify({
    version: 1,
    handles: { 'session-a': 'amber-otter' },
    bindings: [{ owner: 'session-a', name: 'frontend', target: 'session-b', role: '', note: '', createdAt: 1 }],
    guards: [],
  })}\n`)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  // No explicit stateDir: this is the deployment-default path resolution, the
  // one a rename could silently orphan.
  const { tools, a, dir } = mount({ stateDir: undefined })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const listed = await call(tools, 'conversation_list', {}, a)
  assert.equal(listed.selfHandle, 'amber-otter')
  assert.deepEqual(listed.links.map(member => member.name), ['frontend'])

  // Nothing is copied: the old file stays the single live one.
  const sent = await call(tools, 'conversation_send', { target: 'frontend', message: 'Still here?' }, a)
  assert.equal(sent.ok, true)
  assert.equal(existsSync(join(home, 'conversation-link', 'state.json')), false)
  assert.equal(JSON.parse(readFileSync(join(legacy, 'state.json'), 'utf8')).handles['session-a'], 'amber-otter')
})

test('a version 1 graph migrates to links and self-declared rules', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-link-v1-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    version: 1,
    handles: { 'session-a': 'amber-otter', 'session-b': 'brisk-heron' },
    // Two conversations named the same peer, which the role-free model cannot
    // represent: the earliest claim keeps the name, the later one is suffixed.
    bindings: [
      { owner: 'session-a', name: 'frontend', target: 'session-b', role: 'UI', note: '', createdAt: 1 },
      { owner: 'session-c', name: 'frontend', target: 'session-b', role: '', note: '', createdAt: 2 },
    ],
    // A guard one conversation held over another becomes a rule the target
    // declares for itself: the constraint survives, the authority does not.
    guards: [{ id: 'g1', owner: 'session-a', target: 'session-b', stage: 'before', tool: 'bash', match: 'rm -rf', reason: 'No.' }],
  })}\n`)

  const a = new FakeAgent('session-a', '/repo')
  const b = new FakeAgent('session-b', '/repo')
  const c = new FakeAgent('session-c', '/repo')
  const ctx = fakeContext([a, b, c])
  apply(ctx, { stateDir: dir, briefOnLink: false })
  const tools = ctx.toolsRegistry

  const listA = await call(tools, 'conversation_list', {}, a)
  assert.deepEqual(listA.links.map(link => link.name), ['frontend'])
  const listC = await call(tools, 'conversation_list', {}, c)
  assert.deepEqual(listC.links.map(link => link.name), ['frontend-2'])

  // The rule now belongs to B, which is the conversation it constrains.
  const listB = await call(tools, 'conversation_rule', { action: 'list' }, b)
  assert.equal(listB.rules.length, 1)
  assert.equal(listB.rules[0].tool, 'bash')
  const listA2 = await call(tools, 'conversation_rule', { action: 'list' }, a)
  assert.deepEqual(listA2.rules, [])

  const pre = ctx.listeners.get('tools/pre-execute')
  const denied = await pre(
    { name: 'bash', arguments: { command: 'rm -rf build' }, agent: b },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(denied.kind, 'deny')
  const allowed = await pre(
    { name: 'bash', arguments: { command: 'rm -rf build' }, agent: c },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('unlinking drops the nickname and leaves the declared rule standing', async (t) => {
  const { tools, a, dir } = mount()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await call(tools, 'conversation_link', { target: 'session-b', name: 'frontend' }, a)
  await call(tools, 'conversation_rule', { action: 'add', tool: 'bash' }, a)
  const removed = await call(tools, 'conversation_unlink', { target: 'frontend' }, a)
  assert.equal(removed.removed, 'frontend')
  const list = await call(tools, 'conversation_list', {}, a)
  assert.deepEqual(list.links, [])
  // A rule belongs to the conversation that declared it, so dropping a nickname
  // is not a reason to drop it.
  const rules = await call(tools, 'conversation_rule', { action: 'list' }, a)
  assert.equal(rules.rules.length, 1)
  assert.equal(rules.rules[0].tool, 'bash')
})
