# dsh-conversation-link

[中文](README.md) | English

> Peer communication, progress checks, and standing rules **between conversations** inside one DeepSeek Harness process.

**Let your conversations talk to each other.** Conversations inside one dsh process can discover each other, send messages directly, watch progress, and set rules for themselves — no link step first, and no subagent layer in between.

DeepSeek Harness keeps every conversation it has opened alive in one process, and any plugin can already address any live agent — but the only cross-conversation path it ships is parent → subagent. This plugin adds the horizontal one: a coordinating conversation discovers its peers, registers them as named links, exchanges messages both ways, watches progress without interrupting, opens new peer conversations of its own, and sets rules on a linked conversation's tool calls.

**A link is not a prerequisite for talking.** The first message to any conversation this workspace shows the human registers it as a link in the same call (named after its handle unless you pass `name`) and then delivers. The link still exists — it is the durable, auditable relationship record — it just no longer costs a separate step.

## The scenario

Conversation A coordinates: open B/C/D/E as peers (not subagents) in one project, have A remember who owns what, watch progress, do the interface hand-offs, and remind a peer before it touches something it should not. B/C/D/E can report back to A at any time.

There is no role here. A link is a **name**, not an authority: nothing makes one conversation another's supervisor, and the only enforcing mechanism — a rule — binds the conversation that declares it.

## Install

Through the application's plugin manager or `dshpm` (published on npm and GitHub):

```
dshpm install dsh-conversation-link --profile web
dshpm install github:duanyunlun/dsh-conversation-link --profile web
```

Restart the app afterwards: the desktop host does not hot-reload the profile patch layer.

This package declares `dsh.bundle.patch` (`./cordis.patch.yml`), so it is a **bundle layer**: a profile that installs it applies that patch through `dsh.profile.bundles` and gets the plugin row — which is how DSH Desktop's built-in community market and `dsh-web-plugin-manager` install it (the market's "installable" view only accepts packages that declare `dsh.bundle.patch`). A bundle row and a hand-written insert row in the profile must not coexist, or the plugin loads twice.

## Tools

| Tool | Purpose |
|---|---|
| `conversation_list` | The conversations you can address, with their stable handles: exactly what this workspace shows the human, plus the conversations linked to you |
| `conversation_link` | Link a conversation under a nickname you choose and introduce yourself to it automatically. Only needed to pick the nickname yourself — first contact in `conversation_send` links too |
| `conversation_unlink` | Drop a nickname you gave a conversation. The peer keeps running, and the rules it declared for itself stay in force |
| `conversation_send` | Send a message to any conversation this workspace shows, or to a conversation linked to you; first contact links the target (`name` picks the nickname, the return value reports `linked`). Delivery defaults to `auto`: a **running** target is steered at its **next step boundary** instead of waiting for its turn to end, an **idle** one gets a fresh turn. Explicit `queue` / `steer` / `inject` still work, and the returned `mode` is where the message actually landed. A closed target is opened first |
| `conversation_status` | Read a linked conversation's progress without waking it |
| `conversation_spawn` | Open a new **peer** conversation (`cwd` defaults to the caller's own working directory; the new conversation is then registered in the workspace that owns it), optionally linking it and handing it a first task |
| `conversation_rule` | Declare standing rules for **your own** tool calls (no parameter points at another conversation): `before` refuses a call, `after` rejects a completed result with feedback, `input` restates a constraint before a step |

Address a linked conversation by name, by handle (`ivory-quartz`), or by session id.

## Design notes

- **Addressing equals visibility.** The list reads the same source the sidebar does, so a conversation the human cannot see is neither listed nor addressable: archived, still-blank, and subagent sessions are excluded, and the send/link tools refuse them too.
- **Every channel leaves a record.** A conversation may message a conversation linked to it, or open a channel to any conversation the workspace shows — which registers it first. This grants nothing new (`conversation_link` never had a gate: any conversation can link any other, and the target can neither refuse nor undo it), so what changes is the record-keeping: addressing always lands on a durable link the listing shows and `conversation_unlink` removes. Set `autoLink: false` to require an explicit link again.
- **No hidden loop.** Every message is an explicit tool call, so two conversations cannot wake each other forever.
- **Messages are visible.** A cross-conversation message is a normal user-role turn in the target's own log — never a system prompt change — and a bundled browser half promotes it to a message card whose header is the sending conversation's title and whose click opens that conversation.
- **Rules fail open, loudly.** Rules are policy on top of the pipeline: a defect in this plugin never blocks an unrelated conversation's work.

See [README.md](README.md) for the full design rationale, the configuration reference, and the known limits (same-process only; the card layer depends on rendered DOM markers, with `messageForm: notice` as the fallback).

## Development

```sh
node --test 'test/*.test.mjs'
```

## License

MIT
