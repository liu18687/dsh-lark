/**
 * Per-conversation model routing. `/model use` points one conversation at a
 * provider/model route; unlike a workspace switch this keeps the SAME session —
 * a route is an `agentOptions` fact the host accepts on resume, not part of the
 * session's identity — so the conversation continues with its context intact
 * and only the model changes from the next message on.
 *
 * The catalog shown by `/model` comes from the host `llm` registry's own
 * listing. It is advisory by that service's contract: adapters may accept
 * models they do not list, so an unlisted route is set with a note, never
 * rejected.
 *
 * The mapping persists through the host settings service, in the same section
 * as credentials and workspace switches.
 * @module dsh-lark-channel/model
 */

import type { HostAgentOptions } from './host.ts'

/** Show or switch this conversation's model route. Channel-owned: needs no agent. */
export const MODEL_COMMAND = 'model'

/** Entry value marking "explicitly the default": deep-merge persistence cannot delete a key. */
const DEFAULT_MARKER = ''

/** Longest catalog the chat listing renders before summarizing the rest. */
const CATALOG_ROWS = 25

/** One provider/model pair, both halves known. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** One advertised model, as the host llm registry lists it. */
export interface CatalogEntry {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/**
 * Render a route (or a partial deployment selection) for the chat.
 * @param options - provider/model, either possibly absent.
 * @returns `provider/model`, the present half alone, or the host-default label.
 */
export function formatRoute(options: HostAgentOptions): string {
  const parts = [options.provider, options.model].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  return parts.length === 0 ? '宿主默认' : parts.join('/')
}

/**
 * Serialize a route for the persisted entry. The first `/` splits it back
 * apart, so the provider half must not contain one — and host provider route
 * keys do not, while model ids (`org/model` styles) may.
 */
function serializeRoute(route: ModelRoute): string {
  return `${route.provider}/${route.model}`
}

/**
 * Parse one persisted entry back into a route.
 * @param entry - a non-marker entry value.
 * @returns the route, treating everything after the first `/` as the model id.
 */
export function parseRoute(entry: string): ModelRoute | undefined {
  const separator = entry.indexOf('/')
  if (separator <= 0 || separator === entry.length - 1) return undefined
  return { provider: entry.slice(0, separator), model: entry.slice(separator + 1) }
}

/** What one `/model use` or `/model reset` attempt concluded. */
export interface RouteChange {
  /** False when the conversation was already on that route. */
  readonly changed: boolean
  /** Whether the mapping survives a restart. */
  readonly durable: boolean
}

/** Construction options for {@link ChatModels}. */
export interface ChatModelsOptions {
  /** Persisted conversation-key → serialized route; {@link DEFAULT_MARKER} means default. */
  readonly entries?: Record<string, string> | undefined
  /** Deep-merge one patch into the plugin's settings section; false = not composed. */
  readonly persist?: ((patch: { chatModels: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * The per-conversation model state: which route each conversation asked for,
 * against the deployment default meaning "no entry". Pure state plus injected
 * persistence, mirroring the workspace store.
 */
export class ChatModels {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatModels: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  /** The non-durable warning is orientation; once is enough. */
  private warnedNotDurable = false

  constructor(options: ChatModelsOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /** The route one conversation asked for, or undefined for the deployment default. */
  routeFor(key: string): ModelRoute | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined || entry === DEFAULT_MARKER) return undefined
    return parseRoute(entry)
  }

  /** Whether one conversation runs on the deployment default. */
  isDefault(key: string): boolean {
    return this.routeFor(key) === undefined
  }

  /** Point one conversation at a route. */
  async set(key: string, route: ModelRoute): Promise<RouteChange> {
    return this.record(key, serializeRoute(route))
  }

  /** Return one conversation to the deployment default. */
  async reset(key: string): Promise<RouteChange> {
    return this.record(key, DEFAULT_MARKER)
  }

  private async record(key: string, value: string): Promise<RouteChange> {
    const changed = (this.entries.get(key) ?? DEFAULT_MARKER) !== value
    this.entries.set(key, value)
    let durable = true
    if (changed) {
      durable = await this.persist({ chatModels: { [key]: value } }).catch((error: unknown) => {
        this.report(`lark-channel: persisting the model switch failed: ${String(error)}`)
        return false
      })
      if (!durable && !this.warnedNotDurable) {
        this.warnedNotDurable = true
        this.report('lark-channel: model switches are in-memory only (no settings service); they reset on restart')
      }
    }
    return { changed, durable }
  }
}

/** What {@link runModelCommand} needs from the bridge. */
export interface ModelCommandPorts {
  /** The host llm registry's advertised routes; empty when none is composed. */
  readonly catalog: () => Promise<readonly CatalogEntry[]>
  /** The deployment default's display form. */
  readonly deploymentRoute: () => string
  /** Awaited after a change, before the reply; releases the conversation's agent. */
  readonly release: () => Promise<void>
}

/**
 * Resolve the operator's route input against the catalog: a full
 * `provider/model` form is taken as written, and a bare model id is accepted
 * when exactly one advertised route carries it — the same shorthand contract
 * `/cd` uses for directory basenames.
 * @param input - the operator's target exactly as typed.
 * @param catalog - advertised routes.
 * @returns the route with its catalog standing, or the refusal.
 */
export function resolveRouteInput(
  input: string,
  catalog: readonly CatalogEntry[],
): { route: ModelRoute; listed: boolean } | { reason: string } {
  if (input.includes('/')) {
    const route = parseRoute(input)
    if (route === undefined) return { reason: `\`${input}\` 不是合法的 \`provider/model\` 形式。` }
    const listed = catalog.some(entry => entry.provider === route.provider && entry.id === route.model)
    return { route, listed }
  }
  const matches = catalog.filter(entry => entry.id === input)
  if (matches.length === 1 && matches[0] !== undefined) {
    return { route: { provider: matches[0].provider, model: matches[0].id }, listed: true }
  }
  if (matches.length > 1) {
    const rows = matches.map(entry => `- \`${entry.provider}/${entry.id}\``).join('\n')
    return { reason: `模型 \`${input}\` 属于多个 provider：\n${rows}\n请用完整的 \`provider/model\`。` }
  }
  return {
    reason: catalog.length === 0
      ? '本部署没有可枚举的模型目录，请用完整的 `provider/model` 形式。'
      : `目录里没有 \`${input}\`。发 \`/${MODEL_COMMAND}\` 查看可用路由，或用完整的 \`provider/model\`。`,
  }
}

/**
 * Run one `/model` command line and produce the chat reply.
 * @param line - the complete line, slash included.
 * @param key - the conversation the command is about.
 * @param store - the model route state.
 * @param ports - catalog, default display, and the release hook.
 * @returns markdown for the chat.
 */
export async function runModelCommand(
  line: string,
  key: string,
  store: ChatModels,
  ports: ModelCommandPorts,
): Promise<string> {
  const argument = line.trimStart().slice(1 + MODEL_COMMAND.length).trim()
  const [verb, ...rest] = argument.split(/\s+/).filter(part => part !== '')
  const currentRoute = store.routeFor(key)
  const current = currentRoute === undefined
    ? `${ports.deploymentRoute()}（默认）`
    : formatRoute(currentRoute)

  if (verb === undefined) {
    const catalog = await ports.catalog()
    const lines = [`**模型**：\`${current}\``]
    if (catalog.length > 0) {
      const shown = catalog.slice(0, CATALOG_ROWS)
      lines.push('', '**可用路由**')
      for (const entry of shown) {
        const mark = currentRoute !== undefined
          && entry.provider === currentRoute.provider && entry.id === currentRoute.model
          ? '（当前）'
          : ''
        lines.push(`- \`${entry.provider}/${entry.id}\` ${entry.name}${mark}`)
      }
      if (catalog.length > shown.length) lines.push(`…还有 ${catalog.length - shown.length} 个。`)
    }
    lines.push('', `用 \`/${MODEL_COMMAND} use <provider/model 或模型名>\` 切换本会话，\`/${MODEL_COMMAND} reset\` 回默认。`)
    return lines.join('\n')
  }

  if (verb === 'reset') {
    const result = await store.reset(key)
    if (!result.changed) return `🤖 本会话已在使用默认模型 \`${ports.deploymentRoute()}\`。`
    await ports.release()
    return `🤖 已切回默认模型 \`${ports.deploymentRoute()}\`\n下一条消息起生效，上下文保留。${result.durable ? '' : '\n（本部署未组合 settings，这次切换在重启后会丢失。）'}`
  }

  if (verb === 'use') {
    const target = rest.join(' ').trim()
    if (target === '') return `用法：\`/${MODEL_COMMAND} use <provider/model 或模型名>\``
    const resolved = resolveRouteInput(target, await ports.catalog())
    if ('reason' in resolved) return `⚠️ ${resolved.reason}`
    const result = await store.set(key, resolved.route)
    if (!result.changed) return `🤖 本会话已在使用 \`${formatRoute(resolved.route)}\`。`
    await ports.release()
    const advisory = resolved.listed ? '' : '\n（目录未列出该路由；宿主目录是建议性的，仍按你给的设置。）'
    const durability = result.durable ? '' : '\n（本部署未组合 settings，这次切换在重启后会丢失。）'
    return `🤖 已切换到 \`${formatRoute(resolved.route)}\`\n下一条消息起生效，上下文保留。${advisory}${durability}`
  }

  return `用法：\`/${MODEL_COMMAND}\`、\`/${MODEL_COMMAND} use <provider/model>\`、\`/${MODEL_COMMAND} reset\``
}
