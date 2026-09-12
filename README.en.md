# dsh-conversation-bindings

[中文](README.md) | English

> Peer communication, supervision, and tool guardrails **between conversations** inside one DeepSeek Harness process.

DeepSeek Harness keeps every conversation it has opened alive in one process, and any plugin can already address any live agent — but the only cross-conversation path it ships is parent → subagent. This plugin adds the horizontal one: a coordinating conversation discovers its peers, registers them as named members, exchanges messages both ways, watches progress without interrupting, opens new peer conversations of its own, and sets guardrails on a member's tool calls.

## The scenario

Conversation A coordinates: open B/C/D/E as peers (not subagents) in one project, have A remember who owns what, watch progress, do the interface hand-offs, and stop B when it is about to touch something it should not. B/C/D/E can report back to A at any time.

## Install

Through the application's plugin manager or `dshpm` (published on npm and GitHub):

```
dshpm install dsh-conversation-bindings --profile web
dshpm install github:duanyunlun/dsh-conversation-bindings --profile web
```

Restart the app afterwards: the desktop host does not hot-reload the profile patch layer.

## Tools

| Tool | Purpose |
|---|---|
| `conversation_list` | The conversations you can address, with their stable handles: exactly what this workspace shows the human, plus the members you supervise and the supervisors that name you |
| `conversation_bind` | Register a conversation as a named member you supervise; hands it the working agreement automatically |
| `conversation_unbind` | Drop a member and its rules |
| `conversation_send` | Send a message; `queue` (new turn), `steer` (next step), or `inject` (context without waking). A closed target is opened first |
| `conversation_status` | Read a member's progress without waking it |
| `conversation_spawn` | Open a new **peer** conversation, optionally binding it and handing it a first task |
| `conversation_guard` | Rules in three stages: `before` refuses a call, `after` rejects a completed result with feedback, `input` asserts a standing constraint |

Address a member by name, by handle (`ivory-quartz`), or by session id.

## Design notes

- **Addressing equals visibility.** The list reads the same source the sidebar does, so a conversation the human cannot see is neither listed nor addressable: archived, still-blank, and subagent sessions are excluded, and the send/bind tools refuse them too.
- **Authorized addressing only.** A conversation may message a member it bound, or reply to a conversation that bound it. A conversation you have never bound cannot be cold-called with instructions.
- **No hidden loop.** Every message is an explicit tool call, so two conversations cannot wake each other forever.
- **Messages are visible.** A cross-conversation message is a normal user-role turn in the target's own log — never a system prompt change — and a bundled browser half promotes it to a message card whose header is the sending conversation's title and whose click opens that conversation.
- **Rules fail open, loudly.** Guards are policy on top of the pipeline: a defect in this plugin never blocks an unrelated conversation's work.

See [README.md](README.md) for the full design rationale, the configuration reference, and the known limits (same-process only; the card layer depends on rendered DOM markers, with `messageForm: notice` as the fallback).

## Development

```sh
node --test 'test/*.test.mjs'
```

## License

MIT
