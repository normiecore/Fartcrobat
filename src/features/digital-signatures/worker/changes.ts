/**
 * Describes what later incremental updates changed. Every changed object is judged by what it is
 * in the signed revision as well as in the current document: whatever a page draws in either one
 * is page content, and an object only counts as part of a comment, a form field or a signature
 * when that is all it is used for, in both.
 */
import type { PDFDocument, PDFObject } from '@engine/session'
import { catalog, isNull, readName, readNumber, walkFields } from '@engine/util/pdf'
import type { XrefEntryType } from '../lib/pdfbytes'
import type { ChangeCategory, ChangeEntry, MdpPermission } from '../types'
import { fieldOf, fullName, safe } from './fields'

interface AnnotRef {
  /** Object number of the annotation itself (popups and appearances point to it). */
  owner: number
  page: number
  subtype: string
  widget: boolean
  fieldName: string
  ft: string
  signed: boolean
}

/** What an object is used for in a document (several roles can apply to one object). */
const ROLE = {
  /** Drawn by a page: content streams and everything reachable from page resources. */
  content: 1,
  /** An annotation dictionary listed by a page (or the popup of one). */
  annot: 2,
  /** Part of an annotation: appearance streams, their resources... */
  ap: 4,
  /** A form field dictionary (not a widget). */
  field: 8,
  /** A signature value dictionary. */
  sig: 16,
  /** Validation data (/DSS). */
  dss: 32,
  /** The form's default resources (/DR). */
  formRes: 64,
  /** Reachable from the document some other way (outlines, actions, names, structure...). */
  other: 128,
  /** The catalog, the form dictionary, the page tree, pages, their /Annots arrays, document information. */
  struct: 256
} as const
const ANNOT_PARTS = ROLE.annot | ROLE.ap | ROLE.field | ROLE.sig

interface DocIndex {
  /** Page objects (and indirect /Annots arrays) -> page index. */
  pages: Map<number, number>
  /** Objects a page draws -> page. */
  contents: Map<number, number>
  annots: Map<number, AnnotRef>
  /** Objects reachable from an annotation (appearance streams and their resources) -> annotation. */
  ap: Map<number, number>
  /** Non-widget field dictionaries. */
  fields: Map<number, { name: string; ft: string }>
  sigDicts: Map<number, string>
  pageTree: Set<number>
  roles: Map<number, number>
  /** Every object reachable from the trailer: the objects the document actually uses. */
  inUse: Set<number>
  catalog: number
  acroForm: number
  fieldsArray: number
  info: number
  metadata: number
}

function num(o: PDFObject): number {
  return o && !isNull(o) && o.isIndirect() ? o.asIndirect() : -1
}

/** Thrown when a document is too large to classify its changes. */
class TooManyObjectsError extends Error {}

/**
 * Visits every object reachable from `roots`. `claim` is called for each indirect object and
 * returns false to not look inside it (already seen, or belongs elsewhere); dictionary entries
 * whose key `skip` returns true for are not followed.
 */
function reach(roots: PDFObject[], claim: (n: number) => boolean, skip: (key: string) => boolean = () => false) {
  const stack = roots.filter((o) => o && !isNull(o))
  let budget = 4_000_000
  while (stack.length) {
    if (--budget < 0) throw new TooManyObjectsError('The document has too many objects to list its changes')
    const o = stack.pop()!
    if (o.isIndirect() && !claim(o.asIndirect())) continue
    const r = o.resolve()
    if (r.isDictionary()) {
      r.forEach((v, k) => {
        if (!skip(String(k)) && !isNull(v)) stack.push(v)
      })
    } else if (r.isArray()) {
      for (let i = 0; i < r.length; i++) {
        const v = r.get(i)
        if (!isNull(v)) stack.push(v)
      }
    }
  }
}

/** A dictionary (not a stream) with a /Subtype: what an annotation looks like. */
function isAnnotDict(o: PDFObject): boolean {
  return o.isDictionary() && !o.isStream() && readName(o.get('Subtype')) !== null
}

function isPlainDict(o: PDFObject): boolean {
  return o.isDictionary() && !o.isStream()
}

function buildIndex(pdf: PDFDocument): DocIndex {
  const root = catalog(pdf)
  const acro = root.get('AcroForm')
  const idx: DocIndex = {
    pages: new Map(),
    contents: new Map(),
    annots: new Map(),
    ap: new Map(),
    fields: new Map(),
    sigDicts: new Map(),
    pageTree: new Set(),
    roles: new Map(),
    inUse: new Set(),
    catalog: num(pdf.getTrailer().get('Root')),
    acroForm: num(acro),
    fieldsArray: isNull(acro) ? -1 : num(acro.get('Fields')),
    info: num(pdf.getTrailer().get('Info')),
    metadata: num(root.get('Metadata'))
  }
  const addRole = (n: number, role: number) => {
    if (n > 0) idx.roles.set(n, (idx.roles.get(n) ?? 0) | role)
  }
  const walkTree = (node: PDFObject, depth: number) => {
    if (depth > 64 || isNull(node)) return
    const n = node.resolve()
    if (readName(n.get('Type')) !== 'Pages') return
    if (node.isIndirect()) idx.pageTree.add(node.asIndirect())
    const kids = n.get('Kids')
    if (isNull(kids)) return
    if (kids.isIndirect()) idx.pageTree.add(kids.asIndirect())
    const k = kids.resolve()
    for (let i = 0; i < k.length; i++) walkTree(k.get(i), depth + 1)
  }
  safe(() => walkTree(root.get('Pages'), 0), undefined)
  const count = pdf.countPages()
  const pageObjs: PDFObject[] = []
  for (let p = 0; p < count; p++) {
    const pageObj = pdf.findPage(p)
    pageObjs.push(pageObj)
    idx.pages.set(num(pageObj), p)
  }
  const isPageNode = (n: number) => idx.pages.has(n) || idx.pageTree.has(n)
  // What each page draws: everything reachable from the page dictionary (contents, resources,
  // group, actions...) except its parent and its annotations, with inherited resources. Every
  // key inside is followed: a resource may have any name.
  for (let p = 0; p < count; p++) {
    const pageObj = pageObjs[p]
    const page = pageObj.resolve()
    const roots: PDFObject[] = []
    page.forEach((v, k) => {
      if (k !== 'Parent' && k !== 'Annots') roots.push(v)
    })
    if (isNull(page.get('Resources'))) roots.push(pageObj.getInheritable('Resources'))
    reach(roots, (n) => {
      if (isPageNode(n) || idx.contents.has(n)) return false
      idx.contents.set(n, p)
      return true
    })
  }
  for (let p = 0; p < count; p++) {
    const pageObj = pageObjs[p]
    const annots = pageObj.get('Annots')
    if (annots.isIndirect()) idx.pages.set(annots.asIndirect(), p)
    if (isNull(annots) || !annots.isArray()) continue
    for (let k = 0; k < annots.length; k++) {
      const ref = annots.get(k)
      const a = ref.resolve()
      if (!isAnnotDict(a)) continue
      const subtype = readName(a.get('Subtype')) ?? 'Annot'
      const widget = subtype === 'Widget'
      const field = widget ? fieldOf(ref) : ref
      const ft = widget ? (readName(a.getInheritable('FT')) ?? '') : ''
      const signed = ft === 'Sig' && !isNull(field.resolve().get('V'))
      const n = num(ref)
      const parent = a.get('Parent')
      // A popup belongs to the annotation it pops up from.
      const popupOf = subtype === 'Popup' && parent.isIndirect() && isAnnotDict(parent.resolve())
      const owner = popupOf ? parent.asIndirect() : n
      const ownerType = popupOf ? (readName(parent.resolve().get('Subtype')) ?? 'Annot') : subtype
      const info: AnnotRef = { owner, page: p, subtype: ownerType, widget, fieldName: widget ? fullName(field) : '', ft, signed }
      if (n > 0 && !idx.annots.has(n)) idx.annots.set(n, info)
      const popup = a.get('Popup')
      if (popup.isIndirect() && readName(popup.resolve().get('Subtype')) === 'Popup' && isAnnotDict(popup.resolve()) && !idx.annots.has(popup.asIndirect())) {
        idx.annots.set(popup.asIndirect(), info)
      }
    }
  }
  for (const n of idx.annots.keys()) addRole(n, ROLE.annot)
  walkFields(pdf, (field, name, ft) => {
    let cur: PDFObject = field
    for (let d = 0; d < 32 && !isNull(cur); d++) {
      const n = num(cur)
      if (n > 0 && !idx.annots.has(n) && isPlainDict(cur.resolve())) {
        idx.fields.set(n, { name: d === 0 ? name : fullName(cur), ft: ft ?? '' })
        addRole(n, ROLE.field)
      }
      cur = cur.resolve().get('Parent')
    }
    if (ft === 'Sig') {
      const v = field.resolve().get('V')
      if (v.isIndirect() && isPlainDict(v.resolve())) {
        idx.sigDicts.set(v.asIndirect(), name)
        addRole(v.asIndirect(), ROLE.sig)
      }
    }
  })
  const isAnnotPart = (n: number) => idx.annots.has(n) || idx.fields.has(n) || idx.sigDicts.has(n)
  // Appearance streams, their resources and whatever else an annotation refers to belong to it.
  for (const [n] of idx.annots) {
    const roots: PDFObject[] = []
    pdf.newIndirect(n).resolve().forEach((v, k) => {
      if (!ANNOT_LINKS.has(String(k))) roots.push(v)
    })
    reach(
      roots,
      (m) => {
        if (isPageNode(m) || isAnnotPart(m) || idx.ap.has(m)) return false
        idx.ap.set(m, n)
        return true
      },
      (k) => ANNOT_LINKS.has(k)
    )
  }
  for (const n of idx.contents.keys()) addRole(n, ROLE.content)
  for (const n of idx.ap.keys()) addRole(n, ROLE.ap)
  const seenDss = new Set<number>()
  const dss = root.get('DSS')
  if (!isNull(dss)) reach([dss], (n) => !seenDss.has(n) && !!seenDss.add(n))
  for (const n of seenDss) addRole(n, ROLE.dss)
  const seenRes = new Set<number>()
  if (!isNull(acro)) reach([acro.get('DR')], (n) => !seenRes.has(n) && !!seenRes.add(n))
  for (const n of seenRes) addRole(n, ROLE.formRes)
  // Everything else the document reaches without going through pages, annotations, fields,
  // signatures, validation data or the form's default resources.
  const otherRoots: PDFObject[] = []
  pdf.getTrailer().forEach((v, k) => {
    if (k !== 'Root' && k !== 'Info') otherRoots.push(v)
  })
  root.forEach((v, k) => {
    if (k !== 'Pages' && k !== 'DSS' && k !== 'AcroForm' && k !== 'Metadata') otherRoots.push(v)
  })
  if (!isNull(acro)) {
    acro.resolve().forEach((v, k) => {
      if (k !== 'Fields' && k !== 'DR') otherRoots.push(v)
    })
  }
  const struct = new Set<number>([idx.catalog, idx.acroForm, idx.fieldsArray, idx.info, idx.metadata, ...idx.pages.keys(), ...idx.pageTree])
  const seenOther = new Set<number>()
  reach(otherRoots, (n) => {
    if (seenOther.has(n) || isPageNode(n) || isAnnotPart(n) || n === idx.catalog || n === idx.acroForm) return false
    seenOther.add(n)
    return true
  })
  for (const n of seenOther) addRole(n, ROLE.other)
  for (const n of struct) addRole(n, ROLE.struct)
  const trailer = pdf.getTrailer()
  const trailerRoots: PDFObject[] = []
  trailer.forEach((v) => trailerRoots.push(v))
  reach(trailerRoots, (n) => !idx.inUse.has(n) && !!idx.inUse.add(n))
  return idx
}

/** Entries of an annotation that point to other annotations, fields or pages, not to its own parts. */
const ANNOT_LINKS = new Set(['P', 'Parent', 'Popup', 'IRT', 'Kids', 'V', 'Dest', 'A', 'AA', 'Lock', 'SV'])

interface Found {
  category: ChangeCategory
  page?: number
  key: string
  added: boolean
  name?: string
  subtype?: string
  /** Description of an 'other' change. */
  description?: string
}

export interface ChangeContext {
  /** Most restrictive DocMDP/lock permission in force for this signature, or null (approval). */
  permission: MdpPermission | null
  /** Fields locked by this signature's field lock ("*" for all). */
  lockedFields: string[] | '*' | null
  /** The signed revision, opened on its own. */
  before: PDFDocument
}

const str = (o: PDFObject | null | undefined): string => (o && !isNull(o) ? o.toString() : '')

function sameValue(a: PDFObject | null | undefined, b: PDFObject | null | undefined): boolean {
  return str(a) === str(b)
}

function keysOf(...dicts: (PDFObject | null)[]): Set<string> {
  const keys = new Set<string>()
  for (const d of dicts) if (d && !isNull(d) && d.isDictionary()) d.forEach((_v, k) => keys.add(String(k)))
  return keys
}

/**
 * Whether `now` only adds entries to `before`: every entry `before` has is still there with the
 * same value (direct dictionaries are compared the same way, entry by entry). Streams never are.
 */
function onlyAdds(before: PDFObject | null, now: PDFObject | null): boolean {
  const o = before && !isNull(before) ? before : null
  if (!o) return true
  if (!now || isNull(now)) return false
  if (o.isIndirect() || now.isIndirect()) return sameValue(o, now)
  if (o.isStream() || now.isStream() || !o.isDictionary() || !now.isDictionary()) return sameValue(o, now)
  for (const key of keysOf(o)) if (!onlyAdds(o.get(key), now.get(key))) return false
  return true
}

const fieldsRemoved: Found = { category: 'other', key: 'other:fields', added: false, description: 'Form fields were removed' }
const formSettings: Found = { category: 'other', key: 'other:form', added: false, description: 'The form settings were changed' }
const formResources: Found = { category: 'other', key: 'other:form-resources', added: false, description: 'The resources used to draw form fields were changed' }

/** Whether fields listed in `before` (a /Fields array) are missing from `now`. */
function fieldsMissing(before: PDFObject | null, now: PDFObject | null): boolean {
  const listed = new Set<string>()
  const na = now && !isNull(now) ? now.resolve() : null
  if (na?.isArray()) for (let i = 0; i < na.length; i++) listed.add(str(na.get(i)))
  const oa = before && !isNull(before) ? before.resolve() : null
  if (oa?.isArray()) for (let i = 0; i < oa.length; i++) if (!listed.has(str(oa.get(i)))) return true
  return false
}

/**
 * Changes to the interactive form dictionary itself (fields are classified on their own).
 * /SigFlags, /NeedAppearances, /DA and /DR only decide how field appearances are drawn and
 * whether the form is signed; approval signatures let them change. A certification without
 * changes allows none of them; one that allows filling in and signing allows setting the
 * signature flags and adding default resources, nothing else.
 */
function compareAcroForm(before: PDFObject | null, now: PDFObject | null, permission: MdpPermission | null): Found[] {
  const out: Found[] = []
  const o = before && !isNull(before) ? before.resolve() : null
  const n = now && !isNull(now) ? now.resolve() : null
  for (const key of keysOf(o, n)) {
    const ov = o?.get(key) ?? null
    const nv = n?.get(key) ?? null
    if (key === 'Fields') {
      // Fields may be added (each is classified on its own) but not removed.
      if (fieldsMissing(ov, nv)) out.push(fieldsRemoved)
      continue
    }
    if (sameValue(ov, nv)) continue
    if (permission === null && (key === 'SigFlags' || key === 'NeedAppearances' || key === 'DA')) continue
    if (key === 'DR') {
      if (permission === null || (permission !== 1 && onlyAdds(ov ? ov.resolve() : null, nv ? nv.resolve() : null))) continue
      out.push(formResources)
      continue
    }
    if (key === 'SigFlags' && permission !== 1) {
      // Signing sets SignaturesExist and AppendOnly; nothing else, and nothing is cleared.
      const of = Math.round(readNumber(ov, 0))
      const nf = Math.round(readNumber(nv, 0))
      if ((nf & ~3) === 0 && (of & ~nf) === 0) continue
    }
    out.push(formSettings)
  }
  return out
}

/** Changes to the document catalog, compared with the signed revision's. */
function compareCatalog(before: PDFDocument, pdf: PDFDocument, permission: MdpPermission | null): Found[] {
  const o = catalog(before).resolve()
  const n = catalog(pdf).resolve()
  const out: Found[] = []
  for (const key of keysOf(o, n)) {
    if (key === 'DSS') continue
    const ov = o.get(key)
    const nv = n.get(key)
    if (key === 'AcroForm') out.push(...compareAcroForm(ov, nv, permission))
    else if (sameValue(ov, nv)) continue
    else if (key === 'Metadata') out.push({ category: 'metadata', key: 'metadata', added: false })
    else if (key === 'Pages') out.push({ category: 'pages', key: 'pages', added: false })
    else out.push({ category: 'other', key: `other:catalog:${key}`, added: false, description: `The document catalog entry /${key} was changed` })
  }
  return out
}

/** Whether a page dictionary changed in more than its list of annotations. */
function pageDictChanged(before: PDFDocument, pdf: PDFDocument, n: number): boolean {
  const o = before.newIndirect(n).resolve()
  const p = pdf.newIndirect(n).resolve()
  if (!o.isDictionary()) return true
  for (const key of keysOf(o, p)) if (key !== 'Annots' && !sameValue(o.get(key), p.get(key))) return true
  return false
}

/** A change to an annotation (or to its popup or appearance when `n` is not the annotation itself). */
function annotFinding(owner: AnnotRef, n: number, added: boolean): Found {
  const isNew = added && owner.owner === n
  if (owner.widget) {
    if (owner.ft === 'Sig') return { category: 'signature', key: `sig:${owner.fieldName}`, added: isNew, name: owner.fieldName, page: owner.page }
    return { category: 'form', key: `form:${owner.fieldName}`, added: isNew, name: owner.fieldName, page: owner.page }
  }
  return { category: 'annotation', key: `annot:${owner.owner}`, added: isNew, page: owner.page, subtype: owner.subtype }
}

const otherObjects = (added: boolean): Found => ({ category: 'other', key: 'other:objects', added, description: 'Other parts of the document were changed' })

/** Classifies the objects changed after a signature and says whether each change is allowed. */
export function describeChanges(pdf: PDFDocument, changed: Map<number, XrefEntryType>, oldSize: number, ctx: ChangeContext): ChangeEntry[] {
  const idx = buildIndex(pdf)
  const signed = buildIndex(ctx.before)
  const permission = ctx.permission
  const found: Found[] = []
  const touchedPages = new Set<number>()
  const pageObjects = new Set<number>()
  for (let p = 0; p < pdf.countPages(); p++) pageObjects.add(num(pdf.findPage(p)))
  let removed = 0
  for (const [n, type] of changed) {
    const added = oldSize > 0 && n >= oldSize
    // What the object is used for now and, unless it is new, what it was used for when signed.
    const roles = (idx.roles.get(n) ?? 0) | (added ? 0 : (signed.roles.get(n) ?? 0))
    // Whatever a page draws, now or in the signed revision, is page content, whatever else
    // the update makes it look like.
    const drawnBy = idx.contents.get(n) ?? (added ? undefined : signed.contents.get(n))
    if (drawnBy !== undefined) {
      found.push({ category: 'content', key: `content:${drawnBy}`, added, page: drawnBy })
      continue
    }
    if (type === 'f') {
      if (idx.inUse.has(n) && roles & (ROLE.other | ROLE.struct | ROLE.dss | ROLE.formRes)) found.push(otherObjects(false))
      else if (!added) removed++
      continue
    }
    const page = idx.pages.get(n)
    if (page !== undefined) {
      // A page whose dictionary changed in more than its annotations (resources, contents, boxes...)
      // shows something else now.
      if (pageObjects.has(n) && !added && pageDictChanged(ctx.before, pdf, n)) found.push({ category: 'content', key: `content:${page}`, added, page })
      else if (!pageObjects.has(n) && roles & ~ROLE.struct) found.push(otherObjects(added))
      else touchedPages.add(page)
      continue
    }
    if (idx.pageTree.has(n)) {
      found.push({ category: 'pages', key: 'pages', added })
      continue
    }
    if (n === idx.catalog) {
      found.push(...compareCatalog(ctx.before, pdf, permission))
      continue
    }
    if (n === idx.acroForm) {
      found.push(...compareAcroForm(catalog(ctx.before).get('AcroForm'), catalog(pdf).get('AcroForm'), permission))
      continue
    }
    if (n === idx.fieldsArray) {
      if (fieldsMissing(catalog(ctx.before).get('AcroForm').get('Fields'), catalog(pdf).get('AcroForm').get('Fields'))) found.push(fieldsRemoved)
      continue
    }
    // Objects nothing refers to any more do not matter.
    if (!idx.inUse.has(n)) continue
    if (n === idx.info || n === idx.metadata) {
      found.push(roles & ~ROLE.struct ? otherObjects(added) : { category: 'metadata', key: 'metadata', added })
      continue
    }
    // Used for something else (outlines, actions, names...), or a part of the catalog, the page
    // tree or a page in the signed revision.
    if (roles & (ROLE.other | ROLE.struct)) {
      found.push(otherObjects(added))
      continue
    }
    if (roles & ROLE.formRes) {
      // Fonts and other resources added for drawing field appearances are side effects.
      const grew = added || onlyAdds(ctx.before.newIndirect(n).resolve(), pdf.newIndirect(n).resolve())
      if (permission === null || (permission !== 1 && grew)) continue
      found.push(formResources)
      continue
    }
    if (roles & ROLE.dss) {
      found.push(roles & ANNOT_PARTS ? otherObjects(added) : { category: 'dss', key: 'dss', added })
      continue
    }
    const sig = idx.sigDicts.get(n)
    if (sig !== undefined) {
      found.push({ category: 'signature', key: `sig:${sig}`, added, name: sig })
      continue
    }
    const direct = idx.annots.get(n)
    if (direct) {
      found.push(annotFinding(direct, n, added))
      continue
    }
    const field = idx.fields.get(n)
    if (field) {
      found.push({ category: field.ft === 'Sig' ? 'signature' : 'form', key: `${field.ft === 'Sig' ? 'sig' : 'form'}:${field.name}`, added, name: field.name })
      continue
    }
    const apOwner = idx.ap.get(n)
    const owner = apOwner !== undefined ? idx.annots.get(apOwner) : undefined
    if (owner) {
      found.push(annotFinding(owner, n, added))
      continue
    }
    // Anything else the document uses is a change that nothing above allows.
    found.push(otherObjects(added))
  }
  for (const p of touchedPages) {
    if (!found.some((f) => f.page === p && f.category !== 'pages')) found.push({ category: 'page', key: `page:${p}`, added: false, page: p })
  }
  if (removed) found.push({ category: 'deleted', key: 'deleted', added: false })

  const allowed = (f: Found): boolean => {
    const p = ctx.permission
    if (f.category === 'dss') return true
    if (ctx.lockedFields && (f.category === 'form' || (f.category === 'signature' && f.added))) {
      if (ctx.lockedFields === '*' || (f.name && ctx.lockedFields.includes(f.name))) return false
    }
    if (p === null) return f.category !== 'content' && f.category !== 'pages' && f.category !== 'page' && f.category !== 'other'
    if (p === 1) return false
    if (f.category === 'signature') return !f.added || p === 3
    if (f.category === 'form') return !f.added
    if (f.category === 'annotation' || f.category === 'deleted') return p === 3
    return false
  }

  const entries: ChangeEntry[] = []
  const byKey = new Map<string, Found[]>()
  for (const f of found) {
    const list = byKey.get(f.key) ?? []
    list.push(f)
    byKey.set(f.key, list)
  }
  // Group comments per page.
  const annotGroups = new Map<string, { page: number; added: number; changed: number; ok: boolean; types: Set<string> }>()
  for (const [key, list] of byKey) {
    const f = list[0]
    const added = list.some((x) => x.added)
    const ok = list.every(allowed)
    switch (f.category) {
      case 'signature':
        entries.push({ category: 'signature', page: f.page, allowed: ok, description: added ? `Signature field “${f.name}” was added and signed` : `Signature field “${f.name}” was signed` })
        break
      case 'form':
        entries.push({ category: 'form', page: f.page, allowed: ok, description: added ? `Form field “${f.name}” was added` : `Form field “${f.name}” was filled in or changed` })
        break
      case 'annotation': {
        const gk = `${f.page}`
        const g = annotGroups.get(gk) ?? { page: f.page!, added: 0, changed: 0, ok: true, types: new Set<string>() }
        if (added) g.added++
        else g.changed++
        g.ok &&= ok
        if (f.subtype && f.subtype !== 'Popup') g.types.add(f.subtype)
        annotGroups.set(gk, g)
        break
      }
      case 'content':
        entries.push({ category: 'content', page: f.page, allowed: ok, description: `Page ${f.page! + 1}: the page content was changed` })
        break
      case 'pages':
        entries.push({ category: 'pages', allowed: ok, description: 'Pages were added, removed or reordered' })
        break
      case 'page':
        entries.push({ category: 'page', page: f.page, allowed: ok, description: `Page ${f.page! + 1}: the page was changed` })
        break
      case 'metadata':
        entries.push({ category: 'metadata', allowed: ok, description: 'Document properties were changed' })
        break
      case 'dss':
        entries.push({ category: 'dss', allowed: true, description: 'Validation information (certificates, revocation data) was added' })
        break
      case 'deleted':
        entries.push({ category: 'deleted', allowed: ok, description: `${removed} item${removed === 1 ? ' was' : 's were'} removed` })
        break
      case 'other':
        entries.push({ category: 'other', allowed: ok, description: f.description ?? 'Other parts of the document were changed' })
        break
      default:
        void key
    }
  }
  for (const g of annotGroups.values()) {
    const kinds = g.types.size ? ` (${[...g.types].join(', ')})` : ''
    const parts: string[] = []
    if (g.added) parts.push(`${g.added} comment${g.added === 1 ? '' : 's'} added`)
    if (g.changed) parts.push(`${g.changed} comment${g.changed === 1 ? '' : 's'} changed`)
    entries.push({ category: 'annotation', page: g.page, allowed: g.ok, description: `Page ${g.page + 1}: ${parts.join(', ')}${kinds}` })
  }
  const order: ChangeCategory[] = ['signature', 'form', 'annotation', 'deleted', 'content', 'page', 'pages', 'metadata', 'dss', 'other']
  entries.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || (a.page ?? -1) - (b.page ?? -1))
  return entries
}
