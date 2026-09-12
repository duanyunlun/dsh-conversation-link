/**
 * Wiring and DOM tests for the browser half of dsh-conversation-bindings.
 *
 * The half is a loader closure-factory artifact that promotes this plugin's
 * transcript rows into message cards by touching rendered markup. Two failure
 * modes only a browser would otherwise reveal are covered here: a malformed
 * factory face (the plugin silently never applies), and the two-phase expansion
 * — the disclosure renders its body only after a click, and that body is a
 * sibling of the label the half matches on, so scanning added nodes alone never
 * finishes the card.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Selector support limited to the forms the browser half actually uses. */
function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1))
  const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (attribute === null) throw new Error(`fake DOM: unsupported selector ${selector}`)
  const required = attribute[1]
  const value = attribute[2]
  if (!Object.hasOwn(element.attributes, required)) return false
  return value === undefined || element.attributes[required] === value
}

/** Minimal element tree with the traversal the browser half relies on. */
class FakeElement {
  constructor(tag = 'div', attributes = {}) {
    this.tagName = tag.toUpperCase()
    this.attributes = { ...attributes }
    this.children = []
    this.parentElement = null
    this.dataset = {}
    this.textContent = ''
    this.clicked = 0
    this.onClick = null
    const classes = new Set()
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  remove() {
    this.removed = true
  }

  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()])
  }

  matches(selector) {
    return matchesSelector(this, selector)
  }

  querySelectorAll(selector) {
    return this.descendants().filter(node => matchesSelector(node, selector))
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (matchesSelector(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  click() {
    this.clicked += 1
    if (this.onClick !== null) this.onClick()
  }

  get isConnected() {
    return this.removed !== true
  }
}

/** Load the browser half against fresh stubs and return what it registered. */
async function loadClientHalf() {
  const registrations = []
  const observed = []
  const listeners = []
  const effects = []
  const subscribers = []
  const head = new FakeElement('head')
  const body = new FakeElement('body')

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
    }

    observe(target, options) {
      observed.push({ observer: this, target, options })
    }

    disconnect() {
      this.disconnected = true
    }

    /** Deliver records the way the browser would after a DOM change. */
    emit(records) {
      this.callback(records)
    }
  }

  // The stubs stay installed for the whole test: `apply` runs after this helper
  // returns, and it touches the document again.
  Object.assign(globalThis, {
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    document: {
      head,
      body,
      createElement: tag => new FakeElement(tag),
      addEventListener: (type, handler) => listeners.push({ type, handler }),
      removeEventListener: () => {},
    },
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
  })

  await import(`../client.js?fresh=${String(Math.random())}`)

  const registration = registrations[0]
  assert.ok(registration !== undefined, 'the half registers on the module loader')
  const moduleExports = registration.factory(() => {
    throw new Error('the browser half must not require anything beyond the baseline')
  })

  const opened = []
  const ctx = {
    sessions: {
      open: id => opened.push(id),
      list: {
        getSnapshot: () => ({
          byId: { 'session-afbe616a-5e53-499a-88fe-4272445a6a57': { displayTitle: 'Sender conversation' } },
          ids: [],
          current: undefined,
          phase: 'ready',
        }),
        subscribe: (listener) => {
          subscribers.push(listener)
          return () => subscribers.splice(subscribers.indexOf(listener), 1)
        },
      },
    },
    effect: (factory) => {
      effects.push(factory())
    },
  }

  return { registration, exports: moduleExports, ctx, head, body, observed, listeners, effects, subscribers, opened }
}

/**
 * Build one collapsed row of this plugin, plus the callback that plays React's
 * part: clicking the header records an expansion that a later render performs,
 * exactly as the browser defers it.
 */
function collapsedRow({ source = 'dsh-conversation-bindings', senderId = 'session-afbe616a-5e53-499a-88fe-4272445a6a57' } = {}) {
  const wrapper = new FakeElement('div', { 'data-open': '' })
  const header = new FakeElement('div', { 'data-disclosure-row': '', 'aria-expanded': 'false' })
  const label = new FakeElement('span', { 'data-context-source': '' })
  label.textContent = source
  header.append(label)
  wrapper.append(header)
  globalThis.document.body.append(wrapper)

  const records = []
  let renderBody = null
  header.onClick = () => {
    header.setAttribute('aria-expanded', 'true')
    renderBody = () => {
      const body = new FakeElement('div', { 'data-context-injection-body': '', 'data-context-form': 'relay' })
      const sender = new FakeElement('p', { 'data-context-relay-sender': '' })
      sender.textContent = `From session ${senderId}`
      const text = new FakeElement('div', { 'data-context-text': '' })
      text.textContent = 'the delivered message'
      body.append(sender, text)
      wrapper.append(body)
      records.push({ addedNodes: [body] })
    }
  }
  return {
    wrapper,
    header,
    records,
    /** Perform the render the click asked for. */
    expand() {
      if (renderBody !== null) renderBody()
      return records
    },
  }
}

test('the browser half registers under the package id', async () => {
  const { registration, exports } = await loadClientHalf()
  assert.equal(registration.id, 'dsh-conversation-bindings')
  assert.equal(exports.name, 'conversation-bindings')
  assert.deepEqual(exports.inject, ['sessions'])
  assert.equal(typeof exports.apply, 'function')
})

test('applying the half injects its styles and watches the transcript', async () => {
  const { exports, ctx, head, observed, listeners } = await loadClientHalf()
  exports.apply(ctx)

  const style = head.children[0]
  assert.ok(style !== undefined, 'one style element is injected')
  assert.equal(style.getAttribute('data-plugin'), 'dsh-conversation-bindings')
  assert.match(style.textContent, /data-cb-peer-card/)
  assert.equal(observed.length, 1, 'the transcript is observed for added rows')
  assert.equal(observed[0].options.subtree, true)
  assert.deepEqual(listeners.map(entry => entry.type).sort(), ['click', 'keydown'])
})

test('a collapsed row is opened, then promoted to a card with a linked sender', async () => {
  const { exports, ctx, observed, listeners, opened } = await loadClientHalf()
  exports.apply(ctx)
  const row = collapsedRow()
  const { wrapper, header } = row

  // The row arrives after the half applied, exactly as a transcript update would.
  observed[0].observer.emit([{ addedNodes: [wrapper] }])
  assert.equal(header.clicked, 1, 'the collapsed disclosure is asked to open')
  assert.equal(wrapper.getAttribute('data-cb-peer-card'), null, 'a collapsed row is not a card yet')

  // React answers that click by rendering the body, which is a sibling of the
  // label — the half must still finish the row.
  observed[0].observer.emit(row.expand())
  assert.equal(wrapper.getAttribute('data-cb-peer-card'), 'true')
  const sender = wrapper.querySelector('[data-context-relay-sender]')
  assert.equal(sender.textContent, 'Sender conversation', 'the sender reads as the conversation title')
  assert.equal(sender.getAttribute('role'), 'link')
  assert.equal(sender.dataset.cbSession, 'session-afbe616a-5e53-499a-88fe-4272445a6a57')

  // Activating the link opens the sending conversation.
  const click = listeners.find(entry => entry.type === 'click')
  click.handler({ target: sender, preventDefault: () => {} })
  assert.deepEqual(opened, ['session-afbe616a-5e53-499a-88fe-4272445a6a57'])
})

test('an already open row is promoted without clicking', async () => {
  const { exports, ctx, observed } = await loadClientHalf()
  exports.apply(ctx)
  const row = collapsedRow()
  // The user already expanded this row: its body is rendered when the half sees it.
  row.header.setAttribute('aria-expanded', 'true')
  row.header.onClick()
  row.expand()

  observed[0].observer.emit([{ addedNodes: [row.wrapper] }])
  assert.equal(row.header.clicked, 0, 'nothing to expand')
  assert.equal(row.wrapper.getAttribute('data-cb-peer-card'), 'true')
  assert.equal(row.records.length, 1)
})

test('another producer\'s row is left alone', async () => {
  const { exports, ctx, observed } = await loadClientHalf()
  exports.apply(ctx)
  const { wrapper, header } = collapsedRow({ source: 'agent-message' })

  observed[0].observer.emit([{ addedNodes: [wrapper] }])
  assert.equal(header.clicked, 0)
  assert.equal(wrapper.getAttribute('data-cb-peer-card'), null)
})

test('disposal detaches every listener and the observer', async () => {
  const { exports, ctx, observed, subscribers, effects } = await loadClientHalf()
  exports.apply(ctx)
  assert.equal(subscribers.length, 1, 'sender titles refresh when the session list changes')
  assert.equal(effects.length, 1)

  effects[0]()
  assert.equal(observed[0].observer.disconnected, true)
  assert.equal(subscribers.length, 0, 'the session subscription is released')
})
