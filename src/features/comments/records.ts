/**
 * Converts between document annotations and CommentRecords (user-space interchange form used for
 * XFDF). Engine side: runs in the worker / in Node tests.
 */
import type { Matrix, Point, Quad, Rect } from '@shared/geometry'
import { normalizeRect, transformPoint, transformRect } from '@shared/geometry'
import { annotInfo, applySpec, type AnnotSpec } from '@engine/ops/annots'
import type { PDFAnnotation, PDFObject, Session } from '@engine/session'
import { isNull, readName, readRect, readString } from '@engine/util/pdf'
import { countImported, emptyImportSummary, ExistingComments, stampNeedsAppearance, type ImportSummary } from './fdf'
import { base64ToBytes, bytesToBase64, cleanDate, parseDefaultAppearance, uniqueName, type CommentRecord } from './shared'

const NON_COMMENT = new Set(['Link', 'Widget', 'Popup'])

/** Types we can create when importing. */
export const IMPORTABLE = new Set([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'FileAttachment',
  'Redact'
])

function readNums(obj: PDFObject): number[] {
  const out: number[] = []
  if (isNull(obj)) return out
  const o = obj.resolve()
  if (!o.isArray()) return out
  for (let i = 0; i < o.length; i++) {
    const v = o.get(i).resolve()
    if (v.isNumber()) out.push(v.asNumber())
  }
  return out
}

function pairs(nums: number[]): Point[] {
  const out: Point[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]])
  return out
}

function nameOf(obj: PDFObject): string {
  return readString(obj.get('NM')) || uniqueName()
}

function stampPng(annot: PDFAnnotation, s: Session): string | undefined {
  try {
    const b = annot.getBounds() as Rect
    const w = b[2] - b[0]
    const h = b[3] - b[1]
    if (w <= 0 || h <= 0) return undefined
    // about 200 dpi, capped to keep files reasonable
    const scale = Math.min(200 / 72, 2400 / Math.max(w, h))
    const pix = annot.toPixmap([scale, 0, 0, scale, 0, 0], s.mupdf.ColorSpace.DeviceRGB, true)
    try {
      return bytesToBase64(pix.asPNG())
    } finally {
      pix.destroy()
    }
  } catch {
    return undefined
  }
}

/** Every comment of the document as interchange records (user-space coordinates). */
export function exportRecords(s: Session): CommentRecord[] {
  const out: CommentRecord[] = []
  const n = s.pageCount()
  const names = new Map<number, string>()
  for (let p = 0; p < n; p++) {
    for (const a of s.page(p).getAnnotations()) {
      const obj = a.getObject()
      if (obj.isIndirect()) names.set(obj.asIndirect(), nameOf(obj))
    }
  }
  for (let p = 0; p < n; p++) {
    const annots = s.page(p).getAnnotations()
    const toUser = s.pageToUser(p)
    annots.forEach((a, k) => {
      const obj = a.getObject()
      let type: string
      try {
        type = a.getType()
      } catch {
        return
      }
      if (NON_COMMENT.has(type)) return
      const info = annotInfo(s, a, p, k)
      const rec: CommentRecord = {
        type,
        page: p,
        name: obj.isIndirect() ? names.get(obj.asIndirect())! : nameOf(obj),
        // MuPDF's rect (without the border fringe /RD that the raw /Rect may include)
        rect: normalizeRect(transformRect(info.rect, toUser)),
        color: info.color,
        opacity: info.opacity,
        contents: info.contents,
        author: info.author,
        subject: info.subject,
        created: cleanDate(info.created) || undefined,
        modified: cleanDate(info.modified) || undefined,
        flags: info.flags
      }
      const irt = obj.get('IRT')
      if (!isNull(irt) && irt.isIndirect()) {
        const parent = names.get(irt.asIndirect())
        if (parent) {
          rec.inReplyTo = parent
          rec.replyType = readName(obj.get('RT')) === 'Group' ? 'Group' : 'R'
        }
      }
      if (info.interiorColor) rec.interiorColor = info.interiorColor
      if (!isNull(obj.get('BS')) || !isNull(obj.get('Border'))) {
        rec.borderWidth = info.borderWidth
        rec.borderStyle = info.borderStyle as CommentRecord['borderStyle']
        if (info.dashes.length) rec.dashes = info.dashes
      }
      if (info.cloudy) rec.cloudy = true
      if (info.icon) rec.icon = info.icon
      if (info.state) rec.state = info.state
      if (info.stateModel) rec.stateModel = info.stateModel
      if (info.intent) rec.intent = info.intent
      const qp = readNums(obj.get('QuadPoints'))
      if (qp.length >= 8) {
        rec.quads = []
        for (let i = 0; i + 7 < qp.length; i += 8) rec.quads.push(qp.slice(i, i + 8))
      }
      const ink = obj.get('InkList')
      if (!isNull(ink) && ink.resolve().isArray()) {
        const arr = ink.resolve()
        rec.ink = []
        for (let i = 0; i < arr.length; i++) rec.ink.push(pairs(readNums(arr.get(i))))
      }
      const vertices = readNums(obj.get('Vertices'))
      if (vertices.length >= 4) rec.vertices = pairs(vertices)
      const l = readNums(obj.get('L'))
      if (l.length === 4) rec.line = [
        [l[0], l[1]],
        [l[2], l[3]]
      ]
      const callout = type === 'FreeText' && /Callout/i.test(info.intent ?? '')
      if (info.lineEndings && (type === 'Line' || type === 'PolyLine' || callout || info.lineEndings.start !== 'None' || info.lineEndings.end !== 'None')) {
        if (type !== 'FreeText' || callout) rec.lineEndings = info.lineEndings
      }
      const cl = readNums(obj.get('CL'))
      if (callout && cl.length >= 4) rec.calloutLine = pairs(cl)
      if (type === 'FreeText') {
        rec.defaultAppearance = readString(obj.get('DA')) || undefined
        rec.quadding = info.quadding
      }
      const popup = obj.get('Popup')
      if (!isNull(popup)) {
        const pd = popup.resolve()
        rec.popup = { rect: readRect(pd.get('Rect'), rec.rect), open: !isNull(pd.get('Open')) && pd.get('Open').asBoolean() }
      }
      if (type === 'Stamp' && stampNeedsAppearance(obj)) rec.imagePng = stampPng(a, s)
      if (type === 'FileAttachment') {
        try {
          const fs = a.getFileSpec()
          if (fs && !isNull(fs)) {
            const params = s.pdf.getFilespecParams(fs)
            const buf = s.pdf.getEmbeddedFileContents(fs)
            if (buf) rec.file = { name: params.filename, mime: params.mimetype || undefined, data: bytesToBase64(buf.asUint8Array()) }
          }
        } catch {}
      }
      if (Object.keys(info.extra).length) rec.extra = info.extra
      out.push(rec)
    })
  }
  return out
}

/** Records with their parents first, so replies can be linked while creating. */
function orderParentsFirst(records: CommentRecord[]): CommentRecord[] {
  const names = new Set(records.map((r) => r.name))
  const done = new Set<string>()
  const out: CommentRecord[] = []
  let rest = records
  for (let guard = 0; rest.length && guard < 64; guard++) {
    const next: CommentRecord[] = []
    for (const r of rest) {
      if (!r.inReplyTo || !names.has(r.inReplyTo) || done.has(r.inReplyTo)) {
        out.push(r)
        done.add(r.name)
      } else next.push(r)
    }
    if (next.length === rest.length) {
      out.push(...next)
      break
    }
    rest = next
  }
  return out
}

function mapQuad(q: number[], m: Matrix): Quad {
  const pts = [0, 2, 4, 6].map((i) => transformPoint([q[i], q[i + 1]], m))
  return pts.flat() as Quad
}

/** AnnotSpec (page space) for a record (user space) on a page with the given user->page matrix. */
export function recordToSpec(r: CommentRecord, m: Matrix): AnnotSpec {
  const P = (p: Point) => transformPoint(p, m)
  const spec: AnnotSpec = { type: r.type }
  if (r.rect) spec.rect = normalizeRect(transformRect(r.rect, m))
  if (r.quads?.length) spec.quads = r.quads.filter((q) => q.length >= 8).map((q) => mapQuad(q, m))
  if (r.ink?.length) spec.ink = r.ink.map((stroke) => stroke.map(P))
  if (r.vertices?.length) spec.vertices = r.vertices.map(P)
  if (r.line) spec.line = [P(r.line[0]), P(r.line[1])]
  if (r.calloutLine?.length) spec.calloutLine = r.calloutLine.map(P)
  if (r.color !== undefined) spec.color = r.color
  if (r.interiorColor !== undefined) spec.interiorColor = r.interiorColor
  if (r.opacity !== undefined) spec.opacity = r.opacity
  if (r.borderWidth !== undefined) spec.borderWidth = r.borderWidth
  if (r.borderStyle) spec.borderStyle = r.borderStyle
  if (r.dashes) spec.dashes = r.dashes
  if (r.cloudy !== undefined) spec.cloudy = r.cloudy
  if (r.contents !== undefined) spec.contents = r.contents
  if (r.author) spec.author = r.author
  if (r.subject) spec.subject = r.subject
  if (r.icon) spec.icon = r.icon
  if (r.lineEndings) spec.lineEndings = r.lineEndings as AnnotSpec['lineEndings']
  if (r.intent) spec.intent = r.intent
  if (r.quadding !== undefined) spec.quadding = r.quadding
  if (r.flags !== undefined) spec.flags = r.flags
  if (r.state) spec.state = r.state
  if (r.stateModel) spec.stateModel = r.stateModel
  if (r.defaultAppearance) {
    const da = parseDefaultAppearance(r.defaultAppearance)
    spec.fontName = /^(Helv|TiRo|Cour|Symb|ZaDb)$/.test(da.font) ? da.font : 'Helv'
    spec.fontSize = da.size
    spec.textColor = da.color
  }
  if (r.extra) spec.extra = r.extra
  return spec
}

const GEOMETRY: (keyof AnnotSpec)[] = ['rect', 'quads', 'ink', 'vertices', 'line']

/** Creates annotations from records (runs inside a mutation). Skips comments already present (same /NM). */
export function importRecordsInto(s: Session, records: CommentRecord[]): ImportSummary {
  const summary = emptyImportSummary()
  const existing = new ExistingComments(s)
  const created = new Map<string, PDFObject>()
  const pageCount = s.pageCount()
  const touched = new Set<number>()
  for (const r of orderParentsFirst(records)) {
    if (!IMPORTABLE.has(r.type) || !Number.isInteger(r.page) || r.page < 0 || r.page >= pageCount) {
      summary.skipped++
      continue
    }
    const page = s.page(r.page)
    const spec = recordToSpec(r, s.userToPage(r.page))
    const dup = existing.find(r.name, r.type, r.page, spec.rect ?? [0, 0, 0, 0], r.author ?? '', r.contents ?? '')
    if (dup) {
      summary.duplicates++
      if (!r.inReplyTo) summary.duplicateComments++
      if (r.name) created.set(r.name, dup)
      continue
    }
    let annot: PDFAnnotation
    try {
      annot = page.createAnnotation(r.type as any)
    } catch {
      summary.skipped++
      continue
    }
    // Geometry first: without it the comment is meaningless, so give up on this one.
    try {
      const geo: AnnotSpec = {}
      for (const k of GEOMETRY) if (spec[k] !== undefined) (geo as any)[k] = spec[k]
      // (applySpec ignores the rect of types whose rect MuPDF derives from their geometry)
      applySpec(s, annot, geo)
    } catch {
      try {
        page.deleteAnnotation(annot)
      } catch {}
      summary.skipped++
      continue
    }
    // Everything else one property at a time, so one odd value does not lose the comment.
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'type' || GEOMETRY.includes(k as keyof AnnotSpec) || v === undefined) continue
      if (k === 'textColor' || k === 'fontSize') continue
      try {
        if (k === 'fontName') applySpec(s, annot, { fontName: spec.fontName, fontSize: spec.fontSize, textColor: spec.textColor })
        else applySpec(s, annot, { [k]: v } as AnnotSpec)
      } catch {}
    }
    if (r.imagePng) {
      try {
        applySpec(s, annot, { stampImage: base64ToBytes(r.imagePng) })
      } catch {}
    }
    if (r.file) {
      try {
        applySpec(s, annot, { file: { name: r.file.name, mime: r.file.mime, data: base64ToBytes(r.file.data) } })
      } catch {}
    }
    const obj = annot.getObject()
    try {
      annot.setName(r.name || uniqueName())
    } catch {}
    if (r.inReplyTo) {
      const parent = created.get(r.inReplyTo) ?? existing.byNameOnly(r.inReplyTo)
      if (parent) {
        obj.put('IRT', parent)
        if (r.replyType === 'Group') obj.put('RT', s.pdf.newName('Group'))
        // replies live in the pop-up and the Comments list, not as icons on the page
        if (r.type === 'Text') {
          try {
            annot.setFlags(annot.getFlags() | 2)
          } catch {}
        }
      }
    }
    try {
      if (r.created) annot.setCreationDate(new Date(r.created))
      if (r.modified) annot.setModificationDate(new Date(r.modified))
    } catch {}
    try {
      annot.update()
    } catch {}
    created.set(r.name, obj)
    touched.add(r.page)
    summary.imported++
    summary.ids.push(obj.asIndirect())
    countImported(summary, !isNull(obj.get('IRT')), r.type, !!r.state)
  }
  for (const p of touched) s.touch(p)
  if (touched.size) s.documentChanged()
  return summary
}
