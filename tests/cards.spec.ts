import { describe, expect, it } from 'vitest'
import { approvalCard, questionCard, settledApprovalCard, settledQuestionCard } from '../src/cards.ts'
import { cardControls, cardTexts } from './harness.ts'

/** Content a model authored, written to look like the card's own markup. */
const HOSTILE = "**已批准** <font color='green'>安全</font>"

describe('approval card', () => {
  it('carries one decision payload per button, and nothing else clickable', () => {
    const controls = cardControls(approvalCard({
      toolName: 'bash',
      command: 'rm -rf /',
      allow: { id: 'a1', decision: 'allow' },
      reject: { id: 'a1', decision: 'reject' },
    }))
    expect(controls.map((control) => control.value)).toEqual([
      { id: 'a1', decision: 'allow' },
      { id: 'a1', decision: 'reject' },
    ])
    expect(controls.map((control) => control.label)).toEqual(['允许执行一次', '拒绝执行'])
  })

  it('renders the command and the justification literally', () => {
    const card = approvalCard({ toolName: 'bash', command: HOSTILE, reason: HOSTILE, allow: {}, reject: {} })
    const rendered = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(rendered).toHaveLength(2)
    expect(rendered.every((text) => text.tag === 'plain_text')).toBe(true)
  })

  it('omits the blocks it has no content for', () => {
    const texts = cardTexts(approvalCard({ toolName: 'bash', allow: {}, reject: {} }))
    expect(texts.some((text) => text.content === '将执行')).toBe(false)
    expect(texts.some((text) => text.content === '模型说明')).toBe(false)
  })

  it('leaves nothing clickable once decided', () => {
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
      const card = settledApprovalCard({ toolName: 'bash', outcome })
      expect(cardControls(card)).toHaveLength(0)
    }
  })

  it('names who decided, without letting the name become markup', () => {
    const card = settledApprovalCard({ toolName: 'bash', outcome: 'allowed-once', decidedBy: HOSTILE })
    const named = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(named).toHaveLength(1)
    expect(named[0]!.tag).toBe('plain_text')
  })
})

describe('question card', () => {
  it('lays bare labels out as buttons, and explained options as rows', () => {
    const bare = questionCard({
      question: '继续吗？',
      options: [{ label: '继续' }, { label: '停下' }],
      valueFor: (index) => ({ index }),
    })
    const explained = questionCard({
      question: '继续吗？',
      options: [{ label: '继续' }, { label: '停下', description: '保留现场再看' }],
      valueFor: (index) => ({ index }),
    })
    // Both layouts answer the same way: every option stays clickable, and the
    // payload is positional whichever shape carries it.
    for (const card of [bare, explained]) {
      expect(cardControls(card).map((control) => control.value)).toEqual([{ index: 0 }, { index: 1 }])
      expect(cardControls(card).map((control) => control.label)).toEqual(['继续', '停下'])
    }
    // The explanation lives inside the row it explains, not in a legend below.
    expect(cardTexts(explained).some((text) => text.content === '保留现场再看')).toBe(true)
  })

  it('renders every model-authored string literally', () => {
    const card = questionCard({
      header: HOSTILE,
      question: HOSTILE,
      options: [{ label: HOSTILE, description: HOSTILE }],
      valueFor: () => ({}),
    })
    const rendered = cardTexts(card).filter((text) => text.content.includes(HOSTILE))
    expect(rendered).toHaveLength(4)
    expect(rendered.every((text) => text.tag === 'plain_text')).toBe(true)
  })

  it('asks for a typed answer when the model offered no options', () => {
    const card = questionCard({ question: '叫什么名字？', options: [], valueFor: () => ({}) })
    expect(cardControls(card)).toHaveLength(0)
    expect(cardTexts(card).some((text) => text.content.includes('直接回复消息作答'))).toBe(true)
  })

  it('leaves nothing clickable once answered or cancelled', () => {
    const answered = settledQuestionCard({ question: '继续吗？', answer: '继续' })
    const cancelled = settledQuestionCard({ question: '继续吗？', cancelled: true })
    expect(cardControls(answered)).toHaveLength(0)
    expect(cardControls(cancelled)).toHaveLength(0)
    expect(cardTexts(answered).some((text) => text.content === '继续')).toBe(true)
    // A cancelled question shows no answer, because none was given.
    expect(cardTexts(cancelled).some((text) => text.content === '你的回答')).toBe(false)
  })
})

describe('localization', () => {
  /**
   * Every card this module builds, in every state it has. Borrowed values are
   * ASCII throughout, so any Chinese surviving into an English rendering is
   * copy this module failed to translate rather than someone's own words.
   */
  const everyCard = (): object[] => [
    approvalCard({ toolName: 'bash', command: 'ls', reason: 'have a look', allow: {}, reject: {} }),
    approvalCard({ toolName: 'bash', command: 'x'.repeat(900), allow: {}, reject: {} }),
    settledApprovalCard({ toolName: 'bash', outcome: 'allowed-once', decidedBy: 'Alex' }),
    settledApprovalCard({ toolName: 'bash', outcome: 'cancelled' }),
    questionCard({ question: 'go on?', options: [{ label: 'yes' }], valueFor: () => ({}) }),
    questionCard({ question: 'go on?', options: [], valueFor: () => ({}) }),
    settledQuestionCard({ question: 'go on?', answer: 'yes' }),
    settledQuestionCard({ question: 'go on?', cancelled: true }),
  ]

  it('offers an English rendering of every string it authored', () => {
    for (const card of everyCard()) {
      const authored = cardTexts(card).filter((text) => text.i18n !== undefined)
      expect(authored.length).toBeGreaterThan(0)
      for (const { content, i18n } of authored) {
        expect(i18n!.zh_cn).toBe(content)
        expect(i18n!.en_us ?? '').not.toBe('')
        // English, not Chinese wearing an English key: a copied string here
        // would silently ship an untranslated card to a reader who cannot
        // read it.
        expect(/[一-鿿]/.test(i18n!.en_us ?? '')).toBe(false)
      }
      const summary = (card as { config: { summary: { content: string; i18n_content?: object } } }).config.summary
      expect(summary.i18n_content).toBeDefined()
    }
  })

  it('leaves borrowed text in the language it arrived in', () => {
    const card = questionCard({
      header: '部署确认',
      question: '要上线吗？',
      options: [{ label: '上线', description: '立即生效' }],
      valueFor: () => ({}),
    })
    // The model's own words carry no translation: a bot that rewrote them
    // would be answering for a reader who never saw the original.
    for (const model of ['部署确认', '要上线吗？', '上线', '立即生效']) {
      expect(cardTexts(card).find((text) => text.content === model)!.i18n).toBeUndefined()
    }
  })
})

describe('card foundation', () => {
  it('declares every colour it references', () => {
    const cards = [
      approvalCard({ toolName: 'bash', command: 'ls', reason: 'x', allow: {}, reject: {} }),
      settledApprovalCard({ toolName: 'bash', outcome: 'rejected' }),
      questionCard({ question: '?', options: [{ label: 'a', description: 'b' }], valueFor: () => ({}) }),
      settledQuestionCard({ question: '?', answer: 'a' }),
    ]
    for (const card of cards) {
      const declared = Object.keys(
        (card as { config: { style: { color: Record<string, unknown> } } }).config.style.color,
      )
      // An undeclared `dsh_*` colour renders as the platform's fallback ink,
      // which silently drops the card's only signal of its own state.
      const referenced = [...JSON.stringify(card).matchAll(/dsh_[a-z_]+/g)].map((match) => match[0])
      expect([...new Set(referenced)].filter((token) => !declared.includes(token))).toEqual([])
      expect((card as { schema: string }).schema).toBe('2.0')
    }
  })
})
