/**
 * Engine helpers for the comment creation tools. Every annotation is created through the core
 * `annots.create` op (so the author, dates and flags are set the same way everywhere); these ops
 * only add what the core spec cannot express and give each change a plain-language undo label.
 */
import type { Point, Quad, Rect } from '@shared/geometry'
import { transformRect } from '@shared/geometry'
import { defineOps, EngineError, mutation } from '@engine/define'
import annotOps, { annotInfo, applySpec, type AnnotInfo, type AnnotSpec, type LineEnding } from '@engine/ops/annots'
import type { PDFAnnotation, PDFObject, Session } from '@engine/session'
import { pdfDate } from '@engine/util/pdf'

const coreCreate = annotOps.ops.create
const coreDelete = annotOps.ops.delete

export interface CreateItem {
  page: number
  spec: AnnotSpec
  /** Line ending drawn at the arrow tip of a callout (FreeText with intent FreeTextCallout). */
  calloutStyle?: LineEnding
  /**
   * Give a Highlight a crisp rectangular appearance (Highlight area on scanned pages) instead of the
   * rounded text-highlight shape.
   */
  rectAppearance?: boolean
  /** File to embed in a FileAttachment annotation (use this rather than spec.file, see embedFile). */
  attachment?: { name: string; data: Uint8Array; mime: string }
}

function info(s: Session, annot: PDFAnnotation, page: number): AnnotInfo {
  return annotInfo(s, annot, page, s.page(page).getAnnotations().indexOf(annot))
}

function num(v: number): string {
  return Number.isFinite(v) ? (Math.round(v * 1000) / 1000).toString() : '0'
}

/** Replaces a highlight's appearance with a plain rectangle per quad, blended with Multiply. */
function setRectHighlightAppearance(s: Session, page: number, annot: PDFAnnotation) {
  const quads = annot.getQuadPoints() as Quad[]
  if (!quads.length) return
  const toUser = s.pageToUser(page)
  const rects = quads.map((q) => {
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    return transformRect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], toUser)
  })
  const bbox: Rect = [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3]))
  ]
  const color = (annot.getColor() as number[]) ?? [1, 1, 0]
  const rgb = color.length === 3 ? color : color.length === 1 ? [color[0], color[0], color[0]] : [1, 1, 0]
  const opacity = annot.getOpacity()
  const pdf = s.pdf
  const gs = pdf.newDictionary()
  gs.put('Type', pdf.newName('ExtGState'))
  gs.put('BM', pdf.newName('Multiply'))
  gs.put('ca', pdf.newReal(opacity))
  gs.put('CA', pdf.newReal(opacity))
  const gsDict = pdf.newDictionary()
  gsDict.put('H', gs)
  const res = pdf.newDictionary()
  res.put('ExtGState', gsDict)
  const ops = [`/H gs ${rgb.map(num).join(' ')} rg`]
  for (const r of rects) ops.push(`${num(r[0])} ${num(r[1])} ${num(r[2] - r[0])} ${num(r[3] - r[1])} re f`)
  // Rect must match the appearance BBox, otherwise viewers stretch the appearance to fit.
  const arr = pdf.newArray()
  for (const v of bbox) arr.push(pdf.newReal(v))
  annot.getObject().put('Rect', arr)
  annot.setAppearance(null, null, s.mupdf.Matrix.identity, bbox, res, ops.join('\n'))
}

/**
 * Embeds a file as a /Filespec with an /EmbeddedFile stream. Built by hand because MuPDF's
 * addEmbeddedFile() leaves a journal operation open, which silently breaks undo for the rest of the
 * session.
 */
function embedFile(s: Session, file: { name: string; data: Uint8Array; mime: string }): PDFObject {
  const pdf = s.pdf
  const now = pdfDate(new Date())
  const params = pdf.newDictionary()
  params.put('Size', pdf.newInteger(file.data.length))
  params.put('CreationDate', pdf.newString(now))
  params.put('ModDate', pdf.newString(now))
  const ef = pdf.newDictionary()
  ef.put('Type', pdf.newName('EmbeddedFile'))
  if (file.mime) ef.put('Subtype', pdf.newName(file.mime))
  ef.put('Params', params)
  const stream = pdf.addStream(file.data, ef)
  const efd = pdf.newDictionary()
  efd.put('F', stream)
  efd.put('UF', stream)
  const spec = pdf.newDictionary()
  spec.put('Type', pdf.newName('Filespec'))
  spec.put('F', pdf.newString(file.name))
  spec.put('UF', pdf.newString(file.name))
  spec.put('EF', efd)
  return pdf.addObject(spec)
}

function createOne(s: Session, item: CreateItem): AnnotInfo {
  if (item.spec.file) throw new EngineError('Pass files as an attachment, not spec.file', 'BAD_SPEC')
  const created = coreCreate(s, item.page, item.spec)
  if (!item.calloutStyle && !item.rectAppearance && !item.attachment) return created
  const { annot } = s.requireAnnotation(created.id, item.page)
  if (item.attachment) {
    if (annot.getType() !== 'FileAttachment') throw new EngineError('Only file attachments can carry a file', 'BAD_SPEC')
    annot.setFileSpec(embedFile(s, item.attachment))
    annot.update()
  }
  if (item.calloutStyle) {
    annot.setCalloutStyle(item.calloutStyle)
    annot.update()
  }
  if (item.rectAppearance) setRectHighlightAppearance(s, item.page, annot)
  s.touch(item.page)
  return info(s, annot, item.page)
}

export interface ReplaceTextSpec {
  quads: Quad[]
  /** Where the caret goes (end of the struck-out text). */
  caretRect: Rect
  color: string
  opacity: number
  /** The replacement text, when already known. */
  contents?: string
}

export default defineOps('markup-tools', {
  /**
   * Creates one or more annotations as a single undo step labelled `label` (e.g. a highlight that
   * spans two pages, or a callout with its arrow style).
   */
  create: mutation(
    (_items: CreateItem[], label?: string) => label || 'Add Comment',
    (s, items: CreateItem[], _label?: string): AnnotInfo[] => {
      if (!items.length) throw new EngineError('Nothing to create', 'BAD_SPEC')
      return items.map((it) => createOne(s, it))
    }
  ),

  /**
   * Acrobat's "Replace text": a StrikeOut over the old text grouped with a Caret that holds the new
   * text. The StrikeOut is /IRT the Caret with /RT /Group (how Acrobat links them), and both carry
   * FartcrobatData {fartcrobat: 'replaceText', group: '<caret id>'}.
   */
  replaceText: mutation('Replace Text', (s, page: number, spec: ReplaceTextSpec): { caret: AnnotInfo; strikeOut: AnnotInfo } => {
    if (!spec.quads.length) throw new EngineError('Select the text to replace first', 'BAD_SPEC')
    const caretInfo = coreCreate(s, page, {
      type: 'Caret',
      rect: spec.caretRect,
      color: spec.color,
      opacity: spec.opacity,
      contents: spec.contents ?? '',
      subject: 'Inserted Text',
      extra: { fartcrobat: 'replaceText', role: 'caret' }
    })
    const strikeInfo = coreCreate(s, page, {
      type: 'StrikeOut',
      quads: spec.quads,
      color: spec.color,
      opacity: spec.opacity,
      subject: 'Cross-Out',
      extra: { fartcrobat: 'replaceText', role: 'strikeout', group: String(caretInfo.id) }
    })
    const caret = s.requireAnnotation(caretInfo.id, page).annot
    const strike = s.requireAnnotation(strikeInfo.id, page).annot
    const pdf = s.pdf
    caret.getObject().put('IT', pdf.newName('Replace'))
    applySpec(s, caret, { extra: { group: String(caretInfo.id) } })
    const so = strike.getObject()
    so.put('IRT', caret.getObject())
    so.put('RT', pdf.newName('Group'))
    so.put('IT', pdf.newName('StrikeOutTextEdit'))
    caret.update()
    strike.update()
    s.touch(page)
    s.documentChanged()
    return { caret: info(s, caret, page), strikeOut: info(s, strike, page) }
  }),

  /** Adds strokes to an existing Ink annotation (free-form drawing continues in one annotation). */
  appendInk: mutation('Add Drawing', (s, page: number, id: number, strokes: Point[][]): AnnotInfo => {
    const { annot, pageIndex } = s.requireAnnotation(id, page)
    if (annot.getType() !== 'Ink') throw new EngineError('Not a drawing', 'BAD_TYPE')
    const ink = (annot.getInkList() as Point[][]).concat(strokes.filter((st) => st.length > 0))
    applySpec(s, annot, { ink })
    annot.update()
    s.touch(pageIndex)
    s.documentChanged()
    return info(s, annot, pageIndex)
  }),

  /**
   * Applies an eraser pass: each changed Ink annotation gets its new stroke list; annotations left
   * with no strokes are deleted. One undo step.
   */
  erase: mutation('Erase Drawing', (s, page: number, changes: { id: number; ink: Point[][] }[]) => {
    const empty: number[] = []
    for (const c of changes) {
      const strokes = c.ink.filter((st) => st.length >= 2)
      if (!strokes.length) {
        empty.push(c.id)
        continue
      }
      const { annot, pageIndex } = s.requireAnnotation(c.id, page)
      if (annot.getType() !== 'Ink') throw new EngineError('Only drawings can be erased', 'BAD_TYPE')
      applySpec(s, annot, { ink: strokes })
      annot.update()
      s.touch(pageIndex)
    }
    if (empty.length) coreDelete(s, empty, page)
    s.documentChanged()
    return { deleted: empty }
  })
})
