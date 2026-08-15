# dsh-lark-channel

[![npm](https://img.shields.io/npm/v/dsh-lark-channel)](https://www.npmjs.com/package/dsh-lark-channel) [![CI](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml/badge.svg)](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

[English](README.md) | 中文

DeepSeek Harness 的飞书/Lark IM 机器人渠道插件。每个会话（单聊或群聊）驱动一个独立的 DSH Agent；助手的推理与工具调用以平台原生的思考过程呈现，最终答案单独发送，宿主的审批问题变成交互卡片，按钮点击即作答。

传输层使用 `@larksuite/channel`，WebSocket 长连接，无需公网回调地址。

<!-- 截图：把 PNG 放到 .github/assets/ 下并取消注释。
<p align="center">
  <img src=".github/assets/thinking-process.png" alt="原生思考过程" width="45%">
  <img src=".github/assets/approval-card.png" alt="审批卡片" width="45%">
</p>
-->

- [能力](#能力)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置](#配置)
- [行为](#行为)
- [已知限制](#已知限制)
- [开发](#开发)

## 能力

- 每个会话一个 Agent。`sessionScope` 决定粒度：整个会话、单个话题、或共享会话里的单个发送者。session id 跨重启稳定。
- `/cd` 把会话指向一个目录；`/ws` 列出宿主注册表里的全部工作区，每个都能用裸名字直达。每个（会话 × 目录）组合拥有各自的持久会话——切回某个目录就续用在那里积累的上下文；切换跨重启保留，`workspaceRoots` 可限定 `/cd` 的可达范围，文件系统根和 Home 根永远拒绝。
- `/model` 展示当前路由和宿主 llm 注册表的模型目录；`/model use <provider/model>` 从下一条消息起切换本会话——**同一个** session 以新路由续跑，上下文不丢。`/status` 报告工作区、模型、会话与运行状态，第一条消息发出前就能问。
- 两种输出模式：`cot` 用平台原生思考过程，`stream` 每轮一张打字机卡片，供旧客户端使用。
- 以 `/` 开头的一行作为宿主命令执行，不开模型轮次。`/stop` 停止当前轮次，`/help` 列出可用命令。
- 宿主的审批问题变成带「允许一次 / 拒绝」按钮的卡片，点击即结算，卡片改写为决定结果。
- 模型的提问（`ask_user_question`）同样变成卡片：该工具在每个会话 Agent 自己的层里被遮蔽，模型给的选项渲染成按钮，选项都不合适时直接回复消息即可作答。
- 计划审阅（`exit_plan_mode`）也落在会话里：计划先作为普通消息发出，markdown 完整渲染；随后一张卡片承载决定——批准，或把你的意见回传给模型。
- `/model` 用选择卡列出可用路由，`/status` 用状态卡说明下一条消息会怎么跑。两者都保留打字方式：`/model use <provider/model>` 不看卡片直接切换。
- 所有卡片共用一套视觉语言，并按读者的语言渲染：本渠道自己的文案中英双语，平台按接收人语言显示；模型写的文本一律字面渲染，永远不会成为卡片标记。
- 图片可选开启，下载后提交到宿主附件存储，随消息进入模型。
- 每条回复指向提出它的那条消息，原消息在话题里时回复也留在话题内。
- 授权只在平台的应用可用范围内收窄，所有名单默认为空。
- 未配置凭证时启动即画二维码，扫码经官方流程创建应用，含事件订阅。

## 环境要求

- Node `^22.19.0 || >=24.0.0`，pnpm 11.7。
- 一个 DeepSeek Harness 部署（`dsh` 0.1.0-rc.6 或更新）。`@deepseek-ai/cordis`（`^4.0.1`）是 peer 依赖，由宿主提供。
- 飞书或 Lark 租户。应用本身可以由首次启动的扫码流程创建。
- `cot` 输出要求客户端能渲染思考过程：PC 7.70、移动端 7.74。更旧的客户端用 `output: 'stream'`。

## 快速开始

```sh
npx dsh-lark-channel@latest start
```

终端会打印一个二维码，用飞书扫掉机器人就活了。它从一开始就在后台运行——macOS 交给 launchd，Linux 交给 `systemd --user`——关掉终端不受影响，重启开机自起。然后私聊它或在群里 @ 它。

之后用 `stop`、`restart`、`status`、`logs` 管理；重跑 `start` 即应用更新。需要装好 `dsh`（`npm i -g @deepseek-ai/dsh`），后台服务不能依赖 npx 联网解析。没有 launchd / systemd 的环境（Windows、无 systemd 的 Linux）里，`start` 会改为前台运行。

已经在跑 `dsh web`、想把渠道挂在那个 profile 上：

```sh
dsh plugin --profile web add dsh-lark-channel@latest
dsh web
```

升级就是重跑这条命令，然后重启 `dsh web`。

模型 key 在 `web` 下从 Settings → Models 页面填；其他情况来自 `DEEPSEEK_API_KEY` 环境变量或宿主托管的 `$DSH_HOME/.credentials.yaml`。

<details>
<summary>组合细节、二维码有效期与 invariant 伴生行</summary>

包清单声明了 `dsh.bundle.patch: ./cordis.patch.yml`，安装进 profile 时其 patch 行叠加到 profile 组合上。凭证可在 patch 中使用 `!!js process.env.…`。

一个二维码的有效期由平台下发（当前是 60 分钟），没人扫就自动换一个，所以晚点再来也总有一个能用的码；被拒绝或请求失败则停下并说明原因，需要重启重新发起。要重置已存凭证，删除 settings 文档里的 `lark-channel` 段即可，其路径可从宿主 settings 界面获得；settings 层存在期间会覆盖入口配置的值。

invariant 伴生行不在默认 patch 里：发货的 `web` profile 未组合 `invariants` 服务，等待缺失服务的行会让整棵树启动失败。`cordis.patch.yml` 里注释了诊断组合用的行写法。

</details>

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `appId`、`appSecret` | 首次启动扫码注册 | 飞书/Lark 应用凭证。分层见下。 |
| `domain` | 飞书 | 开放平台域名；Lark 用 `https://open.larksuite.com`。 |
| `cwd` | 宿主进程 cwd | 会话 Agent 的绝对工作目录；`/cd` 永远可以切回的默认目录。 |
| `workspaceRoots` | `[]` | `/cd` 可以指向的目录前缀；空 = 任何存在的目录。默认目录始终可达。 |
| `chatWorkspaces` | `{}` | 托管状态而非配置：各会话被 `/cd` 到的目录，经 settings 服务写回。 |
| `chatModels` | `{}` | 托管状态而非配置：各会话经 `/model use` 指定的 `provider/model` 路由。 |
| `provider`、`model` | 宿主 `agentDefaultModel` | 会话 Agent 的模型路由。 |
| `preset` | roster 默认 | 部署组合了 roster 时，会话 Agent 加入的 preset。 |
| `sessionScope` | `chat` | 一个 Agent 会话对应的会话粒度：`chat`（整个会话共用一个）、`chat-thread`（每个话题各自一个，避免并行话题互相覆盖上下文）、`chat-sender`（共享会话里每个人各自一个）。 |
| `output` | `cot` | `cot`（原生思考过程 + markdown 答案）或 `stream`（每轮一张打字机卡片）。 |
| `showProcess` | `true` | 展示 Agent 的推理与工具调用；关闭则只发答案。 |
| `hideProcessWhenDone` | `false` | 运行结束后让平台收起该过程（仅 `cot`）。 |
| `attachImages` | `false` | 是否把图片传给模型。仅用于确实支持图片的路由：一次被拒就会终结该对话。 |
| `syncSlashCommands` | `true` | 把会话可用的命令注册到机器人上，用户打 `/` 即可看到菜单。 |
| `denyTools` | `[]` | 会话 Agent 不可调用的工具，按 agent 在执行处拒绝。默认为空：人类交互类工具改为被遮蔽并在此作答，而不是拒绝。在这里写下的名字仍然优先于遮蔽。 |
| `requireMention` | `true` | 群聊中仅在被 @ 时响应。 |
| `senderAllowlist` | `[]` | 允许私聊的 open id；留空则服务应用可用范围内的任何人。 |
| `groupAllowlist` | `[]` | 非空时仅服务这些 `oc_…` 群会话；空=任意群。 |
| `approvers` | `[]` | 允许作答审批的 open id；空=能驱动该会话的人都可以。 |

什么都不配时，它服务被拉进的任何群，以及应用可用范围内的任何人。要不要再收紧是部署方的选择：平台已经决定了谁能触达机器人，本插件只在那个范围内收窄。

凭证按三层解析，后者覆盖前者：组合 patch 里的入口配置（通常写成 `!!js process.env.LARK_APP_ID`）；settings 文档的 `lark-channel` 段，存在期间优先级最高；两者都没有时走首次启动的扫码注册，结果经宿主 `settings` 服务持久化。

配置在启动时读取一次，见[已知限制](#已知限制)。

## 行为

仓库自包含：仅依赖已发布的 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 编译，从不需要宿主源码检出，并通过 `src/host.ts` 中的窄本地契约访问宿主服务（`agents`、`agentPresets`、`agentDefaultModel`、`settings`、`invariants`、`loader`）。所有注册归插件 fiber 所有，卸载时断开传输、销毁所有会话 Agent、把未决审批卡片结算为 `cancelled`。

<details>
<summary>入向</summary>

`message` 事件被路由到 `sessionScope` 选定的会话粒度：整个会话、单个话题、或会话内的单个发送者。session id 由该键派生（`lark-<key>`），因此跨重启稳定：渠道按接管在线 Agent、恢复已存 session、新建三者的顺序处理。后续消息成为 `agent.followup()` 轮次。

群聊消息带发送者名字前缀，便于模型区分说话人。机器人自己发出的消息，以及只有 @ 没有正文的提及，在授权检查之后被跳过。

</details>

<details>
<summary>出向</summary>

`cot`（默认）用平台自家 Agent 的方式展示执行过程——原生思考过程消息承载推理、每个工具调用带按类别映射的图标、每个结果按代码块渲染；最终答案作为普通 markdown 消息单独发送，这正是平台规定的位置。它要求客户端足够新（PC 7.70、移动端 7.74）；`stream` 则把整轮塞进一张打字机卡片，供旧客户端使用。`showProcess` 可在两种模式下关闭过程展示、只留答案，`hideProcessWhenDone` 让平台在结束后收起过程。平台拒绝创建时答案照常送达。

工具活动的标签取自各工具自己的 `presentCall` 标题，与宿主自有界面显示的一致，依次回落到模型的 `description` 参数、最后是裸工具名。既没有 presenter 也没有 description 的工具仍然只显示名字。工具声明的类别决定图标。

</details>

<details>
<summary>斜杠命令</summary>

以 `/` 开头的一行是控制指令而非提问——宿主不开模型轮次就执行它，因此该部署组合了哪些命令就有哪些——`/compact`、`/plan`、`/permission`、`/export` 等——它们会进入命令运行时，而不是被模型当普通文本读。`/stop` 停止当前轮次（取消是 agent 方法，不是注册命令），`/help` 列出本会话可用的命令。`/cd` 和 `/ws` 同样是渠道自有命令，且完全不需要 agent——新会话里发 `/cd` 会直接切目录，而不是先在旧目录白建一个会话。无法解析的名字会被明确告知"未知命令"并附上清单，而不是丢给模型。

首次使用时还会把这些命令注册到机器人本身（`syncSlashCommands`），用户在飞书里打 `/` 就能看到菜单；同步是**对齐式**的：缺的建、渠道不再提供的删，因此菜单里不会出现一个点了回"未知命令"的条目。自己维护菜单的部署把同步关掉即可。

</details>

<details>
<summary>图片</summary>

发截图是描述问题最自然的方式，开启后入向图片会被下载、提交到宿主附件存储，并以不透明引用随用户消息进入模型。数量、单张与单条消息的字节上限、可接受的媒体类型都取自该存储。

**默认关闭是刻意的**：不支持图片的路由会拒绝整个请求，而那时图片已经写进会话日志，之后每一轮（包括压缩）都会重发它——一张截图就此终结这个对话。宿主没有提供"该路由是否接受图片"的查询方式，所以由跑在视觉模型上的部署自己开启。无法附加的图片会在文本里留一句说明而不是凭空消失——否则模型会当作自己看过截图来回答。

</details>

<details>
<summary>审批</summary>

本插件拥有的 Agent 的 `approval/request` 问题变成带「允许一次 / 拒绝」按钮的交互卡片；点击即结算宿主 outcome（`allowed-once` / `rejected`），卡片改写为决定结果，被撤回的问题结算为 `cancelled`。其他 Agent 的问题通过 `next()` 交给下一个应答器。

该监听以 prepend 注册，这一点在与 Web 应用同时组合时是关键：Web BFF 会抢答所有带审计的审批且从不 `next()`，按到达顺序排队会让会话侧的审批弹到没人看的浏览器里、而聊天永久等待。

卡片会展示该调用**将要执行的完整参数**（有长度上限），且所有模型撰写的内容（命令、说明）都以 `plain_text` 渲染，无法伪装成卡片自身的标记。能驱动某个会话的人就能作答它的审批——群里即"这个房间"——**结算后的卡片会署名是谁批的**。要求具名审批时配置 `approvers`；来自其他会话的点击一律不计。

</details>

<details>
<summary>授权</summary>

外层边界归平台，本插件只做**收窄**而非把关。租户里谁能私聊到这个机器人，取决于应用的**可用范围**（在开发者后台设置）——那才是私聊的授权决策，在这里重复一遍只会增加摩擦。群聊是有人主动把机器人拉进去的房间，所以那里的关口是"哪些房间"。

所有名单默认为空：`senderAllowlist` 收窄私聊发送者、`groupAllowlist` 收窄房间、`approvers` 收窄谁能作答升级审批。被拒消息在会话里静默忽略、在控制台打印——回复会让机器人变成"谁有权限"的探测器。传输层 policy 会同步收窄到与配置一致，因此被限制的流量在进入本进程前就被拦住。

</details>

<details>
<summary>人类交互</summary>

`ctx.userQuestions` 每个上下文只接受**一个** provider，组合了 Web 应用时它的 BFF 独占该 provider 并抢答所有带 agent 的提问。

`ask_user_question` 因此不走那个 seam：本渠道在**每个会话 Agent 自己的层**里注册同名工具遮蔽它——宿主的分层注册表按就近解析，且只保留 `run_code` 一个名字不可遮蔽，所以这是被承认的一等能力而非取巧。提问变成卡片：模型给的选项渲染成按钮，点击即作答；选项都不合适时直接回复消息，那条消息成为答案而不会另开一轮。轮次被 `/stop` 取消、会话被释放、或长时间无人作答（30 分钟）时，提问以空答案收场并把卡片改写为「已取消」，绝不把轮次永久挂住。宿主的注册表若老到没有 `register`，则回落为拒绝该工具。

`exit_plan_mode` 按同样的方式遮蔽，前提是部署里有 plan 服务可供事后离开规划模式。计划正文作为**普通聊天消息**发出而不是塞进卡片——它是模型写的 markdown，而卡片里的模型文本一律字面渲染，那样会把计划的标题和列表全部抹平——随后的卡片只承载决定。批准时调用 plan 服务自己的公开开关，状态迁移仍归宿主，而不是我们复制一份。用文字作答则把你的话回传给模型作为修改依据；卡片被取消则告诉模型停下等待，而不是再提一遍。

两处遮蔽都不会让兜底失效：宿主注册表老到不支持按 agent 注册时，工具重新回落为拒绝；而那句"这些工具在此不可用"的提示词，只在确实有工具被拒时才出现。

</details>

<details>
<summary>组合与工作区分组</summary>

每个会话 Agent 在创建 `setup` 里加入一个 agent preset（`preset`，默认取 roster 自己的默认值）。组合了 preset roster 的部署把所有模型可见的行放在 agent 平面上，所以不加入任何 preset 的 Agent 到达模型时**一个工具都没有**——而没有工具的模型会把它的原生工具调用标记当纯文本吐出来，什么也调用不了。未知 preset 让创建失败并回报到会话，而不是跑一个无工具的会话。

会话会被登记到其目录对应的工作区记录下（没有记录就注册一个），因为宿主的分组是**登记制**而非按 cwd 推导——没被登记的会话无论 cwd 写什么都会落在 GUI 的「未分组」里。会话的 cwd 取工作区自身的规范化路径，那正是 `attachSession` 校验的值。注册表拒绝该目录时只损失分组，聊天照常可用。

</details>

## 已知限制

- 配置在启动时读取一次。两层都生效，组合 patch 与 settings 文档的 `lark-channel` 段（后者更高），但都不监听变更，因此改 `output`、`showProcess` 或授权字段需要重启生效。
- 会话 Agent 存活到插件卸载为止；空闲回收暂缓，长期运行的渠道会为服务过的每个会话各留一个 Agent。
- 重启会恢复已持久化的会话，但停机期间到达的事件不会重放：传输层没有 cursor。
- 文件与音频仅透传 SDK 的归一化文本，文件更合适的归宿通常是 Agent 本来就能读的工作区，而不是塞进请求。图片是例外，会下载并附加。
- 模型将群聊消息视为 `发送者: 文本` 的单用户轮次，除前缀外没有更强的发送者身份。
- 人类交互类工具靠按 agent 遮蔽来接管，而不是占住 `userQuestions` seam：宿主工具注册表若不支持按 agent 注册，它们仍回落为拒绝；计划审阅也需要部署里组合了 plan 服务，才能在批准后离开规划模式。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

测试针对假传输端口和假 `agents` 注册表运行（`tests/harness.ts`），不需要飞书凭证。生产传输通过 `src/runtime.ts` 的 `internals.createPort` 替换。贡献约束见 [AGENTS.md](AGENTS.md)。

## 许可

[BSD-3-Clause](LICENSE)
