/**
 * Boot backfill: cursor store, message normalization, the list sweep, and the
 * live-path claim that keeps one message from being handled twice.
 */

import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '@larksuite/channel'
import {
  BACKFILL_OVERLAP_MS,
  createBackfillStore,
  extractText,
  runBackfill,
  type MessageLister,
} from '../src/backfill.ts'
import { fakeMessage, mountChannel } from './harness.ts'

/** A minimal lister serving scripted pages per chat. */
function stubLister(pagesByChat: Record<string, Array<Record<string, unknown>[] | { error: number; msg: string }>>) {
  const calls: string[] = []
  const lister: MessageLister = {
    request: async (payload) => {
      calls.push(payload.url)
      const containerId = decodeURIComponent(payload.url.match(/container_id=([^&]+)/)?.[1] ?? '')
      const pageToken = decodeURIComponent(payload.url.match(/page_token=([^&]+)/)?.[1] ?? '')
      const pages = pagesByChat[containerId] ?? []
      const index = pageToken === '' ? 0 : Number.parseInt(pageToken, 10)
      const page = pages[index]
      if (page === undefined) return { data: { items: [], has_more: false } }
      if ('error' in page) return { code: (page as { error: number }).error, msg: (page as { msg: string }).msg }
      const next = pages[index + 1]
      return {
        data: {
          items: page as Record<string, unknown>[],
          has_more: next !== undefined,
          page_token: next === undefined ? undefined : String(index + 1),
        },
      }
    },
  }
  return { lister, calls }
}

/** One list item the way the message-list API reports it. */
function listed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'om_1',
    chat_id: 'oc_chat_1',
    msg_type: 'text',
    create_time: '1787215913000',
    sender: { id: 'ou_sender_1', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'hello' }) },
    ...overrides,
  }
}

describe('extractText', () => {
  it('reads a text message body', () => {
    expect(extractText('text', JSON.stringify({ text: '排查系统状态' }))).toBe('排查系统状态')
  })

  it('reads a post body, localized or not', () => {
    const post = JSON.stringify({
      zh_cn: {
        title: '标题',
        content: [[{ tag: 'text', text: '第一段' }, { tag: 'text', text: '第二段' }]],
      },
    })
    expect(extractText('post', post)).toBe('标题\n第一段\n第二段')
    const plain = JSON.stringify({ title: 't', content: [[{ tag: 'text', text: 'x' }]] })
    expect(extractText('post', plain)).toBe('t\nx')
  })

  it('returns empty for malformed or non-text bodies', () => {
    expect(extractText('text', 'not json')).toBe('')
    expect(extractText('text', undefined)).toBe('')
    expect(extractText('image', JSON.stringify({ image_key: 'k' }))).toBe('')
  })
})

describe('createBackfillStore', () => {
  it('claims each id once and advances the cursor to the newest time', () => {
    const patches: object[] = []
    const store = createBackfillStore({
      initial: {},
      persistState: async (patch) => { patches.push(patch); return true },
      notify: () => {},
    })
    expect(store.observe('om_1', 'oc_1', 100)).toBe(true)
    expect(store.observe('om_1', 'oc_1', 200)).toBe(false)
    expect(store.observe('om_2', 'oc_1', 50)).toBe(true)
    expect(store.seen('om_1')).toBe(true)
    expect(store.cursor('oc_1').lastSeenMs).toBe(100)
  })

  it('bounds recent ids and flushes the cursor patch on demand', () => {
    const patches: object[] = []
    const store = createBackfillStore({
      initial: { oc_1: { lastSeenMs: 10, recentIds: ['om_old'] } },
      persistState: async (patch) => { patches.push(patch); return true },
      notify: () => {},
      recentIds: 2,
      persistDebounceMs: 60_000,
    })
    // The persisted recent ids seed the seen set across restarts.
    expect(store.seen('om_old')).toBe(true)
    store.observe('om_a', 'oc_1', 20)
    store.observe('om_b', 'oc_1', 30)
    store.observe('om_c', 'oc_1', 40)
    store.flush()
    expect(patches).toHaveLength(1)
    const entry = (patches[0] as { chatBackfill: Record<string, { lastSeenMs: number; recentIds: string[] }> })
      .chatBackfill['oc_1']!
    expect(entry.lastSeenMs).toBe(40)
    // Bounded to the newest two.
    expect(entry.recentIds).toEqual(['om_b', 'om_c'])
  })
})

describe('runBackfill', () => {
  it('lists from the cursor minus the overlap window and ingests only unseen text', async () => {
    const { lister, calls } = stubLister({
      oc_chat_1: [
        [
          // Own bot message: skipped, but recorded.
          listed({ message_id: 'om_self', sender: { id: 'ou_bot', sender_type: 'app' }, create_time: '1787215913100' }),
          // Already seen (persisted from the previous process): skipped.
          listed({ message_id: 'om_seen', create_time: '1787215913200' }),
          // Deleted: skipped entirely.
          listed({ message_id: 'om_deleted', deleted: true, create_time: '1787215913300' }),
          // Media: recorded but not ingested.
          listed({ message_id: 'om_media', msg_type: 'image', create_time: '1787215913400', body: { content: JSON.stringify({ image_key: 'k' }) } }),
          // Two recoverable messages, oldest first.
          listed({ message_id: 'om_new_1', create_time: '1787215913500', body: { content: JSON.stringify({ text: '第一条' }) } }),
          listed({ message_id: 'om_new_2', msg_type: 'post', create_time: '1787215913600', body: { content: JSON.stringify({ content: [[{ tag: 'text', text: '第二条' }]] }) } }),
        ],
      ],
    })
    const ingested: NormalizedMessage[] = []
    const store = createBackfillStore({
      initial: { oc_chat_1: { lastSeenMs: 1787215910000, recentIds: ['om_seen'] } },
      persistState: async () => true,
      notify: () => {},
    })
    const notices: string[] = []
    const recovered = await runBackfill({
      lister,
      chats: ['oc_chat_1'],
      ownBotId: 'ou_bot',
      ingest: async (msg) => { ingested.push(msg) },
      store,
      notify: (line) => { notices.push(line) },
      overlapMs: BACKFILL_OVERLAP_MS,
    })
    expect(recovered).toBe(2)
    expect(ingested.map((msg) => msg.content)).toEqual(['第一条', '第二条'])
    // Oldest first, both carrying the chat they were listed under.
    expect(ingested.map((msg) => msg.messageId)).toEqual(['om_new_1', 'om_new_2'])
    expect(ingested[0]!.chatId).toBe('oc_chat_1')
    expect(ingested[1]!.threadId).toBeUndefined()
    // The list call started just before the cursor, minus the overlap window.
    const expectedStart = Math.floor((1787215910000 - BACKFILL_OVERLAP_MS) / 1000)
    expect(calls[0]).toContain('container_id=oc_chat_1')
    expect(calls[0]).toContain('start_time=' + expectedStart)
    expect(calls[0]).toContain('sort_type=ByCreateTimeAsc')
    expect(calls[0]).toContain('page_size=50')
    // Media counted, seen counted, and the summary landed on the console.
    expect(notices.join('\n')).toContain('2 recovered')
    expect(notices.join('\n')).toContain('1 media skipped')
    expect(notices.join('\n')).toContain('2 already seen')
    // The cursor advanced past the newest recovered message.
    expect(store.cursor('oc_chat_1').lastSeenMs).toBeGreaterThanOrEqual(1787215913600)
  })

  it('pages through has_more and tolerates one failed ingest', async () => {
    const { lister, calls } = stubLister({
      oc_chat_1: [
        [listed({ message_id: 'om_p1', create_time: '1787215913500', body: { content: JSON.stringify({ text: 'p1' }) } })],
        [listed({ message_id: 'om_p2', create_time: '1787215913600', body: { content: JSON.stringify({ text: 'p2' }) } })],
      ],
    })
    const ingested: string[] = []
    const notices: string[] = []
    const recovered = await runBackfill({
      lister,
      chats: ['oc_chat_1'],
      ingest: async (msg) => {
        if (msg.messageId === 'om_p1') throw new Error('agent blew up')
        ingested.push(msg.messageId)
      },
      store: createBackfillStore({ initial: {}, persistState: async () => true, notify: () => {} }),
      notify: (line) => { notices.push(line) },
    })
    expect(recovered).toBe(1)
    expect(ingested).toEqual(['om_p2'])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('page_token=1')
    expect(notices.join('\n')).toContain('backfill ingest failed for om_p1')
  })

  it('reports list failures instead of vanishing', async () => {
    const { lister } = stubLister({ oc_chat_1: [{ error: 99991401, msg: 'permission denied' }] })
    const notices: string[] = []
    await expect(runBackfill({
      lister,
      chats: ['oc_chat_1'],
      ingest: async () => {},
      store: createBackfillStore({ initial: {}, persistState: async () => true, notify: () => {} }),
      notify: (line) => { notices.push(line) },
    })).rejects.toThrow('backfill list failed in oc_chat_1')
  })
})

describe('live-path claim', () => {
  it('handles a message the transport delivers exactly once, even when replayed', async () => {
    const harness = await mountChannel(
      { groupAllowlist: ['oc_chat_1'], requireMention: false },
      { rawRequest: async () => ({ data: { items: [], has_more: false } }) },
    )
    try {
      const msg = fakeMessage({ chatId: 'oc_chat_1', chatType: 'group', messageId: 'om_dup', content: 'once' })
      await harness.fake.emitMessage(msg)
      await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
      // The same id again — e.g. the backfill race where a message straddles
      // the reconnect boundary — must not start a second turn.
      await harness.fake.emitMessage(msg)
      await new Promise((done) => { setTimeout(done, 50) })
      expect(harness.agents.created).toHaveLength(1)
      expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1)
    } finally {
      await harness.dispose()
    }
  })
})
