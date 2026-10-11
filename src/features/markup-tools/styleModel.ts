/**
 * Tool appearance model: built-in defaults and the mapping from tool settings to annotation
 * properties. Pure (no UI or IPC) so it can be unit-tested.
 */
import type { AnnotSpec, LineEnding } from '@engine/ops/annots'
import type { MarkupTool } from './tools'

export type LineStyle = 'solid' | 'dashed' | 'cloudy'
export type FontKey = 'Helv' | 'TiRo' | 'Cour'

export interface ToolStyle {
  /** Stroke / markup / icon colour. */
  color: string
  /** Fill colour (shapes) or background (text boxes); null = none. */
  fill: string | null
  /** 0..1 */
  opacity: number
  /** Line width in points. */
  width: number
  lineStyle: LineStyle
  startEnd: LineEnding
  endEnd: LineEnding
  fontSize: number
  fontColor: string
  font: FontKey
  /** Sticky note icon (or file attachment icon for Attach file). */
  icon: string
  /** Eraser diameter in points. */
  eraserSize: number
}

const BASE: ToolStyle = {
  color: '#F44336',
  fill: null,
  opacity: 1,
  width: 2,
  lineStyle: 'solid',
  startEnd: 'None',
  endEnd: 'None',
  fontSize: 12,
  fontColor: '#000000',
  font: 'Helv',
  icon: 'Comment',
  eraserSize: 10
}

/** Built-in defaults, close to Acrobat's. */
export const BUILTIN: Record<string, Partial<ToolStyle>> = {
  highlight: { color: '#FFEB3B' },
  underline: { color: '#4CAF50' },
  strikeout: { color: '#F44336' },
  squiggly: { color: '#E91E63' },
  insertText: { color: '#2196F3' },
  replaceText: { color: '#2196F3' },
  note: { color: '#FFEB3B', icon: 'Comment' },
  typewriter: { fontColor: '#000000', fontSize: 12 },
  textbox: { fontColor: '#000000', fill: null, width: 1, fontSize: 12 },
  callout: { fontColor: '#000000', fill: '#FFFFFF', width: 1, fontSize: 12, endEnd: 'OpenArrow' },
  attachFile: { color: '#2196F3', icon: 'PushPin' },
  pencil: { color: '#2196F3', width: 2 },
  eraser: { eraserSize: 10 },
  rectangle: { color: '#F44336', width: 2 },
  oval: { color: '#F44336', width: 2 },
  line: { color: '#F44336', width: 2 },
  arrow: { color: '#F44336', width: 2, endEnd: 'OpenArrow' },
  polygon: { color: '#F44336', width: 2 },
  polyline: { color: '#F44336', width: 2 },
  cloud: { color: '#F44336', width: 2, lineStyle: 'cloudy' },
  areaHighlight: { color: '#FFEB3B' }
}

export function builtinStyle(key: string): ToolStyle {
  return { ...BASE, ...(BUILTIN[key] ?? {}) }
}

export function sanitize(p: unknown): Partial<ToolStyle> {
  if (!p || typeof p !== 'object') return {}
  const src = p as Record<string, unknown>
  const out: Partial<ToolStyle> = {}
  const color = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
  if (color(src.color)) out.color = src.color as string
  if (src.fill === null || color(src.fill)) out.fill = src.fill as string | null
  if (typeof src.opacity === 'number' && src.opacity > 0 && src.opacity <= 1) out.opacity = src.opacity
  if (typeof src.width === 'number' && src.width >= 0 && src.width <= 72) out.width = src.width
  if (src.lineStyle === 'solid' || src.lineStyle === 'dashed' || src.lineStyle === 'cloudy') out.lineStyle = src.lineStyle
  if (typeof src.startEnd === 'string') out.startEnd = src.startEnd as LineEnding
  if (typeof src.endEnd === 'string') out.endEnd = src.endEnd as LineEnding
  if (typeof src.fontSize === 'number' && src.fontSize >= 4 && src.fontSize <= 144) out.fontSize = src.fontSize
  if (color(src.fontColor)) out.fontColor = src.fontColor as string
  if (src.font === 'Helv' || src.font === 'TiRo' || src.font === 'Cour') out.font = src.font
  if (typeof src.icon === 'string' && src.icon) out.icon = src.icon
  if (typeof src.eraserSize === 'number' && src.eraserSize > 0 && src.eraserSize <= 100) out.eraserSize = src.eraserSize
  return out
}

/** Intent that tells tools sharing an annotation type apart (arrow vs line, callout vs text box...). */
const TOOL_INTENT: Record<string, string | null> = {
  line: null,
  arrow: 'LineArrow',
  typewriter: 'FreeTextTypeWriter',
  textbox: null,
  callout: 'FreeTextCallout',
  polygon: null,
  cloud: 'PolygonCloud'
}

/**
 * Whether a comments-feature default for the tool's annotation type is meant for this tool. A
 * default that records an intent only applies to the tool with that intent; one without an intent
 * applies to every tool of the type.
 */
export function defaultsApply(tool: MarkupTool, v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  if (!(tool.key in TOOL_INTENT) || !('intent' in (v as object))) return true
  const intent = (v as { intent?: unknown }).intent
  return (typeof intent === 'string' && intent ? intent : null) === TOOL_INTENT[tool.key]
}

/**
 * Converts a comments-feature default (AnnotSpec-like: color, interiorColor, opacity, borderWidth,
 * dashes, cloudy, lineEndings, fontSize, textColor, fontName, icon) into tool style fields.
 */
export function fromAnnotDefaults(tool: MarkupTool, v: unknown): Partial<ToolStyle> {
  if (!v || typeof v !== 'object') return {}
  const d = v as AnnotSpec & Record<string, unknown>
  const lower = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : undefined)
  const out: Partial<ToolStyle> = {}
  const isText = tool.kind === 'typewriter' || tool.kind === 'textbox' || tool.kind === 'callout'
  if (isText) {
    // FreeText: /C is the background; the text (and border) colour lives in the appearance string.
    if (d.color === null) out.fill = null
    else if (lower(d.color)) out.fill = lower(d.color)!
    if (lower(d.textColor)) out.fontColor = lower(d.textColor)!
    if (d.fontName === 'Helv' || d.fontName === 'TiRo' || d.fontName === 'Cour') out.font = d.fontName
  } else {
    if (lower(d.color)) out.color = lower(d.color)!
    if (d.interiorColor === null) out.fill = null
    else if (lower(d.interiorColor)) out.fill = lower(d.interiorColor)!
  }
  if (typeof d.opacity === 'number' && d.opacity > 0 && d.opacity <= 1) out.opacity = d.opacity
  if (typeof d.borderWidth === 'number' && d.borderWidth >= 0) out.width = d.borderWidth
  if (d.cloudy === true) out.lineStyle = 'cloudy'
  else if (Array.isArray(d.dashes) && d.dashes.length) out.lineStyle = 'dashed'
  else if (d.cloudy === false || Array.isArray(d.dashes)) out.lineStyle = 'solid'
  if (d.lineEndings && typeof d.lineEndings === 'object') {
    if (tool.kind === 'callout') out.endEnd = d.lineEndings.start
    else {
      out.startEnd = d.lineEndings.start
      out.endEnd = d.lineEndings.end
    }
  }
  if (typeof d.fontSize === 'number' && d.fontSize > 0) out.fontSize = d.fontSize
  if (typeof d.icon === 'string' && d.icon) out.icon = d.icon
  // also accept our own field names
  return { ...out, ...sanitize(Object.fromEntries(Object.entries(d).filter(([k]) => ['lineStyle', 'startEnd', 'endEnd', 'fontColor', 'font', 'eraserSize'].includes(k)))) }
}

// ---- style -> annotation properties ------------------------------------------------------

export function dashFor(width: number): number[] {
  const d = Math.max(3, Math.round(width * 2.5))
  return [d, d]
}

function lineStyleSpec(st: ToolStyle, allowCloudy: boolean): Partial<AnnotSpec> {
  if (st.lineStyle === 'dashed') return { borderStyle: 'Dashed', dashes: dashFor(st.width), ...(allowCloudy ? { cloudy: false } : {}) }
  if (st.lineStyle === 'cloudy' && allowCloudy) return { borderStyle: 'Solid', dashes: [], cloudy: true }
  return { borderStyle: 'Solid', dashes: [], ...(allowCloudy ? { cloudy: false } : {}) }
}

/** Appearance properties (AnnotSpec) for a new annotation made with `tool`. */
export function styleSpec(tool: MarkupTool, st: ToolStyle): AnnotSpec {
  const opacity = st.opacity
  switch (tool.kind) {
    case 'textMarkup':
    case 'areaHighlight':
    case 'insertText':
    case 'replaceText':
      return { color: st.color, opacity }
    case 'note':
    case 'attach':
      return { color: st.color, opacity, icon: st.icon }
    case 'typewriter':
      return { color: null, borderWidth: 0, fontName: st.font, fontSize: st.fontSize, textColor: st.fontColor, opacity, intent: 'FreeTextTypeWriter' }
    case 'textbox':
    case 'callout':
      return {
        color: st.fill,
        borderWidth: st.width,
        ...lineStyleSpec(st, false),
        fontName: st.font,
        fontSize: st.fontSize,
        textColor: st.fontColor,
        opacity,
        ...(tool.kind === 'callout' ? { intent: 'FreeTextCallout' } : {})
      }
    case 'pencil':
      return { color: st.color, borderWidth: st.width, opacity }
    case 'rect':
      return { color: st.color, interiorColor: st.fill, borderWidth: st.width, opacity, ...lineStyleSpec(st, true) }
    case 'line':
      return {
        color: st.color,
        interiorColor: st.color,
        borderWidth: st.width,
        opacity,
        lineEndings: { start: st.startEnd, end: st.endEnd },
        ...lineStyleSpec(st, false),
        ...(tool.key === 'arrow' ? { intent: 'LineArrow' } : {})
      }
    case 'poly':
      if (tool.shape === 'PolyLine')
        return {
          color: st.color,
          interiorColor: st.color,
          borderWidth: st.width,
          opacity,
          lineEndings: { start: st.startEnd, end: st.endEnd },
          ...lineStyleSpec(st, false)
        }
      if (tool.key === 'cloud')
        return { color: st.color, interiorColor: st.fill, borderWidth: st.width, opacity, borderStyle: 'Solid', dashes: [], cloudy: true, intent: 'PolygonCloud' }
      return { color: st.color, interiorColor: st.fill, borderWidth: st.width, opacity, ...lineStyleSpec(st, true) }
    default:
      return {}
  }
}
