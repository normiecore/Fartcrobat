import type { Point } from '@shared/geometry'
import { hexToRgb, rgbToHex, transformPoint, transformRect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { PDFObject, Session } from '@engine/session'
import docOps from '@engine/ops/doc'
import {
  catalog,
  isNull,
  pageRotation,
  pdfDate,
  readName,
  readNumber,
  readRect,
  readString
} from '@engine/util/pdf'
import type {
  AnnotationFileInfo,
  AttachmentList,
  Bookmark,
  BookmarkDest,
  BookmarkStyle,
  BookmarkTarget,
  DocumentPropertiesData,
  EmbeddedFileInfo,
  FontInfo,
  InitialLayout,
  InitialMagnification,
  InitialView,
  LayerInfo,
  NavigationTab,
  PropertiesPatch
} from './types'

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function objNum(o: PDFObject): number {
  return safe(() => (o.isIndirect() ? o.asIndirect() : 0), 0)
}

// ==== bookmarks (document outline) ===================================================================
//
// The outline is edited with low-level objects so every change is an ordinary journalled object edit
// (undoable) and the /Parent, /Prev, /Next, /First, /Last and /Count entries always stay consistent.

const FLAG_ITALIC = 1
const FLAG_BOLD = 2

function outlineRoot(s: Session): PDFObject | null {
  const o = catalog(s.pdf).get('Outlines')
  return isNull(o) || !o.resolve().isDictionary() ? null : o
}

/** The /Outlines dictionary as an indirect object, created when missing. */
function ensureOutlineRoot(s: Session): PDFObject {
  const cat = catalog(s.pdf)
  let o = cat.get('Outlines')
  if (isNull(o) || !o.resolve().isDictionary()) {
    const d = s.pdf.newDictionary()
    d.put('Type', s.pdf.newName('Outlines'))
    o = s.pdf.addObject(d)
    cat.put('Outlines', o)
  } else if (!o.isIndirect()) {
    o = s.pdf.addObject(o)
    cat.put('Outlines', o)
  }
  return o
}

/** Children of an outline node in order (cycle-safe). */
function childrenOf(node: PDFObject, visited = new Set<number>()): PDFObject[] {
  const out: PDFObject[] = []
  let cur = node.get('First')
  let guard = 0
  while (!isNull(cur) && guard++ < 100000) {
    const n = objNum(cur)
    if (n) {
      if (visited.has(n)) break
      visited.add(n)
    }
    if (!cur.resolve().isDictionary()) break
    out.push(cur)
    cur = cur.get('Next')
  }
  return out
}

interface Located {
  node: PDFObject
  parent: PDFObject
}

function indexOutline(root: PDFObject): Map<number, Located> {
  const map = new Map<number, Located>()
  const visited = new Set<number>()
  const walk = (parent: PDFObject, depth: number) => {
    if (depth > 64) return
    for (const kid of childrenOf(parent, visited)) {
      const n = objNum(kid)
      if (n) map.set(n, { node: kid, parent })
      walk(kid, depth + 1)
    }
  }
  walk(root, 0)
  return map
}

function requireBookmark(root: PDFObject, id: number): Located {
  const found = indexOutline(root).get(id)
  if (!found) throw new EngineError('This bookmark no longer exists', 'NO_BOOKMARK')
  return found
}

/** Rewrites the sibling chain of `parent` to exactly `items`. */
function writeChildren(s: Session, parent: PDFObject, items: PDFObject[]) {
  const list = items.map((it) => (it.isIndirect() ? it : s.pdf.addObject(it)))
  list.forEach((it, i) => {
    it.put('Parent', parent)
    if (i > 0) it.put('Prev', list[i - 1])
    else it.delete('Prev')
    if (i < list.length - 1) it.put('Next', list[i + 1])
    else it.delete('Next')
  })
  if (list.length) {
    parent.put('First', list[0])
    parent.put('Last', list[list.length - 1])
  } else {
    parent.delete('First')
    parent.delete('Last')
  }
}

/** Recomputes every /Count (positive when open, negative when closed, absent without children). */
function recount(root: PDFObject) {
  const visited = new Set<number>()
  // Returns the number of descendants visible when `node` is open.
  const visit = (node: PDFObject, depth: number): number => {
    const kids = depth > 64 ? [] : childrenOf(node, visited)
    let visible = 0
    for (const kid of kids) {
      const kidVisible = visit(kid, depth + 1)
      const hasKids = !isNull(kid.get('First'))
      const count = readNumber(kid.get('Count'), 0)
      const open = hasKids && count >= 0
      visible += 1 + (open ? kidVisible : 0)
    }
    if (depth === 0) return visible
    if (!kids.length) node.delete('Count')
    else {
      const prev = readNumber(node.get('Count'), 0)
      node.put('Count', prev < 0 ? -visible : visible)
    }
    return visible
  }
  const total = visit(root, 0)
  if (total > 0) root.put('Count', total)
  else root.delete('Count')
}

/** True when `nodeId` is `ancestorId` or nested (at any depth) under it. */
function isInside(root: PDFObject, ancestorId: number, nodeId: number): boolean {
  const index = indexOutline(root)
  let cur = nodeId
  for (let guard = 0; guard < 1000; guard++) {
    if (cur === ancestorId) return true
    const loc = index.get(cur)
    if (!loc) return false
    cur = objNum(loc.parent)
    if (!cur) return false
  }
  return false
}

function resolveUri(
  s: Session,
  uri: string | undefined | null
): { dest: BookmarkDest | null; uri: string | null } {
  if (!uri) return { dest: null, uri: null }
  if (!uri.startsWith('#')) return { dest: null, uri }
  try {
    const d = s.pdf.resolveLinkDestination(uri)
    if (!d || d.page < 0) return { dest: null, uri: null }
    const valid = (v: number) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const zoom = valid(d.zoom)
    return {
      dest: {
        page: d.page,
        x: valid(d.x),
        y: valid(d.y),
        zoom: d.type === 'XYZ' && zoom && zoom > 0 ? zoom / 100 : null,
        type: d.type
      },
      uri: null
    }
  } catch {
    return { dest: null, uri: null }
  }
}

function readColor(item: PDFObject): string | null {
  const c = item.get('C')
  if (isNull(c) || !c.isArray() || c.length < 3) return null
  const rgb = [readNumber(c.get(0)), readNumber(c.get(1)), readNumber(c.get(2))]
  if (rgb.every((v) => v === 0)) return null
  return rgbToHex(rgb)
}

interface MuOutlineItem {
  title?: string
  uri?: string
  open?: boolean
  down?: MuOutlineItem[]
}

/** Page object number -> page index. */
function pageIndexMap(s: Session): Map<number, number> {
  const map = new Map<number, number>()
  const n = s.pageCount()
  for (let i = 0; i < n; i++) {
    const id = safe(() => s.pageId(i), 0)
    if (id) map.set(id, i)
  }
  return map
}

/** Named destinations from the catalog's /Dests dictionary and the /Names /Dests name tree. */
function namedDestinations(s: Session): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>()
  const cat = catalog(s.pdf)
  safe(() => {
    const dests = cat.get('Dests')
    if (!isNull(dests) && dests.resolve().isDictionary()) dests.forEach((v, k) => out.set(String(k), v))
  }, undefined)
  const visited = new Set<number>()
  const walk = (node: PDFObject, depth: number) => {
    if (depth > 32 || isNull(node)) return
    const n = objNum(node)
    if (n) {
      if (visited.has(n)) return
      visited.add(n)
    }
    const names = node.get('Names')
    if (!isNull(names) && names.isArray()) {
      for (let i = 0; i + 1 < names.length; i += 2) {
        const key = names.get(i)
        const name = key.isString() ? key.asString() : key.isName() ? key.asName() : null
        if (name !== null && !out.has(name)) out.set(name, names.get(i + 1))
      }
    }
    const kids = node.get('Kids')
    if (!isNull(kids) && kids.isArray()) for (let i = 0; i < kids.length; i++) walk(kids.get(i), depth + 1)
  }
  safe(() => walk(cat.get('Names').get('Dests'), 0), undefined)
  return out
}

/**
 * True when a bookmark's destination names a page object that is no longer in the document (its
 * page was deleted). MuPDF resolves such destinations to the first page, which would send the
 * reader to the wrong place.
 */
function pointsAtMissingPage(
  item: PDFObject,
  pages: Map<number, number>,
  named: () => Map<string, PDFObject>
): boolean {
  return safe(() => {
    let d = item.get('Dest')
    if (isNull(d)) {
      const a = item.get('A')
      if (isNull(a) || readName(a.get('S')) !== 'GoTo') return false
      d = a.get('D')
    }
    let o = d.resolve()
    if (o.isString() || o.isName()) {
      const target = named().get(o.isString() ? o.asString() : o.asName())
      if (!target) return false
      o = target.resolve()
    }
    if (o.isDictionary()) o = o.get('D').resolve()
    if (!o.isArray() || o.length < 1) return false
    const first = o.get(0)
    return first.isIndirect() && !pages.has(first.asIndirect())
  }, false)
}

function readOutline(s: Session): Bookmark[] {
  const root = outlineRoot(s)
  if (!root) return []
  const pages = pageIndexMap(s)
  let namedCache: Map<string, PDFObject> | null = null
  const named = () => (namedCache ??= namedDestinations(s))
  // MuPDF resolves destinations (explicit, named, GoTo actions) for us; its outline follows the same
  // /First → /Next order as our walk, so the two trees are zipped by position.
  const mu = safe(() => (s.pdf.loadOutline() ?? []) as MuOutlineItem[], [])
  const visited = new Set<number>()
  let synthetic = 0
  const walk = (node: PDFObject, muKids: MuOutlineItem[], depth: number): Bookmark[] => {
    if (depth > 64) return []
    return childrenOf(node, visited).map((item, k) => {
      const m = muKids[k]
      const broken = pointsAtMissingPage(item, pages, named)
      const { dest, uri } = broken ? { dest: null, uri: null } : resolveUri(s, m?.uri)
      const flags = readNumber(item.get('F'), 0)
      const hasKids = !isNull(item.get('First'))
      return {
        id: objNum(item) || --synthetic,
        title: readString(item.get('Title')),
        dest,
        uri,
        broken,
        open: hasKids && readNumber(item.get('Count'), 0) > 0,
        bold: (flags & FLAG_BOLD) !== 0,
        italic: (flags & FLAG_ITALIC) !== 0,
        color: readColor(item),
        children: walk(item, m?.down ?? [], depth + 1)
      }
    })
  }
  return walk(root, mu, 0)
}

/** An explicit /XYZ destination array for a page-space target. */
function makeDest(s: Session, t: BookmarkTarget): PDFObject {
  const count = s.pageCount()
  if (!Number.isInteger(t.page) || t.page < 0 || t.page >= count) {
    throw new EngineError(`Page ${t.page + 1} does not exist`, 'BAD_PAGE')
  }
  const arr = s.pdf.newArray()
  arr.push(s.pdf.findPage(t.page))
  arr.push(s.pdf.newName('XYZ'))
  let left: number | null = null
  let top: number | null = null
  if (t.x !== null || t.y !== null) {
    const rotation = pageRotation(readNumber(s.pdf.findPage(t.page).getInheritable('Rotate'), 0))
    const p = transformPoint([t.x ?? 0, t.y ?? 0] as Point, s.pageToUser(t.page))
    if (rotation === 0) {
      left = t.x === null ? null : p[0]
      top = t.y === null ? null : p[1]
    } else {
      left = p[0]
      top = p[1]
    }
  }
  const round = (v: number) => Math.round(v * 100) / 100
  arr.push(left === null ? s.pdf.newNull() : round(left))
  arr.push(top === null ? s.pdf.newNull() : round(top))
  arr.push(t.zoom && t.zoom > 0 ? round(t.zoom) : s.pdf.newNull())
  return arr
}

function cleanTitle(title: string): string {
  const t = title.replace(/[\r\n\t]+/g, ' ').trim()
  return t || 'Untitled'
}

// ==== attachments ====================================================================================

function isoDate(d: Date | undefined | null): string {
  if (!d || !(d instanceof Date)) return ''
  const t = d.getTime()
  return Number.isFinite(t) && t > 0 ? d.toISOString() : ''
}

function embeddedStream(fs: PDFObject): PDFObject | null {
  const ef = fs.get('EF')
  if (isNull(ef)) return null
  for (const k of ['UF', 'F']) {
    const st = ef.get(k)
    if (!isNull(st)) return st
  }
  return null
}

function fileSize(s: Session, fs: PDFObject): number | null {
  const st = embeddedStream(fs)
  if (!st) return null
  const params = st.get('Params')
  const declared = isNull(params) ? -1 : readNumber(params.get('Size'), -1)
  if (declared >= 0) return declared
  try {
    const buf = s.pdf.getEmbeddedFileContents(fs)
    if (!buf) return null
    const n = buf.getLength()
    buf.destroy()
    return n
  } catch {
    return null
  }
}

function fileSpecInfo(s: Session, fs: PDFObject, fallbackName: string) {
  const params = safe(() => s.pdf.getFilespecParams(fs), null)
  const st = embeddedStream(fs)
  let mime = params?.mimetype || ''
  if (!mime || mime === 'application/octet-stream') {
    const sub = st ? readName(st.get('Subtype')) : null
    if (sub) mime = sub.replace(/#2F/gi, '/')
  }
  return {
    fileName: params?.filename || readString(fs.get('UF')) || readString(fs.get('F')) || fallbackName,
    size: fileSize(s, fs),
    mimeType: mime || 'application/octet-stream',
    created: isoDate(params?.creationDate),
    modified: isoDate(params?.modificationDate)
  }
}

function listEmbeddedFiles(s: Session): EmbeddedFileInfo[] {
  const efs = safe(() => s.pdf.getEmbeddedFiles(), {} as Record<string, PDFObject>)
  return Object.entries(efs)
    .filter(([, fs]) => !isNull(fs) && fs.resolve().isDictionary())
    .map(([key, fs]) => ({ key, ...fileSpecInfo(s, fs, key), description: readString(fs.get('Desc')) }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName))
}

const ANNOT_FLAG_LOCKED = 128

/** FileAttachment annotations, read from the page dictionaries without loading pages. */
function listAnnotationFiles(s: Session): AnnotationFileInfo[] {
  const out: AnnotationFileInfo[] = []
  const n = s.pageCount()
  for (let p = 0; p < n; p++) {
    const annots = s.pdf.findPage(p).get('Annots')
    if (isNull(annots) || !annots.isArray()) continue
    for (let i = 0; i < annots.length; i++) {
      const ref = annots.get(i)
      const a = ref.resolve()
      if (!a.isDictionary() || readName(a.get('Subtype')) !== 'FileAttachment') continue
      const fs = a.get('FS')
      if (isNull(fs) || !ref.isIndirect()) continue
      const info = fileSpecInfo(s, fs, 'attachment')
      const rect = safe(() => transformRect(readRect(a.get('Rect')), s.userToPage(p)), null)
      out.push({
        id: ref.asIndirect(),
        page: p,
        rect,
        fileName: info.fileName,
        size: info.size,
        description: readString(a.get('Contents')),
        locked: (readNumber(a.get('F'), 0) & ANNOT_FLAG_LOCKED) !== 0
      })
    }
  }
  return out
}

function uniqueFileName(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name
  const m = /^(.*?)(\.[^.]*)?$/.exec(name)!
  const stem = m[1]
  const ext = m[2] ?? ''
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!existing.has(candidate)) return candidate
  }
}

function requireEmbedded(s: Session, key: string): PDFObject {
  const fs = s.pdf.getEmbeddedFiles()[key]
  if (!fs || isNull(fs)) throw new EngineError(`The attachment “${key}” no longer exists`, 'NO_ATTACHMENT')
  return fs
}

function bufferBytes(buf: { asUint8Array(): Uint8Array; destroy(): void } | null): Uint8Array {
  if (!buf) throw new EngineError('The attached file is empty or damaged', 'NO_DATA')
  const bytes = buf.asUint8Array().slice()
  buf.destroy()
  return bytes
}

// ==== layers =========================================================================================

const LAYER_INITIAL = 'navigation:layers:initial'

function initialLayerStates(s: Session): boolean[] {
  let states = s.state.get(LAYER_INITIAL) as boolean[] | undefined
  if (!states) {
    const n = safe(() => s.pdf.countLayers(), 0)
    states = []
    for (let i = 0; i < n; i++) states.push(safe(() => s.pdf.isLayerVisible(i), true))
    s.state.set(LAYER_INITIAL, states)
  }
  return states
}

function listLayers(s: Session): LayerInfo[] {
  const initial = initialLayerStates(s)
  const n = safe(() => s.pdf.countLayers(), 0)
  const out: LayerInfo[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      name: safe(() => s.pdf.getLayerName(i), '') || `Layer ${i + 1}`,
      visible: safe(() => s.pdf.isLayerVisible(i), true),
      initiallyVisible: initial[i] ?? true
    })
  }
  return out
}

// ==== document properties ============================================================================

const STANDARD_INFO_KEYS = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped'
])

const PAGE_MODES: Record<string, NavigationTab> = {
  UseNone: 'page',
  UseOutlines: 'bookmarks',
  UseThumbs: 'thumbnails',
  UseAttachments: 'attachments',
  UseOC: 'layers'
}

const PAGE_LAYOUTS: Record<string, InitialLayout> = {
  SinglePage: 'single',
  OneColumn: 'continuous',
  TwoPageLeft: 'two-up',
  TwoColumnLeft: 'two-up-continuous',
  TwoPageRight: 'two-up-cover',
  TwoColumnRight: 'two-up-continuous-cover'
}

const invert = <K extends string, V extends string>(r: Record<K, V>): Record<V, K> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [v, k])) as Record<V, K>

function infoDict(s: Session, create: boolean): PDFObject | null {
  const trailer = s.pdf.getTrailer()
  const info = trailer.get('Info')
  if (!isNull(info) && info.resolve().isDictionary()) return info
  if (!create) return null
  const ref = s.pdf.addObject(s.pdf.newDictionary())
  trailer.put('Info', ref)
  return ref
}

function valueText(v: PDFObject): string {
  try {
    const o = v.resolve()
    if (o.isString()) return o.asString()
    if (o.isName()) return o.asName()
    if (o.isNumber()) return String(o.asNumber())
    if (o.isBoolean()) return o.asBoolean() ? 'true' : 'false'
    return o.toString(true, true)
  } catch {
    return ''
  }
}

interface OpenTarget {
  page: number
  magnification: InitialMagnification
  isScript: boolean
}

function readOpenAction(s: Session): OpenTarget {
  const cat = catalog(s.pdf)
  const oa = cat.get('OpenAction')
  const none: OpenTarget = { page: 0, magnification: 'default', isScript: false }
  if (isNull(oa)) return none
  let dest: PDFObject | null = null
  const o = oa.resolve()
  if (o.isArray()) dest = o
  else if (o.isDictionary()) {
    if (readName(o.get('S')) === 'GoTo') dest = o.get('D')
    else return { ...none, isScript: true }
  }
  if (!dest || isNull(dest)) return none
  let d = dest.resolve()
  if (d.isString() || d.isName()) {
    const name = d.isString() ? d.asString() : d.asName()
    const named = safe(() => s.pdf.resolveLinkDestination('#nameddest=' + encodeURIComponent(name)), null)
    if (named && named.page >= 0) {
      const z = named.zoom
      return {
        page: named.page,
        magnification: magnificationFrom(named.type, typeof z === 'number' && z > 0 ? z / 100 : 0),
        isScript: false
      }
    }
    return none
  }
  if (d.isDictionary()) d = d.get('D').resolve()
  if (!d.isArray() || d.length < 1) return none
  const first = d.get(0)
  let page = 0
  if (first.isIndirect()) page = Math.max(0, s.pageIndexById(first.asIndirect()))
  else if (first.isNumber()) page = Math.max(0, Math.min(s.pageCount() - 1, Math.round(first.asNumber())))
  const type = readName(d.get(1)) ?? 'XYZ'
  const zoom = type === 'XYZ' ? readNumber(d.get(4), 0) : 0
  return { page, magnification: magnificationFrom(type, zoom), isScript: false }
}

function magnificationFrom(type: string, zoom: number): InitialMagnification {
  switch (type) {
    case 'Fit':
      return 'fit-page'
    case 'FitH':
      return 'fit-width'
    case 'FitV':
      return 'fit-height'
    case 'FitB':
    case 'FitBH':
    case 'FitBV':
      return 'fit-visible'
    case 'XYZ':
      if (zoom > 0) return Math.abs(zoom - 1) < 1e-6 ? 'actual-size' : zoom
      return 'default'
    default:
      return 'default'
  }
}

function readInitialView(s: Session): InitialView {
  const cat = catalog(s.pdf)
  let mode = readName(cat.get('PageMode')) ?? 'UseNone'
  if (mode === 'FullScreen')
    mode = readName(cat.get('ViewerPreferences').get('NonFullScreenPageMode')) ?? 'UseNone'
  const layout = readName(cat.get('PageLayout'))
  const open = readOpenAction(s)
  const prefs = cat.get('ViewerPreferences')
  let displayDocTitle = false
  try {
    const v = prefs.get('DisplayDocTitle')
    displayDocTitle = !isNull(v) && v.isBoolean() && v.asBoolean()
  } catch {}
  return {
    navigationTab: PAGE_MODES[mode] ?? 'page',
    pageLayout: (layout && PAGE_LAYOUTS[layout]) || 'default',
    magnification: open.magnification,
    openToPage: open.page,
    displayDocTitle,
    openActionIsScript: open.isScript
  }
}

function writeOpenAction(s: Session, page: number, mag: InitialMagnification) {
  const cat = catalog(s.pdf)
  if (page === 0 && mag === 'default') {
    cat.delete('OpenAction')
    return
  }
  const count = s.pageCount()
  const p = Math.max(0, Math.min(count - 1, Math.round(page)))
  const arr = s.pdf.newArray()
  arr.push(s.pdf.findPage(p))
  const nul = () => s.pdf.newNull()
  switch (mag) {
    case 'fit-page':
      arr.push(s.pdf.newName('Fit'))
      break
    case 'fit-width':
      arr.push(s.pdf.newName('FitH'))
      arr.push(nul())
      break
    case 'fit-height':
      arr.push(s.pdf.newName('FitV'))
      arr.push(nul())
      break
    case 'fit-visible':
      arr.push(s.pdf.newName('FitBH'))
      arr.push(nul())
      break
    default:
      arr.push(s.pdf.newName('XYZ'))
      arr.push(nul())
      arr.push(nul())
      if (mag === 'actual-size') arr.push(1)
      else if (typeof mag === 'number' && mag > 0) arr.push(Math.round(mag * 10000) / 10000)
      else arr.push(nul())
  }
  cat.put('OpenAction', arr)
}

function applyInitialView(s: Session, patch: NonNullable<PropertiesPatch['initialView']>) {
  const cat = catalog(s.pdf)
  if (patch.navigationTab !== undefined) {
    const name = invert(PAGE_MODES)[patch.navigationTab] ?? 'UseNone'
    if (readName(cat.get('PageMode')) === 'FullScreen') {
      let vp = cat.get('ViewerPreferences')
      if (isNull(vp)) {
        cat.put('ViewerPreferences', s.pdf.newDictionary())
        vp = cat.get('ViewerPreferences')
      }
      vp.put('NonFullScreenPageMode', s.pdf.newName(name))
    } else if (name === 'UseNone') cat.delete('PageMode')
    else cat.put('PageMode', s.pdf.newName(name))
  }
  if (patch.pageLayout !== undefined) {
    if (patch.pageLayout === 'default') cat.delete('PageLayout')
    else cat.put('PageLayout', s.pdf.newName(invert(PAGE_LAYOUTS)[patch.pageLayout]))
  }
  if (patch.openToPage !== undefined || patch.magnification !== undefined) {
    const cur = readOpenAction(s)
    writeOpenAction(s, patch.openToPage ?? cur.page, patch.magnification ?? cur.magnification)
  }
  if (patch.displayDocTitle !== undefined) {
    let vp = cat.get('ViewerPreferences')
    if (isNull(vp)) {
      if (!patch.displayDocTitle) return
      cat.put('ViewerPreferences', s.pdf.newDictionary())
      vp = cat.get('ViewerPreferences')
    }
    if (patch.displayDocTitle) vp.put('DisplayDocTitle', true)
    else vp.delete('DisplayDocTitle')
  }
}

const CUSTOM_KEY = /^[A-Za-z0-9_.\-+:]{1,127}$/

function applyCustom(s: Session, entries: { key: string; value: string }[]) {
  for (const e of entries) {
    if (!CUSTOM_KEY.test(e.key)) throw new EngineError(`“${e.key}” is not a valid property name`, 'BAD_KEY')
  }
  const existing = infoDict(s, false)
  if (!existing && !entries.length) return
  const info = existing ?? infoDict(s, true)!
  const remove: string[] = []
  info.forEach((_v, k) => {
    const key = String(k)
    if (!STANDARD_INFO_KEYS.has(key)) remove.push(key)
  })
  for (const k of remove) info.delete(k)
  for (const e of entries) {
    if (STANDARD_INFO_KEYS.has(e.key)) continue
    info.put(e.key, s.pdf.newString(e.value))
  }
}

function readProperties(s: Session): DocumentPropertiesData {
  const cat = catalog(s.pdf)
  let tagged = false
  try {
    const marked = cat.get('MarkInfo').get('Marked')
    tagged = !isNull(marked) && marked.isBoolean() && marked.asBoolean()
  } catch {}
  const info = infoDict(s, false)
  const custom: { key: string; value: string }[] = []
  let trapped = ''
  if (info) {
    info.forEach((v, k) => {
      const key = String(k)
      if (key === 'Trapped') trapped = valueText(v)
      if (!STANDARD_INFO_KEYS.has(key)) custom.push({ key, value: valueText(v) })
    })
  }
  return {
    tagged,
    initialView: readInitialView(s),
    custom,
    trapped,
    hasInfo: !!info,
    hasXmpMetadata: !isNull(cat.get('Metadata'))
  }
}

// ==== fonts ==========================================================================================

const ENCODING_NAMES: Record<string, string> = {
  WinAnsiEncoding: 'Ansi',
  MacRomanEncoding: 'Roman',
  MacExpertEncoding: 'Expert',
  StandardEncoding: 'Standard',
  'Identity-H': 'Identity-H',
  'Identity-V': 'Identity-V'
}

function describeFont(font: PDFObject): Omit<FontInfo, 'id' | 'pages'> {
  const f = font.resolve()
  const subtype = readName(f.get('Subtype')) ?? 'Unknown'
  let rawName = readName(f.get('BaseFont')) ?? readString(f.get('BaseFont'))
  if (!rawName) rawName = subtype === 'Type3' ? readName(f.get('Name')) || 'Type 3 font' : 'Unnamed font'
  const subset = /^[A-Z]{6}\+/.test(rawName)
  const name = rawName.replace(/^[A-Z]{6}\+/, '')
  let descriptor = f.get('FontDescriptor')
  let descendantType: string | null = null
  if (subtype === 'Type0') {
    const desc = f.get('DescendantFonts')
    const d0 = !isNull(desc) && desc.isArray() && desc.length ? desc.get(0) : desc
    if (!isNull(d0)) {
      descriptor = d0.get('FontDescriptor')
      descendantType = readName(d0.get('Subtype'))
    }
  }
  const file3 = isNull(descriptor) ? null : descriptor.get('FontFile3')
  const file3Type = file3 && !isNull(file3) ? readName(file3.get('Subtype')) : null
  const embedded =
    subtype === 'Type3' ||
    (!isNull(descriptor) && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => !isNull(descriptor.get(k))))
  let type: string
  switch (subtype) {
    case 'Type1':
      type = file3Type === 'OpenType' ? 'OpenType' : file3Type === 'Type1C' ? 'Type 1 (CFF)' : 'Type 1'
      break
    case 'MMType1':
      type = 'Type 1 (Multiple Master)'
      break
    case 'TrueType':
      type = file3Type === 'OpenType' ? 'OpenType' : 'TrueType'
      break
    case 'Type3':
      type = 'Type 3'
      break
    case 'Type0':
      type =
        file3Type === 'OpenType'
          ? 'OpenType (CID)'
          : descendantType === 'CIDFontType2'
            ? 'TrueType (CID)'
            : descendantType === 'CIDFontType0'
              ? 'Type 1 (CID)'
              : 'Type 0 (CID)'
      break
    default:
      type = subtype
  }
  let encoding = 'Built-in'
  const enc = f.get('Encoding')
  if (!isNull(enc)) {
    const r = enc.resolve()
    if (r.isName()) encoding = ENCODING_NAMES[r.asName()] ?? r.asName()
    else if (r.isDictionary()) {
      const base = readName(r.get('BaseEncoding'))
      encoding = base ? `Custom (based on ${ENCODING_NAMES[base] ?? base})` : 'Custom'
    } else if (r.isStream()) encoding = 'Custom CMap'
  }
  return { name, type, encoding, embedded, subset }
}

/** Calls fn for each font in a resource dictionary, recursing into forms, patterns and annotation appearances. */
function walkResourceFonts(res: PDFObject, fn: (font: PDFObject) => void, seen: Set<number>, depth = 0) {
  if (depth > 12 || isNull(res)) return
  const n = objNum(res)
  if (n) {
    if (seen.has(n)) return
    seen.add(n)
  }
  const r = res.resolve()
  if (!r.isDictionary()) return
  const fonts = r.get('Font')
  if (!isNull(fonts) && fonts.resolve().isDictionary()) fonts.forEach((f) => fn(f))
  for (const key of ['XObject', 'Pattern']) {
    const dict = r.get(key)
    if (isNull(dict) || !dict.resolve().isDictionary()) continue
    dict.forEach((x) => {
      const xn = objNum(x)
      if (xn && seen.has(-xn)) return
      if (xn) seen.add(-xn)
      const sub = readName(x.get('Subtype'))
      if (key === 'XObject' && sub !== 'Form') return
      walkResourceFonts(x.get('Resources'), fn, seen, depth + 1)
    })
  }
}

function scanFonts(s: Session, from: number, to: number): FontInfo[] {
  const byKey = new Map<string, FontInfo>()
  const count = s.pageCount()
  const end = Math.min(count, Math.max(from, to))
  for (let p = Math.max(0, from); p < end; p++) {
    const pageObj = s.pdf.findPage(p)
    const seen = new Set<number>()
    const add = (font: PDFObject) => {
      try {
        const id = objNum(font)
        const d = describeFont(font)
        const key = id ? `#${id}` : `${d.name}|${d.type}|${d.embedded}`
        let entry = byKey.get(key)
        if (!entry) {
          entry = { id, ...d, pages: [] }
          byKey.set(key, entry)
        }
        if (!entry.pages.includes(p)) entry.pages.push(p)
      } catch {}
    }
    walkResourceFonts(pageObj.getInheritable('Resources'), add, seen)
    const annots = pageObj.get('Annots')
    if (!isNull(annots) && annots.isArray()) {
      for (let i = 0; i < annots.length; i++) {
        const ap = annots.get(i).get('AP')
        if (isNull(ap)) continue
        const normal = ap.get('N')
        if (isNull(normal)) continue
        if (normal.isStream()) walkResourceFonts(normal.get('Resources'), add, seen)
        else if (normal.resolve().isDictionary())
          normal.forEach((st) => walkResourceFonts(st.get('Resources'), add, seen))
      }
    }
    s.progress((p - from + 1) / Math.max(1, end - from), `Page ${p + 1} of ${count}`)
  }
  return [...byKey.values()]
}

// ==== ops ============================================================================================

export default defineOps('navigation', {
  // ---- bookmarks

  /** The bookmark tree with stable ids and resolved destinations. */
  outline(s): Bookmark[] {
    return readOutline(s)
  },

  /** Adds a bookmark under `parentId` (null = top level) at `index` (-1 = last). Returns its id. */
  addBookmark: mutation(
    'Add Bookmark',
    (s, parentId: number | null, index: number, title: string, target: BookmarkTarget): number => {
      const root = ensureOutlineRoot(s)
      const parent = parentId === null ? root : requireBookmark(root, parentId).node
      const kids = childrenOf(parent)
      const item = s.pdf.addObject(s.pdf.newDictionary())
      item.put('Title', s.pdf.newString(cleanTitle(title)))
      item.put('Dest', makeDest(s, target))
      const at = index < 0 || index > kids.length ? kids.length : index
      kids.splice(at, 0, item)
      writeChildren(s, parent, kids)
      recount(root)
      s.documentChanged()
      return item.asIndirect()
    }
  ),

  renameBookmark: mutation('Rename Bookmark', (s, id: number, title: string) => {
    const root = outlineRoot(s)
    if (!root) throw new EngineError('This document has no bookmarks', 'NO_BOOKMARK')
    const { node } = requireBookmark(root, id)
    node.put('Title', s.pdf.newString(cleanTitle(title)))
    s.documentChanged()
  }),

  /** Deletes bookmarks (and everything nested under them). */
  deleteBookmarks: mutation(
    (ids: number[]) => (ids.length > 1 ? 'Delete Bookmarks' : 'Delete Bookmark'),
    (s, ids: number[]) => {
      const root = outlineRoot(s)
      if (!root) return
      for (const id of ids) {
        const found = indexOutline(root).get(id)
        if (!found) continue
        const kids = childrenOf(found.parent).filter((k) => objNum(k) !== id)
        writeChildren(s, found.parent, kids)
      }
      recount(root)
      s.documentChanged()
    }
  ),

  /**
   * Moves a bookmark under `parentId` (null = top level) at `index`, where index counts the new
   * siblings without the moved bookmark.
   */
  moveBookmark: mutation('Move Bookmark', (s, id: number, parentId: number | null, index: number) => {
    const root = outlineRoot(s)
    if (!root) throw new EngineError('This document has no bookmarks', 'NO_BOOKMARK')
    const { node, parent } = requireBookmark(root, id)
    if (parentId !== null && isInside(root, id, parentId)) {
      throw new EngineError('A bookmark cannot be moved inside itself', 'BAD_MOVE')
    }
    const newParent = parentId === null ? root : requireBookmark(root, parentId).node
    writeChildren(
      s,
      parent,
      childrenOf(parent).filter((k) => objNum(k) !== id)
    )
    const kids = childrenOf(newParent)
    const at = index < 0 || index > kids.length ? kids.length : index
    kids.splice(at, 0, node)
    writeChildren(s, newParent, kids)
    recount(root)
    s.documentChanged()
  }),

  /** Points a bookmark at a new page view (Acrobat's "Set Destination"). */
  setBookmarkDestination: mutation('Set Bookmark Destination', (s, id: number, target: BookmarkTarget) => {
    const root = outlineRoot(s)
    if (!root) throw new EngineError('This document has no bookmarks', 'NO_BOOKMARK')
    const { node } = requireBookmark(root, id)
    node.put('Dest', makeDest(s, target))
    node.delete('A')
    s.documentChanged()
  }),

  /** Text style and colour of a bookmark (Bookmark Properties). */
  setBookmarkStyle: mutation('Change Bookmark Properties', (s, id: number, style: BookmarkStyle) => {
    const root = outlineRoot(s)
    if (!root) throw new EngineError('This document has no bookmarks', 'NO_BOOKMARK')
    const { node } = requireBookmark(root, id)
    let flags = readNumber(node.get('F'), 0)
    if (style.bold !== undefined) flags = style.bold ? flags | FLAG_BOLD : flags & ~FLAG_BOLD
    if (style.italic !== undefined) flags = style.italic ? flags | FLAG_ITALIC : flags & ~FLAG_ITALIC
    if (flags) node.put('F', flags)
    else node.delete('F')
    if (style.color !== undefined) {
      if (!style.color || /^#0{6}$/i.test(style.color)) node.delete('C')
      else {
        const arr = s.pdf.newArray()
        for (const v of hexToRgb(style.color)) arr.push(Math.round(v * 1000) / 1000)
        node.put('C', arr)
      }
    }
    s.documentChanged()
  }),

  // ---- attachments

  attachments(s): AttachmentList {
    return { files: listEmbeddedFiles(s), annotations: listAnnotationFiles(s) }
  },

  /** Contents of an embedded file. */
  attachmentData(s, key: string) {
    const fs = requireEmbedded(s, key)
    const bytes = bufferBytes(s.pdf.getEmbeddedFileContents(fs))
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  },

  /** Contents of the file in a FileAttachment annotation. */
  annotationFileData(s, page: number, id: number) {
    const annots = s.pdf.findPage(page).get('Annots')
    if (!isNull(annots) && annots.isArray()) {
      for (let i = 0; i < annots.length; i++) {
        const ref = annots.get(i)
        if (objNum(ref) !== id) continue
        const fs = ref.get('FS')
        if (isNull(fs)) break
        const bytes = bufferBytes(s.pdf.getEmbeddedFileContents(fs))
        return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
      }
    }
    throw new EngineError('The attachment no longer exists', 'NO_ATTACHMENT')
  },

  /** Embeds a file (Attachments > Add file). Returns the key it was stored under. */
  addAttachment: mutation(
    'Add Attachment',
    (
      s,
      fileName: string,
      data: Uint8Array,
      opts: { mimeType?: string; description?: string; modified?: string } = {}
    ): string => {
      const existing = new Set([
        ...Object.keys(s.pdf.getEmbeddedFiles()),
        ...listEmbeddedFiles(s).map((f) => f.fileName)
      ])
      const name = uniqueFileName(existing, fileName.trim() || 'attachment')
      // Built from low-level objects: MuPDF's addEmbeddedFile leaves a journal operation open.
      const pdf = s.pdf
      const now = new Date()
      const modified = opts.modified ? new Date(opts.modified) : now
      const params = pdf.newDictionary()
      params.put('Size', data.length)
      params.put('CreationDate', pdf.newString(pdfDate(now)))
      params.put('ModDate', pdf.newString(pdfDate(Number.isFinite(modified.getTime()) ? modified : now)))
      const streamDict = pdf.newDictionary()
      streamDict.put('Type', pdf.newName('EmbeddedFile'))
      if (opts.mimeType) streamDict.put('Subtype', pdf.newName(opts.mimeType))
      streamDict.put('Params', params)
      const stream = pdf.addStream(data, streamDict)
      const ef = pdf.newDictionary()
      ef.put('F', stream)
      ef.put('UF', stream)
      const spec = pdf.newDictionary()
      spec.put('Type', pdf.newName('Filespec'))
      spec.put('F', pdf.newString(name))
      spec.put('UF', pdf.newString(name))
      spec.put('EF', ef)
      if (opts.description?.trim()) spec.put('Desc', pdf.newString(opts.description.trim()))
      pdf.insertEmbeddedFile(name, pdf.addObject(spec))
      s.documentChanged()
      return name
    }
  ),

  deleteAttachment: mutation('Delete Attachment', (s, key: string) => {
    requireEmbedded(s, key)
    s.pdf.deleteEmbeddedFile(key)
    s.documentChanged()
  }),

  setAttachmentDescription: mutation('Edit Attachment Description', (s, key: string, description: string) => {
    const fs = requireEmbedded(s, key)
    if (description.trim()) fs.put('Desc', s.pdf.newString(description.trim()))
    else fs.delete('Desc')
    s.documentChanged()
  }),

  // ---- layers (optional content). Visibility is a view setting, like in Acrobat: not saved, not undoable.

  layers(s): LayerInfo[] {
    return listLayers(s)
  },

  setLayerVisible(s, index: number, visible: boolean): LayerInfo[] {
    initialLayerStates(s)
    const n = s.pdf.countLayers()
    if (!Number.isInteger(index) || index < 0 || index >= n)
      throw new EngineError('This layer no longer exists', 'NO_LAYER')
    s.pdf.setLayerVisible(index, visible)
    s.touchAll()
    return listLayers(s)
  },

  /** Restores the visibility every layer had when the document was opened. */
  resetLayers(s): LayerInfo[] {
    const initial = initialLayerStates(s)
    initial.forEach((v, i) => s.pdf.setLayerVisible(i, v))
    s.touchAll()
    return listLayers(s)
  },

  // ---- document properties

  properties(s): DocumentPropertiesData {
    return readProperties(s)
  },

  /** Applies the Document Properties dialog in one undoable step. */
  setProperties: mutation('Change Document Properties', (s, patch: PropertiesPatch) => {
    if (patch.metadata && Object.keys(patch.metadata).length) docOps.ops.setMetadata(s, patch.metadata)
    if (patch.initialView) applyInitialView(s, patch.initialView)
    if (patch.custom) applyCustom(s, patch.custom)
    s.documentChanged()
  }),

  /** Fonts referenced by pages [from, to) (Document Properties > Fonts). Call in chunks for big documents. */
  fonts(s, from: number, to: number): FontInfo[] {
    return scanFonts(s, from, to)
  }
})
