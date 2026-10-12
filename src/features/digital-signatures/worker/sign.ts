/**
 * Signing: adds the signature field, appearance and signature dictionary as an incremental update,
 * then fills in the byte range and the CMS signature.
 *
 * The live document is changed inside a MuPDF operation that is abandoned right after the
 * incremental save, so the open document (and its undo history) is left untouched; the caller
 * writes the signed bytes to disk and reloads the tab from them.
 */
import { EngineError } from '@engine/define'
import { saveDocument } from '@engine/ops/doc'
import type { Mupdf, PDFDocument, PDFObject, Session } from '@engine/session'
import { catalog, countSignatures, isNull, pdfDate, readRect } from '@engine/util/pdf'
import { normalizeRect, transformRect } from '@shared/geometry'
import { buildSignedData } from '../lib/cms'
import { digest, importPrivateKey } from '../lib/crypto'
import { locatePlaceholder, patchByteRange, writeContents } from '../lib/pdfbytes'
import type { SignCapability, SignRequest, SignResult } from '../types'
import { addAppearanceXObject } from './appearance'
import {
  certification,
  findSignatureField,
  listSignatureFields,
  lockInfo,
  pageRotation,
  pageTransform,
  safe,
  toUserRect,
  uniqueSignatureName
} from './fields'

/** Room reserved for the CMS signature: at least 16 KB, more for long certificate chains. */
export function contentsSize(chain: Uint8Array[]): number {
  const certs = chain.reduce((n, c) => n + c.length, 0)
  const want = 6144 + 2 * certs
  return Math.max(16384, Math.ceil(want / 1024) * 1024)
}

export function signCapability(s: Session): SignCapability {
  const pdf = s.pdf
  const fields = listSignatureFields(pdf, s)
  const cert = certification(pdf)
  const signed = fields.filter((f) => f.signed)
  const lockedBy = signed.find((f) => {
    const l = lockInfo(f)
    return !!l && (l.permission === 1 || (l.action === 'All' && !l.fields.length && l.permission !== null))
  })
  const canForm = safe(() => pdf.hasPermission('form') || pdf.hasPermission('annotate'), true)
  let reason: string | null = null
  if (!canForm) reason = "The document's security settings do not allow signing."
  else if (cert?.permission === 1) reason = 'This document is certified and the certifier does not allow any changes, including signing.'
  else if (lockedBy) reason = `This document was locked when “${lockedBy.name}” was signed, so it cannot be signed again.`
  else if (signed.length && !safe(() => pdf.canBeSavedIncrementally(), false))
    reason = 'This file was damaged and had to be repaired when it was opened. Signing it would invalidate its existing signatures.'
  let certifyReason: string | null = reason
  if (!certifyReason && (signed.length || cert)) certifyReason = 'Only a document without signatures can be certified.'
  return {
    canSign: !reason,
    canCertify: !certifyReason,
    reason,
    certifyReason,
    certified: cert?.permission ?? null,
    locked: !!lockedBy || cert?.permission === 1,
    newFieldBreaksCertification: !!cert && cert.permission < 3,
    fields: fields.map(({ field: _f, widget: _w, fieldNum: _n, ...rest }) => rest)
  }
}

interface Prepared {
  vNum: number
  fieldName: string
}

function nameArray(pdf: PDFDocument, values: (number | string)[]): PDFObject {
  const arr = pdf.newArray()
  for (const v of values) arr.push(typeof v === 'number' ? pdf.newInteger(v) : pdf.newName(v))
  return arr
}

function transformParams(pdf: PDFDocument, entries: Record<string, PDFObject>): PDFObject {
  const d = pdf.newDictionary()
  d.put('Type', pdf.newName('TransformParams'))
  for (const [k, v] of Object.entries(entries)) d.put(k, v)
  d.put('V', pdf.newName('1.2'))
  return d
}

function sigRef(pdf: PDFDocument, method: string, params: PDFObject): PDFObject {
  const d = pdf.newDictionary()
  d.put('Type', pdf.newName('SigRef'))
  d.put('TransformMethod', pdf.newName(method))
  d.put('TransformParams', params)
  return d
}

/** Adds the field/widget, appearance and the signature dictionary with placeholders to `pdf`. */
export function prepareSignature(m: Mupdf, pdf: PDFDocument, req: SignRequest, time: number, size: number, s?: Session): Prepared {
  const root = catalog(pdf)
  let acro = root.get('AcroForm')
  if (isNull(acro)) {
    acro = pdf.addObject(pdf.newDictionary())
    root.put('AcroForm', acro)
  }
  let fields = acro.get('Fields')
  if (isNull(fields) || !fields.isArray()) {
    fields = pdf.newArray()
    acro.put('Fields', fields)
  }

  let field: PDFObject
  let widget: PDFObject
  let fieldName: string
  let page: number
  let visual: { w: number; h: number }
  const target = req.target
  if (target.kind === 'field') {
    const f = findSignatureField(pdf, target.name, s)
    if (!f) throw new EngineError(`The signature field “${target.name}” was not found`, 'NO_FIELD')
    if (f.signed) throw new EngineError(`The signature field “${target.name}” is already signed`, 'ALREADY_SIGNED')
    field = f.field.resolve()
    widget = f.widget.resolve()
    fieldName = f.name
    page = f.page
    visual = { w: f.rect[2] - f.rect[0], h: f.rect[3] - f.rect[1] }
    if (f.invisible) visual = { w: 0, h: 0 }
  } else {
    fieldName = uniqueSignatureName(pdf)
    page = target.kind === 'new' ? target.page : 0
    if (page < 0 || page >= pdf.countPages()) throw new EngineError(`Page ${page + 1} does not exist`, 'BAD_PAGE')
    const pageObj = pdf.findPage(page)
    let userRect: [number, number, number, number] = [0, 0, 0, 0]
    visual = { w: 0, h: 0 }
    if (target.kind === 'new') {
      const r = normalizeRect(target.rect)
      visual = { w: r[2] - r[0], h: r[3] - r[1] }
      if (visual.w < 4 || visual.h < 4) throw new EngineError('The signature box is too small', 'BAD_RECT')
      userRect = toUserRect(pdf, page, r, s)
    }
    const d = pdf.newDictionary()
    d.put('Type', pdf.newName('Annot'))
    d.put('Subtype', pdf.newName('Widget'))
    d.put('FT', pdf.newName('Sig'))
    d.put('T', pdf.newString(fieldName))
    const rect = pdf.newArray()
    for (const v of userRect) rect.push(pdf.newReal(Math.round(v * 1000) / 1000))
    d.put('Rect', rect)
    d.put('F', pdf.newInteger(132)) // Print + Locked, like Acrobat
    d.put('P', pageObj)
    widget = pdf.addObject(d)
    field = widget
    let annots = pageObj.get('Annots')
    if (isNull(annots) || !annots.isArray()) {
      annots = pdf.newArray()
      pageObj.put('Annots', annots)
    }
    annots.push(widget)
    fields.push(widget)
  }
  acro.put('SigFlags', pdf.newInteger(3))

  // Appearance
  const rotate = pageRotation(pdf, page)
  const ap = addAppearanceXObject(m, pdf, visual.w > 0 && visual.h > 0 ? req.appearance : null, visual.w, visual.h, rotate)
  const apDict = pdf.newDictionary()
  apDict.put('N', ap)
  widget.put('AP', apDict)
  if (isNull(widget.get('F'))) widget.put('F', pdf.newInteger(132))

  // Signature dictionary
  const v = pdf.newDictionary()
  v.put('Type', pdf.newName('Sig'))
  v.put('Filter', pdf.newName('Adobe.PPKLite'))
  v.put('SubFilter', pdf.newName(req.subFilter ?? 'ETSI.CAdES.detached'))
  v.put('ByteRange', nameArray(pdf, [0, '**********', '**********', '**********']))
  v.put('Contents', pdf.newByteString(new Uint8Array(size)))
  if (req.appearance.name) v.put('Name', pdf.newString(req.appearance.name))
  v.put('M', pdf.newString(pdfDate(new Date(time))))
  if (req.reason?.trim()) v.put('Reason', pdf.newString(req.reason.trim()))
  if (req.location?.trim()) v.put('Location', pdf.newString(req.location.trim()))
  if (req.contactInfo?.trim()) v.put('ContactInfo', pdf.newString(req.contactInfo.trim()))
  const build = pdf.newDictionary()
  const app = pdf.newDictionary()
  app.put('Name', pdf.newName('Fartcrobat'))
  build.put('App', app)
  const filter = pdf.newDictionary()
  filter.put('Name', pdf.newName('Adobe.PPKLite'))
  build.put('Filter', filter)
  v.put('Prop_Build', build)

  const references: PDFObject[] = []
  if (req.mode === 'certify') {
    const p = req.permission ?? 2
    references.push(sigRef(pdf, 'DocMDP', transformParams(pdf, { P: pdf.newInteger(p) })))
  }
  if (req.lock) {
    const lock = pdf.newDictionary()
    lock.put('Type', pdf.newName('SigFieldLock'))
    lock.put('Action', pdf.newName('All'))
    lock.put('P', pdf.newInteger(1))
    field.put('Lock', lock)
    references.push(sigRef(pdf, 'FieldMDP', transformParams(pdf, { Action: pdf.newName('All'), P: pdf.newInteger(1) })))
  }
  if (references.length) {
    const arr = pdf.newArray()
    for (const r of references) arr.push(r)
    v.put('Reference', arr)
  }
  const vRef = pdf.addObject(v)
  field.put('V', vRef)
  if (req.mode === 'certify') {
    let perms = root.get('Perms')
    if (isNull(perms)) {
      perms = pdf.newDictionary()
      root.put('Perms', perms)
    }
    perms.put('DocMDP', vRef)
  }
  return { vNum: vRef.asIndirect(), fieldName }
}

/** Checks the request against what the document allows. Throws a readable EngineError. */
function checkRequest(s: Session, req: SignRequest) {
  const cap = signCapability(s)
  if (!cap.canSign) throw new EngineError(cap.reason!, 'CANNOT_SIGN')
  if (req.mode === 'certify' && !cap.canCertify) throw new EngineError(cap.certifyReason!, 'CANNOT_CERTIFY')
  if (!req.chain.length) throw new EngineError('The Digital ID has no certificate', 'NO_CERT')
}

/** Produces the signed file. */
export async function signDocument(s: Session, req: SignRequest): Promise<SignResult> {
  checkRequest(s, req)
  const m = s.mupdf
  const time = req.time ?? Date.now()
  const size = contentsSize(req.chain)
  // Import the key first: a bad key should fail before any work on the document.
  const key = await importPrivateKey(req.key.pkcs8, req.key.alg)
  const live = s.pdf
  let bytes: Uint8Array | null = null
  let prepared: Prepared | null = null
  let began = false
  if (safe(() => live.canBeSavedIncrementally(), false)) {
    try {
      live.beginOperation('Sign Document')
      began = true
    } catch {
      began = false
    }
  }
  if (began) {
    try {
      prepared = prepareSignature(m, live, req, time, size, s)
      const buf = live.saveToBuffer('incremental')
      bytes = buf.asUint8Array().slice()
      buf.destroy()
    } finally {
      try {
        live.abandonOperation()
      } catch {}
      s.invalidatePages()
    }
  } else {
    if (safe(() => countSignatures(live), 0) > 0) {
      throw new EngineError('This file cannot be updated without invalidating its existing signatures.', 'CANNOT_SIGN')
    }
    if (!isNull(live.getTrailer().get('Encrypt'))) {
      throw new EngineError(
        'This password-protected file was damaged and repaired when it was opened. Save a copy first (File > Save As), open the copy and sign it.',
        'CANNOT_SIGN'
      )
    }
    const full = saveDocument(s, { mode: 'full' })
    const scratch = new m.PDFDocument(full)
    try {
      prepared = prepareSignature(m, scratch, req, time, size)
      const buf = scratch.saveToBuffer('incremental')
      bytes = buf.asUint8Array().slice()
      buf.destroy()
    } finally {
      scratch.destroy()
    }
  }
  if (!bytes || !prepared) throw new EngineError('The signed file could not be written', 'SIGN_FAILED')
  const ph = locatePlaceholder(bytes, prepared.vNum)
  const br = patchByteRange(bytes, ph)
  const contentDigest = await digest('SHA-256', [bytes.subarray(br[0], br[0] + br[1]), bytes.subarray(br[2], br[2] + br[3])])
  const cms = await buildSignedData({
    contentDigest,
    signer: req.chain[0],
    extraCerts: req.chain.slice(1),
    key,
    keyAlg: req.key.alg,
    signingTime: new Date(time),
    cades: (req.subFilter ?? 'ETSI.CAdES.detached') === 'ETSI.CAdES.detached'
  })
  writeContents(bytes, ph, cms)
  return { bytes, fieldName: prepared.fieldName }
}

/** Removes the signature value from a field (Acrobat's "Clear Signature"). */
export function clearSignatureField(s: Session, name: string) {
  const pdf = s.pdf
  const f = findSignatureField(pdf, name, s)
  if (!f) throw new EngineError(`The signature field “${name}” was not found`, 'NO_FIELD')
  if (!f.signed) throw new EngineError(`“${name}” is not signed`, 'NOT_SIGNED')
  const cap = signCapability(s)
  if (cap.locked) throw new EngineError('The document is locked by a signature; signatures cannot be cleared.', 'LOCKED')
  const field = f.field.resolve()
  const v = field.get('V')
  const vNum = v.isIndirect() ? v.asIndirect() : -1
  field.delete('V')
  const perms = catalog(pdf).get('Perms')
  if (!isNull(perms)) {
    const docMdp = perms.resolve().get('DocMDP')
    if (!isNull(docMdp) && docMdp.isIndirect() && docMdp.asIndirect() === vNum) perms.resolve().delete('DocMDP')
  }
  // A blank appearance of the same size.
  const widget = f.widget.resolve()
  const rect = readRect(widget.get('Rect'), [0, 0, 0, 0])
  const t = pageTransform(pdf, f.page, s)
  const r = normalizeRect(transformRect(rect, t))
  const ap = addAppearanceXObject(s.mupdf, pdf, null, r[2] - r[0], r[3] - r[1], pageRotation(pdf, f.page))
  const apDict = pdf.newDictionary()
  apDict.put('N', ap)
  widget.put('AP', apDict)
  s.invalidatePages()
  s.touch(f.page)
  s.documentChanged()
}
