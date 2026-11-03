/**
 * Whether everything written after a signature is nothing but later signatures, written the way
 * a standard incremental signing writes them. This decides whether a signature that does not cover
 * the whole file can still show as valid: anything else written after it caps its status (see
 * status.ts), however harmless describeChanges makes it look.
 *
 * The check fails closed. Every object the later updates define must be one of:
 * - the signature dictionary of a later signature that verified, with objects only it uses;
 * - the field and widget holding that signature: new, or an empty signature field of the signed
 *   revision that only gained its value, appearance, flags and lock; its appearance objects new;
 * - a page, /Annots array, catalog, form dictionary or /Fields array of the signed revision that
 *   only had new signature widgets or fields appended (and the form's signature flags set);
 * - an object written again with the very same value, or a new cross-reference or object stream
 *   whose dictionary refers to nothing.
 * New objects must not be numbers the signed revision already refers to (a dangling reference
 * there would start showing them). Anything else, or anything that cannot be read, is a change.
 */
import type { PDFDocument, PDFObject } from '@engine/session'
import { catalog, isNull, readName, readNumber } from '@engine/util/pdf'
import type { XrefEntryType } from '../lib/pdfbytes'
import { safe, signedFieldIn } from './fields'

const str = (o: PDFObject | null | undefined): string => (o && !isNull(o) ? o.toString() : '')
const num = (o: PDFObject | null | undefined): number => (o && !isNull(o) && o.isIndirect() ? o.asIndirect() : -1)
const isStreamRef = (o: PDFObject): boolean => !isNull(o) && o.isIndirect() && o.isStream()

function keysOf(...dicts: (PDFObject | null)[]): Set<string> {
  const keys = new Set<string>()
  for (const d of dicts) if (d && !isNull(d) && d.isDictionary()) d.forEach((_v, k) => keys.add(String(k)))
  return keys
}

/** Keys whose values differ between two dictionaries (either may be missing). */
function changedKeys(o: PDFObject | null, n: PDFObject | null): string[] {
  const out: string[] = []
  for (const k of keysOf(o, n)) if (str(o && !isNull(o) ? o.get(k) : null) !== str(n && !isNull(n) ? n.get(k) : null)) out.push(k)
  return out
}

/** Every object number referred to anywhere in a document's objects and trailer. */
function referencedNumbers(pdf: PDFDocument): Set<number> {
  const out = new Set<number>()
  let budget = 4_000_000
  const scan = (root: PDFObject) => {
    const stack = [root]
    while (stack.length) {
      if (--budget < 0) throw new Error('too many objects')
      const o = stack.pop()!
      if (isNull(o)) continue
      if (o.isIndirect()) {
        out.add(o.asIndirect())
        continue
      }
      if (o.isDictionary()) o.forEach((v) => stack.push(v))
      else if (o.isArray()) for (let i = 0; i < o.length; i++) stack.push(o.get(i))
    }
  }
  scan(pdf.getTrailer())
  const count = pdf.countObjects()
  if (count > 2_000_000) throw new Error('too many objects')
  for (let n = 1; n < count; n++) {
    const o = safe(() => pdf.newIndirect(n).resolve(), null)
    if (o) scan(o)
  }
  return out
}

/**
 * Whether a dictionary (or array) holds no references, at any depth, other than under the keys
 * `except` at its top level.
 */
function allDirect(o: PDFObject, except: Set<string> = new Set()): boolean {
  const stack: PDFObject[] = []
  if (o.isDictionary()) o.forEach((v, k) => !except.has(String(k)) && stack.push(v))
  else stack.push(o)
  while (stack.length) {
    const x = stack.pop()!
    if (isNull(x)) continue
    if (x.isIndirect()) return false
    if (x.isDictionary()) x.forEach((v) => stack.push(v))
    else if (x.isArray()) for (let i = 0; i < x.length; i++) stack.push(x.get(i))
  }
  return true
}

/** Trailer entries that refer to objects. */
const TRAILER_REFS = new Set(['Root', 'Info', 'Encrypt'])

/** Entries of an annotation or field that point to other things (pages, parents, values). */
const LINKS = new Set(['P', 'Parent', 'V', 'Kids'])
/**
 * Entries a new signature field or widget may have: what it is, where and how it shows, its value
 * and lock. Not actions (/A, /AA), which could change the document when it is opened or viewed.
 */
const NEW_FIELD_KEYS = new Set(['Type', 'Subtype', 'FT', 'T', 'TU', 'TM', 'Ff', 'Rect', 'F', 'P', 'V', 'AP', 'AS', 'Parent', 'Kids', 'Lock', 'SV', 'MK', 'DA', 'Q', 'NM', 'M', 'Border', 'BS', 'C', 'StructParent', 'Contents'])

function unexpectedKey(d: PDFObject): string | null {
  let bad: string | null = null
  d.forEach((_v, k) => {
    if (!bad && !NEW_FIELD_KEYS.has(String(k))) bad = String(k)
  })
  return bad
}

/** What signing an empty signature field may change on its field and widget dictionaries. */
const SIGNING_SETS = new Set(['V', 'AP'])
/** ...and what it may add when the field did not have it. */
const SIGNING_ADDS = new Set(['F', 'Lock'])

/**
 * Returns null when the objects `changed` after the signed revision `before` are only later
 * signatures (`laterSigs`: the object numbers of signature dictionaries of later signatures whose
 * signed bytes verified), else a short reason (for tests and debugging).
 */
export function laterUpdatesOtherThanSigning(now: PDFDocument, before: PDFDocument, changed: Map<number, XrefEntryType>, laterSigs: Set<number>): string | null {
  try {
    return judge(now, before, changed, laterSigs)
  } catch (err) {
    return `could not be checked (${(err as Error).message})`
  }
}

function judge(now: PDFDocument, before: PDFDocument, changed: Map<number, XrefEntryType>, laterSigs: Set<number>): string | null {
  const existedCache = new Map<number, boolean>()
  const existed = (n: number): boolean => {
    let v = existedCache.get(n)
    if (v === undefined) {
      v = n > 0 && safe(() => !isNull(before.newIndirect(n).resolve()), true)
      existedCache.set(n, v)
    }
    return v
  }
  const pending = new Set<number>()
  for (const [n, type] of changed) {
    if (type === 'f') {
      // Freeing an object the signed revision had changes what refers to it.
      if (existed(n)) return `object ${n} was freed`
      continue
    }
    pending.add(n)
  }
  if (!pending.size) return null
  const accounted = new Set<number>()
  const fresh = new Set<number>()

  // The trailer keeps its catalog, document information and encryption.
  const bt = before.getTrailer()
  const nt = now.getTrailer()
  for (const k of TRAILER_REFS) if (str(bt.get(k)) !== str(nt.get(k))) return `the trailer /${k} changed`

  for (const n of pending) {
    if (existed(n)) {
      // Written again with the same value.
      const same = safe(() => {
        const o = before.newIndirect(n)
        const p = now.newIndirect(n)
        if (isStreamRef(o) || isStreamRef(p)) return false
        return o.resolve().toString() === p.resolve().toString()
      }, false)
      if (same) accounted.add(n)
    } else {
      // A cross-reference or object stream of an update: read by position, not by reference.
      const ref = now.newIndirect(n)
      if (isStreamRef(ref)) {
        const d = ref.resolve()
        const type = readName(d.get('Type'))
        // A cross-reference stream is also the trailer, whose references were compared above.
        if ((type === 'XRef' && allDirect(d, TRAILER_REFS)) || (type === 'ObjStm' && allDirect(d))) accounted.add(n)
      }
    }
  }

  /** Claims new objects reachable from `roots` (not through `skip` keys) as parts of a signature. */
  const claimNew = (roots: PDFObject[], skip: Set<string> = LINKS) => {
    const stack = roots.filter((o) => o && !isNull(o))
    let budget = 1_000_000
    while (stack.length) {
      if (--budget < 0) throw new Error('too many objects')
      const o = stack.pop()!
      if (o.isIndirect()) {
        const m = o.asIndirect()
        if (!pending.has(m) || accounted.has(m) || existed(m)) continue
        accounted.add(m)
        fresh.add(m)
      }
      const r = o.resolve()
      if (r.isDictionary()) {
        r.forEach((v, k) => {
          if (!skip.has(String(k)) && !isNull(v)) stack.push(v)
        })
      } else if (r.isArray()) {
        for (let i = 0; i < r.length; i++) if (!isNull(r.get(i))) stack.push(r.get(i))
      }
    }
  }

  /**
   * An existing field or widget dictionary that signing changed: only its value and appearance
   * (new objects), plus flags and a lock it did not have.
   */
  const signedInPlace = (ref: PDFObject): string | null => {
    const n = num(ref)
    if (n <= 0 || !pending.has(n) || accounted.has(n)) return null
    if (isStreamRef(ref) || isStreamRef(before.newIndirect(n))) return `object ${n} is a stream`
    const o = before.newIndirect(n).resolve()
    const p = now.newIndirect(n).resolve()
    if (!o.isDictionary() || !p.isDictionary()) return `object ${n} is not a dictionary`
    for (const k of changedKeys(o, p)) {
      if (SIGNING_SETS.has(k)) continue
      if (SIGNING_ADDS.has(k) && isNull(o.get(k))) continue
      return `signing changed /${k} of object ${n}`
    }
    accounted.add(n)
    claimNew([p.get('AP'), p.get('Lock')])
    return null
  }

  // Later signatures: their values, fields, widgets and appearances.
  const newWidgets = new Set<number>()
  const newFields = new Set<number>()
  for (const vNum of laterSigs) {
    if (!pending.has(vNum)) continue
    if (existed(vNum)) return `the signature value ${vNum} replaces an object of the signed revision`
    const field = signedFieldIn(now, vNum)
    if (!field) continue
    if (readName(field.resolve().getInheritable('FT')) !== 'Sig') return `the field holding signature ${vNum} is not a signature field`
    claimNew([now.newIndirect(vNum)], new Set())
    const f = num(field)
    if (f <= 0) return 'a signature field is not an object of its own'
    const fd = field.resolve()
    const kids = fd.get('Kids')
    const widgets: PDFObject[] = []
    if (readName(fd.get('Subtype')) === 'Widget') widgets.push(field)
    if (!isNull(kids)) {
      const k = kids.resolve()
      if (!k.isArray()) return `the kids of field ${f} are not an array`
      for (let i = 0; i < k.length; i++) widgets.push(k.get(i))
    }
    if (!existed(f)) {
      // A new signature field: top level, with new widgets of its own.
      if (!isNull(fd.get('Parent'))) return `the new signature field ${f} has a parent`
      if (!isNull(kids) && kids.isIndirect()) return `the new signature field ${f} has an indirect /Kids`
      const extra = unexpectedKey(fd)
      if (extra) return `the new signature field ${f} has /${extra}`
      claimNew([field])
      for (const w of widgets) {
        const wn = num(w)
        if (wn <= 0 || existed(wn) || readName(w.resolve().get('Subtype')) !== 'Widget') return `a widget of the new signature field ${f} is not new`
        if (wn !== f && num(w.resolve().get('Parent')) !== f) return `widget ${wn} does not belong to field ${f}`
        const extraW = unexpectedKey(w.resolve())
        if (extraW) return `the new signature widget ${wn} has /${extraW}`
        claimNew([w])
        newWidgets.add(wn)
      }
      newFields.add(f)
    } else {
      // An empty signature field of the signed revision, now signed.
      const was = before.newIndirect(f).resolve()
      if (!was.isDictionary() || readName(was.getInheritable('FT')) !== 'Sig' || !isNull(was.get('V'))) return `field ${f} was not an empty signature field`
      const bad = signedInPlace(field)
      if (bad) return bad
      for (const w of widgets) {
        const wn = num(w)
        if (wn === f) continue
        if (wn <= 0 || !existed(wn)) return `field ${f} gained a widget`
        const bad2 = signedInPlace(w)
        if (bad2) return bad2
      }
    }
  }

  /** An array that only had new entries (from `allowed`) appended; `nowVal` may be a reference. */
  const appended = (beforeVal: PDFObject | null, nowVal: PDFObject | null, allowed: Set<number>, what: string): string | null => {
    const b = beforeVal && !isNull(beforeVal) ? beforeVal.resolve() : null
    const a = nowVal && !isNull(nowVal) ? nowVal.resolve() : null
    if (b && !b.isArray()) return `${what} was not an array`
    if (!a || !a.isArray()) return `${what} is not an array`
    const blen = b ? b.length : 0
    if (a.length < blen) return `${what} lost entries`
    for (let i = 0; i < blen; i++) if (str(b!.get(i)) !== str(a.get(i))) return `${what} changed`
    for (let i = blen; i < a.length; i++) if (!allowed.has(num(a.get(i)))) return `${what} gained an entry that is not a new signature`
    const an = num(nowVal)
    if (an > 0 && pending.has(an) && !accounted.has(an)) {
      if (isStreamRef(nowVal!)) return `${what} is a stream`
      if (existed(an) && an !== num(beforeVal)) return `${what} now uses another object of the signed revision`
      accounted.add(an)
      if (!existed(an)) fresh.add(an)
    }
    return null
  }

  // Pages: only their /Annots may change, by new signature widgets appended.
  const pages = now.countPages()
  if (pages !== before.countPages()) return 'the number of pages changed'
  for (let i = 0; i < pages; i++) {
    const pn = num(now.findPage(i))
    const pb = num(before.findPage(i))
    if (pn !== pb) return `page ${i + 1} is another object`
    const p = now.newIndirect(pn).resolve()
    const o = before.newIndirect(pn).resolve()
    if (pending.has(pn) && !accounted.has(pn)) {
      if (isStreamRef(now.newIndirect(pn))) return `page ${i + 1} is a stream`
      for (const k of changedKeys(o, p)) if (k !== 'Annots') return `page ${i + 1} changed its /${k}`
      accounted.add(pn)
    }
    const bAnnots = o.get('Annots')
    const nAnnots = p.get('Annots')
    if (str(bAnnots) !== str(nAnnots) || pending.has(num(nAnnots))) {
      const bad = appended(bAnnots, nAnnots, newWidgets, `the annotations of page ${i + 1}`)
      if (bad) return bad
    }
  }

  // The catalog may only change its form dictionary; the form only its fields and signature flags.
  const root = num(nt.get('Root'))
  const bc = catalog(before)
  const nc = catalog(now)
  if (root > 0 && pending.has(root) && !accounted.has(root)) {
    if (isStreamRef(now.newIndirect(root))) return 'the catalog is a stream'
    for (const k of changedKeys(bc, nc)) if (k !== 'AcroForm') return `the catalog changed its /${k}`
    accounted.add(root)
  }
  const ba = bc.get('AcroForm')
  const na = nc.get('AcroForm')
  const an = num(na)
  if (str(ba) !== str(na) || (an > 0 && pending.has(an) && !accounted.has(an))) {
    if (isNull(na)) return 'the form was removed'
    if (an > 0) {
      if (isStreamRef(na)) return 'the form dictionary is a stream'
      if (existed(an) && an !== num(ba)) return 'the form dictionary is another object of the signed revision'
      if (pending.has(an)) {
        accounted.add(an)
        if (!existed(an)) fresh.add(an)
      }
    }
    const bd = isNull(ba) ? null : ba.resolve()
    const nd = na.resolve()
    if (!nd.isDictionary()) return 'the form is not a dictionary'
    for (const k of changedKeys(bd, nd)) {
      if (k === 'Fields') continue
      if (k === 'SigFlags') {
        const of = Math.round(readNumber(bd?.get('SigFlags'), 0))
        const nf = Math.round(readNumber(nd.get('SigFlags'), 0))
        if ((of & ~nf) === 0 && ((nf & ~of) & ~3) === 0) continue
      }
      return `the form changed its /${k}`
    }
  }
  if (!isNull(na)) {
    const bf = isNull(ba) ? null : ba.resolve().get('Fields')
    const nf = na.resolve().get('Fields')
    if (str(bf) !== str(nf) || pending.has(num(nf))) {
      const bad = appended(bf, nf, newFields, 'the form fields')
      if (bad) return bad
    }
  }

  for (const n of pending) if (!accounted.has(n)) return `object ${n} changed`
  // A new object the signed revision already refers to would change what that reference shows.
  for (const n of pending) {
    if (existed(n)) continue
    fresh.add(n)
  }
  if (fresh.size) {
    const refs = referencedNumbers(before)
    for (const n of fresh) if (refs.has(n)) return `the signed revision already refers to the new object ${n}`
  }
  return null
}
