import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE,
  ROW_ID,
  SERVICE_LABEL,
  dshHome,
  envCredentials,
  hasCredentialSection,
  isOnboarded,
  launchdPlist,
  ownVersion,
  parseArguments,
  servicePath,
  supervisorKind,
  systemdUnit,
  whichSync,
} from '../src/provision.ts'
import type { ServiceSpec } from '../src/provision.ts'

/** A spec with every field set, so a writer that drops one is visible. */
const spec: ServiceSpec = {
  dsh: '/usr/local/bin/dsh',
  profile: 'lark',
  workspace: '/srv/work',
  dshHome: '/srv/home',
}

/** Environment keys these tests move, restored after each case. */
const owned = ['DSH_HOME', 'LARK_APP_ID', 'LARK_APP_SECRET'] as const
const saved = new Map(owned.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of owned) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('parseArguments', () => {
  it('defaults a bare invocation to start on the default profile', () => {
    expect(parseArguments([])).toMatchObject({ kind: 'start', profile: DEFAULT_PROFILE })
  })

  it('treats a leading option as start, so flags need no verb', () => {
    expect(parseArguments(['--profile', 'bot'])).toMatchObject({ kind: 'start', profile: 'bot' })
  })

  it('reads the profile and workspace of an explicit start', () => {
    expect(parseArguments(['start', '--profile', 'bot', '--workspace', '/srv/work']))
      .toMatchObject({ kind: 'start', profile: 'bot', workspace: '/srv/work' })
  })

  it('resolves a relative workspace against the invoking directory', () => {
    expect(parseArguments(['start', '--workspace', '.'])).toMatchObject({ workspace: process.cwd() })
  })

  it.each(['stop', 'restart', 'status'] as const)('reads the %s verb', (verb) => {
    expect(parseArguments([verb])).toEqual({ kind: verb })
  })

  it('rejects options on a verb that takes none, rather than ignoring them', () => {
    expect(() => parseArguments(['stop', '--profile', 'bot'])).toThrow(/takes no options/)
  })

  it.each([['help'], ['--help'], ['-h']])('answers %s with the help command', (flag) => {
    expect(parseArguments([flag])).toEqual({ kind: 'help' })
  })

  it('rejects an unknown command or option', () => {
    expect(() => parseArguments(['launch'])).toThrow(/unknown command/)
    expect(() => parseArguments(['start', '--colour'])).toThrow(/unknown option/)
  })

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArguments(['start', '--profile'])).toThrow(/--profile needs a name/)
    expect(() => parseArguments(['start', '--workspace'])).toThrow(/--workspace needs a directory/)
  })
})

describe('whichSync', () => {
  it('returns the absolute path of an executable on the searched PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'which-'))
    const executable = join(directory, 'dsh')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    expect(whichSync('dsh', directory)).toBe(executable)
  })

  it('skips empty entries and directories holding no such executable', () => {
    const empty = mkdtempSync(join(tmpdir(), 'which-'))
    const holder = mkdtempSync(join(tmpdir(), 'which-'))
    const executable = join(holder, 'dsh')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    expect(whichSync('dsh', ['', empty, holder].join(delimiter))).toBe(executable)
  })

  it('returns undefined when nothing on PATH matches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'which-'))
    mkdirSync(join(directory, 'dsh'))
    expect(whichSync('no-such-executable', directory)).toBeUndefined()
  })
})

describe('supervisorKind', () => {
  it('names launchd on macOS and no supervisor on Windows', () => {
    expect(supervisorKind('darwin')).toBe('launchd')
    expect(supervisorKind('win32')).toBeUndefined()
  })
})

describe('onboarding detection', () => {
  it('recognizes this plugin\'s section, and only at the top level', () => {
    expect(hasCredentialSection(`${ROW_ID}:\n  appId: cli_x\n`)).toBe(true)
    expect(hasCredentialSection(`llm-deepseek:\n  thinking: enabled\n${ROW_ID}:\n`)).toBe(true)
    expect(hasCredentialSection('llm-deepseek:\n  note: lark-channel is not configured\n')).toBe(false)
    expect(hasCredentialSection('')).toBe(false)
  })

  it('yields environment credentials only as a complete, non-empty pair', () => {
    expect(envCredentials({})).toBeUndefined()
    expect(envCredentials({ LARK_APP_ID: 'cli_x' })).toBeUndefined()
    expect(envCredentials({ LARK_APP_ID: 'cli_x', LARK_APP_SECRET: '' })).toBeUndefined()
    expect(envCredentials({ LARK_APP_ID: 'cli_x', LARK_APP_SECRET: 's' })).toEqual({ appId: 'cli_x', appSecret: 's' })
  })

  it('treats environment credentials as onboarded, since the unit forwards them', () => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'home-'))
    expect(isOnboarded()).toBe(false)
    process.env.LARK_APP_ID = 'cli_x'
    expect(isOnboarded()).toBe(false)
    process.env.LARK_APP_SECRET = 'secret'
    expect(isOnboarded()).toBe(true)
  })

  it('reads the settings document under the configured home', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    delete process.env.LARK_APP_ID
    delete process.env.LARK_APP_SECRET
    process.env.DSH_HOME = home
    expect(dshHome()).toBe(home)
    expect(isOnboarded()).toBe(false)
    writeFileSync(join(home, 'settings.yaml'), `${ROW_ID}:\n  appId: cli_x\n`)
    expect(isOnboarded()).toBe(true)
  })
})

describe('servicePath', () => {
  it('leads with the interpreter that can run a `#!/usr/bin/env node` dsh', () => {
    const path = servicePath('/opt/nvm/v22/bin/dsh', '/opt/nvm/v22/bin/node', '/usr/bin')
    expect(path.split(delimiter)[0]).toBe('/opt/nvm/v22/bin')
  })

  it('keeps a separately installed interpreter as well as dsh\'s own directory', () => {
    const entries = servicePath('/opt/prefix/bin/dsh', '/opt/nvm/v22/bin/node', '/usr/bin').split(delimiter)
    expect(entries).toContain('/opt/prefix/bin')
    expect(entries).toContain('/opt/nvm/v22/bin')
  })

  it('carries the operator\'s PATH through, so the agent still finds its tools', () => {
    const entries = servicePath('/opt/bin/dsh', '/opt/bin/node', '/opt/homebrew/bin:/usr/bin').split(delimiter)
    expect(entries).toContain('/opt/homebrew/bin')
  })

  it('dedupes and drops empty entries, and always ends up with the system ones', () => {
    const entries = servicePath('/opt/bin/dsh', '/opt/bin/node', '/opt/bin::/usr/bin').split(delimiter)
    expect(entries.filter((entry) => entry === '/opt/bin')).toHaveLength(1)
    expect(entries).not.toContain('')
    expect(entries).toContain('/usr/bin')
    expect(entries).toContain('/bin')
  })
})

describe('unit files', () => {
  it('runs the resolved dsh against the named profile from the workspace', () => {
    const plist = launchdPlist(spec)
    expect(plist).toContain(`<string>${spec.dsh}</string>`)
    expect(plist).toContain(`<string>${spec.profile}</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${spec.workspace}</string>`)
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)

    const unit = systemdUnit(spec)
    expect(unit).toContain(`ExecStart="${spec.dsh}" --profile "${spec.profile}"`)
    expect(unit).toContain(`WorkingDirectory=${spec.workspace}`)
  })

  it('asks the supervisor to keep the bot up', () => {
    expect(launchdPlist(spec)).toContain('<key>KeepAlive</key><true/>')
    expect(launchdPlist(spec)).toContain('<key>RunAtLoad</key><true/>')
    expect(systemdUnit(spec)).toContain('Restart=always')
    expect(systemdUnit(spec)).toContain('WantedBy=default.target')
  })

  it('always carries a PATH, since a supervisor supplies almost none', () => {
    expect(launchdPlist(spec)).toContain('<key>PATH</key>')
    expect(systemdUnit(spec)).toContain('Environment="PATH=')

    const { dshHome: _omitted, ...bare } = spec
    expect(launchdPlist(bare)).toContain('<key>PATH</key>')
    expect(systemdUnit(bare)).toContain('Environment="PATH=')
  })

  it('passes DSH_HOME through only when the operator set one', () => {
    expect(launchdPlist(spec)).toContain('<key>DSH_HOME</key>')
    expect(systemdUnit(spec)).toContain('Environment="DSH_HOME=/srv/home"')

    const { dshHome: _omitted, ...bare } = spec
    expect(launchdPlist(bare)).not.toContain('DSH_HOME')
    expect(systemdUnit(bare)).not.toContain('DSH_HOME')
  })

  it('escapes what each platform would misread', () => {
    const plist = launchdPlist({ ...spec, workspace: '/srv/R&D <lab>' })
    expect(plist).toContain('<key>WorkingDirectory</key><string>/srv/R&amp;D &lt;lab&gt;</string>')
    expect(plist).not.toContain('R&D')

    const unit = systemdUnit({ ...spec, dsh: '/opt/my tools/dsh' })
    expect(unit).toContain('ExecStart="/opt/my tools/dsh"')
  })

  it('forwards app credentials only when the environment supplied them', () => {
    expect(launchdPlist(spec)).not.toContain('LARK_APP_ID')
    expect(systemdUnit(spec)).not.toContain('LARK_APP_ID')

    const armed: ServiceSpec = { ...spec, credentials: { appId: 'cli_x', appSecret: 's&"t' } }
    expect(launchdPlist(armed)).toContain('<key>LARK_APP_ID</key><string>cli_x</string>')
    expect(launchdPlist(armed)).toContain('<key>LARK_APP_SECRET</key><string>s&amp;"t</string>')
    expect(systemdUnit(armed)).toContain('Environment="LARK_APP_SECRET=s&\\"t"')
  })

  it('never carries a model credential, because the host resolves that itself', () => {
    for (const contents of [launchdPlist(spec), systemdUnit(spec)]) {
      expect(contents).not.toContain('DEEPSEEK_API_KEY')
    }
  })
})

describe('ownVersion', () => {
  it('reads this package\'s version, so a profile gets the matching build', () => {
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
