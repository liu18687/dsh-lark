/**
 * The `/status` report: what this conversation is pointed at and what its
 * agent is doing, assembled by the bridge from channel state alone — no agent
 * is created to answer it, because "what would my next message do" must be
 * answerable before a first message exists.
 * @module dsh-lark-channel/status
 */

import { statusCard } from './cards.ts'
import type { ConversationSubject } from './session.ts'

/** Show this conversation's routing and activity. Channel-owned: needs no agent. */
export const STATUS_COMMAND = 'status'

/** Marks this plugin's status refresh apart from other card actions. */
export const STATUS_ACTION = 'dsh-lark-channel/status'

/** Card payload carried by a status refresh. */
export interface StatusActionValue extends ConversationSubject {
  readonly kind: typeof STATUS_ACTION
}

/**
 * Narrow an arbitrary card-action value to this module's refresh payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function statusActionValue(value: unknown): StatusActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== STATUS_ACTION) return undefined
  if (typeof record.key !== 'string' || typeof record.chatId !== 'string') return undefined
  if (typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  return {
    kind: STATUS_ACTION,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
  }
}

/** Everything the report states, resolved by the bridge. */
export interface StatusFields {
  /** The directory the conversation's agent runs in. */
  readonly workspace: string
  /** Whether that is the deployment default. */
  readonly workspaceIsDefault: boolean
  /** Display form of the model route. */
  readonly route: string
  /** Whether that is the deployment default. */
  readonly routeIsDefault: boolean
  /** The durable session id the conversation resolves to. */
  readonly sessionId: string
  /** Whether an agent is currently bound for the conversation. */
  readonly bound: boolean
  /** Whether a turn is running right now. */
  readonly running: boolean
  /** Open approval cards waiting in this chat. */
  readonly pendingApprovals: number
  /** The running plugin's version; empty hides the row rather than lying. */
  readonly version: string
}

/**
 * Render the report as a card.
 *
 * The refresh button carries the conversation rather than reading it from the
 * click, because the facets a key is built from — a thread, a sender — are not
 * in a card action at all. It is the same reason every control card here
 * carries its own subject.
 * @param fields - resolved status facts.
 * @param subject - the conversation the report is about, and where it lives.
 * @returns a card object for `send({ card })`.
 */
export function renderStatusCard(fields: StatusFields, subject: ConversationSubject): object {
  return statusCard({
    workspace: fields.workspace,
    workspaceIsDefault: fields.workspaceIsDefault,
    route: fields.route,
    routeIsDefault: fields.routeIsDefault,
    sessionId: fields.sessionId,
    activity: fields.running ? 'running' : fields.bound ? 'idle' : 'unbound',
    pendingApprovals: fields.pendingApprovals,
    version: fields.version,
    refresh: {
      kind: STATUS_ACTION,
      key: subject.key,
      chatId: subject.chatId,
      chatType: subject.chatType,
      ...subject.owner === undefined ? {} : { owner: subject.owner },
    } satisfies StatusActionValue,
  })
}
