/** MCP text changes; pages are zero based inside the engine. */
import type { Rect } from '@shared/geometry'
import { EngineError } from '@engine/define'
import {
  DEFAULT_STYLE,
  replaceRange,
  type TextBlockInfo,
  type TextEdit,
  type Run,
  type Align
} from '@features/edit-text/model'
import { fontLabel } from '@features/edit-text/fonts'

export interface TextChange {
  page: number
  block_id?: string
  original_text?: string
  text: string
  rect?: Rect
  font_size?: number
  font?: 'Helvetica' | 'Times' | 'Courier'
  color?: string
  bold?: boolean
  italic?: boolean
  style_runs?: Run[]
  align?: Align
  line_spacing?: number
}
export interface PlannedTextChange {
  page: number
  block: TextBlockInfo | null
  edit: TextEdit
}

export interface TextLimits {
  edits: number
  pages: number
  chars: number
}
/** What one edit_text call may send. */
export const CALL_LIMITS: TextLimits = { edits: 50, pages: 5, chars: 60000 }
/** What one review may hold: the edits of every call that joined it (see agent-live-review.md). */
export const REVIEW_LIMITS: TextLimits = { edits: 100, pages: 10, chars: 120000 }

export function validateTextChanges(changes: TextChange[], pageCount: number, limits: TextLimits = CALL_LIMITS) {
  const fail = (message: string): never => {
    throw new EngineError(message, 'BAD_EDIT')
  }
  if (!Array.isArray(changes) || !changes.length || changes.length > limits.edits)
    fail(`Give from 1 to ${limits.edits} text changes.`)
  const blocks = new Set<string>()
  const pages = new Set<number>()
  let chars = 0
  for (const c of changes) {
    if (!c || !Number.isInteger(c.page) || c.page < 0 || c.page >= pageCount)
      fail('A text change names a page that does not exist.')
    pages.add(c.page)
    if (
      typeof c.text !== 'string' ||
      c.text.length > 20000 ||
      Array.from(c.text).some((ch) => ch.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(ch))
    )
      fail('Each replacement must be text, at most 20000 characters, without control characters.')
    chars += c.text.length
    if (c.block_id !== undefined) {
      if (typeof c.block_id !== 'string' || !c.block_id || typeof c.original_text !== 'string')
        fail('An existing block needs block_id and its exact original_text from get_editable_text.')
      const key = c.page + ':' + c.block_id
      if (blocks.has(key)) fail('Change each text block only once per batch.')
      blocks.add(key)
    } else if (!c.rect || !c.text.trim()) fail('New text needs a rect and nonempty text.')
    if (
      c.rect !== undefined &&
      (!Array.isArray(c.rect) ||
        c.rect.length !== 4 ||
        c.rect.some((v) => !Number.isFinite(v)) ||
        c.rect[2] <= c.rect[0] ||
        c.rect[3] <= c.rect[1])
    )
      fail('rect must have positive width and height in page points.')
    if (c.font_size !== undefined && (!Number.isFinite(c.font_size) || c.font_size < 4 || c.font_size > 144))
      fail('font_size must be from 4 to 144 points.')
    if (c.font !== undefined && !['Helvetica', 'Times', 'Courier'].includes(c.font))
      fail('font must be Helvetica, Times or Courier; omit it to keep the original font.')
    if (c.color !== undefined && !/^#[0-9a-f]{6}$/i.test(c.color)) fail('color must be #rrggbb.')
    if (c.align !== undefined && !['left', 'center', 'right', 'justify'].includes(c.align))
      fail('align must be left, center, right or justify.')
    if (
      c.line_spacing !== undefined &&
      (!Number.isFinite(c.line_spacing) || c.line_spacing < 0.8 || c.line_spacing > 3)
    )
      fail('line_spacing must be from 0.8 to 3.')
    if (c.style_runs !== undefined) {
      if (!Array.isArray(c.style_runs) || c.style_runs.length < 1 || c.style_runs.length > 1000)
        fail('style_runs needs 1–1000 styled text runs.')
      for (const r of c.style_runs) {
        if (
          !r ||
          typeof r.text !== 'string' ||
          typeof r.font !== 'string' ||
          (!['Helvetica', 'Times', 'Courier'].includes(r.font) && !r.font.startsWith('orig:')) ||
          !Number.isFinite(r.size) ||
          r.size < 4 ||
          r.size > 144 ||
          !/^#[0-9a-f]{6}$/i.test(r.color) ||
          ['bold', 'italic', 'underline'].some((k) => typeof r[k as keyof Run] !== 'boolean')
        )
          fail('Each style run needs text, font, size, #rrggbb color, bold, italic and underline.')
      }
      if (c.style_runs.map((r) => r.text).join('') !== c.text)
        fail('style_runs must concatenate to exactly text.')
    }
    for (const k of ['bold', 'italic'] as const)
      if (c[k] !== undefined && typeof c[k] !== 'boolean') fail(k + ' must be true or false.')
  }
  if (chars > limits.chars || pages.size > limits.pages)
    fail(`One batch is limited to ${limits.chars} characters on ${limits.pages} pages. Work in smaller batches.`)
}

export function planTextChange(c: TextChange, blocks: TextBlockInfo[]): PlannedTextChange {
  const b = c.block_id === undefined ? null : blocks.find((b) => b.id === c.block_id)
  if (c.block_id !== undefined && (!b || b.text !== c.original_text))
    throw new EngineError('The text block changed. Call get_editable_text again.', 'STALE_BLOCK')
  if (b?.mark || b?.unreadable)
    throw new EngineError(
      'This block is a page mark or has unreadable characters. Use its own tool or OCR first.',
      'BAD_EDIT'
    )
  const text = c.text.replace(/\r\n?/g, '\n')
  let runs = b ? b.runs.map((r) => ({ ...r })) : [{ ...DEFAULT_STYLE, text: '' }]
  if (b) {
    let start = 0
    let end = b.text.length
    while (start < end && start < text.length && b.text[start] === text[start]) start++
    let suffix = 0
    while (
      suffix < end - start &&
      suffix < text.length - start &&
      b.text[end - suffix - 1] === text[text.length - suffix - 1]
    )
      suffix++
    end -= suffix
    runs = replaceRange(runs, start, end, text.slice(start, text.length - suffix))
  } else runs = [{ ...DEFAULT_STYLE, text }]
  if (c.style_runs) {
    const fonts = new Set(b?.runs.map((r) => r.font) ?? [])
    if (c.style_runs.some((r) => r.font.startsWith('orig:') && !fonts.has(r.font)))
      throw new EngineError('Use only original font keys from this source block.', 'BAD_EDIT')
    runs = c.style_runs.map((r) => ({ ...r, text: r.text.replace(/\r\n?/g, '\n') }))
  }
  runs = runs.map((r) => ({
    ...r,
    ...(c.font_size !== undefined ? { size: c.font_size } : {}),
    ...(c.font ? { font: c.font } : {}),
    ...(c.color ? { color: c.color } : {}),
    ...(c.bold !== undefined ? { bold: c.bold } : {}),
    ...(c.italic !== undefined ? { italic: c.italic } : {})
  }))
  const rect = c.rect
  if (rect && b && Math.abs(b.frame.dir[1]) > 0.01)
    throw new EngineError(
      'Moving a rotated text block with rect is not supported; omit rect to keep its frame.',
      'BAD_EDIT'
    )
  return {
    page: c.page,
    block: b ?? null,
    edit: {
      source: b ? { start: b.start, end: b.end, check: b.text } : null,
      frame: rect ? { origin: [rect[0], rect[1]], dir: [1, 0], width: rect[2] - rect[0] } : b!.frame,
      runs,
      align: c.align ?? b?.align ?? 'left',
      lineSpacing: c.line_spacing ?? b?.lineSpacing ?? 1.2,
      wrap: true,
      ascent: b?.ascent ?? 1
    }
  }
}

/** The style of a block's first visible run, as shown in the review. */
export interface ReviewStyle {
  font: string
  size: number
  color: string
  bold: boolean
  italic: boolean
}
export function styleOf(runs: Run[], fonts: TextBlockInfo['fonts'] = []): ReviewStyle | undefined {
  const r = runs.find((r) => r.text.trim()) ?? runs[0]
  if (!r) return undefined
  return { font: fontLabel(r.font, fonts), size: r.size, color: r.color.toLowerCase(), bold: r.bold, italic: r.italic }
}
const pt = (v: number) => String(Math.round(v * 10) / 10)
const weight = (s: ReviewStyle) => [s.bold && 'bold', s.italic && 'italic'].filter(Boolean).join(' ') || 'regular'

/** "Aa Calibri 10 → Inter 11 pt" when the font or size changes, or null. */
export function fontNote(before?: ReviewStyle, after?: ReviewStyle): string | null {
  if (!before || !after || (before.font === after.font && Math.abs(before.size - after.size) < 0.05)) return null
  return 'Aa ' + before.font + ' ' + pt(before.size) + ' → ' + after.font + ' ' + pt(after.size) + ' pt'
}

/** Plain notes on how the style of a change differs from the original. */
export function styleNotes(before?: ReviewStyle, after?: ReviewStyle): string[] {
  if (!before || !after) return []
  const notes: string[] = []
  const font = fontNote(before, after)
  if (font) notes.push(font)
  if (before.color !== after.color) notes.push('Colour ' + before.color + ' → ' + after.color)
  if (weight(before) !== weight(after)) notes.push('Style ' + weight(before) + ' → ' + weight(after))
  return notes
}

/** "Text area left 54 → 40 pt" for the edges of a page's text area that moved, or null. */
export function marginNote(before: Rect | null, after: Rect | null): string | null {
  if (!before || !after) return null
  const edges = (['left', 'top', 'right', 'bottom'] as const).flatMap((name, i) =>
    Math.abs(before[i] - after[i]) > 1 ? [name + ' ' + pt(before[i]) + ' → ' + pt(after[i])] : []
  )
  return edges.length ? 'Text area ' + edges.join(', ') + ' pt' : null
}
