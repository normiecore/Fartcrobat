/**
 * Describes what later incremental updates changed, by classifying the objects they (re)defined
 * against the current document: comments, form fields, signatures, page content, page tree...
 */
import type { PDFDocument, PDFObject } from '@engine/session'
import { catalog, isNull, readName, walkFields } from '@engine/util/pdf'
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

interface DocIndex {
  pages: Map<number, number>
  contents: Map<number, number>
  annots: Map<number, AnnotRef>
  /** Appearance streams -> owning annotation object. */
  ap: Map<number, number>
  /** Non-widget field dictionaries. */
  fields: Map<number, { name: string; ft: string }>
  sigDicts: Map<number, string>
  pageTree: Set<number>
  dss: Set<number>
  catalog: number
  acroForm: number
  info: number
  metadata: number
}

function num(o: PDFObject): number {
  return o && !isNull(o) && o.isIndirect() ? o.asIndirect() : -1
}

function collectStreams(o: PDFObject, out: (n: number) => void, depth = 0) {
  if (!o || isNull(o) || depth > 3) return
  if (o.isIndirect()) out(o.asIndirect())
  const r = o.resolve()
  if (r.isDictionary() && !r.isStream()) r.forEach((v) => collectStreams(v, out, depth + 1))
  else if (r.isArray()) for (let i = 0; i < r.length; i++) collectStreams(r.get(i), out, depth + 1)
}

function buildIndex(pdf: PDFDocument): DocIndex {
  const root = catalog(pdf)
  const idx: DocIndex = {
    pages: new Map(),
    contents: new Map(),
    annots: new Map(),
    ap: new Map(),
    fields: new Map(),
    sigDicts: new Map(),
    pageTree: new Set(),
    dss: new Set(),
    catalog: num(pdf.getTrailer().get('Root')),
    acroForm: num(root.get('AcroForm')),
    info: num(pdf.getTrailer().get('Info')),
    metadata: num(root.get('Metadata'))
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
  for (let p = 0; p < count; p++) {
    const pageObj = pdf.findPage(p)
    idx.pages.set(num(pageObj), p)
    const contents = pageObj.get('Contents')
    if (!isNull(contents)) {
      if (contents.isIndirect()) idx.contents.set(contents.asIndirect(), p)
      const cr = contents.resolve()
      if (cr.isArray()) for (let i = 0; i < cr.length; i++) if (cr.get(i).isIndirect()) idx.contents.set(cr.get(i).asIndirect(), p)
    }
    const annots = pageObj.get('Annots')
    if (annots.isIndirect()) idx.pages.set(annots.asIndirect(), p)
    if (isNull(annots) || !annots.isArray()) continue
    for (let k = 0; k < annots.length; k++) {
      const ref = annots.get(k)
      const a = ref.resolve()
      if (!a.isDictionary()) continue
      const subtype = readName(a.get('Subtype')) ?? 'Annot'
      const widget = subtype === 'Widget'
      const field = widget ? fieldOf(ref) : ref
      const ft = widget ? (readName(a.getInheritable('FT')) ?? '') : ''
      const signed = ft === 'Sig' && !isNull(field.resolve().get('V'))
      const n = num(ref)
      const parent = a.get('Parent')
      // A popup belongs to the annotation it pops up from.
      const owner = subtype === 'Popup' && parent.isIndirect() ? parent.asIndirect() : n
      const ownerType = owner !== n ? (readName(parent.resolve().get('Subtype')) ?? 'Annot') : subtype
      const info: AnnotRef = { owner, page: p, subtype: ownerType, widget, fieldName: widget ? fullName(field) : '', ft, signed }
      if (n > 0) idx.annots.set(n, info)
      if (n > 0) collectStreams(a.get('AP'), (s) => idx.ap.set(s, n))
      const popup = a.get('Popup')
      if (popup.isIndirect()) idx.annots.set(popup.asIndirect(), info)
    }
  }
  walkFields(pdf, (field, name, ft) => {
    let cur: PDFObject = field
    for (let d = 0; d < 32 && !isNull(cur); d++) {
      const n = num(cur)
      if (n > 0 && !idx.annots.has(n)) idx.fields.set(n, { name: d === 0 ? name : fullName(cur), ft: ft ?? '' })
      cur = cur.resolve().get('Parent')
    }
    if (ft === 'Sig') {
      const v = field.resolve().get('V')
      if (v.isIndirect()) idx.sigDicts.set(v.asIndirect(), name)
    }
  })
  const dss = root.get('DSS')
  if (!isNull(dss)) {
    if (dss.isIndirect()) idx.dss.add(dss.asIndirect())
    collectStreams(dss, (s) => idx.dss.add(s))
  }
  return idx
}

interface Found {
  category: ChangeCategory
  page?: number
  key: string
  added: boolean
  name?: string
  subtype?: string
}

export interface ChangeContext {
  /** Most restrictive DocMDP/lock permission in force for this signature, or null (approval). */
  permission: MdpPermission | null
  /** Fields locked by this signature's field lock ("*" for all). */
  lockedFields: string[] | '*' | null
}

/** Classifies the objects changed after a signature and says whether each change is allowed. */
export function describeChanges(pdf: PDFDocument, changed: Map<number, XrefEntryType>, oldSize: number, ctx: ChangeContext): ChangeEntry[] {
  const idx = buildIndex(pdf)
  const found: Found[] = []
  const touchedPages = new Set<number>()
  let removed = 0
  for (const [n, type] of changed) {
    const added = oldSize > 0 && n >= oldSize
    if (type === 'f') {
      if (!added) removed++
      continue
    }
    const sig = idx.sigDicts.get(n)
    if (sig !== undefined) {
      found.push({ category: 'signature', key: `sig:${sig}`, added, name: sig })
      continue
    }
    const owner = idx.annots.get(n) ?? (idx.ap.has(n) ? idx.annots.get(idx.ap.get(n)!) : undefined)
    if (owner) {
      // Popups and appearance streams belong to their annotation.
      const isAppearance = owner.owner !== n
      if (owner.widget) {
        if (owner.ft === 'Sig') found.push({ category: 'signature', key: `sig:${owner.fieldName}`, added: added && !isAppearance, name: owner.fieldName, page: owner.page })
        else found.push({ category: 'form', key: `form:${owner.fieldName}`, added: added && !isAppearance, name: owner.fieldName, page: owner.page })
      } else {
        found.push({ category: 'annotation', key: `annot:${owner.owner}`, added: added && !isAppearance, page: owner.page, subtype: owner.subtype })
      }
      continue
    }
    const field = idx.fields.get(n)
    if (field) {
      found.push({ category: field.ft === 'Sig' ? 'signature' : 'form', key: `${field.ft === 'Sig' ? 'sig' : 'form'}:${field.name}`, added, name: field.name })
      continue
    }
    const contentPage = idx.contents.get(n)
    if (contentPage !== undefined) {
      found.push({ category: 'content', key: `content:${contentPage}`, added, page: contentPage })
      continue
    }
    const page = idx.pages.get(n)
    if (page !== undefined) {
      touchedPages.add(page)
      continue
    }
    if (idx.pageTree.has(n)) {
      found.push({ category: 'pages', key: 'pages', added })
      continue
    }
    if (n === idx.info || n === idx.metadata) {
      found.push({ category: 'metadata', key: 'metadata', added })
      continue
    }
    if (idx.dss.has(n)) {
      found.push({ category: 'dss', key: 'dss', added })
      continue
    }
    // Catalog, AcroForm and unattached resources (fonts, images of new appearances) are side
    // effects of the changes above.
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
