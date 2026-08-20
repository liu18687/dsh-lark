import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

describe('thread-bound turns (topic cards)', () => {
  /** Bind one group conversation and return an emitter for its session events. */
  async function groupChat(harness: Awaited<ReturnType<typeof mountChannel>>, msg: ReturnType<typeof fakeMessage>) {
    await harness.fake.emitMessage(msg)
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    const consumed = harness.agents.created[0]!.agent.followup.mock.calls[0]![0]
    harness.ctx.emit('session/event', session, { type: 'user/message', data: { id: consumed.id } })
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('mounts the merged card inside the topic for a main-channel group message', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_root', content: 'nih',
      }))
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '看不懂，问一句。' } })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '这个我没看懂，你是想让我做什么？' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      // The guide reply opens the topic...
      await vi.waitFor(() => { expect(harness.fake.openedThreads).toHaveLength(1) })
      expect(harness.fake.openedThreads[0]!.replyTo).toBe('om_root')
      // ...and no CoT message is created, because the CoT API cannot address
      // a topic. The merged card rides an interactive message instead.
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      expect(harness.fake.cots).toHaveLength(0)
      expect(harness.fake.streams).toHaveLength(0)
      const sent = harness.fake.sent[0]!
      expect(sent.to).toBe('oc_group')
      expect(sent.opts?.replyTo).toBe('om_root')
      expect(sent.opts?.replyInThread).toBe(true)
      const card = (sent.input as { card: { schema: string; body: { elements: Array<Record<string, unknown>> } } }).card
      expect(card.schema).toBe('2.0')
      const [process, answer] = card.body.elements
      // The folded thinking panel comes first, collapsed by default...
      expect(process).toMatchObject({ tag: 'collapsible_panel', expanded: false })
      const panel = process as { header: { title: { content: string } }; elements: [{ content: string }] }
      expect(panel.header.title.content).toContain('思考过程')
      expect(panel.elements[0]!.content).toContain('看不懂，问一句。')
      // ...and the answer is appended after it.
      expect(answer).toMatchObject({ tag: 'markdown', content: '这个我没看懂，你是想让我做什么？' })
    } finally {
      await harness.dispose()
    }
  })

  it('falls back to the ordinary reply when the topic cannot be opened', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_root', content: 'nih',
      }))
      harness.fake.state.failOpenThread = true
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await new Promise((done) => { setTimeout(done, 30) })
      expect(harness.fake.streams).toHaveLength(0)
      expect(harness.fake.sent.map((s) => s.input)).toEqual([{ markdown: '你好' }])
    } finally {
      await harness.dispose()
    }
  })

  it('leaves a silent turn with no topic, no card, and no message', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_root', content: 'hi',
      }))
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '闲聊，静默。' } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await new Promise((done) => { setTimeout(done, 30) })
      expect(harness.fake.openedThreads).toHaveLength(0)
      expect(harness.fake.streams).toHaveLength(0)
      expect(harness.fake.sent).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('mounts the card inside an existing topic, aimed at the message there', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_in', threadId: 'omt_existing', content: '排查一下',
      }))
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '查日志。' } })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'test 环境，成功率掉到 80%。' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      expect(harness.fake.openedThreads).toHaveLength(0)
      expect(harness.fake.cots).toHaveLength(0)
      expect(harness.fake.streams).toHaveLength(0)
      const sent = harness.fake.sent[0]!
      expect(sent.opts?.replyTo).toBe('om_in')
      expect(sent.opts?.replyInThread).toBe(true)
      const card = (sent.input as { card: { body: { elements: Array<Record<string, unknown>> } } }).card
      const [process, answer] = card.body.elements
      expect(process).toMatchObject({ tag: 'collapsible_panel', expanded: false })
      const panel = process as { elements: [{ content: string }] }
      expect(panel.elements[0]!.content).toContain('查日志。')
      expect(answer).toMatchObject({ tag: 'markdown', content: 'test 环境，成功率掉到 80%。' })
    } finally {
      await harness.dispose()
    }
  })
})
