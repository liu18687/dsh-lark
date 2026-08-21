/**
 * Card text extraction and the bridge's card-entity enrichment: an alert
 * card sent as a card entity must reach the model as words, not as a
 * placeholder it cannot read.
 */

import { describe, expect, it, vi } from 'vitest'
import { extractCardText } from '../src/card-text.ts'
import { fakeMessage, mountChannel } from './harness.ts'

describe('extractCardText', () => {
  it('reads a CardKit 2.0 card, collapsible panels included', () => {
    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '告警标题' } },
      body: {
        elements: [
          {
            tag: 'collapsible_panel',
            header: { title: { tag: 'markdown', content: '**思考过程**' } },
            elements: [{ tag: 'markdown', content: '查了日志，没问题。' }],
          },
          { tag: 'markdown', content: '成功率掉到 80%。' },
          { tag: 'button', text: { tag: 'plain_text', content: '确认' } },
        ],
      },
    }
    const text = extractCardText(JSON.stringify(card))
    expect(text).toContain('告警标题')
    expect(text).toContain('思考过程')
    expect(text).toContain('查了日志，没问题。')
    expect(text).toContain('成功率掉到 80%。')
    expect(text).toContain('确认')
  })

  it('reads a v1 card the platform downgraded', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: '标题' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '磁盘使用率 92%' } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '备注' }] },
      ],
    }
    const text = extractCardText(JSON.stringify(card))
    expect(text).toContain('标题')
    expect(text).toContain('磁盘使用率 92%')
    expect(text).toContain('备注')
  })

  it('deduplicates repeated pieces and tolerates garbage', () => {
    const card = { elements: [{ tag: 'markdown', content: 'x' }, { tag: 'markdown', content: 'x' }] }
    expect(extractCardText(JSON.stringify(card))).toBe('x')
    expect(extractCardText('not json')).toBe('')
    // A bare card-entity reference carries no text at all.
    expect(extractCardText(JSON.stringify({ type: 'card', data: { card_id: 'c' } }))).toBe('')
  })
})

describe('card-entity enrichment', () => {
  it('fetches the card text when the event body holds only a reference', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      harness.fake.port.fetchMessageCard = async () => '[Action Needed] Alert: Process Error - aiassistanthub 成功率掉到 80%'
      await harness.fake.emitMessage(fakeMessage({
        chatId: 'oc_chat_1', chatType: 'group', messageId: 'om_card',
        rawContentType: 'interactive', content: '[interactive card]',
      }))
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      const followup = harness.agents.created[0]!.agent.followup.mock.calls[0]![0] as unknown as {
        content: Array<{ type: string; text?: string }>
      }
      const text = (followup.content ?? []).map((part) => part.text ?? '').join('')
      expect(text).toContain('Process Error')
      expect(text).toContain('成功率掉到 80%')
      expect(text).not.toContain('[interactive card]')
    } finally {
      await harness.dispose()
    }
  })

  it('leaves an unreadable card as the placeholder instead of stalling', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      harness.fake.port.fetchMessageCard = async () => undefined
      await harness.fake.emitMessage(fakeMessage({
        chatId: 'oc_chat_1', chatType: 'group', messageId: 'om_card',
        rawContentType: 'interactive', content: '[interactive card]',
      }))
      await new Promise((done) => { setTimeout(done, 40) })
      // Nothing to read, nothing to start a turn on: no agent was created.
      expect(harness.agents.created).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})
