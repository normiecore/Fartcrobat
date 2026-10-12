/**
 * FDF (Forms Data Format) comment export/import, engine side.
 *
 * Export writes the annotation dictionaries themselves (PDF syntax, user-space coordinates) into a
 * small "%FDF-1.2" file, renumbering every indirect object it needs (replies, file attachments,
 * image stamp appearances). Import opens the FDF with MuPDF and grafts the dictionaries into the
 * pages, so nothing is lost in translation.
 */
import { EngineError } from '@engine/define'
import type { PDFObject, Session } from '@engine/session'
import type { Rect } from '@shared/geometry'
import { normalizeRect, transformRect } from '@shared/geometry'
import { isNull, num, readName, readNumber, readRect, readString } from '@engine/util/pdf'
import { STANDARD_STAMPS, uniqueName } from './shared'

const NON_COMMENT = new Set(['Link', 'Widget', 'Popup'])
/** Keys that point back into the source document and must not be copied. */
const SKIP_KEYS = new Set(['P', 'Popup', 'Parent', 'StructParent', 'Page'])

const enc = new TextEncoder()

function escapeName(n: string): string {
  let out = ''
  for (const ch of n) {
    const c = ch.codePointAt(0)!
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) {
      for (const b of enc.encode(ch)) out += '#' + b.toString(16).padStart(2, '0')
    } else out += ch
  }
  return out
}

function encodeString(s: string): string {
  if (/^[\x20-\x7e\r\n\t]*$/.test(s)) {
    return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + ')'
  }
  let hex = 'FEFF'
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return '<' + hex + '>'
}

function hasImage(xobj: PDFObject, depth = 0): boolean {
  if (depth > 6 || isNull(xobj)) return false
  try {
    const x = xobj.resolve()
    if (readName(x.get('Subtype')) === 'Image') return true
    const res = x.get('Resources')
    if (isNull(res)) return false
    const xobjects = res.get('XObject')
    if (isNull(xobjects) || !xobjects.isDictionary()) return false
    let found = false
    xobjects.forEach((v) => {
      if (!found && hasImage(v, depth + 1)) found = true
    })
    return found
  } catch {
    return false
  }
}

/** True for stamps whose look cannot be rebuilt from the icon name alone (images, custom stamps). */
export function stampNeedsAppearance(dict: PDFObject): boolean {
  const name = readName(dict.get('Name')) ?? ''
  if (!STANDARD_STAMPS.has(name)) return true
  const ap = dict.get('AP')
  return !isNull(ap) && hasImage(ap.get('N'))
}

class FdfWriter {
  private parts: (string | Uint8Array)[] = []
  private numbers = new Map<number, number>()
  private queue: PDFObject[] = []
  private next = 2

  constructor(private readonly keepAppearance: (dict: PDFObject) => boolean) {}

  /** Assigns an FDF object number to an object the caller writes itself. */
  reserve(obj: PDFObject): number {
    const src = obj.asIndirect()
    let n = this.numbers.get(src)
    if (n === undefined) {
      n = this.next++
      this.numbers.set(src, n)
    }
    return n
  }

  /** Object number in the FDF for a source indirect object (queued for writing). */
  ref(obj: PDFObject): number {
    const src = obj.asIndirect()
    let n = this.numbers.get(src)
    if (n === undefined) {
      n = this.next++
      this.numbers.set(src, n)
      this.queue.push(obj)
    }
    return n
  }

  value(obj: PDFObject, depth = 0): string {
    if (depth > 32) return 'null'
    if (obj.isIndirect()) {
      const target = obj.resolve()
      if (isNull(target)) return 'null'
      return `${this.ref(obj)} 0 R`
    }
    if (obj.isNull()) return 'null'
    if (obj.isBoolean()) return obj.asBoolean() ? 'true' : 'false'
    if (obj.isInteger()) return String(Math.round(obj.asNumber()))
    if (obj.isNumber()) return num(obj.asNumber())
    if (obj.isName()) return '/' + escapeName(obj.asName())
    if (obj.isString()) return encodeString(obj.asString())
    if (obj.isArray()) {
      const items: string[] = []
      for (let i = 0; i < obj.length; i++) items.push(this.value(obj.get(i), depth + 1))
      return '[' + items.join(' ') + ']'
    }
    if (obj.isDictionary()) return this.dict(obj, depth)
    return 'null'
  }

  dict(obj: PDFObject, depth = 0, extra = ''): string {
    const isAnnot = !obj.isStream() && (readName(obj.get('Type')) === 'Annot' || !isNull(obj.get('Subtype')))
    let out = '<<'
    obj.forEach((v, k) => {
      const key = String(k)
      if (isAnnot && SKIP_KEYS.has(key)) return
      if (isAnnot && key === 'AP' && !this.keepAppearance(obj)) return
      if (key === 'Length' && obj.isStream()) return
      out += '/' + escapeName(key) + ' ' + this.value(v, depth + 1)
    })
    return out + extra + '>>'
  }

  writeObject(n: number, body: string | Uint8Array[]) {
    this.parts.push(`${n} 0 obj\n`)
    if (typeof body === 'string') this.parts.push(body)
    else this.parts.push(...body)
    this.parts.push('\nendobj\n')
  }

  /** Writes queued indirect objects (and whatever they reference). */
  flush() {
    while (this.queue.length) {
      const obj = this.queue.shift()!
      const n = this.numbers.get(obj.asIndirect())!
      const target = obj.resolve()
      if (target.isStream()) {
        let raw: Uint8Array
        try {
          raw = target.readRawStream().asUint8Array().slice()
        } catch {
          raw = new Uint8Array(0)
        }
        const dict = this.dict(target, 0, `/Length ${raw.length}`)
        this.writeObject(n, [enc.encode(dict + '\nstream\n'), raw, enc.encode('\nendstream')])
      } else {
        this.writeObject(n, this.value(target))
      }
    }
  }

  push(s: string) {
    this.parts.push(s)
  }

  bytes(): Uint8Array {
    const chunks = this.parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p))
    const len = chunks.reduce((a, c) => a + c.length, 0)
    const out = new Uint8Array(len)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }
}

/** Builds an FDF file with every comment of the document. Returns the bytes and the number of comments. */
export function buildFdf(s: Session, fileName: string): { bytes: Uint8Array; count: number } {
  const w = new FdfWriter((dict) => readName(dict.get('Subtype')) === 'Stamp' && stampNeedsAppearance(dict))
  w.push('%FDF-1.2\n%âãÏÓ\n')
  const annotRefs: string[] = []
  const bodies: { n: number; body: string }[] = []
  let count = 0
  const pages = s.pageCount()
  // First give every comment a number so replies can point at each other.
  const entries: { obj: PDFObject; page: number }[] = []
  for (let p = 0; p < pages; p++) {
    for (const a of s.page(p).getAnnotations()) {
      const obj = a.getObject()
      const type = readName(obj.get('Subtype')) ?? ''
      if (NON_COMMENT.has(type) || !obj.isIndirect()) continue
      entries.push({ obj, page: p })
    }
  }
  // Annotation dictionaries are written here (with their /Page index), not through the queue.
  const numbers = entries.map((e) => w.reserve(e.obj))
  entries.forEach((e, i) => {
    const dict = e.obj.resolve()
    const nm = isNull(dict.get('NM')) ? `/NM${encodeString(uniqueName())}` : ''
    bodies.push({ n: numbers[i], body: w.dict(dict, 0, `/Page ${e.page}${nm}`) })
    annotRefs.push(`${numbers[i]} 0 R`)
    if (isNull(dict.get('IRT'))) count++
  })
  const name = fileName.replace(/[\\/]/g, '_')
  w.writeObject(1, `<</FDF<</Annots[${annotRefs.join(' ')}]/F${encodeString(name)}>>>>`)
  for (const b of bodies) w.writeObject(b.n, b.body)
  w.flush()
  w.push('trailer\n<</Root 1 0 R>>\n%%EOF\n')
  return { bytes: w.bytes(), count }
}

export interface ImportSummary {
  imported: number
  duplicates: number
  skipped: number
  ids: number[]
}

/**
 * The comments already in the document, to avoid importing the same comment twice: either the
 * same /NM, or the same type, page, position, author and text (re-importing your own export, or
 * a file exported before names were assigned).
 */
export class ExistingComments {
  private byName = new Map<string, PDFObject>()
  private items: { obj: PDFObject; type: string; page: number; rect: Rect; author: string; contents: string }[] = []

  constructor(s: Session) {
    const n = s.pageCount()
    for (let p = 0; p < n; p++) {
      for (const a of s.page(p).getAnnotations()) {
        try {
          const obj = a.getObject()
          const type = a.getType()
          if (NON_COMMENT.has(type)) continue
          const nm = readString(obj.get('NM'))
          if (nm) this.byName.set(nm, obj)
          const rect = (a.hasRect() ? a.getRect() : a.getBounds()) as Rect
          const author = a.hasAuthor() ? a.getAuthor() : ''
          this.items.push({ obj, type, page: p, rect, author, contents: a.getContents().trim() })
        } catch {}
      }
    }
  }

  byNameOnly(name: string): PDFObject | null {
    return this.byName.get(name) ?? null
  }

  find(name: string | undefined, type: string, page: number, rect: Rect, author: string, contents: string): PDFObject | null {
    if (name && this.byName.has(name)) return this.byName.get(name)!
    const text = contents.trim()
    const near = (a: Rect, b: Rect) => a.every((v, i) => Math.abs(v - b[i]) <= 2.5)
    const hit = this.items.find((e) => e.type === type && e.page === page && e.author === author && e.contents === text && near(e.rect, rect))
    return hit?.obj ?? null
  }
}

/**
 * Grafts the annotations of an FDF file into the document (runs inside a mutation). Missing
 * appearance streams are generated afterwards.
 */
export function importFdfInto(s: Session, bytes: Uint8Array): ImportSummary {
  let fdf: InstanceType<Session['mupdf']['PDFDocument']>
  try {
    fdf = new s.mupdf.PDFDocument(bytes)
  } catch (err) {
    throw new EngineError(`This is not a valid FDF file (${(err as Error).message})`, 'BAD_FDF')
  }
  try {
    const annots = fdf.getTrailer().get('Root').get('FDF').get('Annots')
    if (isNull(annots) || !annots.isArray() || annots.length === 0) {
      throw new EngineError('The file does not contain any comments', 'NO_COMMENTS')
    }
    const existing = new ExistingComments(s)
    const map = s.pdf.newGraftMap()
    const created = new Map<number, PDFObject>()
    const pending: { src: PDFObject; dest: PDFObject; page: number }[] = []
    const summary: ImportSummary = { imported: 0, duplicates: 0, skipped: 0, ids: [] }
    const pageCount = s.pageCount()
    for (let i = 0; i < annots.length; i++) {
      const ref = annots.get(i)
      const src = ref.resolve()
      const type = readName(src.get('Subtype'))
      if (!src.isDictionary() || !type || NON_COMMENT.has(type)) {
        summary.skipped++
        continue
      }
      const page = Math.round(readNumber(src.get('Page'), 0))
      if (page < 0 || page >= pageCount) {
        summary.skipped++
        continue
      }
      const userRect = readRect(src.get('Rect'), [0, 0, 0, 0])
      const pageRect = normalizeRect(transformRect(userRect, s.userToPage(page)))
      const dup = existing.find(
        readString(src.get('NM')) || undefined,
        type,
        page,
        pageRect,
        readString(src.get('T')),
        readString(src.get('Contents'))
      )
      if (dup) {
        summary.duplicates++
        if (ref.isIndirect()) created.set(ref.asIndirect(), dup)
        continue
      }
      const copy = s.pdf.newDictionary()
      src.forEach((v, k) => {
        const key = String(k)
        if (SKIP_KEYS.has(key) || key === 'IRT') return
        copy.put(key, map.graftObject(v))
      })
      if (isNull(copy.get('NM'))) copy.put('NM', s.pdf.newString(uniqueName()))
      const dest = s.pdf.addObject(copy)
      if (ref.isIndirect()) created.set(ref.asIndirect(), dest)
      pending.push({ src, dest, page })
    }
    const touched = new Set<number>()
    for (const { src, dest, page } of pending) {
      const irt = src.get('IRT')
      if (!isNull(irt) && irt.isIndirect()) {
        const parent = created.get(irt.asIndirect())
        if (parent) dest.put('IRT', parent)
      }
      const pageObj = s.pdf.findPage(page)
      dest.put('P', pageObj)
      let arr = pageObj.get('Annots')
      if (isNull(arr) || !arr.isArray()) {
        pageObj.put('Annots', s.pdf.newArray())
        arr = pageObj.get('Annots')
      }
      arr.push(dest)
      touched.add(page)
    }
    if (!pending.length) return summary
    s.invalidatePages()
    const wanted = new Set(pending.map((p) => p.dest.asIndirect()))
    for (const p of touched) {
      for (const a of s.page(p).getAnnotations()) {
        const obj = a.getObject()
        if (!wanted.has(obj.asIndirect())) continue
        try {
          // Replies are shown in pop-ups and the Comments list, not as icons on the page.
          if (a.getType() === 'Text' && !isNull(obj.get('IRT'))) a.setFlags(a.getFlags() | 2)
          if (isNull(obj.get('AP'))) a.setColor(a.getColor())
          a.update()
        } catch {}
        summary.imported++
        summary.ids.push(obj.asIndirect())
      }
      s.touch(p)
    }
    s.documentChanged()
    return summary
  } finally {
    fdf.destroy()
  }
}
