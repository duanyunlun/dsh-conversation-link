# dsh-conversation-link

[中文](README.md) | English

> Peer communication, supervision, and tool guardrails **between conversations** inside one DeepSeek Harness process.

**Let your conversations talk to each other.** Conversations inside one dsh process can discover each other, send messages directly, watch progress, and set rules for one another — no binding step first, and no subagent layer in between.

DeepSeek Harness keeps every conversation it has opened alive in one process, and any plugin can already address any live agent — but the only cross-conversation path it ships is parent → subagent. This plugin adds the horizontal one: a coordinating conversation discovers its peers, registers them as named members, exchanges messages both ways, watches progress without interrupting, opens new peer conversations of its own, and sets guardrails on a member's tool calls.

**Binding is not a prerequisite for talking.** The first message to any conversation this workspace shows the human registers it as a member in the same call (named after its handle unless you pass `name`) and then delivers. The binding still exists — it is the durable, auditable edge — it just no longer costs a separate step.

## The scenario

Conversation A coordinates: open B/C/D/E as peers (not subagents) in one project, have A remember who owns what, watch progress, do the interface hand-offs, and stop B when it is about to touch something it should not. B/C/D/E can report back to A at any time.

## Install

Through the application's plugin manager or `dshpm` (published on npm and GitHub):

```
dshpm install dsh-conversation-link --profile web
dshpm install github:duanyunlun/dsh-conversation-link --profile web
```

Restart the app afterwards: the desktop host does not hot-reload the profile patch layer.

## Tools

| Tool | Purpose |
|---|---|
| `conversation_list` | The conversations you can address, with their stable handles: exactly what this workspace shows the human, plus the members you supervise and the supervisors that name you |
| `conversation_bind` | Register a conversation as a named member you supervise; hands it the working agreement automatically. Only needed to choose the name and role up front — first contact in `conversation_send` registers too |
| `conversation_unbind` | Drop a member and its rules |
| `conversation_send` | Send a message to any conversation this workspace shows, a member of yours, or a supervisor of you; first contact registers the target as a member (`name` picks the member name, the return value reports `bound`). `queue` (new turn), `steer` (next step), or `inject` (context without waking). A closed target is opened first |
| `conversation_status` | Read a member's progress without waking it |
| `conversation_spawn` | Open a new **peer** conversation, optionally binding it and handing it a first task |
| `conversation_guard` | Rules in three stages: `before` refuses a call, `after` rejects a completed result with feedback, `input` asserts a standing constraint |

Address a member by name, by handle (`ivory-quartz`), or by session id.

## Design notes

- **Addressing equals visibility.** The list reads the same source the sidebar does, so a conversation the human cannot see is neither listed nor addressable: archived, still-blank, and subagent sessions are excluded, and the send/bind tools refuse them too.
- **Every channel leaves a record.** A conversation may message a member it bound, reply to a conversation that bound it, or open a channel to any conversation the workspace shows — which registers it first. This grants nothing new (`conversation_bind` never had a gate: any conversation can register any other, and the target can neither refuse nor undo it), so what changes is the record-keeping: addressing always lands on a durable edge the listing shows and `conversation_unbind` removes. Set `autoBind: false` to require an explicit bind again.
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
