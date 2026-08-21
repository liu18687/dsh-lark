/**
 * Readable text out of a Feishu interactive card, for cards the event body
 * does not carry — a card-entity message arrives with only a `card_id` reference, so the transport must fetch the card JSON and walk it here.
 * Covers the CardKit 2.0 tags this deployment's cards use (markdown,
 * collapsible panels) and the v1 shapes the platform may downgrade to.
 * @module dsh-lark-channel/card-text
 */

/** Text-bearing tags, in either card schema. */
const TEXT_TAGS = new Set(['plain_text', 'lark_md', 'markdown', 'content'])

/** Walk one JSON node, appending every piece of human-readable text. */
function visit(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) visit(child, out)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const tag = typeof obj.tag === 'string' ? obj.tag : undefined
  if (tag !== undefined && TEXT_TAGS.has(tag) && typeof obj.content === 'string') {
    out.push(obj.content)
    return
  }
  if (obj.header !== null && typeof obj.header === 'object') {
    const header = obj.header as Record<string, unknown>
    const title = header.title
    if (title !== null && typeof title === 'object' && typeof (title as Record<string, unknown>).content === 'string') {
      out.push((title as Record<string, unknown>).content as string)
    }
  }
  if (typeof obj.title === 'string') out.push(obj.title)
  else if (obj.title !== null && typeof obj.title === 'object') visit(obj.title, out)
  if (typeof obj.text === 'string') out.push(obj.text)
  else if (obj.text !== null && typeof obj.text === 'object') visit(obj.text, out)
  if (typeof obj.label === 'string') out.push(obj.label)
  else if (obj.label !== null && typeof obj.label === 'object') visit(obj.label, out)
  if (typeof obj.placeholder === 'string') out.push(obj.placeholder)
  else if (obj.placeholder !== null && typeof obj.placeholder === 'object') visit(obj.placeholder, out)
  if (Array.isArray(obj.options)) visit(obj.options, out)
  if (Array.isArray(obj.elements)) visit(obj.elements, out)
  if (Array.isArray(obj.fields)) visit(obj.fields, out)
  if (Array.isArray(obj.actions)) visit(obj.actions, out)
  if (Array.isArray(obj.columns)) visit(obj.columns, out)
  if (obj.body !== null && typeof obj.body === 'object') visit(obj.body, out)
}

/**
 * Extract one card's text, deduplicated and in reading order.
 * @param raw - the card JSON string, or the parsed card object.
 * @returns the joined text; empty when the card carries none (e.g. a bare
 * card-entity reference with no fetched JSON).
 */
export function extractCardText(raw: string | object): string {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return ''
    }
  }
  const pieces: string[] = []
  visit(parsed, pieces)
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of pieces) {
    const key = piece.replace(/\s+/g, ' ').trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out.join('\n')
}
