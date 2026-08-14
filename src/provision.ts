/**
 * One-command deployment for a standalone bot. `dsh plugin`, profiles, and unit
 * files are host or operating-system vocabulary, and someone who only wants a
 * chat bot should not have to learn any of it: `start` provisions a dedicated
 * profile, hands it to the platform supervisor, and streams the first run to the
 * terminal so the QR code is scanned where a person is actually looking. Once
 * the scan lands, the command returns and the bot keeps running.
 *
 * Backgrounding from the first moment — rather than running in the foreground
 * and migrating later — is what makes that one command. There is no second step
 * to forget, and the process the operator scanned into is the same one that
 * survives the terminal closing. Where no supervisor exists (Windows, a Linux
 * without systemd), `start` degrades to a foreground run instead of a dead end.
 *
 * The profile stays an ordinary profile rather than a hidden invention. `dsh
 * --profile <name>` keeps working on it, and everything the host documents about
 * composition, settings, and credentials still applies.
 *
 * Unit files carry no model key — that always resolves inside the host through
 * `ctx.credentials` — and no Lark secret either, with one exception: an operator
 * who supplies `LARK_APP_ID`/`LARK_APP_SECRET` through the environment gets them
 * copied into the unit, because a supervisor starts the process with no shell
 * environment and the shipped patch reads exactly those variables. Units are
 * written user-only (0600) for that reason.
 * @module dsh-lark-channel/provision
 */

import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Profile created when the operator names none. */
export const DEFAULT_PROFILE = 'lark'

/** Reverse-DNS label shared by the launchd job and the systemd unit. */
export const SERVICE_LABEL = 'dev.omdsh.dsh-lark'

/** Composition row id this plugin owns, and its section name in the settings document. */
export const ROW_ID = 'lark-channel'

/** How long `start` watches for a scan before leaving the operator to it. */
export const ONBOARDING_WATCH_MS = 10 * 60 * 1000

/** Log size past which `start` truncates it, since no supervisor rotates it. */
export const LOG_TRUNCATE_BYTES = 10 * 1024 * 1024

/** What the operator asked for, after argument parsing. */
export type Command =
  | { readonly kind: 'start'; readonly profile: string; readonly workspace: string }
  | { readonly kind: 'stop' | 'restart' | 'status' }
  | { readonly kind: 'help' }

/** App credentials the operator supplied through the environment. */
export interface EnvCredentials {
  readonly appId: string
  readonly appSecret: string
}

/** Everything a unit file needs, resolved once so both writers agree. */
export interface ServiceSpec {
  /** Absolute path to `dsh`: a supervisor inherits no PATH worth trusting. */
  readonly dsh: string
  /** Profile to boot. */
  readonly profile: string
  /** Directory the host treats as the default workspace root. */
  readonly workspace: string
  /** `$DSH_HOME` when the operator set one, so the service reads the same home. */
  readonly dshHome?: string | undefined
  /** Environment-supplied app credentials, forwarded so the service sees them too. */
  readonly credentials?: EnvCredentials | undefined
}

/** Usage text, printed for `help`. */
export const USAGE = `dsh-lark-channel — Lark/Feishu IM bot channel for DeepSeek Harness

  dsh-lark-channel start [--profile <name>] [--workspace <dir>]
      Provision a profile, run it in the background under launchd or
      systemd --user, and show the first-run QR code here until it is
      scanned. Re-running start applies updates by restarting the bot.

  dsh-lark-channel stop        Stop the bot and remove it from the supervisor;
                               the profile and its credentials stay.
  dsh-lark-channel restart     Restart the running bot.
  dsh-lark-channel status      Report what the supervisor is running.

Options
  --profile <name>    Profile to create and boot. Default: ${DEFAULT_PROFILE}
  --workspace <dir>   Workspace root handed to the host. Default: the current directory

Where neither launchd nor systemd exists, start runs in the foreground instead.
`

/**
 * This package's version, so a profile receives the plugin build that matches
 * the CLI the operator just ran. Read through `import.meta.url` rather than a
 * bare specifier: the bundler leaves a runtime URL alone, and both `src/` and
 * the published `lib/` sit one directory below the manifest.
 * @returns the version string from this package's manifest.
 */
export function ownVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return manifest.version
}

/**
 * Parse argv into one command, defaulting a bare invocation to `start` so
 * `npx dsh-lark-channel` on its own does the useful thing.
 * @param argv - arguments after the node executable and the script path.
 * @returns the parsed command.
 * @throws when a verb or flag is unknown, or a flag's value is missing.
 */
export function parseArguments(argv: readonly string[]): Command {
  const verb = argv[0]
  if (verb === 'help' || verb === '--help' || verb === '-h') return { kind: 'help' }
  if (verb === 'stop' || verb === 'restart' || verb === 'status') {
    if (argv.length > 1) throw new Error(`${verb} takes no options`)
    return { kind: verb }
  }
  if (verb !== undefined && verb !== 'start' && !verb.startsWith('-')) {
    throw new Error(`unknown command ${verb}`)
  }

  const options = verb === 'start' ? argv.slice(1) : argv
  let profile = DEFAULT_PROFILE
  let workspace = process.cwd()
  for (let index = 0; index < options.length; index += 1) {
    const flag = options[index]
    const value = options[index + 1]
    if (flag === '--profile') {
      if (value === undefined) throw new Error('--profile needs a name')
      profile = value
      index += 1
    } else if (flag === '--workspace') {
      if (value === undefined) throw new Error('--workspace needs a directory')
      workspace = resolve(value)
      index += 1
    } else {
      throw new Error(`unknown option ${String(flag)}`)
    }
  }
  return { kind: 'start', profile, workspace }
}

/**
 * Locate an executable on PATH without shelling out, so the answer is an
 * absolute path a supervisor can use.
 * @param name - executable name, without a platform extension.
 * @param path - PATH to search; defaults to this process's.
 * @returns the absolute path, or undefined when no entry holds that executable.
 */
export function whichSync(name: string, path = process.env.PATH ?? ''): string | undefined {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined
}

/**
 * Which supervisor this system offers, when it offers one. Linux is only
 * supervised when systemctl exists: a WSL or container without systemd should
 * degrade to a foreground run, not fail on a missing binary.
 * @param platform - platform to answer for; defaults to this process's.
 * @returns the supervisor kind, or undefined when the system has none.
 */
export function supervisorKind(platform: NodeJS.Platform = process.platform): 'launchd' | 'systemd' | undefined {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux' && whichSync('systemctl') !== undefined) return 'systemd'
  return undefined
}

/** The harness home the supervised process will read. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Where a supervised run writes its console output. */
export function logPath(): string {
  return join(homedir(), '.dsh-lark-channel.log')
}

/** Absolute path of the unit file this platform uses. */
export function unitPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    : join(homedir(), '.config', 'systemd', 'user', 'dsh-lark.service')
}

/**
 * Whether the settings document already carries this plugin's section, which is
 * where a completed scan persists its credentials. A top-level key is enough to
 * decide, so no YAML parser — and no dependency on one — is needed.
 * @param document - contents of the settings document.
 * @returns true when the section is present.
 */
export function hasCredentialSection(document: string): boolean {
  return new RegExp(`^${ROW_ID}\\s*:`, 'm').test(document)
}

/**
 * App credentials from the environment, when the operator supplied a complete
 * pair. These must reach the unit file: the CLI seeing them proves nothing
 * about the supervised process, which inherits no shell environment.
 * @param environment - environment to read; defaults to this process's.
 * @returns the pair, or undefined when either half is missing or empty.
 */
export function envCredentials(environment: NodeJS.ProcessEnv = process.env): EnvCredentials | undefined {
  const { LARK_APP_ID: appId, LARK_APP_SECRET: appSecret } = environment
  if (appId === undefined || appId === '' || appSecret === undefined || appSecret === '') return undefined
  return { appId, appSecret }
}

/**
 * Whether a scan is still needed: credentials exist in the environment (the
 * unit forwards them) or a previous scan persisted them through the host
 * settings service.
 * @returns true when the bot already has credentials to connect with.
 */
export function isOnboarded(): boolean {
  if (envCredentials() !== undefined) return true
  try {
    return hasCredentialSection(readFileSync(join(dshHome(), 'settings.yaml'), 'utf8'))
  } catch {
    return false
  }
}

/**
 * PATH for the supervised process. A supervisor starts it with a stunted PATH,
 * and two things break on that: `dsh` is a `#!/usr/bin/env node` script, so a
 * PATH without its interpreter crash-loops the service before it prints
 * anything; and the agent this bot drives runs shell commands, which expect the
 * tools the operator has. So the interpreter's directory and `dsh`'s own lead,
 * and the PATH in force at install time follows — a snapshot of the environment
 * the operator would have started it in by hand.
 * @param dsh - absolute path to the `dsh` executable.
 * @param execPath - the interpreter running this CLI.
 * @param inherited - PATH to append; defaults to this process's.
 * @returns a PATH value for the unit file.
 */
export function servicePath(dsh: string, execPath = process.execPath, inherited = process.env.PATH ?? ''): string {
  const entries = [dirname(dsh), dirname(execPath), ...inherited.split(delimiter), '/usr/bin', '/bin']
  return [...new Set(entries.filter((entry) => entry !== ''))].join(delimiter)
}

/** Environment every unit sets, in a stable order so a rewrite is a no-op. */
function serviceEnvironment(spec: ServiceSpec): ReadonlyArray<readonly [string, string]> {
  const variables: Array<readonly [string, string]> = [['PATH', servicePath(spec.dsh)]]
  if (spec.dshHome !== undefined) variables.push(['DSH_HOME', spec.dshHome])
  if (spec.credentials !== undefined) {
    variables.push(['LARK_APP_ID', spec.credentials.appId], ['LARK_APP_SECRET', spec.credentials.appSecret])
  }
  return variables
}

/** Escape a value for a plist text node, where a bare `&` or `<` breaks the XML. */
function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Quote a value for a systemd unit. `Environment=` takes a space-separated list
 * of assignments — a PATH with a space in it (Visual Studio Code's directory,
 * routinely) shears apart without this — and `ExecStart` tokenizes the same way.
 */
function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * launchd job description for one profile.
 * @param spec - the resolved service description.
 * @returns plist XML.
 */
export function launchdPlist(spec: ServiceSpec): string {
  const pairs = serviceEnvironment(spec)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.dsh)}</string>
    <string>--profile</string>
    <string>${xmlEscape(spec.profile)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(spec.workspace)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${pairs}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath())}</string>
</dict>
</plist>
`
}

/**
 * systemd user unit for one profile.
 * @param spec - the resolved service description.
 * @returns unit file contents.
 */
export function systemdUnit(spec: ServiceSpec): string {
  const environment = serviceEnvironment(spec)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}\n`)
    .join('')
  return `[Unit]
Description=dsh-lark-channel (profile ${spec.profile})
After=network-online.target

[Service]
ExecStart=${systemdQuote(spec.dsh)} --profile ${systemdQuote(spec.profile)}
WorkingDirectory=${spec.workspace}
${environment}Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** Run one command with the operator watching, and fail the CLI when it fails. */
function must(argv: readonly string[], cwd?: string): void {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('empty command')
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? 'by signal'}`)
}

/** Run one command with the operator watching and report its exit code instead of throwing. */
function passthrough(argv: readonly string[], cwd?: string): number {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('empty command')
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

/** Run one command and swallow both its output and its failure. */
function quiet(argv: readonly string[]): void {
  const [command, ...args] = argv
  if (command !== undefined) spawnSync(command, args, { stdio: 'ignore' })
}

/** The launchd domain target for the invoking user. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

/** The supervisor, for commands that manage one and cannot degrade. */
function requireSupervisor(): 'launchd' | 'systemd' {
  const kind = supervisorKind()
  if (kind === undefined) {
    throw new Error('no launchd or systemd on this system — the bot runs in the foreground via `dsh-lark-channel start`')
  }
  return kind
}

/**
 * The `dsh` a unit file can name. npx would be wrong even for the foreground
 * fallback: provisioning and the unit must agree on one executable that exists
 * offline at boot.
 * @returns the absolute path to `dsh`.
 * @throws when PATH holds none, naming the install command that fixes it.
 */
function requireDsh(): string {
  const found = whichSync('dsh')
  if (found === undefined) {
    throw new Error('dsh is not on PATH — install it with `npm i -g @deepseek-ai/dsh`, then run this again')
  }
  return found
}

/** Create the profile when absent, then install the matching plugin version into it. */
function provision(dsh: string, profile: string, workspace: string): void {
  process.stderr.write(`dsh-lark-channel: provisioning profile ${profile}\n`)
  must([dsh, 'plugin', '--profile', profile, 'add', `dsh-lark-channel@${ownVersion()}`], workspace)
}

/** Whether launchd currently holds the job in this user's domain. */
function isLoaded(): boolean {
  return spawnSync('launchctl', ['print', `${guiDomain()}/${SERVICE_LABEL}`], { stdio: 'ignore' }).status === 0
}

/**
 * Remove the job and wait for it to be gone. `bootout` returns before launchd
 * has finished, and bootstrapping over a job still being torn down fails with a
 * bare I/O error, so replacing a running service has to wait for the removal.
 */
async function bootoutAndWait(): Promise<void> {
  quiet(['launchctl', 'bootout', `${guiDomain()}/${SERVICE_LABEL}`])
  for (let attempt = 0; attempt < 40 && isLoaded(); attempt += 1) await delay(250)
}

/** Write a unit readable by its owner alone, since it may carry forwarded credentials. */
function writeUnit(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  chmodSync(path, 0o600)
}

/**
 * Write and load the platform's unit, replacing any previous one. Both branches
 * end in a restart on purpose: `start` is also the upgrade path, and a service
 * left running would keep executing the version from before the provision.
 */
async function superviseService(kind: 'launchd' | 'systemd', spec: ServiceSpec): Promise<void> {
  const path = unitPath()
  if (kind === 'launchd') {
    writeUnit(path, launchdPlist(spec))
    await bootoutAndWait()
    must(['launchctl', 'bootstrap', guiDomain(), path])
  } else {
    writeUnit(path, systemdUnit(spec))
    must(['systemctl', '--user', 'daemon-reload'])
    must(['systemctl', '--user', 'enable', 'dsh-lark.service'])
    must(['systemctl', '--user', 'restart', 'dsh-lark.service'])
  }
}

/** Byte length of the log, or zero when the supervisor has not written one yet. */
function logSize(): number {
  try {
    return statSync(logPath()).size
  } catch {
    return 0
  }
}

/**
 * Copy any log growth past `offset` to this terminal.
 * @param offset - byte offset the previous relay ended at.
 * @returns the offset the next relay should start at.
 */
async function relayNewOutput(offset: number): Promise<number> {
  const size = logSize()
  let from = offset
  if (size < from) from = 0 // The log was truncated or replaced.
  if (size === from) return from
  const handle = await open(logPath(), 'r')
  try {
    const buffer = Buffer.alloc(size - from)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    process.stdout.write(buffer.subarray(0, bytesRead))
    return from + bytesRead
  } finally {
    await handle.close()
  }
}

/**
 * Relay the supervised process's console to this terminal until it has been
 * onboarded, so the QR code is scanned where a person is looking rather than
 * dug out of a log file.
 * @param from - byte offset to start relaying at, so earlier runs stay hidden.
 * @param deadline - epoch milliseconds after which to stop waiting.
 * @returns true when a scan landed, false when the deadline passed first.
 */
async function relayUntilOnboarded(from: number, deadline: number): Promise<boolean> {
  let offset = from
  while (Date.now() < deadline) {
    offset = await relayNewOutput(offset)
    if (isOnboarded()) {
      // Give the host a beat to print its connected line, then drain it too.
      await delay(750)
      await relayNewOutput(offset)
      return true
    }
    await delay(500)
  }
  return false
}

/** Provision, supervise, and stay attached for the first-run scan. */
async function start(profile: string, workspace: string): Promise<void> {
  const dsh = requireDsh()
  const kind = supervisorKind()
  provision(dsh, profile, workspace)

  if (kind === undefined) {
    process.stderr.write('dsh-lark-channel: no launchd or systemd here — running in the foreground, keep this terminal open\n')
    process.exitCode = passthrough([dsh, '--profile', profile], workspace)
    return
  }

  const onboarded = isOnboarded()
  if (logSize() > LOG_TRUNCATE_BYTES) writeFileSync(logPath(), '')
  const from = logSize()
  await superviseService(kind, { dsh, profile, workspace, dshHome: process.env.DSH_HOME, credentials: envCredentials() })
  process.stderr.write(`dsh-lark-channel: running in the background, logs at ${logPath()}\n`)

  if (onboarded) {
    process.stderr.write('dsh-lark-channel: already onboarded — DM the bot or @-mention it in a group\n')
    return
  }

  process.stderr.write('dsh-lark-channel: scan the QR code below in Feishu; Ctrl-C leaves the bot running\n\n')
  const scanned = await relayUntilOnboarded(from, Date.now() + ONBOARDING_WATCH_MS)
  process.stderr.write(scanned
    ? '\ndsh-lark-channel: bound — the bot is live; manage it with stop, restart, and status\n'
    : `\ndsh-lark-channel: still waiting for a scan; the bot keeps issuing codes, follow ${logPath()}\n`)
}

/**
 * Stop the bot and remove its unit. Removal is the point: a booted-out launchd
 * job whose plist stays in LaunchAgents comes back at the next login, which
 * would make "stopped" a lie. The profile and its credentials stay, so `start`
 * brings the same bot back.
 */
function stop(): void {
  const kind = requireSupervisor()
  if (kind === 'launchd') quiet(['launchctl', 'bootout', `${guiDomain()}/${SERVICE_LABEL}`])
  else quiet(['systemctl', '--user', 'disable', '--now', 'dsh-lark.service'])
  rmSync(unitPath(), { force: true })
  if (kind === 'systemd') quiet(['systemctl', '--user', 'daemon-reload'])
  process.stderr.write('dsh-lark-channel: stopped — `dsh-lark-channel start` brings it back\n')
}

/**
 * Restart the supervised process, touching neither the profile nor credentials.
 * `kickstart -k` is launchd's own restart and avoids the unload/load race; it
 * needs a loaded job, so a job that is not running is bootstrapped from its
 * unit instead.
 */
async function restart(): Promise<void> {
  const kind = requireSupervisor()
  if (!existsSync(unitPath())) {
    throw new Error('nothing is installed — run `dsh-lark-channel start` first')
  }
  if (kind === 'launchd') {
    const kicked = spawnSync('launchctl', ['kickstart', '-k', `${guiDomain()}/${SERVICE_LABEL}`], { stdio: 'ignore' })
    if (kicked.status !== 0) {
      await bootoutAndWait()
      must(['launchctl', 'bootstrap', guiDomain(), unitPath()])
    }
  } else {
    must(['systemctl', '--user', 'restart', 'dsh-lark.service'])
  }
  process.stderr.write('dsh-lark-channel: restarted\n')
}

/**
 * Report what the supervisor is running, passing its exit code through — a
 * stopped service is information, not a CLI failure.
 */
function status(): void {
  const kind = requireSupervisor()
  if (kind === 'launchd') {
    if (!isLoaded()) {
      process.stderr.write('dsh-lark-channel: not running — `dsh-lark-channel start` brings it up\n')
      process.exitCode = 3
      return
    }
    process.exitCode = passthrough(['launchctl', 'print', `${guiDomain()}/${SERVICE_LABEL}`])
  } else {
    process.exitCode = passthrough(['systemctl', '--user', 'status', 'dsh-lark.service'])
  }
}

/**
 * Execute one parsed command.
 * @param command - what the operator asked for.
 */
export async function execute(command: Command): Promise<void> {
  if (command.kind === 'help') process.stdout.write(USAGE)
  else if (command.kind === 'start') await start(command.profile, command.workspace)
  else if (command.kind === 'stop') stop()
  else if (command.kind === 'restart') await restart()
  else status()
}

/**
 * Entry point: parse, execute, and turn any failure into a diagnosed nonzero exit.
 * @param argv - arguments after the node executable and the script path.
 */
export async function main(argv: readonly string[]): Promise<void> {
  try {
    await execute(parseArguments(argv))
  } catch (error) {
    process.stderr.write(`dsh-lark-channel: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
