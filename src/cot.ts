/**
 * The thinking process as a native CoT message — and, where the CoT API
 * cannot go, as one stream card.
 *
 * Feishu carries an agent's process as its own message, driven by AG-UI events,
 * and renders it the way the platform's own agents look: reasoning streams into
 * a thinking area, each tool call gets an icon and a title, each result gets a
 * code block. That vocabulary lines up with the host's session events almost
 * one to one, so this renderer translates rather than draws — and the final
 * answer goes where the platform says it belongs, in an ordinary message.
 *
 * Topic threads are the one place the CoT message cannot live: the platform
 * rejects `receive_id_type=thread_id` for apps (a bot can never be a topic
 * participant). A thread-bound turn — a main-channel group message answered
 * by creating a topic, or a message already inside one — therefore buffers
 * the process and mounts it with the answer as one stream card inside the
 * topic, so the answer never leaves the conversation that asked for it.
 * @module dsh-lark-channel/cot
 */

import {
  assistantText,
  type AssistantMessageData,
  isAssistantChunkEvent,
  isAssistantMessageEvent,
  isStepStartEvent,
  isToolCallEvent,
  isToolResultEvent,
  isTurnEndEvent,
  toolResultText,
  turnErrorDetail,
} from './host.ts'
import { replyOptions, stripToolCallMarkup } from './outbound.ts'
import type { HostSessionEvent, OutboundPort, OutboundRenderer, ReplyTarget, ToolPresentation } from './outbound.ts'

/** One AG-UI event, as the write API takes it. */
export interface CotEvent {
  readonly event_type: string
  /** The event's own fields, JSON-encoded; the API caps one at 4096 characters. */
  readonly content: string
  /** Milliseconds, as a string, used by the client to order events. */
  readonly timestamp: string
}

/** A created thinking process, addressed by both ids on every write. */
export interface CotHandle {
  readonly cotId: string
  readonly messageId: string
}

/** The CoT operations this renderer drives, plus the outbound card transport thread-bound turns mount through. */
export interface CotPort extends OutboundPort {
  /** Open a thinking process in one chat, optionally aimed at the message that asked. */
  createCot(chatId: string, options: { replyTo?: string; hidden: boolean; threadId?: string }): Promise<CotHandle>
  /** Append events to one thinking process, in order. */
  writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void>
  /** Delete a thinking-process message; a silenced turn leaves no card behind. */
  deleteCot(handle: CotHandle): Promise<void>
  /** Send a short guide reply that opens a topic under the message; returns the new thread id. */
  openThread(chatId: string, replyTo: string): Promise<string | undefined>
}

/** How many events one write call may carry, per the API's own bound. */
const MAX_EVENTS_PER_WRITE = 50

/** How long one event's JSON may be, per the API's own bound. */
const MAX_EVENT_CONTENT_CHARS = 4096

/**
 * How much reasoning a topic card carries. The platform's CoT UI collapses a
 * long process; a topic card cannot, so the tail of the reasoning — where the
 * conclusion lives — is what survives the cap.
 */
const MAX_THREAD_REASONING_CHARS = 1200

/**
 * Assemble the merged card a thread-bound turn mounts: the buffered process
 * folded inside a collapsible panel (collapsed by default, the way the
 * platform's CoT UI folds its thinking area), and the answer after it.
 * @param thread - the buffered process of the turn.
 * @param answer - the turn's final text.
 * @param showProcess - whether the process appears at all.
 * @returns a card JSON 2.0 object, sent as an interactive message.
 */
function threadCardJson(thread: { reasoning: string; toolLines: string[] }, answer: string, showProcess: boolean): object {
  const elements: object[] = []
  if (showProcess) {
    const process: string[] = []
    if (thread.reasoning.trim() !== '') {
      const capped = thread.reasoning.length > MAX_THREAD_REASONING_CHARS
        ? thread.reasoning.slice(-MAX_THREAD_REASONING_CHARS)
        : thread.reasoning
      process.push(capped)
    }
    process.push(...thread.toolLines)
    if (process.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'markdown', content: '**思考过程**' } },
        elements: [{ tag: 'markdown', content: process.join('\n') }],
      })
    }
  }
  elements.push({ tag: 'markdown', content: answer })
  return { schema: '2.0', body: { elements } }
}

/**
 * Tool-call kinds the host reports, mapped to the platform's icon vocabulary.
 * A kind with no counterpart falls through to the platform default rather than
 * guessing at a shape the icon set does not carry.
 */
const TOOL_ICONS: Record<string, string> = {
  read: 'read',
  edit: 'write',
  delete: 'write',
  move: 'write',
  search: 'search',
  fetch: 'search',
  execute: 'bash',
}

/**
 * The last timestamp handed out, so the next one is strictly greater.
 *
 * The client ORDERS events by this value, and a run emits many within one
 * millisecond — a burst of reasoning deltas sharing a timestamp is free to be
 * reordered, which is how one sentence arrives interleaved with the next.
 */
let lastTimestamp = 0

/**
 * Encode one AG-UI event, bounding its payload and stamping it after every
 * event already handed out.
 * @param eventType - the AG-UI event name.
 * @param content - the event's own fields.
 * @returns the event ready to write.
 */
function cotEvent(eventType: string, content: object): CotEvent {
  const encoded = JSON.stringify(content)
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return {
    event_type: eventType,
    content: encoded.length <= MAX_EVENT_CONTENT_CHARS
      ? encoded
      // Dropping the payload would lose the event; a truncation marker keeps
      // its shape valid while saying that something was cut.
      : JSON.stringify({ ...content as Record<string, unknown>, truncated: true, delta: undefined }),
    timestamp: String(lastTimestamp),
  }
}

/** Bound a value a tool produced before it rides an event. */
function boundResult(text: string): string {
  const limit = 1500
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Options for {@link createCotRenderer}. */
export interface CotRendererOptions {
  /** Whether the agent's reasoning and tool calls appear at all. */
  readonly showProcess: boolean
  /** Whether the platform hides the process once the run finishes. */
  readonly hidden: boolean
  /** The tool's own label and kind for one call. */
  readonly presentCall: ToolPresentation
  /** Report a handled failure to the operator. */
  readonly onFailure: (error: unknown) => void
  /** Renders the answer itself; the thinking process deliberately carries none. */
  readonly answer: OutboundRenderer
}

/** The thinking process of one turn, and the queue feeding it. */
interface LiveRun {
  readonly turn: number
  readonly opening: Promise<CotHandle | undefined>
  /** For deferred cards (main-channel turns): resolves the pending opening. */
  readonly resolveOpening: ((handle: CotHandle | undefined) => void) | undefined
  /** Events awaiting a write; drained in arrival order. */
  readonly pending: CotEvent[]
  /** Settles when the queue is idle, so disposal can wait for it. */
  draining: Promise<void>
  /** Whether a reasoning block is open, so its deltas append to one area. */
  reasoningOpen: boolean
  /** Whether the run was already closed by a terminal event. */
  finished: boolean
  /**
   * Thread-bound turns render as one stream card inside the topic instead of
   * a CoT message: the CoT API rejects `receive_id_type=thread_id` (the bot
   * can never be a topic participant), so the buffered process and the answer
   * mount together once the turn ends.
   */
  readonly thread?: {
    reasoning: string
    toolLines: string[]
  }
}

/**
 * Renderer that shows the process as a native CoT message and leaves the answer
 * to `answer`. Falling back is the caller's job: when {@link CotPort.createCot}
 * rejects, this renderer reports it and the turn still answers, because the
 * answer never depended on the thinking process existing.
 * @param port - the CoT operations.
 * @param chatId - the owned chat.
 * @param options - what to show, and where the answer goes.
 * @returns the renderer.
 */
export function createCotRenderer(
  port: CotPort,
  chatId: string,
  options: CotRendererOptions,
): OutboundRenderer {
  const { showProcess, hidden, presentCall, onFailure, answer } = options
  let live: LiveRun | undefined
  let aimed: ReplyTarget | undefined
  /**
   * The turn's latest committed text, held because only the LAST one is the
   * answer. An agent narrates between tool calls — "let me look at the packages
   * first" — and every one of those commits would otherwise become its own
   * chat message, which is a wall of replies to a single question. Held at the
   * renderer, not on a run: the answer does not depend on a process existing.
   */
  let held: { turn: number; event: HostSessionEvent } | undefined
  const closing = new Set<Promise<void>>()

  /** Drain one run's queue, respecting the API's per-call event bound. */
  const drain = async (run: LiveRun): Promise<void> => {
    const handle = await run.opening
    if (handle === undefined) {
      run.pending.length = 0
      return
    }
    while (run.pending.length > 0) {
      const batch = run.pending.splice(0, MAX_EVENTS_PER_WRITE)
      await port.writeCotEvents(handle, batch).catch(onFailure)
    }
  }

  const enqueue = (run: LiveRun, ...events: CotEvent[]): void => {
    run.pending.push(...events)
    run.draining = run.draining.then(() => drain(run)).catch(onFailure)
  }

  /** The run for `turn`, opening one when the turn is new. */
  const ensure = (turn: number): LiveRun => {
    if (live !== undefined && live.turn === turn) return live
    if (live !== undefined) closeRun(live)
    // The CoT API cannot address a topic (the bot is never a topic
    // participant), so thread-bound turns — a main-channel group message
    // answered by creating one, or a message already inside one — buffer the
    // process and mount it with the answer as one stream card at turn end.
    const mainChannel = aimed !== undefined && aimed.threadId === undefined && aimed.inThread === true
    const inTopic = aimed !== undefined && aimed.threadId !== undefined
    const thread = mainChannel || inTopic ? { reasoning: '', toolLines: [] as string[] } : undefined
    const opening = thread === undefined
      ? port
        .createCot(chatId, {
          ...aimed === undefined ? {} : { replyTo: aimed.messageId },
          ...aimed === undefined || aimed.threadId === undefined ? {} : { threadId: aimed.threadId },
          hidden,
        })
        .catch((error: unknown) => {
          // The process is presentation; the answer still arrives without it.
          onFailure(error)
          return undefined
        })
      : Promise.resolve(undefined)
    live = {
      turn,
      opening,
      resolveOpening: undefined,
      pending: [],
      draining: Promise.resolve(),
      reasoningOpen: false,
      finished: false,
      ...thread === undefined ? {} : { thread },
    }
    if (thread === undefined) {
      enqueue(live, cotEvent('RUN_STARTED', { threadId: chatId, runId: `turn-${turn}` }))
    }
    return live
  }

  /** Finish one run, closing whatever it left open. */
  const closeRun = (run: LiveRun, failure?: string): void => {
    if (run.finished) return
    run.finished = true
    // Thread-bound runs never opened a CoT message: their card already
    // mounted at turn end, and there is nothing left to drain or finish.
    if (run.thread !== undefined) return
    if (run.reasoningOpen) {
      enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${run.turn}` }))
      run.reasoningOpen = false
    }
    enqueue(run, failure === undefined
      ? cotEvent('RUN_FINISHED', { threadId: chatId, runId: `turn-${run.turn}`, status: 'done' })
      : cotEvent('RUN_ERROR', { message: failure, code: 'TURN_FAILED' }))
    const settled = run.draining
    closing.add(settled)
    void settled.finally(() => closing.delete(settled))
  }

  return {
    aim(target) {
      aimed = target
      answer.aim(target)
    },
    handle(event) {
      if (isAssistantMessageEvent(event)) {
        const text = stripToolCallMarkup(assistantText(event.data))
        if (text === '') return
        const superseded = held?.turn === event.data.turn ? held.event : undefined
        held = { turn: event.data.turn, event }
        // The text this one replaces was narration, not an answer: it belongs
        // in the process, where the platform shows it as the agent's own words.
        if (superseded === undefined || !showProcess || !isAssistantMessageEvent(superseded)) return
        const run = ensure(event.data.turn)
        const messageId = `text-${run.turn}-${run.pending.length}`
        enqueue(
          run,
          cotEvent('TEXT_MESSAGE_START', { messageId, role: 'assistant' }),
          cotEvent('TEXT_MESSAGE_CONTENT', {
            messageId,
            delta: stripToolCallMarkup(assistantText(superseded.data)),
          }),
          cotEvent('TEXT_MESSAGE_END', { messageId }),
        )
        return
      }
      // Failures reach the chat through the answer half.
      if (isTurnEndEvent(event)) answer.handle(event)

      if (isStepStartEvent(event)) {
        // With the process off, nothing here is ever shown — so no process is
        // opened either, and the chat carries answers alone.
        if (!showProcess) return
        // Opening the process here overlaps its round trip with the model's
        // time to first token. No STEP event is written: a step is one
        // iteration of the agent's own loop, and a reader who sees "step 1
        // … step 8" listed above the work learns nothing from the numbering
        // that the reasoning and tool calls do not already say.
        ensure(event.data.turn)
        return
      }
      if (isAssistantChunkEvent(event)) {
        const { chunk } = event.data
        // Only reasoning belongs here: the platform reserves this message for
        // the process, and the answer is sent as its own message.
        if (!showProcess || chunk.type !== 'reasoning-delta') return
        if (chunk.text === undefined || chunk.text === '') return
        const run = ensure(event.data.turn)
        if (run.thread !== undefined) {
          // The card is assembled at turn end; deltas just accumulate.
          run.thread.reasoning += chunk.text
          return
        }
        const messageId = `reasoning-${run.turn}`
        if (!run.reasoningOpen) {
          run.reasoningOpen = true
          enqueue(run, cotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }))
        }
        enqueue(run, cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: chunk.text }))
        return
      }
      if (isToolCallEvent(event)) {
        if (!showProcess) return
        const run = ensure(event.data.turn)
        const shown = presentCall(event.data.name, event.data.arguments)
        if (run.thread !== undefined) {
          run.thread.toolLines.push(`🔧 ${shown.title}`)
          return
        }
        const toolCallId = event.data.callId
        if (run.reasoningOpen) {
          run.reasoningOpen = false
          enqueue(run, cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${run.turn}` }))
        }
        enqueue(
          run,
          cotEvent('TOOL_CALL_START', {
            toolCallId,
            icon: TOOL_ICONS[shown.kind ?? ''] ?? 'default',
            title: shown.title,
            toolCallName: event.data.name,
          }),
          cotEvent('TOOL_CALL_ARGS', { toolCallId, delta: event.data.arguments }),
          cotEvent('TOOL_CALL_END', { toolCallId }),
        )
        return
      }
      if (isToolResultEvent(event)) {
        if (!showProcess) return
        const { callId, text } = toolResultText(event.data)
        if (callId === undefined) return
        const run = ensure(event.data.turn)
        // The topic card keeps tool titles, not result payloads: a code block
        // per call would bury the answer the card exists to show.
        if (run.thread !== undefined) return
        enqueue(run, cotEvent('TOOL_CALL_RESULT', {
          messageId: `result-${callId}`,
          toolCallId: callId,
          role: 'tool',
          // A command's output reads as output, not prose.
          content: { type: 'code', code: boundResult(text) },
          ...event.data.error === undefined ? {} : { error: event.data.error.code },
        }))
        return
      }
      if (isTurnEndEvent(event)) {
        // One message per turn: the text the turn ended on.
        const answered = held !== undefined && held.turn === event.data.turn
        const run = live !== undefined && live.turn === event.data.turn ? live : undefined
        if (run !== undefined) live = undefined
        const detail = turnErrorDetail(event.data)

        // Thread-bound turn (a main-channel group message answered by
        // creating a topic, or a message already inside one): the CoT API
        // cannot address a topic, so the merged card — buffered process plus
        // the answer — mounts inside it as one stream card.
        if (run?.thread !== undefined) {
          closeRun(run, detail === '' ? undefined : detail)
          if (!answered) return
          const heldEvent = held!.event
          const text = stripToolCallMarkup(assistantText(heldEvent.data as AssistantMessageData))
          held = undefined
          if (text === '') return
          const target: ReplyTarget = aimed!.threadId === undefined
            ? { messageId: aimed!.messageId, inThread: true }
            : { messageId: aimed!.messageId, threadId: aimed!.threadId }
          const opts = replyOptions(target)
          void (async () => {
            try {
              const threadId = aimed!.threadId ?? await port.openThread(chatId, aimed!.messageId)
              if (threadId === undefined) {
                // The topic could not be opened; the answer still reaches the
                // chat through the ordinary reply path.
                answer.handle(heldEvent)
                return
              }
              // One interactive card, sent when the turn settles: the
              // answer with the folded process above it.
              await port.send(chatId, { card: threadCardJson(run!.thread!, text, showProcess) }, opts)
            } catch (error) {
              onFailure(error)
              answer.handle(heldEvent)
            }
          })()
          return
        }

        if (answered) {
          // CoT-mode turns: the process card carries the process; the answer
          // goes through the answer half, aimed at the message that asked.
          answer.handle(held!.event)
          held = undefined
        } else if (run !== undefined) {
          run.resolveOpening?.(undefined)
        }

        if (run !== undefined) {
          closeRun(run, detail === '' ? undefined : detail)
          // A turn that ended with no answer (the silence rule) should leave no
          // process card either: once its events have drained, delete the CoT
          // message so a quiet chat stays quiet. Errors keep their card — the
          // failure notice is the one thing a broken turn must still show.
          if (!answered && detail === '') {
            const settled = run.draining
            void settled.then(() =>
              run.opening.then(handle => {
                if (handle !== undefined) return port.deleteCot(handle)
              }),
            ).catch(onFailure)
          }
        }
      }
    },
    async close() {
      if (held !== undefined) {
        answer.handle(held.event)
        held = undefined
      }
      if (live !== undefined) {
        const run = live
        live = undefined
        closeRun(run)
      }
      await Promise.allSettled([...closing, answer.close()])
    },
  }
}
