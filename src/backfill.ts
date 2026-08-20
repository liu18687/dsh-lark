/**
 * Boot backfill: recover chat messages that arrived while the long
 * connection was down. Feishu does not replay missed events, so the
 * supervisor's restart window (bootout → bootstrap) would otherwise eat
 * every message sent during it. After the connection settles, this module
 * lists each served group's messages since the stored cursor and feeds the
 * unseen ones through the bridge's normal ingest path — authorization, bot
 * policy, topic handling, and the agent all behave exactly as if the event
 * had arrived live.
 * @module dsh-lark-channel/backfill
 */

import type { NormalizedMessage } from '@larksuite/channel'
import type { ChatBackfillEntry } from './config.ts'

/** How many recent message ids one cursor keeps for cross-restart dedupe. */
export const BACKFILL_RECENT_IDS = 300

/** Re-list this much history before the cursor to catch boundary races. */
export const BACKFILL_OVERLAP_MS = 90 * 1000

/**
 * Most messages one sweep may ingest per chat. A long outage would otherwise
 * burst dozens of turns at once; the remainder rides the next sweep minutes
 * later.
 */
export const BACKFILL_MAX_PER_SWEEP = 30

/**
 * The transport surface the backfill lists messages through. The production
 * port's \`rawClient\` satisfies it; tests substitute a stub.
 */
export interface MessageLister {
  request(payload: { method: string; url: string; data?: unknown }): Promise<unknown>
}

/** One message as the list API reports it; only the fields backfill reads. */
interface ListedMessage {
  message_id?: string
  thread_id?: string
  root_id?: string
  parent_id?: string
  msg_type?: string
  create_time?: string
  deleted?: boolean
  sender?: { id?: string; sender_type?: string }
  body?: { content?: string }
}

/** The state one runBackfill call carries. */
export interface BackfillOptions {
  lister: MessageLister
  /** Group chat ids to recover; p2p history is not backfilled (v1). */
  chats: readonly string[]
  /** This bot's own open id, when known, so its own messages are never replayed. */
  ownBotId?: string
  /** The bridge's single ingest funnel — the same path live events take. */
  ingest: (msg: NormalizedMessage) => Promise<void>
  store: BackfillStore
  notify: (line: string) => void
  /** Look-back window before the cursor; defaults to BACKFILL_OVERLAP_MS. */
  overlapMs?: number
}

/** A mutable, persistable view of the per-chat cursors and the seen-id set. */
export interface BackfillStore {
  /**
   * Record one processed inbound message (live or backfilled). Returns true
   * when the id was new — the first recorder wins the message.
   */
  observe(messageId: string, chatId: string, createTime: number): boolean
  /** Whether a message id was already processed in this process or persisted. */
  seen(messageId: string): boolean
  /** The cursor one chat's backfill should start from. */
  cursor(chatId: string): ChatBackfillEntry
  /** Write the cursors through the settings seam; callers choose when. */
  persist(): void
  /** Force a synchronous write before the process exits. */
  flush(): void
}

/** One list-API page as the platform reports it. */
interface ListResponse {
  data?: {
    items?: ListedMessage[]
    has_more?: boolean
    page_token?: string
  }
  code?: number
  msg?: string
}

/**
 * Extract plain text from a text/post message body. Media types are not
 * backfilled (their bytes would each need a download); an empty string means
 * "no words to recover", and the caller skips the message.
 */
export function extractText(msgType: string | undefined, rawContent: string | undefined): string {
  if (rawContent === undefined || rawContent === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return ''
  }
  if (msgType === 'text') {
    const text = (parsed as { text?: unknown })?.text
    return typeof text === 'string' ? text : ''
  }
  if (msgType === 'post') {
    const post = parsed as { title?: string; content?: unknown; zh_cn?: { title?: string; content?: unknown } }
    const locale = (post.zh_cn ?? post) as { title?: string; content?: unknown }
    const parts: string[] = []
    if (typeof locale.title === 'string' && locale.title !== '') parts.push(locale.title)
    if (Array.isArray(locale.content)) {
      for (const line of locale.content) {
        if (!Array.isArray(line)) continue
        for (const segment of line) {
          const text = (segment as { tag?: string; text?: string } | undefined)?.text
          if (typeof text === 'string' && text !== '') parts.push(text)
        }
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** Normalize one list item into the shape live events carry. */
function normalizeListed(item: ListedMessage, chatId: string): NormalizedMessage | undefined {
  if (item.message_id === undefined) return undefined
  const senderType = item.sender?.sender_type
  return {
    messageId: item.message_id,
    chatId,
    chatType: 'group',
    senderId: item.sender?.id ?? '',
    ...(senderType === undefined ? {} : { senderType }),
    ...(senderType === undefined ? {} : { senderIsBot: senderType === 'bot' || senderType === 'app' }),
    content: extractText(item.msg_type, item.body?.content),
    rawContentType: item.msg_type ?? 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    ...(item.root_id === undefined ? {} : { rootId: item.root_id }),
    ...(item.thread_id === undefined ? {} : { threadId: item.thread_id }),
    ...(item.parent_id === undefined ? {} : { replyToMessageId: item.parent_id }),
    createTime: item.create_time === undefined ? 0 : Number.parseInt(item.create_time, 10) || 0,
  }
}

/** List one chat's messages after a start time, oldest first, paging through. */
async function listSince(lister: MessageLister, chatId: string, startMs: number): Promise<ListedMessage[]> {
  const items: ListedMessage[] = []
  let pageToken: string | undefined
  const startSeconds = Math.floor(startMs / 1000)
  for (let page = 0; page < 10; page++) {
    const query = [
      'container_id_type=chat',
      'container_id=' + encodeURIComponent(chatId),
      'start_time=' + startSeconds,
      'sort_type=ByCreateTimeAsc',
      'page_size=50',
      ...(pageToken === undefined ? [] : ['page_token=' + encodeURIComponent(pageToken)]),
    ].join('&')
    const response = await lister.request({
      method: 'GET',
      url: '/open-apis/im/v1/messages?' + query,
    }) as ListResponse
    if (response.code !== undefined && response.code !== 0) {
      throw new Error('lark-channel: backfill list failed in ' + chatId + ': ' + response.code + ' ' + (response.msg ?? ''))
    }
    const pageItems = response.data?.items ?? []
    items.push(...pageItems)
    pageToken = response.data?.page_token
    if (response.data?.has_more !== true || pageToken === undefined || pageToken === '') break
  }
  return items
}

/**
 * Recover one chat's missed messages. Sequential by construction: the list is
 * oldest-first and each ingest is awaited, so the agent sees the gap in order.
 */
export async function runBackfill(options: BackfillOptions): Promise<number> {
  const { lister, chats, ownBotId, ingest, store, notify } = options
  const overlapMs = options.overlapMs ?? BACKFILL_OVERLAP_MS
  let recovered = 0
  for (const chatId of chats) {
    const cursor = store.cursor(chatId)
    // A fresh deployment (or a wiped cursor) must not re-list the chat's whole
    // history as if it were missed traffic: start from just before the sweep.
    const startMs = cursor.lastSeenMs === 0
      ? Date.now() - overlapMs
      : Math.max(0, cursor.lastSeenMs - overlapMs)
    const listed = await listSince(lister, chatId, startMs)
    let taken = 0
    let skippedMedia = 0
    let seen = 0
    let capped = 0
    for (const item of listed) {
      // The cap bounds agent turns, not cheap skips: once this sweep has
      // recovered enough, everything older is left for the next sweep.
      if (taken >= BACKFILL_MAX_PER_SWEEP) {
        capped++
        continue
      }
      if (item.deleted === true || item.message_id === undefined) continue
      if (item.sender?.id !== undefined && item.sender.id === ownBotId) {
        store.observe(item.message_id, chatId, Number.parseInt(item.create_time ?? '0', 10) || 0)
        seen++
        continue
      }
      if (store.seen(item.message_id)) {
        seen++
        continue
      }
      const msg = normalizeListed(item, chatId)
      if (msg === undefined) continue
      if (msg.content.trim() === '') {
        // A media message needs its bytes downloaded; recovery for those is a
        // later revision. Record it as seen so it is not retried every boot.
        skippedMedia++
        store.observe(msg.messageId, chatId, msg.createTime)
        continue
      }
      // Claim the id atomically: the live WebSocket path also claims before
      // processing, so a message crossing the reconnect boundary is handled
      // by exactly one path, never both.
      if (!store.observe(msg.messageId, chatId, msg.createTime)) {
        seen++
        continue
      }
      // The ingest funnel applies authorization, bot policy, and silence
      // rules itself; nothing is bypassed here.
      try {
        await ingest(msg)
        taken++
      } catch (error) {
        notify('lark-channel: backfill ingest failed for ' + msg.messageId + ': ' + String(error))
      }
    }
    recovered += taken
    store.persist()
    notify('lark-channel: backfill in ' + chatId + ': ' + taken + ' recovered, '
      + skippedMedia + ' media skipped, ' + seen + ' already seen'
      + (capped === 0 ? '' : ', ' + capped + ' deferred to the next sweep'))
  }
  return recovered
}

/** Build the store: an in-memory view plus a debounced write through settings. */
export function createBackfillStore(options: {
  initial: Record<string, ChatBackfillEntry>
  persistState: (patch: object) => Promise<boolean>
  notify: (line: string) => void
  recentIds?: number
  persistDebounceMs?: number
}): BackfillStore {
  const recentIds = options.recentIds ?? BACKFILL_RECENT_IDS
  const persistDebounceMs = options.persistDebounceMs ?? 5000
  const cursors = new Map<string, ChatBackfillEntry>()
  const seenIds = new Set<string>()
  for (const [chatId, entry] of Object.entries(options.initial)) {
    cursors.set(chatId, { lastSeenMs: entry.lastSeenMs ?? 0, recentIds: [...(entry.recentIds ?? [])] })
    for (const id of entry.recentIds ?? []) seenIds.add(id)
  }
  let dirty = false
  let timer: NodeJS.Timeout | undefined
  const write = () => {
    timer = undefined
    if (!dirty) return
    dirty = false
    const patch: Record<string, ChatBackfillEntry> = {}
    for (const [chatId, entry] of cursors) {
      patch[chatId] = { lastSeenMs: entry.lastSeenMs, recentIds: entry.recentIds }
    }
    void options.persistState({ chatBackfill: patch }).catch(error => {
      options.notify('lark-channel: backfill cursor persist failed: ' + String(error))
    })
  }
  const schedule = () => {
    dirty = true
    if (timer === undefined) {
      timer = setTimeout(write, persistDebounceMs)
      timer.unref?.()
    }
  }
  return {
    observe(messageId, chatId, createTime) {
      let entry = cursors.get(chatId)
      if (entry === undefined) {
        entry = { lastSeenMs: 0, recentIds: [] }
        cursors.set(chatId, entry)
      }
      const fresh = !seenIds.has(messageId)
      if (fresh) {
        if (createTime > entry.lastSeenMs) entry.lastSeenMs = createTime
        seenIds.add(messageId)
        entry.recentIds.push(messageId)
        if (entry.recentIds.length > recentIds) {
          entry.recentIds.splice(0, entry.recentIds.length - recentIds)
        }
        // Bound the in-memory set: only the recent-id windows are needed to
        // dedupe, since the list API never returns anything older than the
        // overlap window anyway.
        if (seenIds.size > recentIds * 50) {
          seenIds.clear()
          for (const cursor of cursors.values()) {
            for (const id of cursor.recentIds) seenIds.add(id)
          }
        }
      }
      schedule()
      return fresh
    },
    seen: messageId => seenIds.has(messageId),
    cursor(chatId) {
      return cursors.get(chatId) ?? { lastSeenMs: 0, recentIds: [] }
    },
    persist: () => {
      schedule()
      write()
    },
    flush: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      write()
    },
  }
}
