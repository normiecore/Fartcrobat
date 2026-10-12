/**
 * "Remove hidden information" (Acrobat: Redact > Remove hidden information / Sanitize document):
 * finds and removes metadata, attachments, bookmarks, comments, form fields, hidden text, hidden
 * layers, search indexes, scripts, external links and text hidden under other objects.
 */
import type { Quad } from '@shared/geometry'
import type { PDFObject, Session } from '@engine/session'
import { isNull, parsePdfDate, readName, readString, walkFields } from '@engine/util/pdf'
import type { HiddenItem, HiddenItemId, HiddenScan, SanitizeOptions, SanitizeReport } from '../shared'
import { binaryToBytes, bytesToBinary, decodeName, filterHiddenLayers } from './contentFilter'
import { collectPageGlyphs, coveredGlyphs, glyphKey, removeGlyphs, type PageGlyphs } from './glyphs'

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

const catalog = (s: Session) => s.pdf.getTrailer().get('Root')

function dict(obj: PDFObject | null | undefined): PDFObject | null {
  if (!obj || isNull(obj)) return null
  const o = obj.resolve()
  return o.isDictionary() ? o : null
}

function keys(obj: PDFObject | null): string[] {
  const out: string[] = []
  if (!obj) return out
  obj.forEach((_v, k) => out.push(String(k)))
  return out
}

function items(obj: PDFObject | null | undefined): PDFObject[] {
  const out: PDFObject[] = []
  if (!obj || isNull(obj)) return out
  const a = obj.resolve()
  if (!a.isArray()) return out
  for (let i = 0; i < a.length; i++) out.push(a.get(i))
  return out
}

function num(obj: PDFObject): number {
  return obj.isIndirect() ? obj.asIndirect() : 0
}

/** Calls fn for each annotation dictionary of each page. */
function forEachAnnot(s: Session, fn: (annot: PDFObject, pageIndex: number) => void) {
  const n = s.pageCount()
  for (let p = 0; p < n; p++) {
    for (const a of items(s.pdf.findPage(p).get('Annots'))) {
      const d = dict(a)
      if (d) fn(d, p)
    }
  }
}

/** Removes annotation references from pages' /Annots arrays when keep() returns false. */
function filterAnnots(s: Session, keep: (annot: PDFObject, ref: PDFObject, pageIndex: number) => boolean): number {
  let removed = 0
  const n = s.pageCount()
  for (let p = 0; p < n; p++) {
    const pageObj = s.pdf.findPage(p)
    const list = items(pageObj.get('Annots'))
    if (!list.length) continue
    const kept = s.pdf.newArray()
    let changed = false
    for (const ref of list) {
      const d = dict(ref)
      if (d && !keep(d, ref, p)) {
        removed++
        changed = true
        continue
      }
      kept.push(ref)
    }
    if (changed) {
      if (kept.length) pageObj.put('Annots', kept)
      else pageObj.delete('Annots')
    }
  }
  if (removed) s.invalidatePages()
  return removed
}

// ---- actions ------------------------------------------------------------------------------------

const EXTERNAL_ACTIONS = new Set(['URI', 'Launch', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData'])

function actionType(a: PDFObject | null): string | null {
  return a ? readName(a.get('S')) : null
}

type IsBad = (type: string | null) => boolean

/**
 * Removes actions of the given kinds from an action chain (/Next). Returns the number removed and
 * whether the head action itself must go.
 */
function pruneChain(s: Session, action: PDFObject, isBad: IsBad, depth = 0): { removed: number; dropHead: boolean } {
  const a = dict(action)
  if (!a || depth > 32) return { removed: 0, dropHead: false }
  let removed = 0
  const next = a.get('Next')
  if (!isNull(next)) {
    if (next.resolve().isArray()) {
      const kept = s.pdf.newArray()
      let changed = false
      for (const it of items(next)) {
        const r = pruneChain(s, it, isBad, depth + 1)
        removed += r.removed
        if (r.dropHead) changed = true
        else kept.push(it)
      }
      if (changed) {
        if (kept.length) a.put('Next', kept)
        else a.delete('Next')
      }
    } else {
      const r = pruneChain(s, next, isBad, depth + 1)
      removed += r.removed
      if (r.dropHead) a.delete('Next')
    }
  }
  if (isBad(actionType(a))) return { removed: removed + 1, dropHead: true }
  return { removed, dropHead: false }
}

function countChain(action: PDFObject, isBad: IsBad, depth = 0): number {
  const a = dict(action)
  if (!a || depth > 32) return 0
  let n = isBad(actionType(a)) ? 1 : 0
  const next = a.get('Next')
  if (!isNull(next)) {
    if (next.resolve().isArray()) for (const it of items(next)) n += countChain(it, isBad, depth + 1)
    else n += countChain(next, isBad, depth + 1)
  }
  return n
}

/** Counts (dry run) or removes bad actions under key `key` of dictionary d. */
function pruneKey(s: Session, d: PDFObject, key: string, isBad: IsBad, dry: boolean): number {
  const v = d.get(key)
  if (isNull(v)) return 0
  if (dry) return countChain(v, isBad)
  const r = pruneChain(s, v, isBad)
  if (r.dropHead) d.delete(key)
  return r.removed
}

/** Prunes every entry of an additional-actions (/AA) dictionary. */
function pruneAA(s: Session, owner: PDFObject, isBad: IsBad, dry: boolean): number {
  const aa = dict(owner.get('AA'))
  if (!aa) return 0
  let n = 0
  for (const k of keys(aa)) n += pruneKey(s, aa, k, isBad, dry)
  if (!dry && keys(aa).length === 0) owner.delete('AA')
  return n
}

function outlineItems(s: Session): PDFObject[] {
  const out: PDFObject[] = []
  const root = dict(catalog(s).get('Outlines'))
  if (!root) return out
  const seen = new Set<number>()
  const visit = (first: PDFObject, depth: number) => {
    let cur: PDFObject | null = first
    while (cur && !isNull(cur) && depth < 64) {
      const n = num(cur)
      if (n && seen.has(n)) break
      if (n) seen.add(n)
      const d = dict(cur)
      if (!d) break
      out.push(d)
      const child = d.get('First')
      if (!isNull(child)) visit(child, depth + 1)
      cur = d.get('Next')
    }
  }
  const first = root.get('First')
  if (!isNull(first)) visit(first, 0)
  return out
}

/** Field dictionaries of the AcroForm tree, including non-terminal parents. */
function allFieldDicts(s: Session): PDFObject[] {
  const out: PDFObject[] = []
  const acro = dict(catalog(s).get('AcroForm'))
  if (!acro) return out
  const seen = new Set<number>()
  const visit = (f: PDFObject, depth: number) => {
    if (depth > 64) return
    const n = num(f)
    if (n && seen.has(n)) return
    if (n) seen.add(n)
    const d = dict(f)
    if (!d) return
    out.push(d)
    for (const k of items(d.get('Kids'))) visit(k, depth + 1)
  }
  for (const f of items(acro.get('Fields'))) visit(f, 0)
  return out
}

/** JavaScript (isBad = JS) or external (isBad = external) actions everywhere in the document. */
function processActions(s: Session, isBad: IsBad, dry: boolean, skipLinks = false): number {
  let n = 0
  const cat = catalog(s)
  // document-level (an /OpenAction that is a destination array is kept)
  if (dict(cat.get('OpenAction'))) n += pruneKey(s, cat, 'OpenAction', isBad, dry)
  n += pruneAA(s, cat, isBad, dry)
  const pages = s.pageCount()
  for (let p = 0; p < pages; p++) n += pruneAA(s, s.pdf.findPage(p), isBad, dry)
  // annotations (links, widgets, screens...)
  forEachAnnot(s, (a) => {
    if (skipLinks && readName(a.get('Subtype')) === 'Link') return
    n += pruneKey(s, a, 'A', isBad, dry)
    n += pruneAA(s, a, isBad, dry)
  })
  // form field parents
  for (const f of allFieldDicts(s)) {
    if (readName(f.get('Subtype')) === 'Widget') continue
    n += pruneAA(s, f, isBad, dry)
  }
  for (const o of outlineItems(s)) n += pruneKey(s, o, 'A', isBad, dry)
  return n
}

const isJs: IsBad = (t) => t === 'JavaScript'
const isExternal: IsBad = (t) => !!t && EXTERNAL_ACTIONS.has(t)

// ---- individual items ---------------------------------------------------------------------------

function metadataItem(s: Session, dry: boolean): HiddenItem {
  const details: string[] = []
  let count = 0
  const info = dict(s.pdf.getTrailer().get('Info'))
  if (info) {
    for (const k of keys(info)) {
      const v = readString(info.get(k))
      if (!v) continue
      count++
      const shown = /Date$/.test(k) ? parsePdfDate(v).slice(0, 10) || v : v
      details.push(`${k}: ${shown.length > 60 ? shown.slice(0, 57) + '…' : shown}`)
      if (!dry) info.delete(k)
    }
    if (!dry) for (const k of keys(info)) info.delete(k)
  }
  const cat = catalog(s)
  if (!isNull(cat.get('Metadata'))) {
    count++
    details.push('XMP metadata')
    if (!dry) cat.delete('Metadata')
  }
  const piece = dict(cat.get('PieceInfo'))
  if (piece) {
    for (const k of keys(piece)) {
      if (k === 'SearchIndex') continue
      count++
      details.push(`Private data of ${decodeName(k)}`)
      if (!dry) piece.delete(k)
    }
    if (!dry && keys(piece).length === 0) cat.delete('PieceInfo')
  }
  // page-level and XObject-level metadata
  const n = s.pageCount()
  const seen = new Set<number>()
  let objectLevel = 0
  for (let p = 0; p < n; p++) {
    const pageObj = s.pdf.findPage(p)
    for (const key of ['Metadata', 'PieceInfo']) {
      if (!isNull(pageObj.get(key))) {
        objectLevel++
        if (!dry) pageObj.delete(key)
      }
    }
    const xobjs = dict(dict(pageObj.getInheritable('Resources'))?.get('XObject'))
    for (const k of keys(xobjs)) {
      const ref = xobjs!.get(k)
      const id = num(ref)
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      const x = dict(ref)
      if (!x) continue
      for (const key of ['Metadata', 'PieceInfo']) {
        if (!isNull(x.get(key))) {
          objectLevel++
          if (!dry) x.delete(key)
        }
      }
    }
  }
  if (objectLevel) {
    count += objectLevel
    details.push(`${objectLevel} page or image metadata entr${objectLevel === 1 ? 'y' : 'ies'}`)
  }
  return { id: 'metadata', count, details }
}

function attachmentsItem(s: Session, dry: boolean): HiddenItem {
  const details: string[] = []
  const files = safe(() => Object.keys(s.pdf.getEmbeddedFiles()), [] as string[])
  details.push(...files)
  let count = files.length
  const cat = catalog(s)
  const names = dict(cat.get('Names'))
  if (!dry && names && !isNull(names.get('EmbeddedFiles'))) names.delete('EmbeddedFiles')
  for (const key of ['AF', 'Collection']) {
    if (!isNull(cat.get(key))) {
      if (key === 'Collection') details.push('Portfolio')
      count += key === 'Collection' ? 1 : 0
      if (!dry) cat.delete(key)
    }
  }
  const pages = s.pageCount()
  for (let p = 0; p < pages; p++) {
    const pageObj = s.pdf.findPage(p)
    if (!dry && !isNull(pageObj.get('AF'))) pageObj.delete('AF')
  }
  const fileAnnot = (a: PDFObject) => readName(a.get('Subtype')) === 'FileAttachment'
  if (dry) {
    forEachAnnot(s, (a) => {
      if (!fileAnnot(a)) return
      count++
      const fs = dict(a.get('FS'))
      details.push(fs ? readString(fs.get('UF')) || readString(fs.get('F')) || 'Attached file' : 'Attached file')
    })
  } else {
    const popups = new Set<number>()
    count += filterAnnots(s, (a) => {
      if (!fileAnnot(a)) return true
      const pop = a.get('Popup')
      if (!isNull(pop) && pop.isIndirect()) popups.add(pop.asIndirect())
      return false
    })
    if (popups.size) filterAnnots(s, (_a, ref) => !(ref.isIndirect() && popups.has(ref.asIndirect())))
  }
  return { id: 'attachments', count, details }
}

function bookmarksItem(s: Session, dry: boolean): HiddenItem {
  const list = outlineItems(s)
  const details = list.slice(0, 8).map((o) => readString(o.get('Title')) || 'Untitled')
  if (list.length > 8) details.push(`and ${list.length - 8} more`)
  const cat = catalog(s)
  if (!dry && !isNull(cat.get('Outlines'))) {
    cat.delete('Outlines')
    if (readName(cat.get('PageMode')) === 'UseOutlines') cat.put('PageMode', s.pdf.newName('UseNone'))
  }
  return { id: 'bookmarks', count: list.length, details }
}

const MARKUP = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly',
  'StrikeOut', 'Caret', 'Ink', 'Stamp', 'Sound'
])

function commentsItem(s: Session, dry: boolean): HiddenItem {
  let count = 0
  const authors = new Set<string>()
  const isComment = (a: PDFObject) => MARKUP.has(readName(a.get('Subtype')) ?? '')
  if (dry) {
    forEachAnnot(s, (a) => {
      if (!isComment(a)) return
      count++
      const t = readString(a.get('T'))
      if (t) authors.add(t)
    })
  } else {
    const popups = new Set<number>()
    count = filterAnnots(s, (a) => {
      if (!isComment(a)) return true
      const pop = a.get('Popup')
      if (!isNull(pop) && pop.isIndirect()) popups.add(pop.asIndirect())
      return false
    })
    filterAnnots(s, (a, ref) => {
      if (readName(a.get('Subtype')) !== 'Popup') return true
      if (ref.isIndirect() && popups.has(ref.asIndirect())) return false
      // popups whose parent is gone
      const parent = a.get('Parent')
      return isNull(parent) ? true : !(parent.isIndirect() && !stillAnnotated(s, parent.asIndirect()))
    })
  }
  return { id: 'comments', count, details: authors.size ? [`By ${[...authors].slice(0, 4).join(', ')}`] : [] }
}

function stillAnnotated(s: Session, objNum: number): boolean {
  let found = false
  const n = s.pageCount()
  for (let p = 0; p < n && !found; p++) {
    for (const a of items(s.pdf.findPage(p).get('Annots'))) {
      if (a.isIndirect() && a.asIndirect() === objNum) {
        found = true
        break
      }
    }
  }
  return found
}

function formsItem(s: Session, dry: boolean, mode: 'flatten' | 'remove'): HiddenItem {
  const names: string[] = []
  safe(() => walkFields(s.pdf, (_f, name) => names.push(name)), undefined)
  const cat = catalog(s)
  const acro = dict(cat.get('AcroForm'))
  const xfa = acro && !isNull(acro.get('XFA'))
  const details = names.slice(0, 8)
  if (names.length > 8) details.push(`and ${names.length - 8} more`)
  if (xfa) details.push('XFA form data')
  const count = names.length + (xfa ? 1 : 0)
  if (!dry && (count || acro)) {
    if (mode === 'flatten') {
      s.pdf.bake(false, true)
      s.invalidatePages()
      if (!isNull(cat.get('AcroForm'))) cat.delete('AcroForm')
    } else {
      filterAnnots(s, (a) => readName(a.get('Subtype')) !== 'Widget')
      cat.delete('AcroForm')
    }
  }
  return { id: 'forms', count, details }
}

function searchIndexItem(s: Session, dry: boolean): HiddenItem {
  const cat = catalog(s)
  const piece = dict(cat.get('PieceInfo'))
  const has = !!piece && !isNull(piece.get('SearchIndex'))
  if (!dry && has) {
    piece!.delete('SearchIndex')
    if (keys(piece).length === 0) cat.delete('PieceInfo')
  }
  return { id: 'searchIndex', count: has ? 1 : 0, details: has ? ['Embedded index'] : [] }
}

function javascriptItem(s: Session, dry: boolean): HiddenItem {
  const details: string[] = []
  const cat = catalog(s)
  const names = dict(cat.get('Names'))
  const docScripts = safe(() => Object.keys(s.pdf.loadNameTree('JavaScript')), [] as string[])
  let count = docScripts.length
  if (docScripts.length) details.push(`Document scripts: ${docScripts.slice(0, 4).join(', ')}`)
  if (!dry && names && !isNull(names.get('JavaScript'))) names.delete('JavaScript')
  const acro = dict(cat.get('AcroForm'))
  if (acro && !isNull(acro.get('CO'))) {
    if (!dry) acro.delete('CO')
  }
  const actions = processActions(s, isJs, dry)
  if (actions) details.push(`${actions} script action${actions === 1 ? '' : 's'} (opening, pages, links, fields, bookmarks)`)
  count += actions
  return { id: 'javascript', count, details }
}

function externalLinksItem(s: Session, dry: boolean): HiddenItem {
  const details: string[] = []
  let count = 0
  const linkTarget = (a: PDFObject) => {
    if (readName(a.get('Subtype')) !== 'Link') return null
    const act = dict(a.get('A'))
    const t = actionType(act)
    if (!t || !EXTERNAL_ACTIONS.has(t)) return null
    return readString(act!.get('URI')) || readString(dict(act!.get('F'))?.get('F')) || readString(act!.get('F')) || t
  }
  if (dry) {
    forEachAnnot(s, (a) => {
      const target = linkTarget(a)
      if (target === null) return
      count++
      if (details.length < 8) details.push(target)
    })
  } else {
    count += filterAnnots(s, (a) => linkTarget(a) === null)
  }
  // other external actions (buttons, bookmarks, page/document actions)
  const others = processActions(s, isExternal, dry, true)
  if (others) details.push(`${others} other action${others === 1 ? '' : 's'} that open web pages, files or submit data`)
  count += others
  return { id: 'externalLinks', count, details }
}

// ---- optional content (layers) ------------------------------------------------------------------

function ocProperties(s: Session): PDFObject | null {
  return dict(catalog(s).get('OCProperties'))
}

/** Object numbers of the OCGs that are off in the default configuration. */
function hiddenOcgs(s: Session): Map<number, string> {
  const out = new Map<number, string>()
  const oc = ocProperties(s)
  if (!oc) return out
  const d = dict(oc.get('D'))
  const all = items(oc.get('OCGs'))
  const base = d ? readName(d.get('BaseState')) : null
  const on = new Set(items(d?.get('ON')).map(num))
  const off = new Set(items(d?.get('OFF')).map(num))
  for (const g of all) {
    const id = num(g)
    if (!id) continue
    const hidden = base === 'OFF' ? !on.has(id) : off.has(id)
    if (hidden) out.set(id, readString(dict(g)?.get('Name')) || 'Unnamed layer')
  }
  return out
}

/** Whether an /OC value (OCG or OCMD) is hidden given the hidden OCG set. */
function ocHidden(oc: PDFObject | null, hidden: Map<number, string>, depth = 0): boolean {
  if (!oc || isNull(oc) || depth > 16) return false
  const d = dict(oc)
  if (!d) return false
  const type = readName(d.get('Type'))
  if (type === 'OCG') return hidden.has(num(oc))
  if (type === 'OCMD') {
    const ve = d.get('VE')
    if (!isNull(ve)) return !evalVE(ve, hidden, 0)
    const ocgs = d.get('OCGs')
    const list = isNull(ocgs) ? [] : ocgs.resolve().isArray() ? items(ocgs) : [ocgs]
    if (!list.length) return false
    const vis = list.map((g) => !hidden.has(num(g)))
    const policy = readName(d.get('P')) ?? 'AnyOn'
    const visible =
      policy === 'AllOn' ? vis.every(Boolean) : policy === 'AnyOff' ? vis.some((v) => !v) : policy === 'AllOff' ? vis.every((v) => !v) : vis.some(Boolean)
    return !visible
  }
  return false
}

function evalVE(ve: PDFObject, hidden: Map<number, string>, depth: number): boolean {
  if (depth > 16) return true
  const v = ve.resolve()
  if (!v.isArray()) return !hidden.has(num(ve))
  const parts = items(v)
  const op = parts.length ? readName(parts[0]) : null
  const args = parts.slice(1).map((p) => evalVE(p, hidden, depth + 1))
  if (op === 'Not') return !args[0]
  if (op === 'And') return args.every(Boolean)
  if (op === 'Or') return args.some(Boolean)
  return true
}

function readContent(obj: PDFObject): string {
  return bytesToBinary(obj.readStream().asUint8Array())
}

/** Filters page content (and the form XObjects it draws) so nothing painted on hidden layers remains. */
function filterLayersOnPage(s: Session, pageIndex: number, hidden: Map<number, string>, doneForms: Set<number>): number {
  const pageObj = s.pdf.findPage(pageIndex)
  const resources = dict(pageObj.getInheritable('Resources'))
  let removed = 0
  const ctxFor = (res: PDFObject | null) => ({
    isHiddenProperty: (name: string) => ocHidden(dict(res?.get('Properties'))?.get(decodeName(name)) ?? null, hidden),
    isHiddenXObject: (name: string) => {
      const x = dict(res?.get('XObject'))?.get(decodeName(name))
      return x ? ocHidden(dict(x)?.get('OC') ?? null, hidden) : false
    }
  })
  const visitForms = (names: string[], res: PDFObject | null, depth: number) => {
    if (depth > 12) return
    const xobjs = dict(res?.get('XObject'))
    for (const name of names) {
      const ref = xobjs?.get(decodeName(name))
      if (!ref || isNull(ref) || !ref.isIndirect()) continue
      const id = ref.asIndirect()
      if (doneForms.has(id)) continue
      doneForms.add(id)
      const x = dict(ref)
      if (!x || readName(x.get('Subtype')) !== 'Form') continue
      const formRes = dict(x.get('Resources')) ?? res
      const r = filterHiddenLayers(readContent(ref), ctxFor(formRes))
      if (r.removed) {
        ref.writeStream(binaryToBytes(r.out))
        removed += r.removed
      }
      visitForms(r.visibleForms, formRes, depth + 1)
    }
  }
  const contents = pageObj.get('Contents')
  if (isNull(contents)) return 0
  const c = contents.resolve()
  const streams = c.isArray() ? items(c) : [contents]
  const src = streams.map(readContent).join('\n')
  const r = filterHiddenLayers(src, ctxFor(resources))
  if (r.removed) {
    if (streams.length === 1) streams[0].writeStream(binaryToBytes(r.out))
    else pageObj.put('Contents', s.pdf.addStream(binaryToBytes(r.out), s.pdf.newDictionary()))
    removed += r.removed
  }
  visitForms(r.visibleForms, resources, 0)
  return removed
}

/** Removes hidden OCGs from the optional content configuration. */
function dropOcgs(s: Session, hidden: Map<number, string>) {
  const oc = ocProperties(s)
  if (!oc) return
  const isHidden = (o: PDFObject) => hidden.has(num(o))
  const pruneArray = (holder: PDFObject, key: string) => {
    const v = holder.get(key)
    if (isNull(v) || !v.resolve().isArray()) return
    const kept = s.pdf.newArray()
    for (const it of items(v)) {
      if (it.resolve().isArray()) {
        // nested Order arrays
        const sub = s.pdf.newArray()
        for (const x of items(it)) if (!isHidden(x)) sub.push(x)
        if (sub.length) kept.push(sub)
      } else if (!isHidden(it)) kept.push(it)
    }
    holder.put(key, kept)
  }
  pruneArray(oc, 'OCGs')
  const configs = [dict(oc.get('D')), ...items(oc.get('Configs')).map((c) => dict(c))].filter(Boolean) as PDFObject[]
  for (const d of configs) {
    for (const key of ['ON', 'OFF', 'Order', 'Locked']) pruneArray(d, key)
    const rb = d.get('RBGroups')
    if (!isNull(rb)) pruneArray(d, 'RBGroups')
    for (const as of items(d.get('AS'))) {
      const asd = dict(as)
      if (asd) pruneArray(asd, 'OCGs')
    }
  }
  if (items(oc.get('OCGs')).length === 0) catalog(s).delete('OCProperties')
}

/** Glyphs drawn only when the hidden layers are switched on, per page. */
function hiddenLayerGlyphs(s: Session): Map<number, Quad[]> {
  const out = new Map<number, Quad[]>()
  const doc = s.pdf
  const n = safe(() => doc.countLayers(), 0)
  const off: number[] = []
  for (let i = 0; i < n; i++) if (!safe(() => doc.isLayerVisible(i), true)) off.push(i)
  if (!off.length) return out
  const pages = s.pageCount()
  const before: Map<number, PageGlyphs> = new Map()
  for (let p = 0; p < pages; p++) before.set(p, collectPageGlyphs(s, p))
  try {
    for (const i of off) doc.setLayerVisible(i, true)
    for (let p = 0; p < pages; p++) {
      const seen = new Set<string>()
      const b = before.get(p)!
      for (const g of [...b.visible, ...b.invisible]) seen.add(glyphKey(g))
      const after = collectPageGlyphs(s, p)
      const extra = [...after.visible, ...after.invisible].filter((g) => !seen.has(glyphKey(g)))
      if (extra.length) out.set(p, extra.map((g) => g.core))
    }
  } finally {
    for (const i of off) safe(() => doc.setLayerVisible(i, false), undefined)
  }
  return out
}

function hiddenLayersItem(s: Session, dry: boolean): HiddenItem {
  const hidden = hiddenOcgs(s)
  const details = [...hidden.values()]
  if (dry || hidden.size === 0) return { id: 'hiddenLayers', count: hidden.size, details }
  const glyphs = hiddenLayerGlyphs(s)
  const doneForms = new Set<number>()
  const pages = s.pageCount()
  for (let p = 0; p < pages; p++) {
    filterLayersOnPage(s, p, hidden, doneForms)
    s.progress((p + 1) / pages / 3, 'Removing hidden layers…')
  }
  for (const [p, quads] of glyphs) removeGlyphs(s, p, quads)
  // annotations on hidden layers
  filterAnnots(s, (a) => !ocHidden(a.get('OC'), hidden))
  dropOcgs(s, hidden)
  return { id: 'hiddenLayers', count: hidden.size, details }
}

function glyphText(glyphs: { ch: string }[]): string {
  const t = glyphs.map((g) => g.ch).join('').replace(/\s+/g, ' ').trim()
  return t.length > 60 ? t.slice(0, 57) + '…' : t
}

function textItems(s: Session, want: { hiddenText: boolean; overlapping: boolean }, dry: boolean, report: (f: number) => void): { hiddenText: HiddenItem; overlapping: HiddenItem } {
  const hiddenText: HiddenItem = { id: 'hiddenText', count: 0, details: [] }
  const overlapping: HiddenItem = { id: 'overlapping', count: 0, details: [] }
  const pages = s.pageCount()
  for (let p = 0; p < pages; p++) {
    const g = collectPageGlyphs(s, p)
    const covered = coveredGlyphs(g)
    const invisibleCount = g.invisible.filter((x) => x.ch.trim()).length
    const coveredCount = covered.filter((x) => x.ch.trim()).length
    if (invisibleCount) {
      hiddenText.count += invisibleCount
      if (hiddenText.details.length < 6) hiddenText.details.push(`Page ${p + 1}: “${glyphText(g.invisible)}”`)
    }
    if (coveredCount) {
      overlapping.count += coveredCount
      if (overlapping.details.length < 6) overlapping.details.push(`Page ${p + 1}: “${glyphText(covered)}”`)
    }
    if (!dry) {
      const quads: Quad[] = []
      if (want.hiddenText) quads.push(...g.invisible.map((x) => x.core))
      if (want.overlapping) quads.push(...covered.map((x) => x.core))
      if (quads.length) removeGlyphs(s, p, quads)
    }
    report((p + 1) / pages)
  }
  return { hiddenText, overlapping }
}

// ---- entry points -------------------------------------------------------------------------------

/** Finds hidden information without changing anything. */
export function scanHidden(s: Session): HiddenScan {
  const text = textItems(s, { hiddenText: false, overlapping: false }, true, (f) => s.progress(f * 0.8, 'Looking for hidden text…'))
  const scan: HiddenScan = {
    metadata: metadataItem(s, true),
    attachments: attachmentsItem(s, true),
    bookmarks: bookmarksItem(s, true),
    comments: commentsItem(s, true),
    forms: formsItem(s, true, 'remove'),
    hiddenText: text.hiddenText,
    hiddenLayers: hiddenLayersItem(s, true),
    searchIndex: searchIndexItem(s, true),
    javascript: javascriptItem(s, true),
    externalLinks: externalLinksItem(s, true),
    overlapping: text.overlapping
  }
  s.progress(1)
  return scan
}

/** Removes the selected kinds of hidden information. Call inside a mutation. */
export function sanitize(s: Session, opts: SanitizeOptions): SanitizeReport {
  const want = new Set<HiddenItemId>(opts.items)
  const removed: SanitizeReport['removed'] = []
  const add = (it: HiddenItem) => {
    if (it.count) removed.push({ id: it.id, count: it.count })
  }
  if (want.has('hiddenLayers')) add(hiddenLayersItem(s, false))
  if (want.has('hiddenText') || want.has('overlapping')) {
    const t = textItems(s, { hiddenText: want.has('hiddenText'), overlapping: want.has('overlapping') }, false, (f) =>
      s.progress(0.33 + f * 0.5, 'Removing hidden text…')
    )
    if (want.has('hiddenText')) add(t.hiddenText)
    if (want.has('overlapping')) add(t.overlapping)
  }
  if (want.has('forms')) add(formsItem(s, false, opts.forms ?? 'flatten'))
  if (want.has('comments')) add(commentsItem(s, false))
  if (want.has('attachments')) add(attachmentsItem(s, false))
  if (want.has('javascript')) add(javascriptItem(s, false))
  if (want.has('externalLinks')) add(externalLinksItem(s, false))
  if (want.has('bookmarks')) add(bookmarksItem(s, false))
  if (want.has('searchIndex')) add(searchIndexItem(s, false))
  if (want.has('metadata')) add(metadataItem(s, false))
  s.progress(1)
  return { removed }
}
