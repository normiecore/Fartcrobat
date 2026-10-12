/**
 * Click-to-place tools: sticky note, text comment (typewriter) and insert text (caret). A ghost of
 * what will be placed follows the pointer.
 */
import { useRef, useState } from 'react'
import { Paperclip, StickyNote } from 'lucide-react'
import type { Point, Rect } from '@shared/geometry'
import { basename, getLoadedText, invoke, readFile, showError, withProgress, type DocumentModel, type PageLayerProps } from '@renderer/sdk'
import { caretRectAt, commentsInstalled, createWith, finishCreate, insertionPoint, textForNewComment } from '../actions'
import { fitRect } from '../geometry'
import { getToolStyle, styleSpec, type ToolStyle } from '../style'
import type { MarkupTool } from '../tools'
import { pagePoint, pageTextOrReport, useActiveToolAndStyle } from './shared'

const FONT_FAMILIES: Record<string, string> = {
  Helv: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  TiRo: '"Times New Roman", Times, "Liberation Serif", serif',
  Cour: '"Courier New", Courier, "Liberation Mono", monospace'
}

export function cssFontFamily(font: string): string {
  return FONT_FAMILIES[font] ?? FONT_FAMILIES.Helv
}

let measureCtx: CanvasRenderingContext2D | null = null

/** Size in points of a text block set in the given PDF base font. */
export function measureText(text: string, font: string, size: number): { width: number; height: number } {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const lines = text.split(/\r?\n/)
  let width = 0
  if (measureCtx) {
    measureCtx.font = `${size}px ${cssFontFamily(font)}`
    for (const l of lines) width = Math.max(width, measureCtx.measureText(l).width)
  } else width = Math.max(...lines.map((l) => l.length)) * size * 0.55
  return { width, height: lines.length * size * 1.2 }
}

/** Rect of a text comment whose first line is centred on the click point. */
export function typewriterRect(p: Point, st: ToolStyle, text: string, page: { width: number; height: number }): Rect {
  const pad = 2
  const m = measureText(text || 'M', st.font, st.fontSize)
  const width = text ? m.width + pad * 2 + st.fontSize * 0.5 : Math.min(240, Math.max(80, page.width - p[0] - 12))
  const height = m.height + pad * 2 + st.fontSize * 0.2
  const x = p[0] - pad
  const y = p[1] - st.fontSize * 0.65 - pad
  return fitRect([x, y, x + width, y + height], page.width, page.height)
}

export async function placeNote(doc: DocumentModel, tool: MarkupTool, page: number, p: Point, size: { width: number; height: number }) {
  const text = await textForNewComment(tool)
  if (text === null) return
  const rect = fitRect([p[0] - 8, p[1] - 8, p[0] + 12, p[1] + 12], size.width, size.height)
  const created = await createWith(doc, tool, [{ page, spec: { type: 'Text', rect, contents: text, ...styleSpec(tool, getToolStyle(tool.key)) } }])
  if (created) finishCreate(doc, tool, page, [created[0].id], { edit: created[0].id })
}

export async function placeTypewriter(doc: DocumentModel, tool: MarkupTool, page: number, p: Point, size: { width: number; height: number }) {
  const text = await textForNewComment(tool)
  // without the comments feature the text was typed first; an empty text comment would be invisible
  if (text === null || (text === '' && !commentsInstalled())) return
  const st = getToolStyle(tool.key)
  const rect = typewriterRect(p, st, text, size)
  const created = await createWith(doc, tool, [{ page, spec: { type: 'FreeText', rect, contents: text, ...styleSpec(tool, st) } }])
  if (created) finishCreate(doc, tool, page, [created[0].id], { edit: created[0].id })
}

export async function placeCaret(doc: DocumentModel, tool: MarkupTool, page: number, p: Point) {
  const t = await pageTextOrReport(doc, page)
  if (!t) return
  const ip = insertionPoint(t, p) ?? { x: p[0], bottom: p[1] }
  const text = await textForNewComment(tool)
  if (text === null) return
  const created = await createWith(doc, tool, [
    { page, spec: { type: 'Caret', rect: caretRectAt(ip.x, ip.bottom), contents: text, subject: 'Inserted Text', ...styleSpec(tool, getToolStyle(tool.key)) } }
  ])
  if (created) finishCreate(doc, tool, page, [created[0].id], { edit: created[0].id })
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export function mimeFor(name: string): string {
  return MIME[(/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream'
}

/** Attach file: choose a file and embed it in a FileAttachment comment at the clicked point. */
export async function placeAttachment(doc: DocumentModel, tool: MarkupTool, page: number, p: Point, size: { width: number; height: number }) {
  let paths: string[]
  try {
    paths = await invoke('file:openDialog', { title: 'Attach File', multiple: false })
  } catch (err) {
    showError(err, 'Could not open the file chooser')
    return
  }
  const path = paths[0]
  if (!path) return
  const name = basename(path)
  let data: Uint8Array
  try {
    data = await withProgress(`Attaching ${name}…`, () => readFile(path))
  } catch (err) {
    showError(err, `Could not read ${name}`)
    return
  }
  const rect = fitRect([p[0] - 8, p[1] - 8, p[0] + 12, p[1] + 12], size.width, size.height)
  const created = await createWith(doc, tool, [
    {
      page,
      spec: { type: 'FileAttachment', rect, contents: name, ...styleSpec(tool, getToolStyle(tool.key)) },
      attachment: { name, data, mime: mimeFor(name) }
    }
  ])
  if (created) finishCreate(doc, tool, page, [created[0].id])
}

export function ClickLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { tool, style } = useActiveToolAndStyle()
  const [hover, setHover] = useState<Point | null>(null)
  const busy = useRef(false)
  if (!tool) return null
  const size = { width: geometry.width, height: geometry.height }

  const onClick = (e: React.MouseEvent) => {
    if (e.button !== 0 || busy.current) return
    const p = pagePoint(e, ref.current!, geometry)
    busy.current = true
    const done = () => {
      busy.current = false
    }
    if (tool.kind === 'note') void placeNote(doc, tool, pageIndex, p, size).finally(done)
    else if (tool.kind === 'typewriter') void placeTypewriter(doc, tool, pageIndex, p, size).finally(done)
    else if (tool.kind === 'insertText') void placeCaret(doc, tool, pageIndex, p).finally(done)
    else if (tool.kind === 'attach') void placeAttachment(doc, tool, pageIndex, p, size).finally(done)
    else done()
  }

  let ghost: React.ReactNode = null
  if (hover) {
    if (tool.kind === 'note' || tool.kind === 'attach') {
      const c = geometry.toCss([hover[0] - 8, hover[1] - 8])
      const s = geometry.len(16)
      const Icon = tool.kind === 'note' ? StickyNote : Paperclip
      ghost = (
        <div className="fc-markup-tools-ghost-note" style={{ left: c[0], top: c[1], width: s, height: s, background: style.color }}>
          <Icon size={Math.max(10, s * 0.8)} />
        </div>
      )
    } else if (tool.kind === 'typewriter') {
      const top = geometry.toCss([hover[0], hover[1] - style.fontSize * 0.65])
      const bottom = geometry.toCss([hover[0], hover[1] + style.fontSize * 0.55])
      ghost = <div className="fc-markup-tools-ghost-caret" style={{ left: top[0], top: Math.min(top[1], bottom[1]), height: Math.abs(bottom[1] - top[1]), background: style.fontColor }} />
    } else if (tool.kind === 'insertText') {
      const t = getLoadedText(doc, pageIndex)
      const ip = t ? insertionPoint(t, hover) : null
      if (ip) {
        const a = geometry.toCss([ip.x, ip.bottom - 3])
        const l = geometry.toCss([ip.x - 6, ip.bottom + 7])
        const r = geometry.toCss([ip.x + 6, ip.bottom + 7])
        ghost = (
          <svg className="fc-markup-tools-svg" width={geometry.cssWidth} height={geometry.cssHeight} aria-hidden="true">
            <polyline points={`${l.join(',')} ${a.join(',')} ${r.join(',')}`} fill="none" stroke={style.color} strokeWidth={2} />
          </svg>
        )
      }
    }
  }

  return (
    <div
      ref={ref}
      className={`viewer-layer fc-markup-tools-layer fc-markup-tools-cursor-${tool.kind}`}
      onClick={onClick}
      onPointerMove={(e) => {
        if (tool.kind === 'insertText' && !getLoadedText(doc, pageIndex)) void pageTextOrReport(doc, pageIndex)
        setHover(pagePoint(e, ref.current!, geometry))
      }}
      onPointerLeave={() => setHover(null)}
    >
      {ghost}
    </div>
  )
}
