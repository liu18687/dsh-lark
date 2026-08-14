# Changelog

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
