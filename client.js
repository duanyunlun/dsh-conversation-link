/**
 * `dsh-conversation-bindings` browser half.
 *
 * A cross-conversation message is durable the moment the host half delivers it,
 * but the transcript renders every message whose `source.kind` is not `user` as
 * a **collapsed context row**: a disclosure header reading
 * "context injection · <producer>", with the text hidden until someone clicks.
 * A supervisor's conversation is unreadable that way, so this half promotes its
 * own rows into message cards.
 *
 * It is a presentation layer over the rendered transcript, not a new node kind.
 * That is forced, not chosen: the built-in `input-message` Definition matches
 * every `user/message` and cannot be replaced (the Definition registry throws on
 * a duplicate kind), and a lower-priority slot registration cannot delegate a
 * non-matching node back to the renderer it shadows — the built-in context body
 * is not reachable from a plugin. So this half identifies its own rows by the
 * producer label the Harness already renders, expands them, hides the disclosure
 * header, and restyles the body as a card with a clickable sender.
 *
 * The cost is a dependency on those rendered markers (`data-disclosure-row`,
 * `data-context-form`, `data-context-source`, `data-context-relay-sender`). If a
 * Harness upgrade changes them, the plugin degrades to what the host half alone
 * can show — set `messageForm: notice` on the host row to fall back to a
 * readable one-line summary instead.
 *
 * This file is the loader's closure-factory artifact by hand, so the package
 * needs no client build step: it registers a factory on the page's module queue
 * and resolves React through the module table the shell seeds.
 */

window.__ModuleLoader__.load({
	id: 'dsh-conversation-bindings',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		/** The `source.plugin` value that identifies this plugin's rows. */
		const SOURCE_LABEL = 'dsh-conversation-bindings'

		/** Marks the wrapper whose disclosure header this half hides. */
		const CARD_ATTR = 'data-cb-peer-card'

		/** Marks the sender element this half made clickable. */
		const LINK_CLASS = 'cb-peer-link'

		/** Session ids look like `session-<uuid>`; the relay body renders the raw id. */
		const SESSION_PATTERN = /session-[A-Za-z0-9][A-Za-z0-9-]{7,}/

		/** One card: a bubble with the sender's title as its header. */
		const CSS = [
			'[' + CARD_ATTR + '] > [data-disclosure-row] { display: none !important; }',
			'[' + CARD_ATTR + '] [data-context-form="relay"] {',
			'  width: fit-content; max-width: min(78%, 760px); max-height: none;',
			'  margin: 0; padding: 12px 16px; overflow: visible;',
			'  border: 1px solid rgba(127,127,127,.24);',
			'  border-radius: 16px 16px 16px 4px;',
			'  background: var(--dsw-alias-markdown-code-block);',
			'  color: var(--dsw-alias-label-primary); font: inherit;',
			'}',
			'[' + CARD_ATTR + '] [data-context-relay-sender] {',
			'  display: block; width: fit-content; margin: 0 0 8px;',
			'  color: var(--dsw-alias-state-business-primary);',
			'  font-size: 13px; font-weight: 600; line-height: 1.5;',
			'}',
			'.' + LINK_CLASS + ' { cursor: pointer; }',
			'.' + LINK_CLASS + ':hover { text-decoration: underline; text-underline-offset: 3px; }',
			'.' + LINK_CLASS + ':focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 2px; }',
		].join('\n')

		/**
		 * Read the session id a relay row names, from the id the Harness already
		 * rendered or from this plugin's own message header.
		 * @param {Element} body - the rendered relay body.
		 * @returns {string|null} the sender session id.
		 */
		function senderSessionId(body) {
			const sender = body.querySelector('[data-context-relay-sender]')
			const fromSender = String(sender === null ? '' : sender.textContent || '').match(SESSION_PATTERN)
			if (fromSender !== null) return fromSender[0]
			const text = body.querySelector('[data-context-text]')
			const fromBody = String(text === null ? '' : text.textContent || '').match(SESSION_PATTERN)
			return fromBody === null ? null : fromBody[0]
		}

		/** The human-facing title of one conversation, falling back to its id. */
		function sessionTitle(ctx, sessionId) {
			const list = ctx.sessions === undefined ? undefined : ctx.sessions.list
			const row = list === undefined ? undefined : list.getSnapshot().byId[sessionId]
			const title = row === undefined ? undefined : row.displayTitle
			return typeof title === 'string' && title.length > 0 ? title : sessionId
		}

		/**
		 * Every descendant of `root` carrying `attribute`, plus `root` itself.
		 * @param {Element} root - subtree to search.
		 * @param {string} attribute - attribute selector.
		 * @returns {Element[]} the matching elements.
		 */
		function collect(root, attribute) {
			const found = Array.from(root.querySelectorAll(attribute))
			return root.matches(attribute) ? [root].concat(found) : found
		}

		/**
		 * Register this half against the browser context.
		 * @param {object} ctx - browser Cordis context carrying `sessions`.
		 */
		function apply(ctx) {
			/** Sender elements this half rewrote, so titles refresh in place. */
			const linked = new Set()

			/** Rows whose disclosure this half asked to open, awaiting their body. */
			const pending = new Set()

			/**
			 * Rewrite one relay sender element into the sending conversation's
			 * title, linked to opening it.
			 * @param {Element} body - the rendered relay body.
			 */
			function linkSender(body) {
				const element = body.querySelector('[data-context-relay-sender]')
				if (element === null) return
				const sessionId = senderSessionId(body)
				if (sessionId === null) return
				if (element.dataset.cbOriginalText === undefined) {
					element.dataset.cbOriginalText = element.textContent || ''
				}
				element.dataset.cbSession = sessionId
				element.textContent = sessionTitle(ctx, sessionId)
				element.classList.add(LINK_CLASS)
				element.setAttribute('role', 'link')
				element.setAttribute('tabindex', '0')
				element.setAttribute('title', sessionId)
				linked.add(element)
			}

			/**
			 * Turn one of this plugin's rows into a card, if its body is rendered.
			 * @param {Element} wrapper - the disclosure container holding header and body.
			 * @returns {boolean} whether the card was adopted.
			 */
			function adopt(wrapper) {
				const body = wrapper.querySelector('[data-context-form="relay"]')
				if (body === null) return false
				wrapper.setAttribute(CARD_ATTR, 'true')
				linkSender(body)
				return true
			}

			/**
			 * Promote every one of this plugin's rows inside one subtree.
			 *
			 * Expansion is asynchronous, and the disclosure renders its body only
			 * once open — as a *sibling* of the header that carries the label this
			 * half matches on. A later scan of that added body alone would therefore
			 * never see the row again, so requesting an expansion records the row
			 * and {@link drainPending} finishes it once the body exists.
			 * @param {Node} root - a node the transcript just added.
			 */
			function prepare(root) {
				if (!(root instanceof Element)) return
				for (const label of collect(root, '[data-context-source]')) {
					if (String(label.textContent || '').trim() !== SOURCE_LABEL) continue
					const header = label.closest('[data-disclosure-row]')
					const wrapper = header === null ? null : header.parentElement
					if (wrapper === null) continue
					if (adopt(wrapper)) continue
					if (pending.has(wrapper)) continue
					pending.add(wrapper)
					if (header.getAttribute('aria-expanded') !== 'true') header.click()
				}
			}

			/** Finish the rows this half asked to open, once their body exists. */
			function drainPending() {
				for (const wrapper of [...pending]) {
					if (!wrapper.isConnected) {
						pending.delete(wrapper)
						continue
					}
					if (adopt(wrapper)) pending.delete(wrapper)
				}
			}

			/** Re-resolve every linked sender against the current session list. */
			function refreshTitles() {
				for (const element of linked) {
					if (!element.isConnected) {
						linked.delete(element)
						continue
					}
					const sessionId = element.dataset.cbSession
					if (sessionId !== undefined) element.textContent = sessionTitle(ctx, sessionId)
				}
			}

			/** Follow one sender link to the conversation that sent the message. */
			function openSender(event) {
				const target = event.target instanceof Element ? event.target.closest('.' + LINK_CLASS) : null
				if (target === null) return
				const sessionId = target.dataset.cbSession
				if (sessionId === undefined) return
				event.preventDefault()
				ctx.sessions.open(sessionId)
			}

			/** Keyboard activation for the sender links, which are not buttons. */
			function onKeyDown(event) {
				if (event.key !== 'Enter' && event.key !== ' ') return
				openSender(event)
			}

			const style = document.createElement('style')
			style.setAttribute('data-plugin', SOURCE_LABEL)
			style.textContent = CSS
			document.head.appendChild(style)

			prepare(document.body)
			const observer = new MutationObserver((records) => {
				for (const record of records) record.addedNodes.forEach(prepare)
				drainPending()
			})
			observer.observe(document.body, { childList: true, subtree: true })

			const unsubscribe = ctx.sessions.list.subscribe(refreshTitles)
			document.addEventListener('click', openSender)
			document.addEventListener('keydown', onKeyDown)

			ctx.effect(() => () => {
				observer.disconnect()
				unsubscribe()
				document.removeEventListener('click', openSender)
				document.removeEventListener('keydown', onKeyDown)
				linked.clear()
				pending.clear()
				style.remove()
			})
		}

		exports.name = 'conversation-bindings'
		exports.inject = ['sessions']
		exports.apply = apply
		return module.exports
	},
})
