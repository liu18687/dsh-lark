# Changelog

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
