# Changelog

## Unreleased

### Added
- Model questions reach the chat as cards. `ask_user_question` is shadowed in each chat agent's own layer — the host's layered tool registry resolves the nearest registration and reserves only `run_code` from shadowing — so the model's options render as buttons and a click answers them; when no option fits, an ordinary reply is the answer and does not start another turn. Cancellation, session release, and a thirty-minute silence all settle the question empty and repaint its card, so a turn is never hung on one. `ask_user_question` accordingly leaves the default `denyTools`.
- Plan review reaches the chat. `exit_plan_mode` is shadowed per chat agent the same way the question tool is, wherever a plan service exists to leave plan mode afterwards: the plan is sent as an ordinary message so its markdown renders, and the decision follows as a card. Approval calls the plan service's own public switch rather than a copy of its state machine; words typed instead go back to the model as feedback, and a dismissed review tells it to stop and wait rather than present again. `denyTools` is empty by default as a result.
- `/model` answers with a picker over the advertised routes — the route in use states itself instead of offering a press, and a conversation that left the default gets a way back — while `/model use <provider/model>` and `/model reset` stay exactly as they were, for anyone who already knows the route. `/status` answers with a readout of what the next message will do, and a refresh that re-reads live state rather than repainting a snapshot. Both cards carry the conversation they govern, so a forwarded card governs nothing and a per-sender conversation cannot be switched by someone else in the room.

### Changed
- Every interactive card rebuilt on one visual language: a semantic ink per state, one type role per purpose, a 20px grid, and copy that names the action rather than the gesture. Options that carry an explanation become full-width clickable rows so the reason sits inside the thing you press, instead of a legend below it. This channel's own copy is bilingual and ships an `i18n` map per string, so one card serves a mixed room in each reader's language, while model-authored text stays literal and untranslated — rewriting a command would be a lie about what runs.

### Fixed
- The bot's slash panel is published from a RESUMED session too, not only a fresh one. A chat that already had a durable session never took the create rung again, so the panel froze at whatever the channel offered the day that session began: every command added later worked when typed and was invisible to anyone who reached for `/`.
- A tool whose per-agent shadow could not be registered is denied again, and the guard that enforces it is installed whenever anything is actually denied. It used to be keyed on the CONFIGURED deny list, so an empty one skipped installing the guard the fallback depends on.
- Concurrency hardening across the bridge, closing six verified races. Inbound handling returns its promise to the transport, restoring the SDK's per-chat serialization that a voided promise had discarded. Approval questions copy an immutable call snapshot — keyed by session and cleaned per turn — so a card can never show one session's command while approving another's, and live as a small state machine registered before the card send, so an abort before, during, or after the send settles exactly once and repaints the card. Conversation releases advance a generation synchronously, so a walk that a release supersedes disposes its own product and retries instead of handing out a dying agent. Binding creation is single-flight. Reply targets correlate through the host's `user/message` events — a turn may consume several queued messages, and the answer follows the message actually consumed (the last of several), never arrival order; a turn that claims no message sends unaimed rather than guessing.
- The reconnect watchdog now spends a budget: the platform meters connection attempts, so a never-resolving outage would have had it rebuilding forever. Ten rebuilds per thirty minutes are admitted — comfortably above what the backoff produces for a genuinely degraded link — and beyond that it pauses, says for how long, and resumes when the window slides, rather than burning the quota.
- A reconnect watchdog supervises the transport's own recovery promise: the SDK's reconnect loop has terminal states (source-verified give-up paths, and a hang that schedules nothing), which left a live process with a silently dead lifeline for hours. A `reconnecting` not followed by `reconnected` within the deadline now rebuilds the transport through its public lifecycle, retrying under capped backoff and never going silent.
- Operator console lines carry timestamps; the incident above was dated off a file mtime because the log could not say when its last line was written.

## 0.0.4 — 2026-08-14

### Added
- In-chat workspace switching: `/cd <path|name>` points a conversation at a directory and `/ws` lists every workspace the host registry knows, each reachable by bare name. Every (conversation × directory) pair owns a durable session, so returning to a directory resumes the context built there. Switches persist through the settings service, `workspaceRoots` fences where `/cd` may go, the filesystem root / home root / home's parent are never accepted, and both commands run without an agent.
- Per-conversation model switching: `/model` shows the current route and the host llm registry's advertised catalog, `/model use <provider/model|model>` switches from the next message on — the same session resumes under the new route with its context intact — and `/model reset` returns to the deployment default. Switches persist through the settings service; unlisted routes are set with a note, since the host catalog is advisory.
- `/status` reports the conversation's workspace, model route, session id, turn activity, pending approvals, and the running plugin's version — without creating a session to answer.
- A packaging spec packs the real tarball on every `pnpm test`, asserting the emitted runtime files and their relative-import graph ship closed.

### Fixed
- `files` now ships `lib` wholesale: the version helper became a bundler chunk shared by two entries, and the enumerating list did not carry it, so installs crash-looped on `ERR_MODULE_NOT_FOUND`. `prepack` is declared alongside `prepare`.
- A `/cd` or `/model` switch that disposes a mid-turn agent clears the conversation's running mark itself, so `/status` cannot report a disposed turn as still running.
- A message racing a switch's release can no longer be handed an agent mid-disposal: session acquisition re-derives the id and self-heals a stale binding.

## 0.0.3 — 2026-08-14

### Fixed
- systemd units now send the bot's console to `~/.dsh-lark-channel.log` instead of the journal, which had left the log file empty on Linux — `start` could never relay the first-run QR code there.
- `start` under systemd now attempts `loginctl enable-linger` and says so when lingering stays off, since a user service otherwise stops at logout.

### Added
- `dsh-lark-channel logs [-f]` prints the bot's recent console output, following it with `-f`.

## 0.0.2 — 2026-08-14

### Added
- A one-command deployment CLI: `npx dsh-lark-channel start` provisions a dedicated profile, runs it in the background under launchd or `systemd --user` from the first moment, and relays the log to the terminal until the QR scan lands. `stop`, `restart`, and `status` manage it afterwards; systems with no supervisor fall back to a foreground run.
- Unit files carry an explicit PATH (a supervisor's stunted default cannot run a `#!/usr/bin/env node` dsh), are user-only, escape everything interpolated, and forward environment-supplied Lark credentials so the supervised process sees them too.
- CI runs typecheck and tests on push and pull request.

## 0.0.1 — 2026-08-14

- First npm release: the Lark/Feishu IM bot channel plugin, installable with `dsh plugin --profile web add dsh-lark-channel` — the registry tarball ships `lib/` prebuilt, so nothing compiles on install.
