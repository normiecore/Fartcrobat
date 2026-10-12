// Builds small PDFs for the core regression tests (no binary fixtures needed).
import * as mupdf from 'mupdf'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type { OpenResult } from '@shared/types'
import { fixture, type OpenedEngine } from './helpers'

type Doc = mupdf.PDFDocument
type Obj = mupdf.PDFObject

function rectArray(doc: Doc, r: number[]): Obj {
  const a = doc.newArray()
  for (const v of r) a.push(v)
  return a
}

function annotsOf(doc: Doc, page: Obj): Obj {
  let a = page.get('Annots')
  if (a.isNull()) {
    page.put('Annots', doc.newArray())
    a = page.get('Annots')
  }
  return a
}

function helvResources(doc: Doc): Obj {
  const helv = doc.addObject(doc.newDictionary())
  helv.put('Type', doc.newName('Font'))
  helv.put('Subtype', doc.newName('Type1'))
  helv.put('BaseFont', doc.newName('Helvetica'))
  helv.put('Encoding', doc.newName('WinAnsiEncoding'))
  const fonts = doc.newDictionary()
  fonts.put('Helv', helv)
  const res = doc.newDictionary()
  res.put('Font', fonts)
  return res
}

function save(doc: Doc): Uint8Array {
  const buf = doc.saveToBuffer('')
  const out = buf.asUint8Array().slice()
  buf.destroy()
  doc.destroy()
  return out
}

export interface SignedFormOptions {
  /** Lock fields with the signature's /Lock dictionary ("All" or the listed field names). */
  lock?: 'All' | string[]
}

/**
 * Two pages. Fields:
 * - "Name": text field with one widget on each page,
 * - "Choice": checkbox field with two widgets whose on-states are "Yes" and "No",
 * - "Signature1": a signed signature field (merged field/widget) on page 1.
 */
export function signedFormPdf(opts: SignedFormOptions = {}): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const res = helvResources(doc)
  for (let i = 0; i < 2; i++) {
    doc.insertPage(
      -1,
      doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), `BT /F1 12 Tf 72 720 Td (Page ${i + 1}) Tj ET`)
    )
  }
  const p0 = doc.findPage(0)
  const p1 = doc.findPage(1)
  const fields = doc.newArray()

  const name = doc.addObject(doc.newDictionary())
  name.put('FT', doc.newName('Tx'))
  name.put('T', doc.newString('Name'))
  name.put('V', doc.newString('Old'))
  name.put('DA', doc.newString('/Helv 12 Tf 0 g'))
  name.put('Kids', doc.newArray())
  for (const page of [p0, p1]) {
    const w = doc.addObject(doc.newDictionary())
    w.put('Type', doc.newName('Annot'))
    w.put('Subtype', doc.newName('Widget'))
    w.put('Rect', rectArray(doc, [100, 700, 300, 720]))
    w.put('P', page)
    w.put('Parent', name)
    w.put('F', 4)
    name.get('Kids').push(w)
    annotsOf(doc, page).push(w)
  }
  fields.push(name)

  const choice = doc.addObject(doc.newDictionary())
  choice.put('FT', doc.newName('Btn'))
  choice.put('T', doc.newString('Choice'))
  choice.put('V', doc.newName('Off'))
  choice.put('Kids', doc.newArray())
  for (const [state, x] of [
    ['Yes', 100],
    ['No', 200]
  ] as const) {
    const w = doc.addObject(doc.newDictionary())
    w.put('Type', doc.newName('Annot'))
    w.put('Subtype', doc.newName('Widget'))
    w.put('Rect', rectArray(doc, [x, 600, x + 15, 615]))
    w.put('P', p0)
    w.put('Parent', choice)
    w.put('F', 4)
    w.put('AS', doc.newName('Off'))
    const form = () => {
      const d = doc.newDictionary()
      d.put('BBox', rectArray(doc, [0, 0, 15, 15]))
      d.put('Subtype', doc.newName('Form'))
      return d
    }
    const n = doc.newDictionary()
    n.put(state, doc.addStream('0 0 1 rg 0 0 15 15 re f', form()))
    n.put('Off', doc.addStream('', form()))
    const ap = doc.newDictionary()
    ap.put('N', n)
    w.put('AP', ap)
    choice.get('Kids').push(w)
    annotsOf(doc, p0).push(w)
  }
  fields.push(choice)

  const sigValue = doc.addObject(doc.newDictionary())
  sigValue.put('Type', doc.newName('Sig'))
  sigValue.put('Filter', doc.newName('Adobe.PPKLite'))
  sigValue.put('SubFilter', doc.newName('adbe.pkcs7.detached'))
  sigValue.put('Contents', doc.newByteString(new Uint8Array([0, 0, 0, 0])))
  const sig = doc.addObject(doc.newDictionary())
  sig.put('FT', doc.newName('Sig'))
  sig.put('T', doc.newString('Signature1'))
  sig.put('V', sigValue)
  sig.put('Type', doc.newName('Annot'))
  sig.put('Subtype', doc.newName('Widget'))
  sig.put('Rect', rectArray(doc, [100, 400, 300, 450]))
  sig.put('P', p1)
  sig.put('F', 4)
  if (opts.lock) {
    const lock = doc.newDictionary()
    lock.put('Type', doc.newName('SigFieldLock'))
    if (opts.lock === 'All') lock.put('Action', doc.newName('All'))
    else {
      lock.put('Action', doc.newName('Include'))
      const names = doc.newArray()
      for (const n of opts.lock) names.push(doc.newString(n))
      lock.put('Fields', names)
    }
    sig.put('Lock', lock)
  }
  annotsOf(doc, p1).push(sig)
  fields.push(sig)

  const acro = doc.newDictionary()
  acro.put('Fields', fields)
  acro.put('DA', doc.newString('/Helv 0 Tf 0 g'))
  acro.put('DR', res)
  acro.put('SigFlags', 3)
  doc.getTrailer().get('Root').put('AcroForm', acro)
  return save(doc)
}

/**
 * text.pdf (5 pages, outline, links) plus catalog entries that must survive page operations:
 * page labels, /Lang, an embedded file, /ViewerPreferences, /OpenAction, /Metadata and a
 * structure tree root.
 */
export function richCatalogPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument(fixture('text.pdf'))
  doc.setPageLabels(0, 'r', '', 1)
  doc.setPageLabels(2, 'D', 'A-', 1)
  const root = doc.getTrailer().get('Root')
  root.put('Lang', doc.newString('en-GB'))
  const fs = doc.addEmbeddedFile('notes.txt', 'text/plain', 'hello', new Date(0), new Date(0))
  doc.insertEmbeddedFile('notes.txt', fs)
  const prefs = doc.newDictionary()
  prefs.put('DisplayDocTitle', true)
  root.put('ViewerPreferences', prefs)
  const open = doc.newArray()
  open.push(doc.findPage(1))
  open.push(doc.newName('Fit'))
  root.put('OpenAction', open)
  const metaDict = doc.newDictionary()
  metaDict.put('Type', doc.newName('Metadata'))
  metaDict.put('Subtype', doc.newName('XML'))
  root.put('Metadata', doc.addStream('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>', metaDict))
  const st = doc.newDictionary()
  st.put('Type', doc.newName('StructTreeRoot'))
  root.put('StructTreeRoot', doc.addObject(st))
  return save(doc)
}

/**
 * Three pages whose page tree has an intermediate /Pages node that carries inherited
 * /MediaBox, /Rotate and /Resources for pages 2 and 3.
 */
export function nestedTreePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const res = helvResources(doc)
  const content = (label: string) => {
    const d = doc.newDictionary()
    return doc.addStream(`BT /Helv 24 Tf 50 150 Td (${label}) Tj ET`, d)
  }
  const pagesRoot = doc.getTrailer().get('Root').get('Pages')
  const mk = (label: string, parent: Obj, own: boolean) => {
    const p = doc.newDictionary()
    p.put('Type', doc.newName('Page'))
    p.put('Parent', parent)
    p.put('Contents', content(label))
    if (own) {
      p.put('MediaBox', rectArray(doc, [0, 0, 612, 792]))
      p.put('Resources', res)
    }
    return doc.addObject(p)
  }
  const first = mk('First', pagesRoot, true)
  const mid = doc.addObject(doc.newDictionary())
  mid.put('Type', doc.newName('Pages'))
  mid.put('Parent', pagesRoot)
  mid.put('MediaBox', rectArray(doc, [0, 0, 400, 300]))
  mid.put('Rotate', 90)
  mid.put('Resources', res)
  const second = mk('Second', mid, false)
  const third = mk('Third', mid, false)
  const midKids = doc.newArray()
  midKids.push(second)
  midKids.push(third)
  mid.put('Kids', midKids)
  mid.put('Count', 2)
  const kids = doc.newArray()
  kids.push(first)
  kids.push(mid)
  pagesRoot.put('Kids', kids)
  pagesRoot.put('Count', 3)
  return save(doc)
}

/** Opens bytes in a fresh in-process engine. */
export async function openBytes(
  bytes: Uint8Array,
  fileName = 'doc.pdf',
  password?: string
): Promise<OpenedEngine> {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const res: OpenResult = await doc.open(bytes, { fileName, password })
  if (!res.ok) throw new Error(`could not open ${fileName}: needs password`)
  return Object.assign(engine, { info: res.info, doc })
}

/** Offsets of every `startxref` in a file and every /Prev in its trailers. */
export function xrefChain(bytes: Uint8Array): { startxrefs: number[]; prevs: number[] } {
  const text = new TextDecoder('latin1').decode(bytes)
  return {
    startxrefs: [...text.matchAll(/startxref\s+(\d+)/g)].map((m) => +m[1]),
    prevs: [...text.matchAll(/\/Prev\s+(\d+)/g)].map((m) => +m[1])
  }
}

/** Reopens bytes with plain MuPDF (no engine) for structural checks. */
export function reopen(bytes: Uint8Array, password?: string): Doc {
  const d = new mupdf.PDFDocument(bytes)
  if (password && d.needsPassword()) d.authenticatePassword(password)
  return d
}
