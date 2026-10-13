/**
 * Link annotations: reading, creating, editing and deleting them with full control over the
 * action (web page, page view, file) and the appearance (border, colour, highlight style).
 *
 * Link annotations are edited at the PDF object level. MuPDF keeps a per-page list of links that it
 * builds when a page is loaded, so after every change the session's cached pages are dropped.
 */
import type { Matrix, Point, Rect } from '@shared/geometry'
import { hexToRgb, invertMatrix, rectIntersection, transformPoint, transformRect } from '@shared/geometry'
import { EngineError } from '@engine/define'
import type { PDFObject, Session } from '@engine/session'
import { extractPageText } from '@engine/ops/text'
import { pathToFileSpec } from './filespec'

export type LinkAction =
  | { type: 'uri'; uri: string }
  /** Go to a page view. x/y are page-space coordinates of the target page (null keeps the current). */
  | { type: 'page'; page: number; x: number | null; y: number | null; zoom: number | null; fit: 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitB' | 'FitR' }
  | { type: 'file'; path: string }
  | { type: 'named'; name: string }
  | { type: 'other'; description: string }

export type LinkLineStyle = 'solid' | 'dashed' | 'underline'
export type LinkHighlight = 'none' | 'invert' | 'outline' | 'push'

export interface LinkAppearance {
  /** Visible rectangle (border width > 0) or invisible. */
  visible: boolean
  /** Border thickness in points (Acrobat: thin 1, medium 2, thick 3). */
  width: number
  style: LinkLineStyle
  /** #rrggbb */
  color: string
  highlight: LinkHighlight
}

export interface LinkItem {
  /** PDF object number of the annotation (negative for direct objects). */
  id: number
  page: number
  /** Page space. */
  rect: Rect
  action: LinkAction
  appearance: LinkAppearance
  /** Short description of the target for tooltips and lists. */
  target: string
}

export interface LinkSpec {
  action: LinkAction
  appearance: LinkAppearance
}

export const DEFAULT_APPEARANCE: LinkAppearance = {
  visible: false,
  width: 1,
  style: 'solid',
  color: '#000000',
  highlight: 'invert'
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function isNullObj(o: PDFObject | null | undefined): boolean {
  if (!o) return true
  return safe(() => o.isNull(), true)
}

function str(o: PDFObject | null | undefined): string {
  if (isNullObj(o)) return ''
  const r = o!.resolve()
  if (r.isString()) return r.asString()
  if (r.isName()) return r.asName()
  return ''
}

function nameOf(o: PDFObject | null | undefined): string | null {
  if (isNullObj(o)) return null
  const r = o!.resolve()
  return r.isName() ? r.asName() : null
}

function numberAt(a: PDFObject, i: number): number | null {
  if (i >= a.length) return null
  const v = a.get(i).resolve()
  return v.isNumber() ? v.asNumber() : null
}

const H_NAMES: Record<string, LinkHighlight> = { N: 'none', I: 'invert', O: 'outline', P: 'push' }
const H_CODES: Record<LinkHighlight, string> = { none: 'N', invert: 'I', outline: 'O', push: 'P' }

function colorToHex(a: PDFObject | null): string | null {
  if (isNullObj(a)) return null
  const arr = a!.resolve()
  if (!arr.isArray() || arr.length === 0) return null
  const c: number[] = []
  for (let i = 0; i < arr.length; i++) c.push(safe(() => arr.get(i).asNumber(), 0))
  let rgb: number[]
  if (c.length === 1) rgb = [c[0], c[0], c[0]]
  else if (c.length >= 4) rgb = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]
  else rgb = c
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')
}

function readAppearance(d: PDFObject): LinkAppearance {
  let width = 1
  let style: LinkLineStyle = 'solid'
  const bs = safe(() => d.get('BS'), null)
  const border = safe(() => d.get('Border'), null)
  const color = colorToHex(safe(() => d.get('C'), null))
  let explicit = false
  if (!isNullObj(bs)) {
    const b = bs!.resolve()
    const w = safe(() => b.get('W'), null)
    if (!isNullObj(w)) width = safe(() => w!.resolve().asNumber(), 1)
    const s = nameOf(safe(() => b.get('S'), null))
    style = s === 'D' ? 'dashed' : s === 'U' ? 'underline' : 'solid'
    explicit = true
  } else if (!isNullObj(border)) {
    const b = border!.resolve()
    if (b.isArray() && b.length >= 3) {
      width = numberAt(b, 2) ?? 1
      if (b.length >= 4 && b.get(3).resolve().isArray() && b.get(3).resolve().length > 0) style = 'dashed'
      explicit = true
    }
  }
  // Without /BS or /Border the PDF default is a 1pt border; only show it when a colour is given.
  const visible = width > 0 && (explicit || color !== null)
  const h = nameOf(safe(() => d.get('H'), null))
  return {
    visible,
    width: width > 0 ? width : 1,
    style,
    color: color ?? '#000000',
    highlight: h && H_NAMES[h] ? H_NAMES[h] : 'invert'
  }
}

function readFileSpec(o: PDFObject | null): string {
  if (isNullObj(o)) return ''
  const f = o!.resolve()
  if (f.isString()) return f.asString()
  if (f.isDictionary()) {
    const uf = str(safe(() => f.get('UF'), null))
    const ff = str(safe(() => f.get('F'), null))
    return uf || ff || str(safe(() => f.get('Unix'), null)) || str(safe(() => f.get('DOS'), null))
  }
  return ''
}

interface MuLinkInfo {
  rect: Rect
  uri: string
  external: boolean
  dest: { page: number; x: number | null; y: number | null; zoom: number | null; type: string } | null
}

function mupdfLinks(s: Session, page: number): MuLinkInfo[] {
  return safe(
    () =>
      s.page(page).getLinks().map((l) => {
        const uri = safe(() => l.getURI() ?? '', '')
        const external = safe(() => l.isExternal(), false)
        let dest: MuLinkInfo['dest'] = null
        if (!external) {
          dest = safe(() => {
            const d = s.pdf.resolveLinkDestination(l)
            if (!d || d.page < 0) return null
            const v = (n: number) => (Number.isFinite(n) ? n : null)
            return { page: d.page, x: v(d.x), y: v(d.y), zoom: v(d.zoom) || null, type: d.type }
          }, null)
        }
        return { rect: l.getBounds() as Rect, uri, external, dest }
      }),
    []
  )
}

function closeRect(a: Rect, b: Rect, tol = 0.6): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol)
}

function readAction(s: Session, d: PDFObject, rect: Rect, mu: MuLinkInfo[], used: Set<number>): LinkAction {
  const matchMu = () => {
    const k = mu.findIndex((l, i) => !used.has(i) && closeRect(l.rect, rect))
    if (k >= 0) used.add(k)
    return k >= 0 ? mu[k] : null
  }
  const pageAction = (): LinkAction | null => {
    const l = matchMu()
    if (l?.dest) {
      const fit = (['XYZ', 'Fit', 'FitH', 'FitV', 'FitB', 'FitR'].includes(l.dest.type) ? l.dest.type : 'XYZ') as 'XYZ'
      return { type: 'page', page: l.dest.page, x: l.dest.x, y: l.dest.y, zoom: l.dest.zoom, fit }
    }
    return null
  }
  const a = safe(() => d.get('A'), null)
  if (isNullObj(a)) {
    if (!isNullObj(safe(() => d.get('Dest'), null))) return pageAction() ?? { type: 'other', description: 'Go to a page view' }
    matchMu()
    return { type: 'other', description: 'No action' }
  }
  const act = a!.resolve()
  const sName = nameOf(safe(() => act.get('S'), null))
  switch (sName) {
    case 'URI':
      matchMu()
      return { type: 'uri', uri: str(safe(() => act.get('URI'), null)) }
    case 'GoTo':
      return pageAction() ?? { type: 'other', description: 'Go to a page view' }
    case 'Launch':
    case 'GoToR': {
      matchMu()
      let f = safe(() => act.get('F'), null)
      if (isNullObj(f)) {
        const win = safe(() => act.get('Win'), null)
        if (!isNullObj(win)) f = safe(() => win!.resolve().get('F'), null)
      }
      const path = readFileSpec(f)
      return path ? { type: 'file', path } : { type: 'other', description: sName === 'Launch' ? 'Launch' : 'Open a file' }
    }
    case 'Named':
      matchMu()
      return { type: 'named', name: nameOf(safe(() => act.get('N'), null)) ?? '' }
    default:
      matchMu()
      return { type: 'other', description: sName ?? 'Unknown action' }
  }
}

export function describeAction(a: LinkAction): string {
  switch (a.type) {
    case 'uri':
      return a.uri.startsWith('mailto:') ? `Send e-mail to ${a.uri.slice(7)}` : a.uri
    case 'page':
      return `Go to page ${a.page + 1}`
    case 'file':
      return `Open ${a.path}`
    case 'named':
      return a.name.replace(/([a-z])([A-Z])/g, '$1 $2')
    default:
      return a.description
  }
}

function annotsArray(s: Session, page: number): PDFObject | null {
  const a = safe(() => s.page(page).getObject().get('Annots'), null)
  if (isNullObj(a)) return null
  const r = a!.resolve()
  return r.isArray() ? r : null
}

function isLink(o: PDFObject): boolean {
  return safe(() => o.resolve().get('Subtype').asName() === 'Link', false)
}

function annotId(o: PDFObject, index: number): number {
  return safe(() => (o.isIndirect() ? o.asIndirect() : 0), 0) || -(index + 1)
}

function rectToPage(s: Session, page: number, d: PDFObject): Rect {
  const r = safe(() => d.get('Rect').resolve(), null)
  if (!r || !r.isArray() || r.length < 4) return [0, 0, 0, 0]
  const v = [0, 1, 2, 3].map((i) => safe(() => r.get(i).asNumber(), 0))
  return transformRect([Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])], s.userToPage(page))
}

export function listLinks(s: Session, page: number): LinkItem[] {
  const annots = annotsArray(s, page)
  if (!annots) return []
  const mu = mupdfLinks(s, page)
  const used = new Set<number>()
  const out: LinkItem[] = []
  for (let i = 0; i < annots.length; i++) {
    const ref = annots.get(i)
    if (!isLink(ref)) continue
    const d = ref.resolve()
    const rect = rectToPage(s, page, d)
    const action = readAction(s, d, rect, mu, used)
    out.push({ id: annotId(ref, i), page, rect, action, appearance: readAppearance(d), target: describeAction(action) })
  }
  return out
}

function findLink(s: Session, page: number, id: number): { annots: PDFObject; index: number; dict: PDFObject } {
  const annots = annotsArray(s, page)
  if (annots) {
    for (let i = 0; i < annots.length; i++) {
      const ref = annots.get(i)
      if (isLink(ref) && annotId(ref, i) === id) return { annots, index: i, dict: ref.resolve() }
    }
  }
  throw new EngineError('The link could not be found. The page may have changed.', 'NO_LINK')
}

function numArray(s: Session, values: number[]): PDFObject {
  const a = s.pdf.newArray()
  for (const v of values) a.push(Math.round(v * 1000) / 1000)
  return a
}

function userRect(s: Session, page: number, rect: Rect): PDFObject {
  const r = transformRect(rect, invertMatrix(s.userToPage(page)))
  return numArray(s, r)
}

/** ASCII-only URI as required by the URI action (non-ASCII characters are percent-encoded). */
export function normalizeUri(uri: string): string {
  const t = uri.trim()
  return t.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c))
}

function buildAction(s: Session, action: LinkAction): PDFObject | null {
  const pdf = s.pdf
  const a = pdf.newDictionary()
  switch (action.type) {
    case 'uri': {
      const uri = normalizeUri(action.uri)
      if (!uri) throw new EngineError('Enter a web address for the link', 'BAD_LINK')
      a.put('S', pdf.newName('URI'))
      a.put('URI', pdf.newString(uri))
      return a
    }
    case 'page': {
      const n = s.pageCount()
      if (!Number.isInteger(action.page) || action.page < 0 || action.page >= n)
        throw new EngineError(`Choose a page between 1 and ${n}`, 'BAD_LINK')
      const m: Matrix = invertMatrix(s.userToPage(action.page))
      const d = pdf.newArray()
      d.push(pdf.findPage(action.page))
      const fit = action.fit ?? 'XYZ'
      d.push(pdf.newName(fit === 'FitR' ? 'XYZ' : fit))
      if (fit === 'XYZ' || fit === 'FitR') {
        const p: Point = transformPoint([action.x ?? 0, action.y ?? 0], m)
        d.push(action.x === null ? pdf.newNull() : Math.round(p[0] * 100) / 100)
        d.push(action.y === null ? pdf.newNull() : Math.round(p[1] * 100) / 100)
        d.push(action.zoom ? Math.round(action.zoom * 100) / 10000 : pdf.newNull())
      } else if (fit === 'FitH') {
        const p = transformPoint([0, action.y ?? 0], m)
        d.push(action.y === null ? pdf.newNull() : Math.round(p[1] * 100) / 100)
      } else if (fit === 'FitV') {
        const p = transformPoint([action.x ?? 0, 0], m)
        d.push(action.x === null ? pdf.newNull() : Math.round(p[0] * 100) / 100)
      }
      a.put('S', pdf.newName('GoTo'))
      a.put('D', d)
      return a
    }
    case 'file': {
      const path = action.path.trim()
      if (!path) throw new EngineError('Choose a file for the link', 'BAD_LINK')
      const fs = pdf.newDictionary()
      fs.put('Type', pdf.newName('Filespec'))
      fs.put('F', pdf.newString(pathToFileSpec(path)))
      fs.put('UF', pdf.newString(pathToFileSpec(path)))
      const isPdf = /\.pdf$/i.test(path)
      a.put('S', pdf.newName(isPdf ? 'GoToR' : 'Launch'))
      a.put('F', fs)
      if (isPdf) {
        const d = pdf.newArray()
        d.push(0)
        d.push(pdf.newName('Fit'))
        a.put('D', d)
      }
      a.put('NewWindow', pdf.newBoolean(true))
      return a
    }
    case 'named': {
      a.put('S', pdf.newName('Named'))
      a.put('N', pdf.newName(action.name))
      return a
    }
    default:
      return null
  }
}

function applyAppearance(s: Session, d: PDFObject, ap: LinkAppearance) {
  const pdf = s.pdf
  const w = ap.visible ? Math.max(0.5, Math.min(12, ap.width)) : 0
  const bs = pdf.newDictionary()
  bs.put('Type', pdf.newName('Border'))
  bs.put('W', w)
  bs.put('S', pdf.newName(ap.style === 'dashed' ? 'D' : ap.style === 'underline' ? 'U' : 'S'))
  if (ap.style === 'dashed') bs.put('D', numArray(s, [3, 2]))
  d.put('BS', bs)
  const border = numArray(s, [0, 0, w])
  if (ap.style === 'dashed' && w > 0) border.push(numArray(s, [3, 2]))
  d.put('Border', border)
  d.put('C', numArray(s, hexToRgb(ap.color || '#000000')))
  d.put('H', pdf.newName(H_CODES[ap.highlight] ?? 'I'))
  // Our own appearance description supersedes any stale appearance stream.
  if (!isNullObj(safe(() => d.get('AP'), null))) d.delete('AP')
}

function afterLinkChange(s: Session, page: number) {
  // MuPDF builds its link list when a page is loaded: drop cached pages so it is rebuilt.
  s.invalidatePages()
  s.touch(page)
}

export function createLink(s: Session, page: number, rect: Rect, spec: LinkSpec): LinkItem {
  const r = normalize(rect)
  if (r[2] - r[0] < 1 || r[3] - r[1] < 1) throw new EngineError('The link area is too small', 'BAD_LINK')
  const pdf = s.pdf
  const d = pdf.newDictionary()
  d.put('Type', pdf.newName('Annot'))
  d.put('Subtype', pdf.newName('Link'))
  d.put('Rect', userRect(s, page, r))
  const action = buildAction(s, spec.action)
  if (action) d.put('A', action)
  applyAppearance(s, d, spec.appearance)
  d.put('P', pdf.findPage(page))
  const ref = pdf.addObject(d)
  const pageObj = s.page(page).getObject()
  let annots = safe(() => pageObj.get('Annots'), null)
  if (isNullObj(annots) || !annots!.resolve().isArray()) {
    pageObj.put('Annots', pdf.newArray())
    annots = pageObj.get('Annots')
  }
  annots!.resolve().push(ref)
  const id = ref.asIndirect()
  afterLinkChange(s, page)
  const made = listLinks(s, page).find((l) => l.id === id)
  if (!made) throw new EngineError('The link could not be created', 'BAD_LINK')
  return made
}

export function updateLink(s: Session, page: number, id: number, patch: Partial<LinkSpec> & { rect?: Rect }): LinkItem {
  const { dict } = findLink(s, page, id)
  if (patch.rect) {
    const r = normalize(patch.rect)
    if (r[2] - r[0] < 1 || r[3] - r[1] < 1) throw new EngineError('The link area is too small', 'BAD_LINK')
    dict.put('Rect', userRect(s, page, r))
    if (!isNullObj(safe(() => dict.get('QuadPoints'), null))) dict.delete('QuadPoints')
  }
  if (patch.action && patch.action.type !== 'other') {
    const a = buildAction(s, patch.action)
    if (a) {
      dict.put('A', a)
      if (!isNullObj(safe(() => dict.get('Dest'), null))) dict.delete('Dest')
    }
  }
  if (patch.appearance) applyAppearance(s, dict, patch.appearance)
  afterLinkChange(s, page)
  const updated = listLinks(s, page).find((l) => l.id === id)
  if (!updated) throw new EngineError('The link could not be updated', 'BAD_LINK')
  return updated
}

export function deleteLinks(s: Session, page: number, ids: number[]) {
  const annots = annotsArray(s, page)
  if (!annots) return
  const targets = new Set(ids)
  for (let i = annots.length - 1; i >= 0; i--) {
    const ref = annots.get(i)
    if (isLink(ref) && targets.has(annotId(ref, i))) annots.delete(i)
  }
  afterLinkChange(s, page)
}

/** Removes every link on the given pages. Returns how many were removed. */
export function removeAllLinks(s: Session, pages: number[]): number {
  let count = 0
  for (const p of pages) {
    const annots = annotsArray(s, p)
    if (!annots) continue
    let changed = false
    for (let i = annots.length - 1; i >= 0; i--) {
      if (isLink(annots.get(i))) {
        annots.delete(i)
        count++
        changed = true
      }
    }
    if (changed) s.touch(p)
  }
  if (count) s.invalidatePages()
  return count
}

function normalize(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

// ---- web addresses in page text ------------------------------------------------------------

export interface FoundUrl {
  page: number
  text: string
  uri: string
  rect: Rect
}

const URL_RE = /\b(?:(?:https?|ftp):\/\/|www\.)[^\s<>"{}|\\^`[\]]+/gi
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g

function trimUrl(u: string): string {
  let t = u
  for (;;) {
    const last = t[t.length - 1]
    if (!last) break
    if (/[.,;:!?'"*]/.test(last)) t = t.slice(0, -1)
    else if (last === ')' && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, -1)
    else if (last === ']' || last === '}' || last === '>') t = t.slice(0, -1)
    else break
  }
  return t
}

/** Finds web addresses and e-mail addresses in the text of a page. */
export function findUrls(s: Session, page: number): FoundUrl[] {
  const t = extractPageText(s, page, 'preserve-whitespace')
  const out: FoundUrl[] = []
  const taken: [number, number][] = []
  const rectOf = (start: number, end: number): Rect | null => {
    let r: Rect | null = null
    for (let i = start; i < end; i++) {
      const k = i * 8
      const xs = [t.quads[k], t.quads[k + 2], t.quads[k + 4], t.quads[k + 6]]
      const ys = [t.quads[k + 1], t.quads[k + 3], t.quads[k + 5], t.quads[k + 7]]
      const c: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      r = r ? [Math.min(r[0], c[0]), Math.min(r[1], c[1]), Math.max(r[2], c[2]), Math.max(r[3], c[3])] : c
    }
    return r
  }
  const push = (start: number, text: string, uri: string) => {
    const end = start + text.length
    const rect = rectOf(start, end)
    if (!rect || rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) return
    taken.push([start, end])
    out.push({ page, text, uri, rect })
  }
  for (const m of t.text.matchAll(URL_RE)) {
    const text = trimUrl(m[0])
    if (text.length < 5 || /^www\.$/i.test(text)) continue
    push(m.index!, text, /^www\./i.test(text) ? `http://${text}` : text)
  }
  for (const m of t.text.matchAll(EMAIL_RE)) {
    const start = m.index!
    const end = start + m[0].length
    if (taken.some(([a, b]) => start < b && end > a)) continue
    push(start, m[0], `mailto:${m[0]}`)
  }
  return out.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
}

function overlapRatio(a: Rect, b: Rect): number {
  const i = rectIntersection(a, b)
  if (!i) return 0
  const ai = (i[2] - i[0]) * (i[3] - i[1])
  const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
  return small > 0 ? ai / small : 0
}

/** Web addresses that are not covered by a link yet. */
export function unlinkedUrls(s: Session, pages: number[]): FoundUrl[] {
  const out: FoundUrl[] = []
  for (const p of pages) {
    const existing = listLinks(s, p).map((l) => l.rect)
    for (const u of findUrls(s, p)) if (!existing.some((r) => overlapRatio(r, u.rect) > 0.5)) out.push(u)
  }
  return out
}

/** Creates invisible links for every web address and e-mail address not linked yet. */
export function createLinksFromUrls(s: Session, pages: number[]): number {
  const found = unlinkedUrls(s, pages)
  if (!found.length) throw new EngineError('No web addresses without links were found.', 'NO_CHANGE')
  const pdf = s.pdf
  const byPage = new Map<number, FoundUrl[]>()
  for (const f of found) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f])
  for (const [p, list] of byPage) {
    const pageObj = s.page(p).getObject()
    let annots = safe(() => pageObj.get('Annots'), null)
    if (isNullObj(annots) || !annots!.resolve().isArray()) {
      pageObj.put('Annots', pdf.newArray())
      annots = pageObj.get('Annots')
    }
    const arr = annots!.resolve()
    for (const f of list) {
      const d = pdf.newDictionary()
      d.put('Type', pdf.newName('Annot'))
      d.put('Subtype', pdf.newName('Link'))
      d.put('Rect', userRect(s, p, [f.rect[0] - 0.5, f.rect[1] - 0.5, f.rect[2] + 0.5, f.rect[3] + 0.5]))
      d.put('A', buildAction(s, { type: 'uri', uri: f.uri })!)
      applyAppearance(s, d, DEFAULT_APPEARANCE)
      d.put('P', pdf.findPage(p))
      arr.push(pdf.addObject(d))
    }
    s.touch(p)
  }
  s.invalidatePages()
  return found.length
}
