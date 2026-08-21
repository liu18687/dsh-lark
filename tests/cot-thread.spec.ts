/**
 * Thread-bound turns: the thinking process is a native CoT message rendered
 * inside the topic (the origin message decides where the platform mounts it),
 * and the answer is a separate message in the same topic.
 */

import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

describe('thread-bound turns (CoT in the topic, answer beside it)', () => {
  /** Bind one group conversation and return an emitter for its session events. */
  async function groupChat(harness: Awaited<ReturnType<typeof mountChannel>>, msg: ReturnType<typeof fakeMessage>) {
    await harness.fake.emitMessage(msg)
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const session = harness.agents.created[0]!.agent.session
    const consumed = harness.agents.created[0]!.agent.followup.mock.calls[0]![0]
    harness.ctx.emit('session/event', session, { type: 'user/message', data: { id: consumed.id } })
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('mounts the CoT inside the topic the guide opens, and answers beside it', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_root', content: 'nih',
      }))
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '看不懂，问一句。' } })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '这个我没看懂，你是想让我做什么？' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      // The guide reply opens the topic, then the CoT mounts with the guide
      // as its origin — the platform renders it inside the topic.
      await vi.waitFor(() => { expect(harness.fake.openedThreads).toHaveLength(1) })
      expect(harness.fake.openedThreads[0]!.replyTo).toBe('om_root')
      await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
      const cot = harness.fake.cots[0]!
      expect(cot.chatId).toBe('oc_group')
      expect(cot.replyTo).toBe(harness.fake.openedThreads[0]!.guideMessageId)
      // No merged interactive card, no stream card: thinking is the CoT.
      expect(harness.fake.sent.some((m) => 'card' in m.input)).toBe(false)
      expect(harness.fake.streams).toHaveLength(0)
      // The buffered process drained into the CoT, and the answer went out as
      // its own message aimed at the topic.
      await vi.waitFor(() => {
        const types = cot.events.map((e) => e.type)
        expect(types).toContain('RUN_STARTED')
        expect(types).toContain('REASONING_MESSAGE_START')
        expect(types).toContain('RUN_FINISHED')
      })
      const answer = harness.fake.sent.find((m) => 'markdown' in m.input)
      expect(answer?.input).toEqual({ markdown: '这个我没看懂，你是想让我做什么？' })
      expect(answer?.opts?.replyTo).toBe('om_root')
      expect(answer?.opts?.replyInThread).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('mounts the CoT inside an existing topic, origin the message there', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_in', threadId: 'omt_existing', content: '排查一下',
      }))
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '查日志。' } })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'test 环境，成功率掉到 80%。' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
      expect(harness.fake.openedThreads).toHaveLength(0)
      const cot = harness.fake.cots[0]!
      expect(cot.replyTo).toBe('om_in')
      const answer = harness.fake.sent.find((m) => 'markdown' in m.input)
      expect(answer?.input).toEqual({ markdown: 'test 环境，成功率掉到 80%。' })
      expect(answer?.opts?.replyTo).toBe('om_in')
      expect(answer?.opts?.replyInThread).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('answers through the ordinary reply path when the topic cannot be opened', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_root', content: 'nih',
      }))
      harness.fake.state.failOpenThread = true
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      expect(harness.fake.cots).toHaveLength(0)
      expect(harness.fake.sent[0]!.input).toEqual({ markdown: '你好' })
    } finally {
      await harness.dispose()
    }
  })

  it('shows a placeholder answer when the turn produced no text, and keeps the CoT', async () => {
    const harness = await mountChannel({ requireMention: false })
    try {
      const emit = await groupChat(harness, fakeMessage({
        chatId: 'oc_group', chatType: 'group', messageId: 'om_root', content: 'hi',
      }))
      emit('step/start', { turn: 1, step: 1 })
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '闲聊。' } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) })
      const placeholder = harness.fake.sent[0]!
      expect(placeholder.input).toEqual({ markdown: '（本轮没有输出文本）' })
      expect(placeholder.opts?.replyTo).toBe('om_root')
      expect(placeholder.opts?.replyInThread).toBe(true)
      // The topic opened and the process card stays: the room saw the bot run.
      expect(harness.fake.openedThreads).toHaveLength(1)
      await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
      expect(harness.fake.deletedCots).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})
