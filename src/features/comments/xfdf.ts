/**
 * XFDF (XML Forms Data Format) comment files, as written and read by Adobe Acrobat.
 * Building is plain string work; parsing walks a DOM (DOMParser in the app, any compatible
 * implementation in tests).
 */
import type { Point, Rect } from '@shared/geometry'
import { normalizeRect } from '@shared/geometry'
import { parsePdfDate, pdfDate } from '@engine/util/pdf'
import { bytesToBase64, bytesToHex, flagsToNames, hexToBytes, base64ToBytes, namesToFlags, type CommentRecord } from './shared'

const ELEMENT_OF: Record<string, string> = {
  Text: 'text',
  FreeText: 'freetext',
  Line: 'line',
  Square: 'square',
  Circle: 'circle',
  Polygon: 'polygon',
  PolyLine: 'polyline',
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
  Stamp: 'stamp',
  Caret: 'caret',
  Ink: 'ink',
  FileAttachment: 'fileattachment',
  Redact: 'redact'
}
const TYPE_OF: Record<string, string> = Object.fromEntries(Object.entries(ELEMENT_OF).map(([k, v]) => [v, k]))

const STYLE_OUT: Record<string, string> = { Solid: 'solid', Dashed: 'dash', Beveled: 'bevelled', Inset: 'inset', Underline: 'underline' }
const STYLE_IN: Record<string, CommentRecord['borderStyle']> = {
  solid: 'Solid',
  dash: 'Dashed',
  dashed: 'Dashed',
  bevelled: 'Beveled',
  beveled: 'Beveled',
  inset: 'Inset',
  underline: 'Underline'
}
const JUSTIFY = ['left', 'centered', 'right']

function n(v: number): string {
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v * 1000) / 1000)
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function escAttr(s: string): string {
  return esc(s).replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
}

function date(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : pdfDate(d)
}

function color(hex: string | null | undefined): string | null {
  if (!hex || hex === 'transparent') return null
  return hex.toUpperCase()
}

/** Writes an XFDF document with the given comments. */
export function buildXfdf(records: CommentRecord[], fileName: string): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">', '<annots>']
  for (const r of records) {
    const el = ELEMENT_OF[r.type]
    if (!el) continue
    const a: [string, string | null | undefined][] = [
      ['page', String(r.page)],
      ['rect', r.rect.map(n).join(',')],
      ['name', r.name],
      ['title', r.author],
      ['subject', r.subject],
      ['date', date(r.modified)],
      ['creationdate', date(r.created)],
      ['color', color(r.color)],
      ['interior-color', color(r.interiorColor)],
      ['opacity', r.opacity !== undefined && r.opacity < 1 ? n(r.opacity) : null],
      ['flags', r.flags ? flagsToNames(r.flags) : null],
      ['inreplyto', r.inReplyTo],
      ['replyType', r.inReplyTo ? (r.replyType === 'Group' ? 'group' : 'reply') : null],
      ['state', r.state],
      ['statemodel', r.stateModel],
      ['icon', r.icon],
      ['IT', r.intent]
    ]
    if (r.borderWidth !== undefined) a.push(['width', n(r.borderWidth)])
    if (r.cloudy) {
      a.push(['style', 'cloudy'], ['intensity', '1'])
    } else if (r.borderStyle) a.push(['style', STYLE_OUT[r.borderStyle] ?? 'solid'])
    if (r.dashes?.length) a.push(['dashes', r.dashes.map(n).join(',')])
    if (r.quads?.length) a.push(['coords', r.quads.flat().map(n).join(',')])
    if (r.line) {
      a.push(['start', `${n(r.line[0][0])},${n(r.line[0][1])}`], ['end', `${n(r.line[1][0])},${n(r.line[1][1])}`])
    }
    if (r.lineEndings) a.push(['head', r.lineEndings.start], ['tail', r.lineEndings.end])
    if (r.type === 'FreeText' && r.quadding) a.push(['justification', JUSTIFY[r.quadding] ?? 'left'])
    if (r.calloutLine?.length) a.push(['callout', r.calloutLine.flat().map(n).join(',')])
    if (r.file) {
      a.push(['file', r.file.name])
      if (r.file.mime) a.push(['mimetype', r.file.mime])
    }
    const attrs = a
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}="${escAttr(String(v))}"`)
      .join(' ')
    const kids: string[] = []
    if (r.contents) kids.push(`<contents>${esc(r.contents)}</contents>`)
    if (r.popup) {
      kids.push(`<popup page="${r.page}" rect="${r.popup.rect.map(n).join(',')}" open="${r.popup.open ? 'yes' : 'no'}"/>`)
    }
    if (r.vertices?.length) kids.push(`<vertices>${r.vertices.map((p) => `${n(p[0])},${n(p[1])}`).join(';')}</vertices>`)
    if (r.ink?.length) {
      kids.push(
        `<inklist>${r.ink.map((stroke) => `<gesture>${stroke.map((p) => `${n(p[0])},${n(p[1])}`).join(';')}</gesture>`).join('')}</inklist>`
      )
    }
    if (r.defaultAppearance) kids.push(`<defaultappearance>${esc(r.defaultAppearance)}</defaultappearance>`)
    if (r.imagePng) kids.push(`<imagedata>data:image/png;base64,${r.imagePng}</imagedata>`)
    if (r.file) {
      const bytes = base64ToBytes(r.file.data)
      kids.push(`<data MODE="raw" encoding="hex" length="${bytes.length}">${bytesToHex(bytes)}</data>`)
    }
    if (r.extra && Object.keys(r.extra).length) {
      kids.push(
        `<fartcrobat-data>${Object.entries(r.extra)
          .map(([k, v]) => `<entry key="${escAttr(k)}">${esc(v)}</entry>`)
          .join('')}</fartcrobat-data>`
      )
    }
    out.push(kids.length ? `<${el} ${attrs}>${kids.join('')}</${el}>` : `<${el} ${attrs}/>`)
  }
  out.push('</annots>', `<f href="${escAttr(fileName)}"/>`, '</xfdf>', '')
  return out.join('\n')
}

// ---- parsing ----------------------------------------------------------------------------------

/** The part of the DOM API the parser uses (browser DOMParser and @xmldom both provide it). */
export interface XmlNode {
  nodeType: number
  nodeName: string
  localName?: string | null
  textContent: string | null
  childNodes: ArrayLike<XmlNode>
  getAttribute?: (name: string) => string | null
}

function local(el: XmlNode): string {
  return (el.localName || el.nodeName.replace(/^.*:/, '')).toLowerCase()
}

function children(el: XmlNode, name?: string): XmlNode[] {
  const out: XmlNode[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === 1 && (!name || local(c) === name)) out.push(c)
  }
  return out
}

function attr(el: XmlNode, ...names: string[]): string | null {
  for (const name of names) {
    const v = el.getAttribute?.(name)
    if (v !== null && v !== undefined && v !== '') return v
  }
  return null
}

function nums(s: string | null): number[] {
  if (!s) return []
  return s
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number)
    .filter((v) => Number.isFinite(v))
}

function points(s: string | null): Point[] {
  const v = nums(s)
  const out: Point[] = []
  for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]])
  return out
}

function parseDate(s: string | null): string | undefined {
  if (!s) return undefined
  const iso = parsePdfDate(s)
  if (iso) return iso
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

function parseColor(s: string | null): string | null | undefined {
  if (s === null) return undefined
  const v = s.trim()
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(v)) return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase()
  if (/^(none|transparent)$/i.test(v)) return null
  return undefined
}

/** Reads "font: Helvetica 12pt; color: #ff0000" (XFDF defaultstyle) into a default appearance string. */
function styleToDA(style: string): string | undefined {
  const size = /font(?:-size)?\s*:[^;]*?([\d.]+)\s*pt/i.exec(style)?.[1]
  const col = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{6})/i.exec(style)?.[1]
  if (!size && !col) return undefined
  const rgb = col ? [1, 3, 5].map((i) => (parseInt(col.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ') : '0 0 0'
  return `/Helv ${parseFloat(size ?? '12')} Tf ${rgb} rg`
}

let counter = 0

/** Parses the comments of an XFDF document. Throws when the document is not XFDF. */
export function parseXfdf(root: XmlNode): CommentRecord[] {
  if (local(root) !== 'xfdf') throw new Error('This is not an XFDF comment file')
  const out: CommentRecord[] = []
  for (const annots of children(root, 'annots')) {
    for (const el of children(annots)) {
      const type = TYPE_OF[local(el)]
      if (!type) continue
      const rectNums = nums(attr(el, 'rect'))
      const rect: Rect = rectNums.length >= 4 ? normalizeRect([rectNums[0], rectNums[1], rectNums[2], rectNums[3]]) : [0, 0, 0, 0]
      const page = parseInt(attr(el, 'page') ?? '0', 10)
      const r: CommentRecord = {
        type,
        page: Number.isFinite(page) ? page : 0,
        name: attr(el, 'name') ?? `xfdf-${Date.now().toString(36)}-${++counter}`,
        rect
      }
      const author = attr(el, 'title', 'T')
      if (author) r.author = author
      const subject = attr(el, 'subject', 'Subj')
      if (subject) r.subject = subject
      r.modified = parseDate(attr(el, 'date', 'M'))
      r.created = parseDate(attr(el, 'creationdate', 'CreationDate'))
      const c = parseColor(attr(el, 'color', 'C'))
      if (c !== undefined) r.color = c
      const ic = parseColor(attr(el, 'interior-color', 'IC', 'fill-color'))
      if (ic !== undefined) r.interiorColor = ic
      const op = attr(el, 'opacity', 'CA')
      if (op !== null && Number.isFinite(parseFloat(op))) r.opacity = Math.max(0, Math.min(1, parseFloat(op)))
      const flags = attr(el, 'flags', 'F')
      if (flags) r.flags = /^\d+$/.test(flags) ? parseInt(flags, 10) : namesToFlags(flags)
      const irt = attr(el, 'inreplyto', 'IRT')
      if (irt) {
        r.inReplyTo = irt
        r.replyType = /group/i.test(attr(el, 'replyType', 'replytype', 'RT') ?? '') ? 'Group' : 'R'
      }
      const state = attr(el, 'state')
      if (state) r.state = state
      const model = attr(el, 'statemodel', 'stateModel')
      if (model) r.stateModel = model
      const icon = attr(el, 'icon', 'Name')
      if (icon) r.icon = icon
      const intent = attr(el, 'IT', 'intent', 'it')
      if (intent) r.intent = intent
      const width = attr(el, 'width')
      if (width !== null && Number.isFinite(parseFloat(width))) r.borderWidth = parseFloat(width)
      const style = (attr(el, 'style') ?? '').toLowerCase()
      if (style === 'cloudy') {
        r.cloudy = true
        r.borderStyle = 'Solid'
      } else if (STYLE_IN[style]) r.borderStyle = STYLE_IN[style]
      const dashes = nums(attr(el, 'dashes'))
      if (dashes.length) r.dashes = dashes
      const coords = nums(attr(el, 'coords'))
      if (coords.length >= 8) {
        r.quads = []
        for (let i = 0; i + 7 < coords.length; i += 8) r.quads.push(coords.slice(i, i + 8))
      }
      const start = points(attr(el, 'start'))
      const end = points(attr(el, 'end'))
      if (start.length && end.length) r.line = [start[0], end[0]]
      const head = attr(el, 'head')
      const tail = attr(el, 'tail')
      if (head || tail) r.lineEndings = { start: head ?? 'None', end: tail ?? 'None' }
      const just = attr(el, 'justification')
      if (just) r.quadding = Math.max(0, JUSTIFY.indexOf(just.toLowerCase()))
      const callout = points(attr(el, 'callout'))
      if (callout.length >= 2) r.calloutLine = callout
      for (const kid of children(el)) {
        const k = local(kid)
        const text = kid.textContent ?? ''
        if (k === 'contents') r.contents = text.replace(/\r\n?/g, '\n')
        else if (k === 'contents-richtext' && r.contents === undefined) r.contents = text.trim()
        else if (k === 'popup') {
          const pr = nums(attr(kid, 'rect'))
          if (pr.length >= 4) r.popup = { rect: normalizeRect([pr[0], pr[1], pr[2], pr[3]]), open: /^(yes|true|1)$/i.test(attr(kid, 'open') ?? '') }
        } else if (k === 'vertices') r.vertices = points(text)
        else if (k === 'inklist') {
          r.ink = children(kid, 'gesture')
            .map((g) => points(g.textContent))
            .filter((s) => s.length)
        } else if (k === 'defaultappearance') r.defaultAppearance = text.trim()
        else if (k === 'defaultstyle' && !r.defaultAppearance) r.defaultAppearance = styleToDA(text)
        else if (k === 'imagedata' && text.trim()) r.imagePng = text.trim().replace(/^data:[^,]*,/, '')
        else if (k === 'data' && text.trim()) {
          const encoding = (attr(kid, 'encoding', 'ENCODING') ?? 'hex').toLowerCase()
          const bytes = encoding === 'base64' ? base64ToBytes(text) : hexToBytes(text)
          r.file = { name: attr(el, 'file') ?? 'attachment', mime: attr(el, 'mimetype') ?? undefined, data: bytesToBase64(bytes) }
        } else if (k === 'fartcrobat-data') {
          r.extra = {}
          for (const e of children(kid, 'entry')) {
            const key = attr(e, 'key')
            if (key) r.extra[key] = e.textContent ?? ''
          }
        }
      }
      if (type === 'FreeText' && !r.defaultAppearance) r.defaultAppearance = '/Helv 12 Tf 0 0 0 rg'
      // markup annotations need a rect for the comment list even when the file only has coords
      if (!rectNums.length && r.quads?.length) {
        const xs = r.quads.flatMap((q) => [q[0], q[2], q[4], q[6]])
        const ys = r.quads.flatMap((q) => [q[1], q[3], q[5], q[7]])
        r.rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      }
      out.push(r)
    }
  }
  return out
}

/** Parses XFDF text with the browser's DOMParser. */
export function parseXfdfText(text: string): CommentRecord[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
    throw new Error('The file is not valid XML')
  }
  return parseXfdf(doc.documentElement as unknown as XmlNode)
}
