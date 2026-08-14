/**
 * The `/status` report: what this conversation is pointed at and what its
 * agent is doing, assembled by the bridge from channel state alone — no agent
 * is created to answer it, because "what would my next message do" must be
 * answerable before a first message exists.
 * @module dsh-lark-channel/status
 */

/** Show this conversation's routing and activity. Channel-owned: needs no agent. */
export const STATUS_COMMAND = 'status'

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
 * Render the report.
 * @param fields - resolved status facts.
 * @returns markdown for the chat.
 */
export function renderStatus(fields: StatusFields): string {
  const activity = fields.running ? '运行中' : fields.bound ? '空闲' : '尚未创建（下一条消息创建）'
  const lines = [
    '**状态**',
    `- 📁 工作区：\`${fields.workspace}\`${fields.workspaceIsDefault ? '（默认）' : ''}`,
    `- 🤖 模型：\`${fields.route}\`${fields.routeIsDefault ? '（默认）' : ''}`,
    `- 🧵 会话：\`${fields.sessionId}\``,
    `- ⏱ 状态：${activity}`,
  ]
  if (fields.version !== '') lines.push(`- 📦 版本：\`${fields.version}\``)
  if (fields.pendingApprovals > 0) lines.push(`- ⏳ 待审批：${fields.pendingApprovals} 个`)
  return lines.join('\n')
}
