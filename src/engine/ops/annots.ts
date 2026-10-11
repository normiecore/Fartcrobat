import type { Point, Quad, Rect } from '@shared/geometry'
import { hexToRgb, rgbToHex } from '@shared/geometry'
import { defineOps, EngineError, mutation } from '../define'
import type { PDFAnnotation, Session } from '../session'
import { isNull, readName, readString } from '../util/pdf'

export type AnnotType =
  | 'Text'
  | 'FreeText'
  | 'Line'
  | 'Square'
  | 'Circle'
  | 'Polygon'
  | 'PolyLine'
  | 'Highlight'
  | 'Underline'
  | 'Squiggly'
  | 'StrikeOut'
  | 'Redact'
  | 'Stamp'
  | 'Caret'
  | 'Ink'
  | 'FileAttachment'
  | 'Sound'
  | 'Link'
  | 'Widget'
  | 'Popup'
  | string

export type LineEnding =
  | 'None'
  | 'Square'
  | 'Circle'
  | 'Diamond'
  | 'OpenArrow'
  | 'ClosedArrow'
  | 'Butt'
  | 'ROpenArrow'
  | 'RClosedArrow'
  | 'Slash'

export interface AnnotInfo {
  id: number
  page: number
  type: AnnotType
  rect: Rect
  /** Stroke/main colour as #rrggbb, or null for none. */
  color: string | null
  /** Fill colour as #rrggbb, or null. */
  interiorColor: string | null
  opacity: number
  borderWidth: number
  borderStyle: string
  dashes: number[]
  cloudy: boolean
  contents: string
  author: string
  subject: string
  created: string
  modified: string
  quads: Quad[]
  ink: Point[][]
  vertices: Point[]
  line: [Point, Point] | null
  lineEndings: { start: LineEnding; end: LineEnding } | null
  icon: string
  flags: number
  hidden: boolean
  locked: boolean
  /** Id of the annotation this one replies to (comment threads), or null. */
  inReplyTo: number | null
  /** Review state ("Accepted", "Rejected", "Cancelled", "Completed", "None", "Marked", "Unmarked") for state annotations. */
  state: string | null
  stateModel: string | null
  intent: string | null
  /** FreeText default appearance. */
  fontName: string | null
  fontSize: number | null
  textColor: string | null
  /** 0 left, 1 centre, 2 right */
  quadding: number
  calloutLine: Point[] | null
  richContents: string
  isOpen: boolean
  /** Name of an attached file (FileAttachment). */
  fileName: string | null
  /** Custom data stored by Fartcrobat features (e.g. measurement scale, stamp kind). */
  extra: Record<string, string>
}

/** Properties accepted when creating or updating an annotation. Colours are #rrggbb or null. */
export interface AnnotSpec {
  type?: AnnotType
  rect?: Rect
  color?: string | null
  interiorColor?: string | null
  opacity?: number
  borderWidth?: number
  borderStyle?: 'Solid' | 'Dashed' | 'Beveled' | 'Inset' | 'Underline'
  dashes?: number[]
  cloudy?: boolean
  contents?: string
  author?: string
  subject?: string
  quads?: Quad[]
  ink?: Point[][]
  vertices?: Point[]
  line?: [Point, Point]
  lineEndings?: { start: LineEnding; end: LineEnding }
  icon?: string
  flags?: number
  hidden?: boolean
  locked?: boolean
  inReplyTo?: number | null
  state?: string
  stateModel?: string
  intent?: string | null
  fontName?: string
  fontSize?: number
  textColor?: string
  quadding?: number
  calloutLine?: Point[]
  isOpen?: boolean
  /** PNG/JPEG bytes used as the appearance of a Stamp annotation. */
  stampImage?: Uint8Array
  /** File to embed in a FileAttachment annotation. */
  file?: { name: string; data: Uint8Array; mime?: string }
  /** Custom string data stored under /FartcrobatData in the annotation dictionary. */
  extra?: Record<string, string>
}

export const FLAG_HIDDEN = 2
export const FLAG_PRINT = 4
export const FLAG_NO_ZOOM = 8
export const FLAG_NO_ROTATE = 16
export const FLAG_LOCKED = 128

/** Annotation types shown and edited as comments (not links, widgets or popups). */
const NON_COMMENT = new Set(['Link', 'Widget', 'Popup'])

function toColor(c: number[] | [] | null | undefined): string | null {
  if (!c || c.length === 0) return null
  return rgbToHex(c as number[])
}

function fromColor(hex: string | null | undefined): [] | [number, number, number] {
  if (!hex || hex === 'transparent') return []
  return hexToRgb(hex)
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function dateIso(fn: () => Date): string {
  try {
    const d = fn()
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''
  } catch {
    return ''
  }
}

function readExtra(annot: PDFAnnotation): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const d = annot.getObject().get('FartcrobatData')
    if (!isNull(d) && d.isDictionary()) {
      d.forEach((v, k) => {
        out[String(k)] = readString(v)
      })
    }
  } catch {}
  return out
}

export function annotInfo(s: Session, annot: PDFAnnotation, pageIndex: number, position: number): AnnotInfo {
  const obj = annot.getObject()
  const type = annot.getType()
  let inReplyTo: number | null = null
  try {
    const irt = obj.get('IRT')
    if (!isNull(irt) && irt.isIndirect()) inReplyTo = irt.asIndirect()
  } catch {}
  const flags = safe(() => annot.getFlags(), 0)
  let da: { font: string; size: number; color: number[] } | null = null
  if (type === 'FreeText') da = safe(() => annot.getDefaultAppearance() as any, null)
  let fileName: string | null = null
  if (type === 'FileAttachment') {
    try {
      const fs = annot.getFileSpec()
      if (fs && !isNull(fs)) fileName = s.pdf.getFilespecParams(fs).filename
    } catch {}
  }
  return {
    id: s.annotationId(annot, pageIndex, position),
    page: pageIndex,
    type,
    rect: safe(() => annotRect(annot), [0, 0, 0, 0] as Rect),
    color: safe(() => toColor(annot.getColor()), null),
    interiorColor: safe(() => (annot.hasInteriorColor() ? toColor(annot.getInteriorColor()) : null), null),
    opacity: safe(() => annot.getOpacity(), 1),
    borderWidth: safe(() => (annot.hasBorder() ? annot.getBorderWidth() : 0), 0),
    borderStyle: safe(() => (annot.hasBorder() ? annot.getBorderStyle() : 'Solid'), 'Solid'),
    dashes: safe(() => (annot.hasBorder() ? (annot.getBorderDashPattern() as number[]) : []), []),
    cloudy: safe(() => (annot.hasBorderEffect() ? annot.getBorderEffect() === 'Cloudy' : false), false),
    contents: safe(() => annot.getContents(), ''),
    author: safe(() => (annot.hasAuthor() ? annot.getAuthor() : ''), ''),
    subject: safe(() => (annot.hasSubject() ? annot.getSubject() : ''), ''),
    created: dateIso(() => annot.getCreationDate()),
    modified: dateIso(() => annot.getModificationDate()),
    quads: safe(() => (annot.hasQuadPoints() ? (annot.getQuadPoints() as Quad[]) : []), []),
    ink: safe(() => (annot.hasInkList() ? (annot.getInkList() as Point[][]) : []), []),
    vertices: safe(() => (annot.hasVertices() ? (annot.getVertices() as Point[]) : []), []),
    line: safe(() => (annot.hasLine() ? (annot.getLine() as [Point, Point]) : null), null),
    lineEndings: safe(() => (annot.hasLineEndingStyles() ? (annot.getLineEndingStyles() as any) : null), null),
    icon: safe(() => (annot.hasIcon() ? annot.getIcon() : ''), ''),
    flags,
    hidden: (flags & FLAG_HIDDEN) !== 0,
    locked: (flags & FLAG_LOCKED) !== 0,
    inReplyTo,
    state: safe(() => readString(obj.get('State')) || null, null),
    stateModel: safe(() => readString(obj.get('StateModel')) || null, null),
    intent: safe(() => annot.getIntent(), null),
    fontName: da?.font ?? null,
    fontSize: da?.size ?? null,
    textColor: da ? toColor(da.color as number[]) : null,
    quadding: safe(() => annot.getQuadding(), 0),
    calloutLine: safe(() => (annot.hasCallout() ? (annot.getCalloutLine() as Point[] | null) : null), null),
    richContents: safe(() => (annot.hasRichContents() ? annot.getRichContents() : ''), ''),
    isOpen: safe(() => (annot.hasOpen() ? annot.getIsOpen() : false), false),
    fileName,
    extra: readExtra(annot)
  }
}

/** Applies spec properties to an annotation (does not call update()). */
export function applySpec(s: Session, annot: PDFAnnotation, spec: AnnotSpec) {
  const has = (k: keyof AnnotSpec) => spec[k] !== undefined
  if (has('rect') && safe(() => annot.hasRect(), true)) annot.setRect(spec.rect!)
  if (has('quads')) annot.setQuadPoints(spec.quads!)
  if (has('ink')) annot.setInkList(spec.ink!)
  if (has('vertices')) annot.setVertices(spec.vertices!)
  if (has('line')) annot.setLine(spec.line![0], spec.line![1])
  if (has('lineEndings')) annot.setLineEndingStyles(spec.lineEndings!.start, spec.lineEndings!.end)
  if (has('color')) annot.setColor(fromColor(spec.color))
  if (has('interiorColor') && safe(() => annot.hasInteriorColor(), false)) annot.setInteriorColor(fromColor(spec.interiorColor))
  if (has('opacity')) annot.setOpacity(Math.max(0, Math.min(1, spec.opacity!)))
  if (safe(() => annot.hasBorder(), false)) {
    if (has('borderWidth')) annot.setBorderWidth(spec.borderWidth!)
    if (has('borderStyle')) annot.setBorderStyle(spec.borderStyle!)
    if (has('dashes')) {
      if (spec.dashes!.length) annot.setBorderDashPattern(spec.dashes!)
      else annot.clearBorderDash()
    }
  }
  if (has('cloudy') && safe(() => annot.hasBorderEffect(), false)) {
    annot.setBorderEffect(spec.cloudy ? 'Cloudy' : 'None')
    if (spec.cloudy) annot.setBorderEffectIntensity(1)
  }
  if (has('contents')) annot.setContents(spec.contents!)
  if (has('author') && safe(() => annot.hasAuthor(), false)) annot.setAuthor(spec.author!)
  if (has('subject') && safe(() => annot.hasSubject(), false)) annot.setSubject(spec.subject!)
  if (has('icon') && safe(() => annot.hasIcon(), false)) annot.setIcon(spec.icon!)
  if (has('intent')) annot.setIntent((spec.intent ?? null) as any)
  if (has('quadding')) annot.setQuadding(spec.quadding!)
  if (has('calloutLine') && safe(() => annot.hasCallout(), false)) annot.setCalloutLine(spec.calloutLine!)
  if (has('isOpen') && safe(() => annot.hasOpen(), false)) annot.setIsOpen(spec.isOpen!)
  if (has('fontName') || has('fontSize') || has('textColor')) {
    const cur = safe(() => annot.getDefaultAppearance(), { font: 'Helv', size: 12, color: [0] as number[] } as any)
    annot.setDefaultAppearance(
      spec.fontName ?? cur.font ?? 'Helv',
      spec.fontSize ?? cur.size ?? 12,
      spec.textColor ? hexToRgb(spec.textColor) : ((cur.color as any) ?? [0])
    )
  }
  if (has('flags') || has('hidden') || has('locked')) {
    let f = spec.flags ?? safe(() => annot.getFlags(), FLAG_PRINT)
    if (spec.hidden !== undefined) f = spec.hidden ? f | FLAG_HIDDEN : f & ~FLAG_HIDDEN
    if (spec.locked !== undefined) f = spec.locked ? f | FLAG_LOCKED : f & ~FLAG_LOCKED
    annot.setFlags(f)
  }
  const obj = annot.getObject()
  if (has('inReplyTo')) {
    if (spec.inReplyTo === null) obj.delete('IRT')
    else {
      const parent = s.requireAnnotation(spec.inReplyTo!)
      obj.put('IRT', parent.annot.getObject())
    }
  }
  if (has('state')) obj.put('State', s.pdf.newString(spec.state!))
  if (has('stateModel')) obj.put('StateModel', s.pdf.newString(spec.stateModel!))
  if (spec.stampImage) {
    const img = new s.mupdf.Image(spec.stampImage)
    annot.setStampImage(img)
  }
  if (spec.file) {
    const now = new Date()
    const fs = s.pdf.addEmbeddedFile(spec.file.name, spec.file.mime ?? 'application/octet-stream', spec.file.data, now, now)
    annot.setFileSpec(fs)
  }
  if (spec.extra) {
    let d = obj.get('FartcrobatData')
    if (isNull(d) || !d.isDictionary()) {
      d = s.pdf.newDictionary()
      obj.put('FartcrobatData', d)
      d = obj.get('FartcrobatData')
    }
    for (const [k, v] of Object.entries(spec.extra)) d.put(k, s.pdf.newString(v))
  }
  try {
    annot.setModificationDate(new Date())
  } catch {}
}

function listPage(s: Session, pageIndex: number, includeAll = false): AnnotInfo[] {
  const page = s.page(pageIndex)
  const out: AnnotInfo[] = []
  page.getAnnotations().forEach((a, k) => {
    const t = safe(() => a.getType(), 'Unknown')
    if (!includeAll && NON_COMMENT.has(t)) return
    out.push(annotInfo(s, a, pageIndex, k))
  })
  return out
}

function mapPoint(p: Point, from: Rect, to: Rect): Point {
  const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0])
  const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1])
  return [to[0] + (p[0] - from[0]) * sx, to[1] + (p[1] - from[1]) * sy]
}

/** Moves/resizes an annotation so its rect goes from `from` to `to`, transforming its geometry. */
export function annotRect(annot: PDFAnnotation): Rect {
  return (safe(() => annot.hasRect(), false) ? annot.getRect() : annot.getBounds()) as Rect
}

export function transformAnnotation(annot: PDFAnnotation, to: Rect) {
  const from = annotRect(annot)
  const map = (p: Point) => mapPoint(p, from, to)
  if (safe(() => annot.hasInkList(), false)) {
    annot.setInkList((annot.getInkList() as Point[][]).map((stroke) => stroke.map(map)))
  }
  if (safe(() => annot.hasVertices(), false)) annot.setVertices((annot.getVertices() as Point[]).map(map))
  if (safe(() => annot.hasLine(), false)) {
    const [a, b] = annot.getLine() as Point[]
    annot.setLine(map(a), map(b))
  }
  if (safe(() => annot.hasQuadPoints(), false)) {
    annot.setQuadPoints(
      (annot.getQuadPoints() as Quad[]).map((q) => {
        const pts = [map([q[0], q[1]]), map([q[2], q[3]]), map([q[4], q[5]]), map([q[6], q[7]])]
        return pts.flat() as Quad
      })
    )
  }
  if (safe(() => annot.hasCallout(), false)) {
    const cl = annot.getCalloutLine() as Point[] | null
    if (cl && cl.length) annot.setCalloutLine(cl.map(map))
  }
  if (safe(() => annot.hasRect(), false)) annot.setRect(to)
}

export default defineOps('annots', {
  /** Comment-type annotations on a page (excludes links, form widgets and popups). */
  list(s, pageIndex: number): AnnotInfo[] {
    return listPage(s, pageIndex)
  },

  /** Every annotation on every page (for the comments panel). */
  listAll(s): AnnotInfo[] {
    const out: AnnotInfo[] = []
    const n = s.pageCount()
    for (let i = 0; i < n; i++) out.push(...listPage(s, i))
    return out
  },

  get(s, id: number, hintPage?: number): AnnotInfo {
    const { annot, pageIndex, page } = s.requireAnnotation(id, hintPage)
    return annotInfo(s, annot, pageIndex, page.getAnnotations().indexOf(annot))
  },

  /** Topmost comment annotation containing the point, or null. */
  hitTest(s, pageIndex: number, point: Point, tolerance = 3): AnnotInfo | null {
    const list = listPage(s, pageIndex).filter((a) => !a.hidden && a.type !== 'Popup')
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i].rect
      if (
        point[0] >= r[0] - tolerance &&
        point[0] <= r[2] + tolerance &&
        point[1] >= r[1] - tolerance &&
        point[1] <= r[3] + tolerance
      )
        return list[i]
    }
    return null
  },

  create: mutation(
    (_page: number, spec: AnnotSpec) => `Add ${spec.type === 'Text' ? 'Comment' : (spec.type ?? 'Annotation')}`,
    (s, pageIndex: number, spec: AnnotSpec): AnnotInfo => {
      if (!spec.type) throw new EngineError('Annotation type is required', 'BAD_SPEC')
      const page = s.page(pageIndex)
      const annot = page.createAnnotation(spec.type as any)
      if (!spec.author && safe(() => annot.hasAuthor(), false)) {
        const author = s.state.get('author')
        if (typeof author === 'string' && author) annot.setAuthor(author)
      }
      try {
        annot.setCreationDate(new Date())
      } catch {}
      if (spec.flags === undefined && spec.hidden === undefined) {
        try {
          annot.setFlags(FLAG_PRINT | (spec.type === 'Text' || spec.type === 'FileAttachment' ? FLAG_NO_ZOOM | FLAG_NO_ROTATE : 0))
        } catch {}
      }
      applySpec(s, annot, spec)
      annot.update()
      s.touch(pageIndex)
      s.documentChanged()
      const annots = page.getAnnotations()
      return annotInfo(s, annot, pageIndex, annots.indexOf(annot))
    }
  ),

  update: mutation('Edit Annotation', (s, id: number, spec: AnnotSpec, hintPage?: number): AnnotInfo => {
    const { annot, pageIndex, page } = s.requireAnnotation(id, hintPage)
    applySpec(s, annot, spec)
    annot.update()
    s.touch(pageIndex)
    s.documentChanged()
    return annotInfo(s, annot, pageIndex, page.getAnnotations().indexOf(annot))
  }),

  /** Moves/resizes annotations to new rectangles (geometry is scaled accordingly). */
  transform: mutation('Move Annotation', (s, moves: { id: number; rect: Rect }[], hintPage?: number) => {
    for (const m of moves) {
      const { annot, pageIndex } = s.requireAnnotation(m.id, hintPage)
      transformAnnotation(annot, m.rect)
      try {
        annot.setModificationDate(new Date())
      } catch {}
      annot.update()
      s.touch(pageIndex)
    }
    s.documentChanged()
  }),

  /** Moves annotations by an offset in page space. */
  move: mutation('Move Annotation', (s, ids: number[], dx: number, dy: number, hintPage?: number) => {
    for (const id of ids) {
      const { annot, pageIndex } = s.requireAnnotation(id, hintPage)
      const r = annotRect(annot)
      transformAnnotation(annot, [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy])
      annot.update()
      s.touch(pageIndex)
    }
    s.documentChanged()
  }),

  /** Deletes annotations and their replies. */
  delete: mutation(
    (ids: number[]) => (ids.length > 1 ? 'Delete Annotations' : 'Delete Annotation'),
    (s, ids: number[], hintPage?: number) => {
      const targets = new Set(ids)
      // include replies (and replies of replies)
      let grew = true
      while (grew) {
        grew = false
        const n = s.pageCount()
        for (let p = 0; p < n; p++) {
          for (const a of listPage(s, p, true)) {
            if (a.inReplyTo !== null && targets.has(a.inReplyTo) && !targets.has(a.id)) {
              targets.add(a.id)
              grew = true
            }
          }
        }
      }
      for (const id of targets) {
        const found = s.findAnnotation(id, hintPage)
        if (!found) continue
        found.page.deleteAnnotation(found.annot)
        s.touch(found.pageIndex)
      }
      s.documentChanged()
    }
  ),

  /** Adds a reply to a comment thread. */
  reply: mutation('Reply to Comment', (s, parentId: number, text: string, author?: string): AnnotInfo => {
    const { pageIndex, page, annot: parent } = s.requireAnnotation(parentId)
    const r = annotRect(parent)
    const reply = page.createAnnotation('Text')
    reply.setRect([r[0], r[1], r[0] + 20, r[1] + 20])
    reply.setContents(text)
    const a = author ?? (s.state.get('author') as string | undefined)
    if (a) reply.setAuthor(a)
    try {
      reply.setCreationDate(new Date())
      reply.setModificationDate(new Date())
    } catch {}
    reply.setFlags(FLAG_HIDDEN | FLAG_PRINT | FLAG_NO_ZOOM | FLAG_NO_ROTATE)
    reply.getObject().put('IRT', parent.getObject())
    reply.getObject().put('RT', s.pdf.newName('R'))
    reply.update()
    s.touch(pageIndex)
    s.documentChanged()
    return annotInfo(s, reply, pageIndex, page.getAnnotations().indexOf(reply))
  }),

  /** Sets a review state ("Accepted", "Rejected", "Cancelled", "Completed", "None") on a comment. */
  setState: mutation('Set Comment Status', (s, parentId: number, state: string, author?: string): AnnotInfo => {
    const { pageIndex, page, annot: parent } = s.requireAnnotation(parentId)
    const r = annotRect(parent)
    const model = state === 'Marked' || state === 'Unmarked' ? 'Marked' : 'Review'
    const st = page.createAnnotation('Text')
    st.setRect([r[0], r[1], r[0] + 20, r[1] + 20])
    const a = author ?? (s.state.get('author') as string | undefined)
    if (a) st.setAuthor(a)
    st.setContents(`${a || 'Someone'} set status to ${state}`)
    st.setFlags(FLAG_HIDDEN | FLAG_PRINT)
    const obj = st.getObject()
    obj.put('IRT', parent.getObject())
    obj.put('State', s.pdf.newString(state))
    obj.put('StateModel', s.pdf.newString(model))
    st.update()
    s.touch(pageIndex)
    s.documentChanged()
    return annotInfo(s, st, pageIndex, page.getAnnotations().indexOf(st))
  }),

  /** Default author for new annotations (from Preferences). */
  setAuthor(s, author: string) {
    s.state.set('author', author)
  },

  /** Contents of a FileAttachment annotation's embedded file. */
  attachment(s, id: number): { name: string; data: Uint8Array } | null {
    const { annot } = s.requireAnnotation(id)
    const fs = annot.getFileSpec()
    if (!fs || isNull(fs)) return null
    const params = s.pdf.getFilespecParams(fs)
    const buf = s.pdf.getEmbeddedFileContents(fs)
    if (!buf) return null
    return { name: params.filename, data: buf.asUint8Array().slice() }
  },

  /** Burns annotations (and optionally form fields) into the page content. */
  flatten: mutation('Flatten', (s, opts: { annots?: boolean; widgets?: boolean } = {}) => {
    s.pdf.bake(opts.annots !== false, !!opts.widgets)
    s.structureChanged()
    s.documentChanged()
  }),

  /** Type name of the low-level annotation dictionary (debugging/tests). */
  rawType(s, id: number): string | null {
    const { annot } = s.requireAnnotation(id)
    return readName(annot.getObject().get('Subtype'))
  }
})
