/**
 * The fault-library archiving tool: argument validation, the lark-cli
 * invocation it runs, and its failure reporting.
 */

import { describe, expect, it } from 'vitest'
import { archiveFindingTool, ARCHIVE_TOOL, type ArchiveSpawn } from '../src/archive.ts'

/** One recorded spawn call, and the tool bound to it. */
function harness(ports: Partial<Parameters<typeof archiveFindingTool>[0]> = {}) {
  const calls: string[][] = []
  const lines: string[] = []
  const spawn: ArchiveSpawn = async (args) => {
    calls.push(args)
    return { code: 0, stdout: '{"ok":true}', stderr: '' }
  }
  const tool = archiveFindingTool({
    baseToken: 'SX2ib6puVaIjkWsigIAcN8KRnIb',
    tableId: 'tblxZUcE9WEPpq33',
    chatLinkOf: (sessionId) => sessionId === 'sess_1' ? 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1' : undefined,
    report: (line) => { lines.push(line) },
    spawn,
    ...ports,
  }) as { name: string; execute: (args: unknown, exec: unknown) => Promise<{ archived: boolean }> }
  return { tool, calls, lines, spawn }
}

describe(ARCHIVE_TOOL, () => {
  it('writes one record through lark-cli with the validated fields', async () => {
    const { tool, calls, lines } = harness()
    const result = await tool.execute({
      title: 'aiassistanthub 成功率掉到 80%',
      environment: '线上cn',
      conclusion: '发布窗口内健康检查超时导致重启',
      service: 'aiassistanthub',
      suggestion: '调大健康检查超时',
      evidence: 'grafana 19:40-19:50 成功率曲线',
    }, { agent: { session: { id: 'sess_1' } } })
    expect(result.archived).toBe(true)
    expect(calls).toHaveLength(1)
    const argv = calls[0]!
    expect(argv[0]).toBe('base')
    expect(argv[1]).toBe('+record-upsert')
    const jsonIndex = argv.indexOf('--json')
    const fields = JSON.parse(argv[jsonIndex + 1]!) as Record<string, string>
    expect(fields['标题']).toBe('aiassistanthub 成功率掉到 80%')
    expect(fields['环境']).toBe('线上cn')
    expect(fields['结论']).toBe('发布窗口内健康检查超时导致重启')
    expect(fields['服务']).toBe('aiassistanthub')
    expect(fields['话题链接']).toContain('openChatId=oc_1')
    expect(fields['时间']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(argv).toContain('--base-token')
    expect(argv).toContain('SX2ib6puVaIjkWsigIAcN8KRnIb')
    expect(argv).toContain('--table-id')
    expect(argv).toContain('tblxZUcE9WEPpq33')
    expect(lines.join(' ')).toContain('archived')
  })

  it('omits optional fields the model left empty', async () => {
    const { tool, calls } = harness()
    await tool.execute({ title: 't', environment: 'test', conclusion: 'c' }, { agent: { session: { id: 'sess_1' } } })
    const argv = calls[0]!
    const fields = JSON.parse(argv[argv.indexOf('--json') + 1]!) as Record<string, string>
    expect(fields['服务']).toBeUndefined()
    expect(fields['建议']).toBeUndefined()
    expect(fields['证据']).toBeUndefined()
  })

  it('refuses a record that fails validation', async () => {
    const { tool, calls } = harness()
    await expect(tool.execute({ title: '', environment: 'test', conclusion: 'c' }, {}))
      .rejects.toThrow('标题')
    await expect(tool.execute({ title: 't', environment: 'unknown', conclusion: 'c' }, {}))
      .rejects.toThrow('环境')
    await expect(tool.execute({ title: 't', environment: 'test', conclusion: '' }, {}))
      .rejects.toThrow('结论')
    expect(calls).toHaveLength(0)
  })

  it('refuses when the deployment named no Base table', async () => {
    const { tool } = harness({ baseToken: undefined, tableId: undefined })
    await expect(tool.execute({ title: 't', environment: 'test', conclusion: 'c' }, {}))
      .rejects.toThrow('not configured')
  })

  it('surfaces a failed lark-cli run to the model and the console', async () => {
    let fail = true
    const { tool, lines } = harness({
      spawn: async () => fail
        ? { code: 1, stdout: '', stderr: 'invalid field 环境' }
        : { code: 0, stdout: '{}', stderr: '' },
    })
    await expect(tool.execute({ title: 't', environment: 'test', conclusion: 'c' }, {}))
      .rejects.toThrow('invalid field 环境')
    expect(lines.join(' ')).toContain('failed (exit 1)')
    fail = false
  })
})
