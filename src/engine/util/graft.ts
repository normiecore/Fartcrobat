// Copying pages between documents (or within one) together with their annotations, links and
// form fields. MuPDF's graftPage copies only the page content and boxes; everything that points
// at other pages (annotations' /P, link destinations, form field trees) needs the care below.
import type * as MuPDF from 'mupdf'
import type { PDFDocument, PDFObject } from '../session'
import { catalog, isNull, readName, readString } from './pdf'

type GraftMap = MuPDF.PDFGraftMap

/** Page dictionary entries copied to the new page (inheritable ones are resolved first). */
const PAGE_KEYS = [
  'Contents',
  'Resources',
  'MediaBox',
  'CropBox',
  'BleedBox',
  'TrimBox',
  'ArtBox',
  'Rotate',
  'UserUnit'
]
const INHERITABLE = new Set(['Resources', 'MediaBox', 'CropBox', 'Rotate'])
/** Further page entries that only describe the page itself (transparency group, tab order...). */
const PAGE_EXTRA_KEYS = ['Group', 'Tabs', 'Trans', 'Dur', 'PZ', 'VP']
/** Field dictionary entries; on a merged field/widget dictionary they belong to the field. */
const FIELD_KEYS = new Set([
  'FT',
  'T',
  'TU',
  'TM',
  'Ff',
  'V',
  'DV',
  'Opt',
  'TI',
  'I',
  'MaxLen',
  'Lock',
  'SV',
  'Kids',
  'Parent'
])

function num(obj: PDFObject): number {
  return obj.isIndirect() ? obj.asIndirect() : 0
}

/**
 * Copies pages from `src` into `dst` (they may be the same document) starting at `at`
 * (-1 = append). Annotations come along: their /P points at the new page, popups and replies
 * stay connected, links to copied pages follow the copy, links to pages that are not copied
 * stay on the original page (same document) or are dropped (another document). Form fields are
 * recreated in the destination /AcroForm; a field whose name is already taken there is renamed
 * ("Name" -> "Name_2"), so copies never share values with existing fields by accident. Copied
 * signature fields come out unsigned: a signature cannot be valid in another file.
 * Returns the new page objects.
 */
export function copyPages(dst: PDFDocument, src: PDFDocument, pages: number[], at: number): PDFObject[] {
  return new PageCopier(dst, src).run(pages, at)
}

class PageCopier {
  private readonly sameDoc: boolean
  private readonly map: GraftMap
  /** src page object number -> new page (last copy when a page is copied twice). */
  private readonly pageMap = new Map<number, PDFObject>()
  private readonly srcPageNums = new Set<number>()
  /** src annotation object number -> new annotation, for the page being copied. */
  private annotMap = new Map<number, PDFObject>()
  /** src field object number -> new field node (shared by every copied page). */
  private readonly fieldMap = new Map<number, PDFObject>()
  /** Whether a src object (by number) references pages, annotations or fields, directly or not. */
  private readonly structural = new Map<number, boolean>()
  /** Hand-made copies of objects that lead to pages (see copy()). */
  private readonly manual = new Map<number, PDFObject>()
  private dstFields: PDFObject | null = null
  private readonly usedRootNames = new Set<string>()
  private namedDests: Record<string, PDFObject> | null = null

  constructor(
    private readonly dst: PDFDocument,
    private readonly src: PDFDocument
  ) {
    this.sameDoc = dst.pointer === src.pointer
    this.map = dst.newGraftMap()
  }

  run(pages: number[], at: number): PDFObject[] {
    const src = this.src
    const n = src.countPages()
    for (let i = 0; i < n; i++) this.srcPageNums.add(src.findPage(i).asIndirect())
    const srcPages = pages.map((p) => src.findPage(p))
    const seen = new Set<number>()
    const out: PDFObject[] = []
    // Pages first, so links between copied pages can point at the copies.
    let pos = at
    for (const sp of srcPages) {
      const page = this.copyPageDict(sp)
      this.dst.insertPage(pos, page)
      if (pos >= 0) pos++
      this.pageMap.set(num(sp), page)
      out.push(page)
    }
    srcPages.forEach((sp, k) => {
      // A page copied twice in one go gets its own annotation copies each time.
      this.annotMap = new Map()
      const map = seen.has(num(sp)) ? this.dst.newGraftMap() : this.map
      seen.add(num(sp))
      this.copyAnnotations(sp, out[k], map)
    })
    return out
  }

  private copyPageDict(srcPage: PDFObject): PDFObject {
    const dst = this.dst
    const page = dst.newDictionary()
    page.put('Type', dst.newName('Page'))
    for (const key of [...PAGE_KEYS, ...PAGE_EXTRA_KEYS]) {
      const v = INHERITABLE.has(key) ? srcPage.getInheritable(key) : srcPage.get(key)
      if (!isNull(v)) page.put(key, this.copy(v, this.map))
    }
    return dst.addObject(page)
  }

  // ---- annotations ------------------------------------------------------------------------

  private copyAnnotations(srcPage: PDFObject, dstPage: PDFObject, map: GraftMap) {
    const annots = srcPage.get('Annots')
    if (isNull(annots) || !annots.resolve().isArray()) return
    const list = annots.resolve()
    const entries: { src: PDFObject; dst: PDFObject }[] = []
    // Placeholders first, so popups, replies and links can refer to annotations copied later.
    for (let i = 0; i < list.length; i++) {
      const ref = list.get(i)
      const dict = ref.resolve()
      if (!dict.isDictionary()) continue
      const placeholder = this.dst.addObject(this.dst.newDictionary())
      if (num(ref)) this.annotMap.set(num(ref), placeholder)
      entries.push({ src: dict, dst: placeholder })
    }
    const kept = this.dst.newArray()
    for (const e of entries) {
      if (this.fillAnnotation(e.src, e.dst, dstPage, map)) kept.push(e.dst)
      else this.dst.deleteObject(e.dst)
    }
    if (kept.length) dstPage.put('Annots', kept)
  }

  /** Copies one annotation dictionary. Returns false when it should be left out. */
  private fillAnnotation(a: PDFObject, out: PDFObject, dstPage: PDFObject, map: GraftMap): boolean {
    const subtype = readName(a.get('Subtype'))
    const isWidget = subtype === 'Widget'
    let ok = true
    a.forEach((v, key) => {
      const k = String(key)
      if (!ok) return
      switch (k) {
        case 'P':
          out.put('P', dstPage)
          return
        case 'StructParent':
          return
        case 'Popup':
        case 'IRT': {
          const target = this.annotMap.get(num(v))
          if (target) out.put(k, target)
          return
        }
        case 'Parent':
          if (!isWidget) {
            const target = this.annotMap.get(num(v))
            if (target) out.put(k, target)
          }
          return
        case 'Dest': {
          const d = this.copyDest(v, map)
          if (d) out.put(k, d)
          else if (subtype === 'Link') ok = false
          return
        }
        case 'A': {
          const action = this.copyAction(v, map)
          if (action) out.put(k, action)
          else if (subtype === 'Link') ok = false
          return
        }
      }
      if (isWidget && FIELD_KEYS.has(k)) return // handled with the field below
      out.put(k, this.copy(v, map))
    })
    if (!ok) return false
    if (isWidget) this.attachWidget(a, out, map)
    return true
  }

  // ---- links ------------------------------------------------------------------------------

  /** Copies a destination. Null when it points at a page of another document that is not copied. */
  private copyDest(dest: PDFObject, map: GraftMap): PDFObject | null {
    let d = dest.resolve()
    if (d.isString() || d.isName()) {
      // Named destination: it still resolves in the same document; elsewhere use its target.
      if (this.sameDoc) return this.copy(dest, map)
      const target = this.resolveNamedDest(d.isString() ? d.asString() : d.asName())
      if (!target) return null
      d = target
    }
    if (d.isDictionary()) d = d.get('D').resolve() // old-style named destination dictionary
    if (!d.isArray() || d.length === 0) return this.copy(dest, map)
    const page = d.get(0)
    if (page.isIndirect()) {
      const mapped = this.pageMap.get(page.asIndirect())
      if (!mapped && !this.sameDoc && this.srcPageNums.has(page.asIndirect())) return null
    }
    return this.copy(d, map)
  }

  private resolveNamedDest(name: string): PDFObject | null {
    if (!this.namedDests) {
      this.namedDests = {}
      try {
        Object.assign(this.namedDests, this.src.loadNameTree('Dests'))
      } catch {}
      try {
        const old = catalog(this.src).get('Dests')
        if (!isNull(old)) old.resolve().forEach((v, k) => (this.namedDests![String(k)] ??= v))
      } catch {}
    }
    const target = this.namedDests[name]
    return target && !isNull(target) ? target.resolve() : null
  }

  private copyAction(action: PDFObject, map: GraftMap): PDFObject | null {
    const a = action.resolve()
    if (!a.isDictionary() || readName(a.get('S')) !== 'GoTo') return this.copy(action, map)
    const dest = this.copyDest(a.get('D'), map)
    if (!dest) return null
    const out = this.dst.newDictionary()
    a.forEach((v, key) => {
      const k = String(key)
      if (k === 'D') out.put('D', dest)
      else out.put(k, this.copy(v, map))
    })
    return out
  }

  // ---- form fields ------------------------------------------------------------------------

  private attachWidget(w: PDFObject, out: PDFObject, map: GraftMap) {
    const merged = !isNull(w.get('T'))
    if (merged) {
      // The widget is also its (terminal) field: copy the field entries onto it.
      this.copyFieldEntries(w, out, map)
      this.linkField(w, out, map)
    } else {
      const parent = w.get('Parent')
      if (isNull(parent)) {
        // A widget without a field: keep it as a field of its own if it has a type.
        if (isNull(w.get('FT'))) return
        this.copyFieldEntries(w, out, map)
        this.addRootField(out, null)
        return
      }
      const field = this.fieldNode(parent, map)
      out.put('Parent', field)
      field.get('Kids').push(out)
    }
    if (readName(w.getInheritable('FT')) === 'Sig') {
      // An unsigned copy: drop the signature appearance as well as the value.
      out.delete('AP')
      out.delete('AS')
    }
  }

  /** The copy of a field node, created (with its ancestors) on first use. */
  private fieldNode(srcRef: PDFObject, map: GraftMap): PDFObject {
    const existing = this.fieldMap.get(num(srcRef))
    if (existing) return existing
    const f = srcRef.resolve()
    const node = this.dst.addObject(this.dst.newDictionary())
    if (num(srcRef)) this.fieldMap.set(num(srcRef), node)
    this.copyFieldEntries(f, node, map)
    node.put('Kids', this.dst.newArray())
    this.linkField(f, node, map)
    return node
  }

  /** Puts `node` under the copy of src's parent field, or at the top of /AcroForm/Fields. */
  private linkField(src: PDFObject, node: PDFObject, map: GraftMap) {
    const parent = src.get('Parent')
    if (isNull(parent)) {
      this.addRootField(node, readString(src.get('T')))
      return
    }
    const p = this.fieldNode(parent, map)
    node.put('Parent', p)
    p.get('Kids').push(node)
  }

  private copyFieldEntries(src: PDFObject, out: PDFObject, map: GraftMap) {
    const isSig = readName(src.getInheritable('FT')) === 'Sig'
    src.forEach((v, key) => {
      const k = String(key)
      if (!FIELD_KEYS.has(k) || k === 'Kids' || k === 'Parent') return
      if (isSig && k === 'V') return
      out.put(k, this.copy(v, map))
    })
  }

  private addRootField(node: PDFObject, name: string | null) {
    const fields = this.acroFormFields()
    if (name) {
      let unique = name
      for (let k = 2; this.usedRootNames.has(unique); k++) unique = `${name}_${k}`
      if (unique !== name) node.put('T', this.dst.newString(unique))
      this.usedRootNames.add(unique)
    }
    fields.push(node)
  }

  /** /AcroForm/Fields of the destination, creating /AcroForm and merging the source's defaults. */
  private acroFormFields(): PDFObject {
    if (this.dstFields) return this.dstFields
    const dst = this.dst
    const root = catalog(dst)
    let acro = root.get('AcroForm')
    if (isNull(acro)) {
      root.put('AcroForm', dst.newDictionary())
      acro = root.get('AcroForm')
    }
    acro = acro.resolve()
    let fields = acro.get('Fields')
    if (isNull(fields) || !fields.resolve().isArray()) {
      acro.put('Fields', dst.newArray())
      fields = acro.get('Fields')
    }
    fields = fields.resolve()
    for (let i = 0; i < fields.length; i++) {
      const t = readString(fields.get(i).resolve().get('T'))
      if (t) this.usedRootNames.add(t)
    }
    if (!this.sameDoc) {
      const srcAcro = catalog(this.src).get('AcroForm')
      if (!isNull(srcAcro)) {
        const sa = srcAcro.resolve()
        for (const k of ['DA', 'Q']) {
          if (isNull(acro.get(k)) && !isNull(sa.get(k))) acro.put(k, this.copy(sa.get(k), this.map))
        }
        if (sa.get('NeedAppearances').valueOf() === true) acro.put('NeedAppearances', true)
        this.mergeResources(acro, sa.get('DR'))
      }
    }
    this.dstFields = fields
    return fields
  }

  /** Adds the source's default resources (fonts used by field appearances) that dst lacks. */
  private mergeResources(acro: PDFObject, srcDR: PDFObject) {
    if (isNull(srcDR)) return
    let dr = acro.get('DR')
    if (isNull(dr)) {
      acro.put('DR', this.copy(srcDR, this.map))
      return
    }
    dr = dr.resolve()
    srcDR.resolve().forEach((category, key) => {
      const k = String(key)
      const mine = dr.get(k)
      if (isNull(mine)) {
        dr.put(k, this.copy(category, this.map))
        return
      }
      const target = mine.resolve()
      if (!target.isDictionary() || !category.resolve().isDictionary()) return
      category.resolve().forEach((v, name) => {
        if (isNull(target.get(String(name)))) target.put(String(name), this.copy(v, this.map))
      })
    })
  }

  // ---- generic copying --------------------------------------------------------------------

  /**
   * Copies a value into dst. Subtrees that reference no pages, annotations or fields go through
   * MuPDF's graft map (shared objects are copied once). References to pages and annotations are
   * remapped to their copies; references to things that are not copied keep pointing at the
   * original in the same document and become null in another document, so a copy never drags
   * the source page tree along.
   */
  private copy(v: PDFObject, map: GraftMap): PDFObject {
    if (v.isIndirect()) {
      const n = v.asIndirect()
      const mapped = this.pageMap.get(n) ?? this.annotMap.get(n) ?? this.fieldMap.get(n)
      if (mapped) return mapped
      if (!this.isStructural(v)) return map.graftObject(v)
      const d = v.resolve()
      if (this.isStructuralNode(d)) return this.sameDoc ? v : this.dst.newNull()
      if (d.isStream()) return map.graftObject(v)
      // An ordinary object that leads to pages (e.g. a shared action): copy it by hand, once.
      const done = this.manual.get(n)
      if (done) return done
      const out = this.dst.addObject(d.isArray() ? this.dst.newArray() : this.dst.newDictionary())
      this.manual.set(n, out)
      if (d.isArray()) d.forEach((item) => out.push(this.copy(item, map)))
      else d.forEach((item, key) => out.put(String(key), this.copy(item, map)))
      return out
    }
    if ((v.isArray() || v.isDictionary()) && this.containsStructure(v)) return this.copyContainer(v, map)
    return map.graftObject(v)
  }

  private copyContainer(v: PDFObject, map: GraftMap): PDFObject {
    if (v.isArray()) {
      const a = this.dst.newArray()
      v.forEach((item) => a.push(this.copy(item, map)))
      return a
    }
    const d = this.dst.newDictionary()
    v.forEach((item, key) => d.put(String(key), this.copy(item, map)))
    return d
  }

  /** Pages, page tree nodes, annotations and fields: never copied wholesale. */
  private isStructuralNode(d: PDFObject): boolean {
    if (!d.isDictionary()) return false
    const type = readName(d.get('Type'))
    if (type === 'Page' || type === 'Pages' || type === 'Annot') return true
    return !isNull(d.get('P')) || !isNull(d.get('Parent')) || !isNull(d.get('Kids')) || !isNull(d.get('FT'))
  }

  /** Whether an indirect object is, or leads to, a page, annotation or field. */
  private isStructural(ref: PDFObject): boolean {
    const n = ref.asIndirect()
    if (this.srcPageNums.has(n)) return true
    const known = this.structural.get(n)
    if (known !== undefined) return known
    this.structural.set(n, false) // cycles
    const d = ref.resolve()
    const result = this.isStructuralNode(d) || this.containsStructure(d)
    this.structural.set(n, result)
    return result
  }

  private containsStructure(v: PDFObject, depth = 0): boolean {
    if (depth > 64) return false
    let found = false
    const visit = (item: PDFObject) => {
      if (found) return
      if (item.isIndirect()) found = this.isStructural(item)
      else if (item.isArray() || item.isDictionary()) found = this.containsStructure(item, depth + 1)
    }
    if (v.isArray() || v.isDictionary()) v.forEach(visit)
    return found
  }
}

// ---- removing pages ---------------------------------------------------------------------------

/**
 * Detaches the form fields whose widgets sit on `page` (about to be deleted) from the field tree:
 * widgets leave their parent's /Kids, and fields left without widgets leave /AcroForm/Fields
 * and /CO. Without this, deleted pages leave ghost fields (and ghost signatures) behind.
 */
export function removePageFields(doc: PDFDocument, page: PDFObject) {
  const annots = page.get('Annots')
  if (isNull(annots)) return
  const list = annots.resolve()
  if (!list.isArray()) return
  const acro = catalog(doc).get('AcroForm')
  if (isNull(acro)) return
  for (let i = 0; i < list.length; i++) {
    const w = list.get(i)
    if (readName(w.resolve().get('Subtype')) !== 'Widget') continue
    detachNode(doc, acro.resolve(), w)
  }
}

function removeFromArray(arr: PDFObject, target: PDFObject): boolean {
  if (isNull(arr)) return false
  const a = arr.resolve()
  if (!a.isArray()) return false
  const n = num(target)
  let removed = false
  for (let i = a.length - 1; i >= 0; i--) {
    const item = a.get(i)
    if (n ? num(item) === n : item.resolve().pointer === target.resolve().pointer) {
      a.delete(i)
      removed = true
    }
  }
  return removed
}

function detachNode(doc: PDFDocument, acro: PDFObject, node: PDFObject) {
  const parent = node.resolve().get('Parent')
  if (isNull(parent)) {
    removeFromArray(acro.get('Fields'), node)
    removeFromArray(acro.get('CO'), node)
    return
  }
  const kids = parent.resolve().get('Kids')
  removeFromArray(kids, node)
  if (isNull(kids) || kids.resolve().length === 0) detachNode(doc, acro, parent)
}
