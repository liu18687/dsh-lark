/**
 * The fault-library archiving tool: one troubleshooting conclusion becomes one
 * record in the deployment's Feishu Base, so today's diagnosis is tomorrow's
 * searchable history. The model decides WHEN a finding is worth keeping (the
 * backend-ops skill instructs it); this module decides nothing — it validates
 * the fields and writes the record through \`lark-cli\`.
 * @module dsh-lark-channel/archive
 */

/** The tool name the model sees; listed in denyTools like every other tool. */
export const ARCHIVE_TOOL = 'archive_finding'

/** The Base fields the tool writes; names must match the deployment's table. */
const FIELD_TITLE = '标题'
const FIELD_TIME = '时间'
const FIELD_ENV = '环境'
const FIELD_SERVICE = '服务'
const FIELD_CONCLUSION = '结论'
const FIELD_SUGGESTION = '建议'
const FIELD_EVIDENCE = '证据'
const FIELD_LINK = '话题链接'

/** The environment values the deployment's select field offers. */
const ENVIRONMENTS = new Set(['test', '线上cn', '线上sg'])

/** How long one lark-cli archive call may take. */
const ARCHIVE_TIMEOUT_MS = 30 * 1000

/** A bounded child-process spawn, injected so tests substitute a fake. */
export type ArchiveSpawn = (args: string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>

/** What the bridge lends the tool. */
export interface ArchivePorts {
  readonly baseToken: string | undefined
  readonly tableId: string | undefined
  /** The chat link the record points back at, for the conversation the call came from. */
  readonly chatLinkOf: (sessionId: string) => string | undefined
  /** Operator console line. */
  readonly report: (line: string) => void
  /** Process runner; defaults to lark-cli in PATH. */
  readonly spawn?: ArchiveSpawn
}

/** One tool call's validated arguments. */
interface ArchiveArguments {
  readonly title: string
  readonly environment: string
  readonly conclusion: string
  readonly service?: string
  readonly suggestion?: string
  readonly evidence?: string
}

/** Trim one argument to the shape a Base cell can hold. */
function cell(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed
}

/** Read and validate the model's arguments; throws what the model should read. */
function argumentsOf(args: unknown): ArchiveArguments {
  const raw = (args ?? {}) as Record<string, unknown>
  const title = cell(String(raw.title ?? ''), 200)
  const environment = cell(String(raw.environment ?? ''), 20)
  const conclusion = cell(String(raw.conclusion ?? ''), 4000)
  if (title === '') throw new Error(ARCHIVE_TOOL + ' requires a 标题')
  if (!ENVIRONMENTS.has(environment)) {
    throw new Error(ARCHIVE_TOOL + ' 环境 must be one of: ' + [...ENVIRONMENTS].join(', '))
  }
  if (conclusion === '') throw new Error(ARCHIVE_TOOL + ' requires a 结论')
  return {
    title,
    environment,
    conclusion,
    ...(raw.service === undefined || String(raw.service) === '' ? {} : { service: cell(String(raw.service), 200) }),
    ...(raw.suggestion === undefined || String(raw.suggestion) === '' ? {} : { suggestion: cell(String(raw.suggestion), 4000) }),
    ...(raw.evidence === undefined || String(raw.evidence) === '' ? {} : { evidence: cell(String(raw.evidence), 4000) }),
  }
}

/** Run lark-cli from PATH, bounded; substituted in tests. */
function defaultSpawn(args: string[]): ReturnType<ArchiveSpawn> {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, ARCHIVE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: stderr + error.message })
    })
  })
}

/**
 * The tool object the host registry takes: name, JSON-schema parameters, a
 * rendered output, and the write itself.
 * @param ports - the deployment's Base destination and process runner.
 * @returns the tool definition.
 */
export function archiveFindingTool(ports: ArchivePorts): object {
  return {
    name: ARCHIVE_TOOL,
    description: '把一次排查/告警的结论归档到飞书多维表格「狂人故障库」：排查完成输出五段式后调用，'
      + '字段：title(标题)、environment(环境: test/线上cn/线上sg)、conclusion(结论)、service(服务,可选)、'
      + 'suggestion(建议,可选)、evidence(证据,可选)。',
    parameters: {
      type: 'object',
      required: ['title', 'environment', 'conclusion'],
      properties: {
        title: { type: 'string', description: '一句话标题，如「aiassistanthub 成功率掉到 80%」' },
        environment: { type: 'string', description: '环境：test / 线上cn / 线上sg' },
        conclusion: { type: 'string', description: '根因结论' },
        service: { type: 'string', description: '涉及的服务名（可选）' },
        suggestion: { type: 'string', description: '修复建议（可选）' },
        evidence: { type: 'string', description: '关键证据摘要：日志/指标片段、时间窗（可选）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['archived'],
        properties: { archived: { type: 'boolean' } },
      },
      render: () => [{ type: 'text', text: '已归档到狂人故障库。' }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ archived: true }> {
      const context = exec as { agent?: { session?: { id?: string } } }
      const sessionId = context.agent?.session?.id
      if (ports.baseToken === undefined || ports.tableId === undefined) {
        throw new Error(ARCHIVE_TOOL + ' is not configured (archiveBaseToken/archiveTableId)')
      }
      const record = argumentsOf(args)
      const link = sessionId === undefined ? undefined : ports.chatLinkOf(sessionId)
      const fields: Record<string, string> = {
        [FIELD_TITLE]: record.title,
        [FIELD_TIME]: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' '),
        [FIELD_ENV]: record.environment,
        [FIELD_CONCLUSION]: record.conclusion,
        ...(record.service === undefined ? {} : { [FIELD_SERVICE]: record.service }),
        ...(record.suggestion === undefined ? {} : { [FIELD_SUGGESTION]: record.suggestion }),
        ...(record.evidence === undefined ? {} : { [FIELD_EVIDENCE]: record.evidence }),
        ...(link === undefined ? {} : { [FIELD_LINK]: link }),
      }
      const spawn = ports.spawn ?? defaultSpawn
      const result = await spawn([
        'base', '+record-upsert',
        '--base-token', ports.baseToken,
        '--table-id', ports.tableId,
        '--json', JSON.stringify(fields),
        '--format', 'json',
      ])
      if (result.code !== 0) {
        const tail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()
        ports.report('lark-channel: ' + ARCHIVE_TOOL + ' failed (exit ' + result.code + '): ' + tail.slice(0, 300))
        throw new Error(ARCHIVE_TOOL + ' 写入失败：' + tail.slice(0, 200))
      }
      ports.report('lark-channel: ' + ARCHIVE_TOOL + ' archived "' + record.title + '" in ' + record.environment)
      return { archived: true }
    },
  }
}
