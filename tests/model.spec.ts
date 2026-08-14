import { describe, expect, it } from 'vitest'
import {
  ChatModels,
  formatRoute,
  parseRoute,
  resolveRouteInput,
  runModelCommand,
} from '../src/model.ts'
import type { CatalogEntry } from '../src/model.ts'
import { renderStatus } from '../src/status.ts'

const catalog: CatalogEntry[] = [
  { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  { provider: 'pi', id: 'org/shared-model', name: 'Shared A' },
  { provider: 'qi', id: 'org/shared-model', name: 'Shared B' },
]

/** A store recording persisted patches. */
function createStore(options: { entries?: Record<string, string>; persisted?: boolean } = {}) {
  const patches: object[] = []
  const reports: string[] = []
  const store = new ChatModels({
    entries: options.entries,
    persist: async (patch) => {
      patches.push(patch)
      return options.persisted ?? true
    },
    report: (line) => { reports.push(line) },
  })
  return { store, patches, reports }
}

/** Ports over the fixed catalog, counting releases. */
function createPorts(entries: readonly CatalogEntry[] = catalog) {
  const state = { releases: 0 }
  return {
    state,
    ports: {
      catalog: async () => entries,
      deploymentRoute: () => 'deepseek/deepseek-chat',
      release: async () => { state.releases += 1 },
    },
  }
}

describe('routes', () => {
  it('formats full, partial, and absent selections', () => {
    expect(formatRoute({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek/deepseek-chat')
    expect(formatRoute({ model: 'deepseek-chat' })).toBe('deepseek-chat')
    expect(formatRoute({})).toBe('宿主默认')
  })

  it('parses at the FIRST slash, so org/model ids survive the round trip', () => {
    expect(parseRoute('pi/org/shared-model')).toEqual({ provider: 'pi', model: 'org/shared-model' })
    expect(parseRoute('no-slash')).toBeUndefined()
    expect(parseRoute('/leading')).toBeUndefined()
    expect(parseRoute('trailing/')).toBeUndefined()
  })

  it('resolves a bare model id only when exactly one route advertises it', () => {
    expect(resolveRouteInput('deepseek-reasoner', catalog))
      .toEqual({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, listed: true })
    const ambiguous = resolveRouteInput('org/shared-model', catalog)
    // A slash form is taken literally, so this reads as provider 'org' — unlisted.
    expect(ambiguous).toMatchObject({ listed: false })
    const missing = resolveRouteInput('nowhere', catalog)
    expect(missing).toMatchObject({ reason: expect.stringContaining('目录里没有') })
    const noCatalog = resolveRouteInput('anything', [])
    expect(noCatalog).toMatchObject({ reason: expect.stringContaining('provider/model') })
  })

  it('flags a full form the catalog does not advertise, without rejecting it', () => {
    expect(resolveRouteInput('deepseek/brand-new-model', catalog))
      .toEqual({ route: { provider: 'deepseek', model: 'brand-new-model' }, listed: false })
  })
})

describe('ChatModels', () => {
  it('resolves overrides, markers, and unknown keys', () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner', back: '' } })
    expect(store.routeFor('chat')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(store.routeFor('back')).toBeUndefined()
    expect(store.routeFor('fresh')).toBeUndefined()
    expect(store.isDefault('chat')).toBe(false)
  })

  it('persists a set and a reset, skipping unchanged writes', async () => {
    const { store, patches } = createStore()
    expect(await store.set('chat', { provider: 'deepseek', model: 'deepseek-reasoner' }))
      .toMatchObject({ changed: true, durable: true })
    expect(await store.set('chat', { provider: 'deepseek', model: 'deepseek-reasoner' }))
      .toMatchObject({ changed: false })
    expect(await store.reset('chat')).toMatchObject({ changed: true })
    expect(patches).toEqual([
      { chatModels: { chat: 'deepseek/deepseek-reasoner' } },
      { chatModels: { chat: '' } },
    ])
  })

  it('reports once when switches are not durable', async () => {
    const { store, reports } = createStore({ persisted: false })
    await store.set('chat', { provider: 'a', model: 'b' })
    await store.set('chat', { provider: 'c', model: 'd' })
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

describe('runModelCommand', () => {
  it('shows the current route and the catalog for a bare /model', async () => {
    const { store } = createStore()
    const { ports } = createPorts()
    const reply = await runModelCommand('/model', 'chat', store, ports)
    expect(reply).toContain('deepseek/deepseek-chat（默认）')
    expect(reply).toContain('deepseek/deepseek-reasoner')
    expect(reply).toContain('DeepSeek Reasoner')
  })

  it('switches on use, releasing so the same session resumes on the new route', async () => {
    const { store, patches } = createStore()
    const { ports, state } = createPorts()
    const reply = await runModelCommand('/model use deepseek-reasoner', 'chat', store, ports)
    expect(reply).toContain('已切换到 `deepseek/deepseek-reasoner`')
    expect(reply).toContain('上下文保留')
    expect(state.releases).toBe(1)
    expect(patches).toEqual([{ chatModels: { chat: 'deepseek/deepseek-reasoner' } }])
  })

  it('does not release when nothing changed or the input failed to resolve', async () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner' } })
    const { ports, state } = createPorts()
    await runModelCommand('/model use deepseek/deepseek-reasoner', 'chat', store, ports)
    await runModelCommand('/model use nowhere', 'chat', store, ports)
    expect(state.releases).toBe(0)
  })

  it('notes an unlisted route instead of rejecting it, per the advisory contract', async () => {
    const { store } = createStore()
    const { ports } = createPorts()
    const reply = await runModelCommand('/model use deepseek/brand-new', 'chat', store, ports)
    expect(reply).toContain('已切换到')
    expect(reply).toContain('目录未列出该路由')
  })

  it('resets to the deployment default, and reports usage for anything else', async () => {
    const { store } = createStore({ entries: { chat: 'deepseek/deepseek-reasoner' } })
    const { ports, state } = createPorts()
    const reply = await runModelCommand('/model reset', 'chat', store, ports)
    expect(reply).toContain('已切回默认模型')
    expect(state.releases).toBe(1)
    expect(await runModelCommand('/model reset', 'chat', store, ports)).toContain('已在使用默认模型')
    expect(await runModelCommand('/model frobnicate', 'chat', store, ports)).toContain('用法')
  })
})

describe('renderStatus', () => {
  it('states routing, activity, and approvals only when pending', () => {
    const idle = renderStatus({
      workspace: '/srv/work',
      workspaceIsDefault: true,
      route: 'deepseek/deepseek-chat',
      routeIsDefault: true,
      sessionId: 'lark-oc_1',
      bound: true,
      running: false,
      pendingApprovals: 0,
      version: '0.0.3',
    })
    expect(idle).toContain('`/srv/work`（默认）')
    expect(idle).toContain('版本：`0.0.3`')
    expect(idle).toContain('空闲')
    expect(idle).not.toContain('待审批')

    const busy = renderStatus({
      workspace: '/srv/other',
      workspaceIsDefault: false,
      route: 'pi/org/shared-model',
      routeIsDefault: false,
      sessionId: 'lark-oc_1--abc',
      bound: true,
      running: true,
      pendingApprovals: 2,
      version: '0.0.3',
    })
    expect(busy).toContain('运行中')
    expect(busy).toContain('待审批：2 个')

    const fresh = renderStatus({
      workspace: '/srv/work',
      workspaceIsDefault: true,
      route: 'deepseek/deepseek-chat',
      routeIsDefault: true,
      sessionId: 'lark-oc_2',
      bound: false,
      running: false,
      pendingApprovals: 0,
      version: '',
    })
    expect(fresh).toContain('尚未创建')
    // An unknown version hides the row rather than printing an empty claim.
    expect(fresh).not.toContain('版本')
  })
})
