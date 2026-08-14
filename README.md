# dsh-lark-channel

[![npm](https://img.shields.io/npm/v/dsh-lark-channel)](https://www.npmjs.com/package/dsh-lark-channel) [![CI](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml/badge.svg)](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

English | [中文](README.zh.md)

A Lark/Feishu IM bot channel plugin for DeepSeek Harness. Each chat (direct message or group) drives its own DSH agent; the assistant's reasoning and tool calls show as the platform's native thinking process, the answer is sent separately, and host approval questions become interactive cards decided by button clicks.

Transport is `@larksuite/channel` over a WebSocket long connection, so no public callback URL is needed.

<!-- Screenshots: drop PNGs under .github/assets/ and uncomment.
<p align="center">
  <img src=".github/assets/thinking-process.png" alt="native thinking process" width="45%">
  <img src=".github/assets/approval-card.png" alt="approval card" width="45%">
</p>
-->

- [Features](#features)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Behavior](#behavior)
- [Limitations](#limitations)
- [Development](#development)

## Features

- One agent per conversation. `sessionScope` picks the facet: the whole chat, one topic thread, or one sender inside a shared chat. Session ids are stable across restarts.
- `/cd` points a conversation at a directory; `/ws` lists every workspace the host registry knows, each reachable by bare name. Every (conversation × directory) pair owns a durable session, so coming back to a directory resumes the context built there; switches persist across restarts, `workspaceRoots` can fence where `/cd` may go, and the filesystem root and home are never accepted.
- `/model` shows the current route and the host llm registry's catalog; `/model use <provider/model>` switches this conversation from the next message on — the SAME session resumes under the new route, context intact. `/status` reports workspace, model, session, and turn activity, before a first message exists.
- Two output modes: `cot` uses the platform's native thinking process, `stream` keeps a turn in one typewriter card for older clients.
- A line starting with `/` runs as a host command without a model turn. `/stop` cancels the running turn, `/help` lists what the chat accepts.
- Host approval questions become cards with 允许一次 / 拒绝 buttons; a click settles the outcome and rewrites the card with the decision.
- Images can be turned on: they are downloaded, committed to the host attachment store, and ride the message to the model.
- Every reply is aimed at the message that asked for it, and stays inside that message's topic thread when it had one.
- Authorization narrows within the app's visibility scope; every allowlist is empty by default.
- With no credentials configured, boot draws a QR code; scanning it creates the app through the official flow, event subscription included.

## Requirements

- Node `^22.19.0 || >=24.0.0`, pnpm 11.7.
- A DeepSeek Harness deployment (`dsh` 0.1.0-rc.6 or newer). `@deepseek-ai/cordis` (`^4.0.1`) is a peer dependency supplied by the host.
- A Feishu or Lark tenant. The app itself can be created by the first-boot QR flow.
- `cot` output needs a client new enough to render a thinking process: PC 7.70, mobile 7.74. Older clients use `output: 'stream'`.

## Quickstart

```sh
npx dsh-lark-channel@latest start
```

A QR code appears; scan it in Feishu and the bot is live. It runs in the background from the first moment — under launchd on macOS, `systemd --user` on Linux — so it survives the terminal closing and comes back after a reboot. Then DM it or @-mention it in a group.

`stop`, `restart`, `status`, and `logs` manage it afterwards; re-running `start` applies updates. `dsh` has to be installed (`npm i -g @deepseek-ai/dsh`), since a supervised process cannot depend on npx. Where neither launchd nor systemd exists — Windows, a Linux without systemd — `start` runs in the foreground instead.

Already running `dsh web` and want the channel in that profile instead:

```sh
dsh plugin --profile web add dsh-lark-channel@latest
dsh web
```

The same command upgrades; restart `dsh web` after.

The model key comes from the Settings → Models page under `web`, and from `DEEPSEEK_API_KEY` or the managed `$DSH_HOME/.credentials.yaml` anywhere else.

<details>
<summary>Composition details, the QR window, and the invariant row</summary>

The package manifest declares `dsh.bundle.patch: ./cordis.patch.yml`; installing it into a profile applies the patch rows over the profile composition. Credentials may use `!!js process.env.…` in the patch.

A code expires after the window the platform states, and an unscanned one is replaced automatically, so coming back later still finds a usable code; a refusal or a rejected request stops the flow with its reason and needs a restart to try again. To reset stored credentials, remove the `lark-channel` section from the settings document, whose path prints via the host settings surface; the settings layer overrides entry-config values while present.

The invariant companion row is not part of the default patch: the shipped `web` profile composes no `invariants` service, and a row waiting on an absent service fails the whole tree at boot. `cordis.patch.yml` documents the diagnostic-composition row.

</details>

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR onboarding | Lark/Feishu app credentials. Layering below. |
| `domain` | Feishu | Open-platform domain; set `https://open.larksuite.com` for Lark. |
| `cwd` | host process cwd | Absolute workspace directory for chat-driven agents; the default a `/cd` can always return to. |
| `workspaceRoots` | `[]` | Directory prefixes `/cd` may point a conversation at; empty allows any existing directory. The deployment default is always reachable. |
| `chatWorkspaces` | `{}` | Managed state, not configuration: the directory each conversation was `/cd`-ed to, written back through the settings service. |
| `chatModels` | `{}` | Managed state, not configuration: the `provider/model` route each conversation asked for via `/model use`. |
| `provider`, `model` | host `agentDefaultModel` | Model route for chat agents. |
| `preset` | roster default | Agent preset chat agents join, when the deployment composes a roster. |
| `sessionScope` | `chat` | Which conversation facet owns one agent session: `chat` (one shared agent per chat), `chat-thread` (one per topic thread, so parallel topics stop overwriting each other's context), `chat-sender` (one per person in a shared chat). |
| `output` | `cot` | `cot` (native thinking process + markdown answer) or `stream` (typewriter card per turn). |
| `showProcess` | `true` | Show the agent's reasoning and tool calls; off sends the answer alone. |
| `hideProcessWhenDone` | `false` | Let the platform drop the process once its run finishes (`cot` only). |
| `attachImages` | `false` | Pass images on to the model. Only for a route that accepts them: one rejected image ends the conversation. |
| `syncSlashCommands` | `true` | Register the chat's commands on the bot so Feishu offers them when a user types `/`. |
| `denyTools` | `['ask_user_question', 'exit_plan_mode']` | Tools chat agents may not call, denied per agent at execution. The default names the human-interaction tools whose answers cannot reach this channel. |
| `requireMention` | `true` | In group chats, only respond when @-mentioned. |
| `senderAllowlist` | `[]` | Open ids allowed to send direct messages; empty serves anyone the app is visible to. |
| `groupAllowlist` | `[]` | When non-empty, only these `oc_…` group chats are served; empty serves any group. |
| `approvers` | `[]` | Open ids allowed to answer approvals; empty lets whoever may drive that chat answer. |

With nothing configured the channel serves any room the bot is added to and anyone the app is visible to. Restricting further is the deployment's call: the platform already decides who can reach the bot, and this plugin only narrows what that admits.

Credentials resolve in three layers, each overriding the one before it: entry config in the composition patch, typically `!!js process.env.LARK_APP_ID`; the `lark-channel` section of the settings document, which wins while present; and first-boot QR onboarding when neither carries one, whose result persists through the host `settings` service.

Configuration is read once at startup, see [Limitations](#limitations).

## Behavior

The repository is self-contained: it builds against the published `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` packages, never a host source checkout, and reaches host services (`agents`, `agentPresets`, `agentDefaultModel`, `settings`, `invariants`, `loader`) through narrow local contracts in `src/host.ts`. Every registration is owned by the plugin fiber; disposal disconnects the transport, disposes every chat agent, and settles open approval cards as `cancelled`.

<details>
<summary>Inbound</summary>

Each `message` event is routed to the conversation `sessionScope` selects — the chat, one topic thread, or one sender within a chat. The session id is derived from that key (`lark-<key>`), so it is stable across restarts: the channel adopts a live agent, resumes a stored session, or creates one, in that order. Later messages become `agent.followup()` turns.

Group messages are prefixed with the sender name so the model can tell voices apart. Messages a bot authored, and mentions carrying no text, are skipped after the authorization check.

</details>

<details>
<summary>Outbound</summary>

`cot` (default) shows the process the way the platform's own agents do — a native thinking-process message carrying reasoning, each tool call with an icon from its kind, and each result as a code block — while the answer is sent as an ordinary markdown message, which is where the platform says a final answer belongs. It needs a client new enough to render one (PC 7.70, mobile 7.74); `stream` keeps the whole turn in one typewriter card for older clients. `showProcess` turns the process off in either mode, leaving the answer alone, and `hideProcessWhenDone` lets the platform drop a finished process. When the platform refuses to open one, the answer still arrives.

Tool activity is labelled from each tool's own `presentCall` title, the label the host's own surfaces show, falling back to the model's `description` argument and then the bare name; its declared kind picks the icon.

</details>

<details>
<summary>Slash commands</summary>

A line beginning with `/` is a control, not a prompt — the host runs it without a model turn, so whatever commands the deployment composed — `/compact`, `/plan`, `/permission`, `/export` and the rest — reach the runtime instead of the model reading them as prose. `/stop` cancels the running turn (cancellation is an agent method, not a registered command) and `/help` lists what the chat accepts. `/cd` and `/ws` are also the channel's own and need no agent at all, so a `/cd` in a fresh chat switches the directory without first spending a session on the one it is leaving. An unresolved name is named as unknown with that listing rather than handed to the model.

On first use the channel also registers those commands on the bot itself (`syncSlashCommands`), so Feishu offers them when a user types `/`. The sync reconciles: it adds what the panel is missing and removes what the channel no longer offers, so the menu never offers a command that answers "unknown". A deployment that curates its own menu turns the sync off.

</details>

<details>
<summary>Images</summary>

A screenshot is how someone shows a problem, so with `attachImages` on, images are downloaded and committed to the host attachment store and ride the user message as opaque references. Bounds come from that store: count, per-image and per-message bytes, accepted media types.

It is off by default because a route that cannot take images rejects the whole request, the image is in the session log by then, and every later request resends it — compaction included — so one screenshot ends that conversation for good. The host exposes no way to ask a route whether it accepts images, so a deployment on a vision route turns this on. An image that cannot be attached leaves a note in the text rather than vanishing — otherwise the model answers as though it had seen one.

</details>

<details>
<summary>Approvals</summary>

`approval/request` questions for agents owned by this plugin become an interactive card with 允许一次 / 拒绝 buttons; the click settles the host outcome (`allowed-once` / `rejected`), the card is rewritten with the decision, and a withdrawn question settles `cancelled`. Questions about other agents delegate to the next composed answerer.

The listener is registered **prepended**, which is load-bearing when the Web app is composed alongside: its BFF claims every audited approval and never delegates, so in arrival order a chat-driven approval would surface in a browser nobody is watching while the chat waited forever.

The card shows the exact arguments the call would run, bounded, and renders every model-authored value (that command, the justification) as `plain_text` so neither can pose as the card's own markup. Whoever may drive a chat may answer its approvals — in a group, the room — and the settled card names who decided. Set `approvers` when an escalation should need a named human; a click from another chat never counts.

</details>

<details>
<summary>Authorization</summary>

The platform owns the outer boundary, and this plugin narrows rather than gates. Who in the tenant can open a conversation with the bot at all is the app's **visibility scope**, set in the developer console — that is the authorization decision for direct messages, and duplicating it here would only add friction. A group is a room someone deliberately put the bot in, so the gate there is which rooms.

Every list is empty by default: `senderAllowlist` narrows direct senders, `groupAllowlist` narrows rooms, `approvers` narrows who may answer an escalation. A refused message is ignored silently in the chat and named on the operator console — answering would make the bot an oracle for who is allowed. The transport policy is narrowed to match whatever is configured, so restricted traffic stops before reaching this process.

</details>

<details>
<summary>Human interaction</summary>

`ctx.userQuestions` admits ONE provider per context, and with the Web app composed its BFF owns it and claims every agent-owned question — so `ask_user_question` and `exit_plan_mode` are denied per chat agent (`denyTools`) with a reason that redirects the model, plus a prompt sentence saying a question belongs in its reply. A chat reply already becomes the next turn, which is the native equivalent.

</details>

<details>
<summary>Composition and workspace grouping</summary>

Each chat agent joins an agent preset (`preset`, default the roster's own default) inside creation `setup`. A deployment with a preset roster keeps every model-facing row on the agent plane, so an agent that joins nothing would reach the model with NO tools — and a model with no tools emits its native tool-call markup as plain text instead of calling anything. An unknown preset fails the creation and is reported to the chat rather than running a toolless session.

Chat sessions are accounted under the workspace record for their directory, registering it when none exists, because host grouping is an account rather than a cwd derivation — an unattached session shows under the GUI's Ungrouped bucket however its cwd reads. The session's cwd is the workspace's own canonical path, which is the value `attachSession` validates against. A registry that refuses the directory only costs grouping; the chat still runs.

</details>

## Limitations

- Configuration is read once at startup. Both layers work, the composition patch and the `lark-channel` section of the settings document, the latter winning, but neither is watched, so a change to `output`, `showProcess`, or the authorization fields applies on the next start.
- Chat agents live until plugin disposal; idle eviction is deferred, so a long-running channel holds one agent per conversation it has served.
- A restart resumes a stored conversation, but nothing that arrived while the process was down is replayed: the transport offers no cursor.
- Files and audio are passed through as the SDK's normalized text only; a file's right home is usually the workspace an agent can already read, not the request. Images are the exception: they are downloaded and attached.
- The model sees group messages as `sender: text` single-user turns; there is no per-sender identity beyond the prefix.
- Question tools are denied rather than answered: the `userQuestions` seam takes one provider per context, so a second UI channel cannot participate. Answering questions as chat cards needs either that seam to route by session owner or a deployment with no other provider.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Tests run against a fake transport port and a fake `agents` registry (`tests/harness.ts`); no Lark credentials are needed. The production transport is substituted through `internals.createPort` in `src/runtime.ts`. Contributor constraints are in [AGENTS.md](AGENTS.md).

## License

[BSD-3-Clause](LICENSE)
