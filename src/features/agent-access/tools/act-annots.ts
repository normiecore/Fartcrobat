// Builds annotation specs for add_annotations and update_annotations. Each type looks like what
// the matching comment tool makes (the person's tool settings, see markup-tools/styleModel.ts).
// Pure, Node-testable.
import type { AnnotSpec } from '@engine/ops/annots'
import type { Point, Rect } from '@shared/geometry'
import { rectToQuad } from '@shared/geometry'
import { fitRect } from '@features/markup-tools/geometry'
import { styleSpec, type ToolStyle } from '@features/markup-tools/styleModel'
import { TOOLS, type MarkupTool } from '@features/markup-tools/tools'
import { InvalidArgs, colorArg, isObject, optString } from './act-common'

export const AGENT_ANNOT_TYPES = [
  'note',
  'textbox',
  'highlight',
  'underline',
  'strikeout',
  'squiggly',
  'rectangle',
  'oval',
  'line',
  'arrow'
] as const

export type AgentAnnotType = (typeof AGENT_ANNOT_TYPES)[number]

/** The markup tool whose look and undo label each type borrows (keys of markup-tools/tools.ts). */
const TOOL_KEY: Record<AgentAnnotType, string> = {
  note: 'note',
  textbox: 'textbox',
  highlight: 'highlight',
  underline: 'underline',
  strikeout: 'strikeout',
  squiggly: 'squiggly',
  rectangle: 'rectangle',
  oval: 'oval',
  line: 'line',
  arrow: 'arrow'
}

/** Sticky notes are placed as a 20 x 20 pt icon, like the Sticky Note tool does. */
export const NOTE_SIZE = 20

/** Types the agent must leave alone: form fields, links and pop-ups are not comments. */
export const NOT_COMMENTS = new Set(['Widget', 'Link', 'Popup'])

export function toolFor(type: AgentAnnotType): MarkupTool {
  const key = TOOL_KEY[type]
  const tool = TOOLS.find((t) => t.key === key)
  if (!tool) throw new Error(`No markup tool for ${type}`)
  return tool
}

/** How a comment made by an agent is signed: "Agent (Claude)", so people can tell them apart. */
export function agentAuthor(clientLabel: string): string {
  return `Agent (${clientLabel})`
}

export interface BuildContext {
  pageCount: number
  /** Size of a page (0-based) in points, as displayed. */
  pageSize(page: number): { width: number; height: number }
  /** The person's current settings of a markup tool (by tool key). */
  style(toolKey: string): ToolStyle
  author: string
}

export interface BuiltAnnotation {
  type: AgentAnnotType
  /** 0-based page. */
  page: number
  spec: AnnotSpec
  tool: MarkupTool
}

/** [x0, y0, x1, y1] normalized so x0 <= x1 and y0 <= y1. */
export function rectValue(value: unknown, name: string): Rect {
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    throw new InvalidArgs(`${name} must be [x0, y0, x1, y1] in points`)
  const [a, b, c, d] = value as number[]
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

function pointValue(value: unknown, name: string): Point {
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    throw new InvalidArgs(`${name} must be [x, y] in points`)
  return [value[0] as number, value[1] as number]
}

function pageValue(value: unknown, name: string, pageCount: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new InvalidArgs(`${name} must be a page number from 1`)
  if (value < 1 || value > pageCount) throw new InvalidArgs(`${name} ${value} does not exist: the document has ${pageCount} pages`)
  return value - 1
}

/** Throws when a rect lies entirely off the page (usually a mix-up of pages or units). */
function onPage(r: Rect, size: { width: number; height: number }, name: string, page: number) {
  const off = r[2] < 0 || r[3] < 0 || r[0] > size.width || r[1] > size.height
  if (off)
    throw new InvalidArgs(
      `${name} is outside page ${page + 1}, which is ${Math.round(size.width)} x ${Math.round(size.height)} points (origin top-left, y down)`
    )
}

function textMarkupRects(item: Record<string, unknown>, where: string): Rect[] {
  if (item.rects !== undefined) {
    if (!Array.isArray(item.rects) || !item.rects.length) throw new InvalidArgs(`${where}.rects must be a list of rects, one per line of text`)
    return item.rects.map((r, i) => rectValue(r, `${where}.rects[${i}]`))
  }
  if (item.rect !== undefined) return [rectValue(item.rect, `${where}.rect`)]
  throw new InvalidArgs(`${where} needs rects (one per line of text, from find_text or get_page_text)`)
}

/** Turns one add_annotations item into the page and AnnotSpec to create. */
export function buildAnnotation(item: unknown, index: number, ctx: BuildContext): BuiltAnnotation {
  const where = `items[${index}]`
  if (!isObject(item)) throw new InvalidArgs(`${where} must be an object with type and page`)
  const type = item.type as AgentAnnotType
  if (!AGENT_ANNOT_TYPES.includes(type)) throw new InvalidArgs(`${where}.type must be one of ${AGENT_ANNOT_TYPES.join(', ')}`)
  const page = pageValue(item.page, `${where}.page`, ctx.pageCount)
  const size = ctx.pageSize(page)
  const tool = toolFor(type)
  const color = colorArg(item.color, `${where}.color`)
  const text = optString(item.text, `${where}.text`)
  const base = ctx.style(tool.key)
  const contents = text ? { contents: text } : {}
  const common = { author: ctx.author }
  const needRect = (): Rect => {
    if (item.rect === undefined) throw new InvalidArgs(`${where} (${type}) needs rect`)
    const r = rectValue(item.rect, `${where}.rect`)
    onPage(r, size, `${where}.rect`, page)
    return r
  }

  switch (type) {
    case 'note': {
      const r = needRect()
      const rect = fitRect([r[0], r[1], r[0] + NOTE_SIZE, r[1] + NOTE_SIZE], size.width, size.height)
      const spec: AnnotSpec = { type: 'Text', rect, contents: text ?? '', ...styleSpec(tool, { ...base, color: color ?? base.color }), ...common }
      return { type, page, spec, tool }
    }
    case 'textbox': {
      const rect = needRect()
      if (!text?.trim()) throw new InvalidArgs(`${where} (textbox) needs text`)
      let fontSize = base.fontSize
      if (item.font_size !== undefined) {
        if (typeof item.font_size !== 'number' || !(item.font_size >= 4 && item.font_size <= 144))
          throw new InvalidArgs(`${where}.font_size must be a number from 4 to 144`)
        fontSize = item.font_size
      }
      const style: ToolStyle = { ...base, fontColor: color ?? base.fontColor, fontSize }
      const spec: AnnotSpec = { type: 'FreeText', rect, contents: text, ...styleSpec(tool, style), ...common }
      return { type, page, spec, tool }
    }
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const rects = textMarkupRects(item, where)
      rects.forEach((r, i) => onPage(r, size, `${where}.rects[${i}]`, page))
      const spec: AnnotSpec = {
        type: tool.markup!,
        quads: rects.map(rectToQuad),
        ...styleSpec(tool, { ...base, color: color ?? base.color }),
        ...contents,
        ...common
      }
      return { type, page, spec, tool }
    }
    case 'rectangle':
    case 'oval': {
      const rect = needRect()
      if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) throw new InvalidArgs(`${where}.rect is too small`)
      const spec: AnnotSpec = { type: tool.shape!, rect, ...styleSpec(tool, { ...base, color: color ?? base.color }), ...contents, ...common }
      return { type, page, spec, tool }
    }
    case 'line':
    case 'arrow': {
      let from: Point
      let to: Point
      if (item.from !== undefined || item.to !== undefined) {
        if (item.from === undefined || item.to === undefined) throw new InvalidArgs(`${where} needs both from and to`)
        from = pointValue(item.from, `${where}.from`)
        to = pointValue(item.to, `${where}.to`)
      } else {
        const r = needRect()
        from = [r[0], r[1]]
        to = [r[2], r[3]]
      }
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1) throw new InvalidArgs(`${where} is too short: from and to are the same point`)
      onPage([Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])], size, where, page)
      const spec: AnnotSpec = { type: 'Line', line: [from, to], ...styleSpec(tool, { ...base, color: color ?? base.color }), ...contents, ...common }
      return { type, page, spec, tool }
    }
  }
}

export interface AnnotUpdate {
  id: number
  spec: AnnotSpec
  /** Move or resize to this rect (applied with annots.transform, which also moves the geometry). */
  rect?: Rect
}

/**
 * One update_annotations entry as a spec. `colour` changes the text colour of text boxes (their
 * /C is the background) and the main colour of everything else.
 */
export function buildUpdate(entry: unknown, index: number, annotType: (id: number) => string | null): AnnotUpdate {
  const where = `updates[${index}]`
  if (!isObject(entry)) throw new InvalidArgs(`${where} must be an object with id`)
  if (typeof entry.id !== 'number' || !Number.isInteger(entry.id)) throw new InvalidArgs(`${where}.id must be a comment id from list_annotations`)
  const type = annotType(entry.id)
  if (type === null) throw new InvalidArgs(`No comment with id ${entry.id}. Call list_annotations for current ids.`)
  if (NOT_COMMENTS.has(type)) throw new InvalidArgs(`${entry.id} is a ${type === 'Widget' ? 'form field' : type.toLowerCase()}, not a comment`)
  const spec: AnnotSpec = {}
  const text = optString(entry.text, `${where}.text`)
  if (text !== undefined) spec.contents = text
  const color = colorArg(entry.color, `${where}.color`)
  if (color) {
    if (type === 'FreeText') spec.textColor = color
    else spec.color = color
  }
  const rect = entry.rect !== undefined ? rectValue(entry.rect, `${where}.rect`) : undefined
  // Moved while the person looks at an apply_redactions confirmation, a mark would remove other content than they approved.
  if (rect && type === 'Redact')
    throw new InvalidArgs(`${where}: redaction marks cannot be moved or resized; delete the mark (delete_ids) and mark again with mark_redactions`)
  if (rect && (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1)) throw new InvalidArgs(`${where}.rect is too small`)
  if (!Object.keys(spec).length && !rect) throw new InvalidArgs(`${where} changes nothing: give text, color or rect`)
  return { id: entry.id, spec, rect }
}
