/**
 * Copies pages between PDF documents *with* their comments, links, form fields and bookmarks.
 *
 * MuPDF's graftPage copies only the page content (it drops /Annots), which would silently lose
 * comments and links on Insert, Extract, Combine and Duplicate. This module grafts the page content
 * and then rebuilds the annotations: markup annotations are deep-copied (with references to other
 * pages removed), links are recreated through MuPDF's link API with their targets remapped to the
 * copied pages, and form fields keep their hierarchy (root fields are added to the destination's
 * AcroForm, renamed when the name is already taken).
 */
import type { PDFDocument, PDFObject, PDFPage } from '@engine/session'
import { isNull, readName, readString } from '@engine/util/pdf'

/** Page dictionary keys that make up the page's appearance (used by Replace Pages). */
export const CONTENT_KEYS = [
  'Contents',
  'Resources',
  'MediaBox',
  'CropBox',
  'BleedBox',
  'TrimBox',
  'ArtBox',
  'Rotate',
  'UserUnit',
  'Group'
]

export interface CopyOptions {
  /** Insert position in the destination; -1 (default) or >= page count appends. */
  at?: number
  /** Copy comments and other markup (default true). */
  annotations?: boolean
  /** Recreate links (default true). */
  links?: boolean
  /** Copy form fields (default true). */
  fields?: boolean
  /**
   * Destination page index for a link that targets source page `p`. Defaults to the copy of that
   * page, or null (the link is dropped) when that page is not copied.
   */
  mapTarget?: (p: number) => number | null
  /** Loads a source page (lets the engine reuse its cached pages). */
  loadSourcePage?: (index: number) => PDFPage
  /** Called when a page from loadSourcePage is no longer needed. */
  releaseSourcePage?: (page: PDFPage) => void
}

export interface CopyResult {
  /** Destination index of each copied page, in order. */
  indices: number[]
  /** Source page index -> destination index. */
  pageMap: Map<number, number>
}

interface Fixup {
  ref: PDFObject
  key: string
  srcNum: number
}

function typeOf(obj: PDFObject): string | null {
  try {
    return readName(obj.get('Type'))
  } catch {
    return null
  }
}

/** True for a signature field that already holds a signature (copies would be invalid). */
function isSignedSignature(obj: PDFObject): boolean {
  try {
    return readName(obj.getInheritable('FT')) === 'Sig' && !isNull(obj.getInheritable('V'))
  } catch {
    return false
  }
}

/** Copies objects from `src` into `dst`, never dragging in other pages or the page tree. */
export class ObjectCopier {
  readonly map
  /** Source page object number -> destination page reference. */
  readonly pages = new Map<number, PDFObject>()
  private memo = new Map<number, PDFObject>()
  private annotMap = new Map<number, PDFObject>()
  private fieldMap = new Map<number, PDFObject>()
  private fixups: Fixup[] = []
  private rootNames: Set<string> | null = null

  constructor(
    readonly dst: PDFDocument,
    readonly src: PDFDocument
  ) {
    this.map = dst.newGraftMap()
  }

  /** Deep copy of a value. Page references map to copied pages (or are dropped). */
  copy(v: PDFObject): PDFObject | null {
    if (v.isIndirect()) {
      const num = v.asIndirect()
      const known = this.memo.get(num)
      if (known) return known
      const r = v.resolve()
      if (r.isNull()) return null
      if (r.isDictionary()) {
        const t = typeOf(r)
        if (t === 'Page') return this.pages.get(num) ?? null
        if (t === 'Pages' || t === 'Catalog') return null
      }
      if (r.isStream()) {
        const g = this.map.graftObject(v)
        this.memo.set(num, g)
        return g
      }
      if (r.isDictionary() || r.isArray()) {
        const ref = this.dst.createObject()
        this.memo.set(num, ref)
        ref.writeObject(r.isDictionary() ? this.copyDict(r) : this.copyArray(r))
        return ref
      }
      return this.map.graftObject(r)
    }
    if (v.isDictionary()) return this.copyDict(v)
    if (v.isArray()) return this.copyArray(v)
    if (v.isNull()) return null
    return this.map.graftObject(v)
  }

  private copyDict(d: PDFObject, skip?: Set<string>): PDFObject {
    const out = this.dst.newDictionary()
    d.forEach((val, key) => {
      const k = String(key)
      if (skip?.has(k)) return
      const c = this.copy(val)
      if (c) out.put(k, c)
    })
    return out
  }

  private copyArray(a: PDFObject): PDFObject {
    const out = this.dst.newArray()
    a.forEach((val) => {
      out.push(this.copy(val) ?? this.dst.newNull())
    })
    return out
  }

  /** Copies one annotation dictionary onto `dstPage`. Relations to other annotations are fixed later. */
  copyAnnotation(ref: PDFObject, dstPage: PDFObject): PDFObject {
    const a = ref.resolve()
    const relations: { key: string; num: number }[] = []
    const d = this.dst.newDictionary()
    a.forEach((val, key) => {
      const k = String(key)
      if (k === 'P' || k === 'StructParent') return
      if (k === 'Popup' || k === 'IRT' || k === 'Parent') {
        if (val.isIndirect()) relations.push({ key: k, num: val.asIndirect() })
        return
      }
      const c = this.copy(val)
      if (c) d.put(k, c)
    })
    d.put('P', dstPage)
    const newRef = this.dst.addObject(d)
    if (ref.isIndirect()) this.annotMap.set(ref.asIndirect(), newRef)
    for (const r of relations) this.fixups.push({ ref: newRef, key: r.key, srcNum: r.num })
    return newRef
  }

  /** Copies a form widget with its field hierarchy. */
  copyWidget(ref: PDFObject, dstPage: PDFObject): PDFObject {
    const w = ref.resolve()
    const signed = isSignedSignature(w)
    const skip = new Set(['P', 'StructParent', 'Parent', 'Popup', 'IRT'])
    if (signed) {
      // A copied signature would no longer match its signed bytes: keep an empty signature field.
      skip.add('V')
      skip.add('AP')
      skip.add('Lock')
    }
    const d = this.copyDict(w, skip)
    d.put('P', dstPage)
    const newRef = this.dst.addObject(d)
    if (ref.isIndirect()) this.annotMap.set(ref.asIndirect(), newRef)
    const parent = w.get('Parent')
    const np = !isNull(parent) && parent.isIndirect() ? this.copyField(parent) : null
    if (np) {
      newRef.put('Parent', np)
      np.get('Kids').push(newRef)
    } else this.addRootField(newRef)
    return newRef
  }

  private copyField(ref: PDFObject): PDFObject | null {
    const num = ref.asIndirect()
    const known = this.fieldMap.get(num)
    if (known) return known
    const f = ref.resolve()
    if (!f.isDictionary()) return null
    const skip = new Set(['Kids', 'Parent', 'P'])
    if (isSignedSignature(f)) skip.add('V')
    const d = this.copyDict(f, skip)
    d.put('Kids', this.dst.newArray())
    const newRef = this.dst.addObject(d)
    this.fieldMap.set(num, newRef)
    const parent = f.get('Parent')
    const np = !isNull(parent) && parent.isIndirect() ? this.copyField(parent) : null
    if (np) {
      newRef.put('Parent', np)
      np.get('Kids').push(newRef)
    } else this.addRootField(newRef)
    return newRef
  }

  private acroForm(): PDFObject {
    const root = this.dst.getTrailer().get('Root')
    let af = root.get('AcroForm')
    if (isNull(af)) {
      af = this.dst.addObject(this.dst.newDictionary())
      root.put('AcroForm', af)
    }
    if (!af.get('Fields').isArray()) af.put('Fields', this.dst.newArray())
    const srcAf = this.src.getTrailer().get('Root').get('AcroForm')
    if (!isNull(srcAf)) {
      for (const key of ['DA', 'Q']) {
        if (isNull(af.get(key)) && !isNull(srcAf.get(key))) {
          const c = this.copy(srcAf.get(key))
          if (c) af.put(key, c)
        }
      }
      const srcDr = srcAf.get('DR')
      if (!isNull(srcDr)) {
        if (isNull(af.get('DR'))) {
          const c = this.copy(srcDr)
          if (c) af.put('DR', c)
        } else {
          const dr = af.get('DR')
          const srcFonts = srcDr.get('Font')
          if (!isNull(srcFonts)) {
            if (isNull(dr.get('Font'))) dr.put('Font', this.dst.newDictionary())
            const fonts = dr.get('Font')
            srcFonts.forEach((val, key) => {
              const k = String(key)
              if (isNull(fonts.get(k))) {
                const c = this.copy(val)
                if (c) fonts.put(k, c)
              }
            })
          }
        }
      }
      try {
        if (srcAf.get('NeedAppearances').asBoolean()) af.put('NeedAppearances', true)
      } catch {}
    }
    return af
  }

  private addRootField(ref: PDFObject) {
    const af = this.acroForm()
    const fields = af.get('Fields')
    if (!this.rootNames) {
      this.rootNames = new Set()
      for (let i = 0; i < fields.length; i++) {
        const n = readString(fields.get(i).get('T'))
        if (n) this.rootNames.add(n)
      }
    }
    let name = readString(ref.get('T'))
    if (name) {
      if (this.rootNames.has(name)) {
        let k = 2
        while (this.rootNames.has(`${name}_${k}`)) k++
        name = `${name}_${k}`
        ref.put('T', this.dst.newString(name))
      }
      this.rootNames.add(name)
    }
    fields.push(ref)
  }

  /** Copies the annotations of a source page onto a destination page (appending to its /Annots). */
  copyAnnotations(srcPageIndex: number, dstPage: PDFObject, opts: { annotations: boolean; fields: boolean }) {
    const annots = this.src.findPage(srcPageIndex).get('Annots')
    if (isNull(annots) || !annots.isArray()) return
    let arr = dstPage.get('Annots')
    const created = isNull(arr) || !arr.isArray()
    if (created) arr = this.dst.newArray()
    let added = 0
    for (let i = 0; i < annots.length; i++) {
      const ref = annots.get(i)
      const a = ref.resolve()
      if (!a.isDictionary()) continue
      const subtype = readName(a.get('Subtype'))
      if (subtype === 'Link') continue
      if (subtype === 'Widget') {
        if (!opts.fields) continue
        arr.push(this.copyWidget(ref, dstPage))
        added++
        continue
      }
      if (!opts.annotations) continue
      arr.push(this.copyAnnotation(ref, dstPage))
      added++
    }
    if (created && added) dstPage.put('Annots', arr)
  }

  /** Connects popups and replies with their parents once every annotation has been copied. */
  finish() {
    for (const f of this.fixups) {
      const target = this.annotMap.get(f.srcNum)
      if (target) f.ref.put(f.key, target)
    }
    this.fixups = []
  }
}

/** Rewrites an internal link URI ("#page=3&view=Fit", named destinations...) for the destination. */
export function remapUri(
  src: PDFDocument,
  dst: PDFDocument,
  uri: string,
  mapTarget: (p: number) => number | null
): string | null {
  if (!uri) return null
  if (!uri.startsWith('#')) return uri
  const m = /^#page=(\d+)(.*)$/.exec(uri)
  if (m) {
    const target = mapTarget(parseInt(m[1], 10) - 1)
    return target === null ? null : `#page=${target + 1}${m[2]}`
  }
  try {
    const d = src.resolveLinkDestination(uri)
    if (!d || d.page < 0) return null
    const target = mapTarget(d.page)
    return target === null ? null : dst.formatLinkURI({ ...d, chapter: 0, page: target })
  } catch {
    return null
  }
}

function isExternalUri(uri: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(uri)
}

/** Recreates the links of a source page on a destination page. */
export function copyLinks(
  src: PDFDocument,
  dst: PDFDocument,
  srcPage: PDFPage,
  dstPage: PDFPage,
  mapTarget: (p: number) => number | null
): number {
  let n = 0
  for (const link of srcPage.getLinks()) {
    const uri = link.getURI()
    const mapped = link.isExternal() || isExternalUri(uri) ? uri : remapUri(src, dst, uri, mapTarget)
    if (!mapped) continue
    dstPage.createLink(link.getBounds(), mapped)
    n++
  }
  return n
}

/** Copies pages from `src` into `dst` with annotations, links and form fields. */
export function copyPages(
  dst: PDFDocument,
  src: PDFDocument,
  pages: number[],
  opts: CopyOptions = {}
): CopyResult {
  const count0 = dst.countPages()
  const at = opts.at === undefined || opts.at < 0 || opts.at >= count0 ? count0 : opts.at
  const copier = new ObjectCopier(dst, src)
  const indices: number[] = []
  const pageMap = new Map<number, number>()
  const unique = pages.filter((p, i) => pages.indexOf(p) === i)
  unique.forEach((p, k) => {
    const to = at + k
    copier.map.graftPage(to >= dst.countPages() ? -1 : to, src, p)
    indices.push(to)
    pageMap.set(p, to)
  })
  unique.forEach((p, k) => copier.pages.set(src.findPage(p).asIndirect(), dst.findPage(indices[k])))
  const annotations = opts.annotations !== false
  const fields = opts.fields !== false
  if (annotations || fields) {
    unique.forEach((p, k) => copier.copyAnnotations(p, dst.findPage(indices[k]), { annotations, fields }))
    copier.finish()
  }
  if (opts.links !== false) {
    const mapTarget = opts.mapTarget ?? ((p: number) => pageMap.get(p) ?? null)
    unique.forEach((p, k) => {
      const sp = opts.loadSourcePage ? opts.loadSourcePage(p) : src.loadPage(p)
      try {
        if (!sp.getLinks().length) return
        const dp = dst.loadPage(indices[k])
        try {
          copyLinks(src, dst, sp, dp, mapTarget)
        } finally {
          dp.destroy()
        }
      } finally {
        if (opts.loadSourcePage) opts.releaseSourcePage?.(sp)
        else sp.destroy()
      }
    })
  }
  return { indices, pageMap }
}

// ---- bookmarks ------------------------------------------------------------------------------

export interface OutlineEntry {
  title: string
  /** Link URI ("#page=N...") or external URL; undefined for a bookmark without destination. */
  uri?: string
  open: boolean
  children: OutlineEntry[]
}

interface MuOutlineItem {
  title?: string
  uri?: string
  open: boolean
  down?: MuOutlineItem[]
}

/**
 * The source's bookmarks with their destinations remapped. Bookmarks that point at pages that were
 * not copied are dropped unless one of their children survives (then they keep no destination).
 */
export function remapOutline(
  src: PDFDocument,
  dst: PDFDocument,
  mapTarget: (p: number) => number | null
): OutlineEntry[] {
  let items: MuOutlineItem[] = []
  try {
    items = (src.loadOutline() as MuOutlineItem[] | null) ?? []
  } catch {
    return []
  }
  const convert = (it: MuOutlineItem, depth: number): OutlineEntry | null => {
    const children =
      depth < 32
        ? (it.down ?? []).map((c) => convert(c, depth + 1)).filter((c): c is OutlineEntry => !!c)
        : []
    let uri: string | undefined
    if (it.uri) uri = isExternalUri(it.uri) ? it.uri : (remapUri(src, dst, it.uri, mapTarget) ?? undefined)
    if (!uri && !children.length) return null
    return { title: it.title ?? '', uri, open: !!it.open, children }
  }
  return items.map((i) => convert(i, 0)).filter((c): c is OutlineEntry => !!c)
}

/** Appends bookmarks at the end of the document's top-level bookmarks. */
export function appendOutline(doc: PDFDocument, entries: OutlineEntry[]) {
  if (!entries.length) return
  const it = doc.outlineIterator()
  try {
    let guard = 0
    while (it.item() && guard++ < 1_000_000) {
      if (it.next() !== 0) break
    }
    const write = (list: OutlineEntry[]) => {
      for (const e of list) {
        it.insert({ title: e.title, uri: e.uri, open: e.open })
        if (e.children.length) {
          it.prev()
          it.down()
          write(e.children)
          it.up()
          it.next()
        }
      }
    }
    write(entries)
  } finally {
    it.destroy()
  }
}
