/** Reading signature fields, certification and lock state from the MuPDF document. */
import type { Matrix, Rect } from '@shared/geometry'
import { invertMatrix, normalizeRect, transformRect } from '@shared/geometry'
import type { PDFDocument, PDFObject, Session } from '@engine/session'
import { catalog, isNull, readName, readNumber, readRect, readString, walkFields } from '@engine/util/pdf'
import type { MdpPermission, SignatureFieldInfo } from '../types'

export interface SigField extends SignatureFieldInfo {
  /** The field dictionary (holds /T, /FT, /V; the widget itself for merged fields). */
  field: PDFObject
  widget: PDFObject
  /** Object number of the field dictionary. */
  fieldNum: number
}

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Fully qualified field name from the /T chain. */
export function fullName(obj: PDFObject): string {
  const parts: string[] = []
  let cur: PDFObject = obj
  for (let d = 0; d < 32 && !isNull(cur); d++) {
    const t = readString(cur.get('T'))
    if (t) parts.unshift(t)
    cur = cur.get('Parent')
  }
  return parts.join('.')
}

/** The dictionary that owns /T, /FT and /V for a widget (itself, or its parent for kids). */
export function fieldOf(widget: PDFObject): PDFObject {
  const w = widget.resolve()
  if (isNull(w.get('T')) && !isNull(w.get('Parent'))) return w.get('Parent')
  return widget
}

/** MuPDF's page transform (user space -> page space) without needing a loaded page. */
export function pageTransform(pdf: PDFDocument, index: number, s?: Session): Matrix {
  if (s && s.doc === pdf) return s.userToPage(index)
  const page = pdf.loadPage(index)
  try {
    return page.getTransform() as Matrix
  } finally {
    page.destroy()
  }
}

export function pageRotation(pdf: PDFDocument, index: number): number {
  const r = Math.round(readNumber(pdf.findPage(index).getInheritable('Rotate'), 0))
  return ((r % 360) + 360) % 360
}

/** Every signature widget in the document, in page order. */
export function listSignatureFields(pdf: PDFDocument, s?: Session): SigField[] {
  const out: SigField[] = []
  const n = pdf.countPages()
  for (let i = 0; i < n; i++) {
    const pageObj = pdf.findPage(i)
    const annots = pageObj.get('Annots')
    if (isNull(annots) || !annots.isArray()) continue
    let transform: Matrix | null = null
    for (let k = 0; k < annots.length; k++) {
      const ref = annots.get(k)
      const a = ref.resolve()
      if (!a.isDictionary() || readName(a.get('Subtype')) !== 'Widget') continue
      if (readName(a.getInheritable('FT')) !== 'Sig') continue
      const field = fieldOf(ref)
      const userRect = readRect(a.get('Rect'), [0, 0, 0, 0])
      transform ??= safe(() => pageTransform(pdf, i, s), [1, 0, 0, 1, 0, 0] as Matrix)
      const rect = normalizeRect(transformRect(userRect, transform))
      const flags = Math.round(readNumber(a.get('F'), 0))
      const invisible = rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1 || (flags & 2) !== 0
      const v = field.resolve().get('V')
      const signed = !isNull(v) && v.resolve().isDictionary()
      out.push({
        name: fullName(field),
        widgetId: ref.isIndirect() ? ref.asIndirect() : -1,
        fieldNum: field.isIndirect() ? field.asIndirect() : ref.isIndirect() ? ref.asIndirect() : -1,
        page: i,
        rect,
        invisible,
        signed,
        signerName: signed ? readString(v.resolve().get('Name')) : '',
        locked: !isNull(field.resolve().get('Lock')),
        field,
        widget: ref
      })
    }
  }
  return out
}

export function findSignatureField(pdf: PDFDocument, name: string, s?: Session): SigField | null {
  return listSignatureFields(pdf, s).find((f) => f.name === name) ?? null
}

/** All field names (for picking a unique "SignatureN"). */
export function allFieldNames(pdf: PDFDocument): Set<string> {
  const names = new Set<string>()
  walkFields(pdf, (_f, name) => names.add(name))
  return names
}

export function uniqueSignatureName(pdf: PDFDocument): string {
  const names = allFieldNames(pdf)
  for (let i = 1; ; i++) if (!names.has(`Signature${i}`)) return `Signature${i}`
}

export interface MdpReference {
  method: 'DocMDP' | 'FieldMDP' | 'UR' | string
  permission: MdpPermission | null
  action: string | null
  fields: string[]
}

/** /Reference entries of a signature dictionary. */
export function readReferences(v: PDFObject): MdpReference[] {
  const refs = v.resolve().get('Reference')
  const out: MdpReference[] = []
  if (isNull(refs) || !refs.isArray()) return out
  for (let i = 0; i < refs.length; i++) {
    const ref = refs.get(i)
    if (isNull(ref)) continue
    const r = ref.resolve()
    if (!r.isDictionary()) continue
    const method = readName(r.get('TransformMethod')) ?? ''
    const rawParams = r.get('TransformParams')
    const params = isNull(rawParams) ? null : rawParams.resolve()
    let permission: MdpPermission | null = null
    const p = params ? readNumber(params.get('P'), 0) : 0
    if (p >= 1 && p <= 3) permission = p as MdpPermission
    else if (method === 'DocMDP') permission = 2
    const fields: string[] = []
    const f = params ? params.get('Fields') : null
    if (f && !isNull(f) && f.isArray()) for (let k = 0; k < f.length; k++) fields.push(readString(f.get(k)))
    out.push({ method, permission, action: params ? readName(params.get('Action')) : null, fields })
  }
  return out
}

/** Certification (DocMDP) of the document: the permission level and the certifying signature. */
export function certification(pdf: PDFDocument): { permission: MdpPermission; sigNum: number } | null {
  const perms = catalog(pdf).get('Perms')
  if (isNull(perms) || !perms.resolve().isDictionary()) return null
  const docMdp = perms.resolve().get('DocMDP')
  if (isNull(docMdp)) return null
  const ref = readReferences(docMdp).find((r) => r.method === 'DocMDP')
  return { permission: ref?.permission ?? 2, sigNum: docMdp.isIndirect() ? docMdp.asIndirect() : -1 }
}

/** Lock dictionary of a signature field (/Lock) merged with its FieldMDP reference. */
export function lockInfo(f: SigField): { action: string; fields: string[]; permission: MdpPermission | null } | null {
  const field = f.field.resolve()
  const lock = field.get('Lock')
  const v = field.get('V')
  const fieldMdp = !isNull(v) ? readReferences(v).find((r) => r.method === 'FieldMDP') : undefined
  if (isNull(lock) && !fieldMdp) return null
  let permission: MdpPermission | null = fieldMdp?.permission ?? null
  const fields: string[] = [...(fieldMdp?.fields ?? [])]
  let lockAction: string | null = null
  if (!isNull(lock)) {
    const l = lock.resolve()
    const lp = readNumber(l.get('P'), 0)
    if (lp >= 1 && lp <= 3) permission = lp as MdpPermission
    const lf = l.get('Fields')
    if (!isNull(lf) && lf.isArray()) for (let k = 0; k < lf.length; k++) fields.push(readString(lf.get(k)))
    lockAction = readName(l.get('Action'))
  }
  return { action: fieldMdp?.action ?? lockAction ?? 'All', fields: [...new Set(fields)], permission }
}

/** Page-space rect -> PDF user-space rect for a page. */
export function toUserRect(pdf: PDFDocument, page: number, rect: Rect, s?: Session): Rect {
  return normalizeRect(transformRect(rect, invertMatrix(pageTransform(pdf, page, s))))
}
