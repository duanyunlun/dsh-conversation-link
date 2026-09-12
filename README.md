# dsh-conversation-link

[English](README.en.md) | 中文

> DeepSeek Harness 里，**对话与对话之间的通信、监工与护栏**。

**让对话像同事一样互相说话。** 同一个 dsh 进程里的对话可以互相发现、直接发消息、盯着对方进度、给对方立规矩——不用先绑定，也不用套一层子代理。多对话协作、跨会话通信、监工与工具护栏，一个插件全包。

Harness 本来就把每个打开过的对话都留在同一个进程里，也允许任何插件寻址任意活跃 agent；但它对外只提供了「父会话 → 子代理」这一条跨会话路径。这个插件补上横向的那条：一个对话可以发现平级对话、把它们登记成具名成员、双向收发消息、在不打扰对方的前提下看进度、自己开新的平级对话，并对成员的工具调用设护栏。

**不需要先绑定才能说话。** 给本工作区侧栏可见的任何一个对话发第一条消息，插件会在同一次调用里把它登记成成员（默认用它的 handle 作名字）再投递；之后按名字或 handle 寻址。绑定依然存在——它就是那条持久、可审计的边——只是不再需要单独一次动作。

## 适用场景

A 对话做总调度：在一个项目里开 B/C/D/E 四个功能对话（平级，不是子代理），A 记住谁负责什么，盯进度、做接口对接、在 B 要动不该动的东西时喊停。B/C/D/E 也能随时回报 A。

## 安装

通过应用的插件管理器或 `dshpm` 安装（发布在 npm 与 GitHub 上）：

```
dshpm install dsh-conversation-link --profile web
dshpm install github:duanyunlun/dsh-conversation-link --profile web
```

装完**需要重启 DSH**：desktop host 不做 patch 热重载（`apps/desktop-host/src/index.ts` 不调用 `watchUserPatches`，只有 CLI 启动路径会）。

### 本地开发（未发布时）

把仓库链进 profile 的 `node_modules`，并在 profile 的 `cordis.patch.yml` 里加一条 insert 行：

```yaml
- insert:
    - id: conversation-link
      name: 'dsh-conversation-link'
```

```sh
ln -sfn "$PWD" ~/.dsh/profiles/<profile>/node_modules/dsh-conversation-link
```

不要往 profile 的 `package.json` 里加依赖：桌面端只在 dsh 版本变化时重装 profile，且用 `pnpm install --offline --frozen-lockfile`——加了依赖而不更新 lockfile 会让那次安装失败。代价是 **dsh 升级后符号链接会丢**，要重新链一次。

## 概念

| 概念 | 含义 |
|---|---|
| **handle** | 每个对话的稳定短名，形如 `amber-otter`。首次被看到时分配，存在插件状态文件里，跨重启不变。用于寻址——不用念 UUID。 |
| **member** | A 用 `conversation_bind` 把某个对话登记成成员时给的具名角色（如 `frontend`）。名字在同一个调度者内唯一。首次给一个对话发消息时，它也会被自动登记成成员（名字默认取它的 handle）。 |
| **binding** | 有向的「谁监督谁」。A 绑 B 之后，A 可以给 B 发消息；B 也能回 A（回复路径不需要第二次绑定）。**首次发送会自动建立这条边**，所以它是通信的副产品，而不是通信的前提。 |
| **rule** | A 给成员定的规则，按**生效时机**分三阶段：`before` 拒绝即将执行的工具调用、`after` 把已完成的结果打回并给出纠正反馈、`input` 在每一步之前向成员声明一条常驻约束。 |

身份仍然是 Harness 的 `SessionId`。handle 只是别名层——核心的会话列表、持久化、恢复全都不需要知道它。

## 工具

| 工具 | 用途 |
|---|---|
| `conversation_list` | 列出你能寻址的对话：**当前工作区所有未归档的对话**（不只是打开着的），以及你监督的成员和正在监督你的对话。`scope: "all"` 可跨工作区 |
| `conversation_bind` | 把某个对话登记为具名成员（可带 role/note），并**自动向它下发协作协议**。持久化，重启后仍在。首次发送也会自动登记，所以这一步只在你想**提前定名字和职责**时才需要 |
| `conversation_unbind` | 解除成员关系，连带删除它的规则 |
| `conversation_send` | 发消息。目标可以是**本工作区侧栏可见的任何对话**、你的成员，或你的监督者。**首次接触会在同一次调用里把对方登记成成员**（`name` 指定成员名，默认用它的 handle；返回值 `bound: true` 表示这次建立了边）。目标没打开时**自动打开再投递**（返回 `opened: true`）。投递默认 **`auto`**：对方**正在跑**就走 `steer`（插到它**下一个 step 边界**，不等它这一轮跑完），对方**空闲**就走 `queue`（给它干净的一轮）；也可显式指定 `queue` / `steer` / `inject`。返回值里的 `mode` 是**实际落点** |
| `conversation_status` | 不打扰对方地读进度：当前 turn/step、最后的人类/助手文本、最近工具名、排队数。需要**已有关系**（你绑过它，或给它发过消息） |
| `conversation_spawn` | 开一个**平级**新对话（默认落在调用者自己的工作区，立刻出现在侧栏），可同时绑定成员并派第一个任务 |
| `conversation_guard` | 给**你绑定的成员**设/删/列规则（`action: add \| remove \| list`，`stage: before \| after \| input`） |

寻址三选一：member name、handle、session id。

### 哪些对话能被寻址：**人看得见的那些**

这是一条硬规则：**agent 眼里的对话列表必须等于人在侧栏看到的列表**。一个 agent 能对着一个人类看不见的对话说话，是错的——人无法理解它在跟谁讲话，也不可能"那个意思"。

所以列表直接读**侧栏自己用的那个来源**（Host 的 `sessionController.list()`），而不是另起一套语料查询；被排除的是：

- **归档的**（`ctx.workspaceRegistry.archivedSessionIds`）
- **空白占位**（工作区浏览器隐藏的空会话；`blank` 在 `turn/start` 时翻转，所以只要收过消息就不再是空白）
- **子代理**（`origin: 'subagent'` 不是平级对话）
- 默认再看**当前工作区**（与调用者 `cwd` 相同）；`scope: "all"` 放开到整台机器

这条规则**同时约束发送、绑定与首次接触的自动登记**：目标若不在这个列表里（例如刚被你归档），`conversation_send` / `conversation_bind` 会直接拒绝，而且**什么都不留下**——连一个 handle 都不会为它铸出来。

打开的和没打开的都能寻址。给一个没打开的对话发消息时，插件先把它打开——走的是 Host 的 `sessionController.resolveAgent()`，也就是**用户自己点开一个对话时所走的同一条路径**（preset 组合、workspace 注册、子代理归属校验都由它负责），所以被打开的对话会像用户亲手点开一样出现在会话列表里。

没有 `sessionController` 的组合（headless/sdk）退回 `sessionQuery.listSessions()` + 归档过滤；那条路径拿不到 `blank`，README 与代码都注明了这个差异。

## 用法示例

在 A 对话里说：

> 列出所有对话，然后我开的那四个（前端、后端、测试、文档）分别绑成 frontend/backend/test/docs，各自说明职责。

A 会调 `conversation_list` 拿到 handle，再逐个 `conversation_bind`。

不想提前绑定就直接说话：

> 问一下「位图刀线矢量化」那个对话：diecut 提取用的是哪个阈值？

A 调 `conversation_send target="<那个对话的 handle>"`，一次调用就够了——对方被登记成成员（名字就是它的 handle），并收到那份协作协议；返回的 `bound: true` 表示这次建立了边。之后 A 可以用这个名字继续找它，也可以 `conversation_status` 看它进度、给它设规则。

派活与对接：

> 告诉 frontend：登录接口按 backend 的 `/api/v2/auth` 来，字段名用 `accessToken`。

A 调 `conversation_send target="frontend"`。B 收到的是带来源头的 relay 消息：

```
[conversation message from clever-otter (session-...)]
[your handle is amber-otter]
[relationship: you are supervised by this conversation as "frontend" (UI work)]
...
[Reply with conversation_send target="clever-otter" when a reply is needed.]
```

B 直接 `conversation_send target="clever-otter"` 就能回报 A。

盯进度（不打断）：

> 看下 backend 和 test 现在到哪一步了。

A 调 `conversation_status`。

设规则（三阶段各一例）：

> 别让 frontend 动 packages/api 下面的东西，也不要执行 git push。

A 调 `conversation_guard`（`stage` 默认 `before`），之后 frontend 的相关调用会在**执行前**被拒：

```
Blocked by supervising conversation: <A 给的理由>
```

> test 拿回来的输出里如果带 token 或密钥，直接打回，让它重跑。

A 设 `stage: "after"` + `matchResult: "token"`。命中时结果被丢弃，test 的模型看到：

```
Rejected by supervising conversation: <A 给的理由>
The result above was discarded. Correct the problem and call the tool again.
```

> 常驻告诉 frontend：接口字段一律 camelCase，已发布的字段名不许改。

A 设 `stage: "input"` + `text`。frontend 之后**每一轮**进入 step 前都会看到这条约束（每轮一次，不刷屏）：

```
[standing constraint from your supervising conversation clever-otter (session-...)]
接口字段一律 camelCase，已发布的字段名不许改。
```

规则命中时 A 会收到一条静默通知（`Rule fired: ...`），不唤醒它。

## 咨询协议

绑定时插件会自动给成员下发一份协作协议（`inject`，不唤醒），内容包括：谁在监督它、**接口/字段/归属不确定时先问而不是猜**、跨模块改动前先说、阶段性完成要带验证方式回报。**首次发送触发的自动登记同样下发这份协议**——对方不会收到一条没有上下文的陌生消息，它知道是谁在跟它说话、以及怎么回。

这是这个插件的立场：**成员是被介绍给协调者的同事，不是被监控的进程。** 所以默认行为是「问」，而不是「拦」——拦截留给少数几条 A 明确写下的规则。

## 设计取舍

- **谁都能开口，但每条通道都留痕。** 一个对话可以给「自己绑定的成员」、给「绑定了自己的监督者」发消息，也可以给**本工作区侧栏可见的任何对话**发第一条消息——那一次发送会把它登记成成员（`autoBind`，默认开）。这没有放松权限：`conversation_bind` 从来没有门槛（谁都能绑谁，目标既不能拒绝也不能解绑），所以首次接触省掉的只是**一次调用**，能对谁说话没有变。真正变的是**防误伤**那一层：以前模型只能对「自己登记过的名字」开口，编出来的 handle 会被拒；现在它对可见的任何对话都能开口，于是治理手段从「必须先登记」换成「登记自动发生，且看得见、撤得掉」——`conversation_list` 会列出这些自动成员，`conversation_unbind` 撤得掉，`autoBind: false` 回到严格模式。始终不变的是那条硬规则：看不见的（归档/空白/子代理/别的默认工作区）既不能被寻址，也不能被登记。
- **消息要让人看得见。** 跨对话消息（请求、回复、约束、规则通知）全部走 Harness 自己的 `plugin` source + `notice` context form，**不需要任何 session 格式变更**，也不自造 `source.kind`。为什么是 `notice` 而不是 `relay`，见下。
- **回报不该等一整轮。** `queue` 在 Harness 里的语义是「**自成一轮**」（`followup` → `next-turn`：*becomes the sole ordinary message of its own turn*，`packages/core/agent-loop/src/agent.ts:137`）。于是 A 正在跑一轮长编排时，B 的回报只能躺在 `next-turn` 里等 A 收轮——而那正是这份回报开始失去价值的时刻。`steer` 走 `next-step`：turn 循环只有在下一条 step 之前箱是空的才允许收尾（`agent.ts:315-321`），所以它**在下一次模型调用前就进上下文**。Harness 自己的跨对话投递（`agent-team` 的 mailbox）对 root 用的就是 `steer`（`mailbox.ts:251`）；本插件把这条语义做成默认值 `auto`：**在跑的用 `steer`，空闲的用 `queue`**。为什么空闲不用 `steer`：`steer` 落到空闲 driver 上只是被「下一步」认领的一条消息，而不是一次干净的轮次边界。
- **没有隐式转发。** 一切消息都是显式的工具调用，两个对话不会互相唤醒成环。约束注入是唯一的推送，且按轮去重。
- **规则失败开放但吵闹。** 规则是策略层不是传输层：插件自身出问题时放行并告警，绝不破坏无关对话的工作。`input` 阶段注入失败也只降级为不注入。
- **改写只落在合法的两处。** `tools/pre-execute` 的决策只有 allow/deny/ask，**不能替换参数**（Harness 明确排除了输入改写，因为参数已经记录并展示过了）。所以改写落在 `tools/post-execute`（结果）与 `agent/pre-step`（进入 step 的消息）——这正是成员能看到并纠正的两处。

### 消息怎么在 UI 里显示成"一条消息"

对话转录对**所有非 `user` 来源**的消息一律渲染成**折叠的上下文行**（`ContextInjectionRow` 是 `useState(false)`）：表头写着"上下文注入 · 来源"，正文要点击才展开。监工场景下这样等于看不见。

这个插件的 **client 半区**（`client.js`）把自己发的行提升成消息卡片：认出属于本插件的行 → 点开它的折叠 → 隐藏表头 → 把正文重排成气泡 → 把发送方换成该会话的标题并做成可点击（点开就跳到那个对话）。

有一个**退路配置**：宿主端的 `messageForm`。

| 值 | 效果 | 何时用 |
|---|---|---|
| `relay`（默认） | 折叠行本身不可读，交给 client 半区渲染成卡片 | 正常情况 |
| `notice` | 折叠行表头直接显示一行摘要 `发送方 → 内容`（118 字符） | client 半区因 Harness 升级失效时 |

**为什么 client 半区走 DOM 而不是注册节点**——这是被迫的，不是偷懒：内置的 `messageDefinition` 匹配**每一条** `user/message` 并生成 context 节点，而 Definition 按 kind 注册、**同名直接抛错、不可替换**；渲染槽位虽然能按优先级遮蔽（lowest renders），却**没有委派机制**（`abdicate` 只是崩溃退休），而 `ui-chat/client` 也**没有导出**内置的上下文行组件——遮蔽 `context` 就意味着重实现全部上下文行（系统提示词、技能目录、文件引用…），对第三方插件太脆弱。

所以代价是：**client 半区依赖渲染出来的 DOM 标记**（`data-disclosure-row` / `data-context-form` / `data-context-source` / `data-context-relay-sender`）。Harness 升级若改了这些标记，卡片会退化回折叠行——那时把 `messageForm` 改成 `notice` 即可恢复可读性。真·一等消息节点需要内核支持。

- **同步进程内。** 只覆盖同一进程内活跃的对话。跨进程（独立的 dsh 进程、SDK/ACP/Claude Code 子代理）需要额外的传输层，见下。

## 已知边界

- **寻址等于可见**：能出现、也能被寻址的，只有侧栏会显示的那些对话。归档的、空白的、子代理一律不在列表里，也不能被发消息或绑定。
- **handle 还没进 GUI。** 人看到的是会话标题；handle 目前通过 `conversation_list` 可见。要在会话头部直接显示，需要加一个 client 半区插件。
- **首次发送建立的也是「监督」这条边。** 自动登记和 `conversation_bind` 是同一条边、同一份协作协议，所以对方读到的是「你被 X 监督」。如果只要纯粹的平级问答、不带监督语义，目前没有单独的边类型——加一个 `kind: "peer"`（可发消息、不可设规则）是下一步的候选。
- **`conversation_spawn` 的 preset。** 在有 Host session controller 的组合（web/desktop）里走 `sessionController.create`，preset 组合与 workspace 注册都由它负责；其他组合回退到 `ctx.agents.create`，此时新对话拿到的是宿主级组合。
- **没有人在环审批，这是有意的。** Harness 自带的 `user-approval` 已经覆盖「危险动作问人类」，再叠一层只会让同一个调用弹两次。规则解决的是另一件事：**无人值守时也生效的项目规则**（内置审批不知道 `packages/api` 意味着什么）。真需要人在环，把 `action` 换成 `ask` 即可复用现成审批通道，但需要先想清楚它是否与内置审批重复。
- **规则是确定性的。** 命中即生效，不会实时问 A「放不放行」。把每个受控调用都交给 A 的模型判断，既费 token 又引入相互等待，而且 A 的信息未必比成员全——所以默认走「成员主动咨询」，而不是「A 审所有调用」。
- **约束注入是进程内状态。** 重启后 `session` 型约束最多再注入一次，`turn` 型不受影响。

## 配置

在 profile 的 patch 行里覆盖：

```yaml
- id: conversation-link
  config:
    stateDir: ~/.dsh/conversation-link   # 状态文件目录（默认 $DSH_HOME/conversation-link）
    briefOnBind: true                         # 绑定时向成员下发协作协议（默认 true）
    autoBind: true                            # 首次发送时自动把对方登记成成员（false = 必须先 conversation_bind）
    messageForm: relay                        # 消息形态：relay（客户端渲染成卡片）| notice（表头显示一行摘要）
    notify: inject                            # 规则命中通知方式：inject | queue | off
    notifyCooldownMs: 10000                   # 同一条规则的通知最小间隔
    mountLog: ''                              # 设成路径可记录挂载事件，用于确认插件已加载
```

## 状态文件

`$DSH_HOME/conversation-link/state.json`，原子写入：

```json
{
  "version": 1,
  "handles": { "session-…": "amber-otter" },
  "bindings": [{ "owner": "session-…", "name": "frontend", "target": "session-…", "role": "UI" }],
  "guards": [{ "id": "rule-…", "owner": "session-…", "target": "session-…", "stage": "before",
               "tool": "bash", "match": "git push", "reason": "…" }]
}
```

删掉这个文件等于重置所有绑定、规则与 handle。

**改名前的状态文件会继续被使用。** 这个插件在 0.3.0 之前叫 `dsh-conversation-bindings`，状态文件在 `$DSH_HOME/conversation-bindings/state.json`。改名不会让你丢掉已经攒下的 handle、绑定和规则：只要新目录下还没有 `state.json`，插件就继续读写旧路径那一份（**不复制、不迁移**，始终只有一份在生效）。想搬过去就自己 `mv`，想重置就删掉它。

## 测试

```sh
node --test 'test/*.test.mjs'
```

32 → **40 个用例**覆盖发现、handle 分配与稳定性、绑定与重绑、**首次接触自动登记（默认按对方 handle 命名、可用 `name` 显式命名、已有关系永不被改名、关掉 `autoBind` 后回到拒绝、自环被拒、被拒的目标连 handle 都不铸）**、**改名前的状态文件继续生效（不复制、不迁移）**、双向投递与来源头、**回复路径的措辞（对监督者说「你监督这个对话」，而不是反过来说）**、**投递默认 auto（在跑的目标落 `next-step`、空闲的落 `next-turn`、显式 mode 不被 auto 覆盖）**、未授权寻址被拒、投递模式、三阶段规则各自的命中与不命中、约束按轮去重、包装 `agent/pre-step` 时不破坏内层决策（含 `startsRequestSeries` 与 reject）、绑定时下发协作协议、进度投影、平级对话创建、冷会话发现（归档/空白/子代理/跨工作区过滤）、"列表即侧栏所见"这条不变式（归档后立刻不可寻址）、给未打开的对话发消息时按需打开、跨重挂载的持久化，以及 client 半区的装配与 DOM 行为（模块队列注册、样式注入、**折叠行的两阶段展开**、非本插件的行不动、监听与卸载）。

其中"两阶段展开"那条是补写的回归测试：disclosure 的正文只在展开后渲染，而它是**表头（承载来源标签）的兄弟节点**——所以只扫描"新增节点"永远找不到它。第一版就是这么错的：展开后的第二次扫描匹配不到任何东西，卡片从不出现。

两层「提前失败」的设计值得单独说：

- 假 ctx 复刻了 **Cordis 的服务解析语义**——访问未在 `inject` 里声明的服务会**抛错**，而不是返回 `undefined`。所以可选服务必须用 `ctx.get(name)` 读（本插件的 `optional()` 就是这一条）。`if (ctx.sessionQuery === undefined)` 这种防御根本走不到，取属性的那一刻就抛了——这个坑真实踩过一次。
- 测试里复刻了 Harness 强制的 **JSON Schema 子集校验**——工具 output schema 写错时只有真实加载器才会报错，这一层让它在本地就失败。

## 下一步

1. **hook 订阅**：让 A 声明「B 的哪些事件要推给我」，带来源标记、跳数上限和事件预算，防回环。
2. **会话头部显示 handle**：client 半区目前只做消息卡片；把 handle、成员关系与规则状态显示在会话头部是下一步。
3. **跨进程传输**：用文件或网络在独立 dsh 进程之间打通同一套语义。
