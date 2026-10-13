/**
 * Interprets page content streams (and the form XObjects they use) just enough to know, for every
 * operator: the q/Q depth, the CTM, the clip region and what it paints. Image edits use this to
 * find the exact operators that paint an image instance.
 */
import type { Matrix, Point, Rect } from '@shared/geometry'
import { IDENTITY, invertMatrix, multiplyMatrix, rectIntersection, transformPoint, transformRect } from '@shared/geometry'
import type { PDFObject, Session } from '@engine/session'
import { concatStreams, opName, opNum, parseContent, type ContentOp, type Operand } from './content'

export interface StreamModel {
  kind: 'page' | 'form'
  bytes: Uint8Array
  ops: ContentOp[]
  /** q/Q depth before each op. */
  depth: Int32Array
  /** CTM (stream space) before each op. */
  ctm: Matrix[]
  /** Clip region (page space) before each op; null = unclipped. */
  clip: (Rect | null)[]
  /** 1 when the op puts marks on the page. */
  paints: Uint8Array
  /** Page-space bbox painted by each op (null when it paints nothing or the area is unknown). */
  paintBox: (Rect | null)[]
  /** For a 'q': index of its matching 'Q' (-1 if never closed). */
  match: Int32Array
  /** Innermost open 'q' before each op (-1 at the root). */
  parentQ: Int32Array
  /** Stream space -> page space. */
  base: Matrix
  resources: PDFObject | null
  /** The form XObject (indirect reference) for form streams. */
  form: PDFObject | null
  parent: { model: StreamModel; opIndex: number } | null
  /** Offsets of the invoking Do operators from the page level down to this stream. */
  locPrefix: number[]
  endDepth: number
  /** CTM of the root graphics state at the end of the stream. */
  endRootCtm: Matrix
  /** Clip at the root at the end of the stream. */
  endRootClip: Rect | null
  initialClip: Rect | null
  /** Page models: the page's content streams (edits write the editable ones back as one stream). */
  parts?: ContentPart[]
}

/**
 * A stream of the page's /Contents. Page marks (headers, footers, watermarks, backgrounds and
 * Bates numbers added by Add header, watermark or background) are separate streams tagged in
 * their stream dictionary, and the page's own content is wrapped between two tagged streams
 * (`q`, optionally with a shrink `cm`, and `Q`). Marks are not content the user edits here, and
 * edits must leave those streams and their tags exactly as they are so the marks can still be
 * updated or removed.
 */
export interface ContentPart {
  ref: PDFObject
  role: 'content' | 'mark' | 'wrapBegin' | 'wrapEnd'
  /** Marks drawn behind the page content (backgrounds, watermarks set to appear behind). */
  behind: boolean
}

const MARK_KEY = 'FartcrobatMark'
const WRAP_KEY = 'FartcrobatWrap'
const BEHIND_KEY = 'FartcrobatBehind'

export interface ImageOcc {
  index: number
  model: StreamModel
  opIndex: number
  kind: 'xobject' | 'inline'
  name: string | null
  /** Indirect reference to the image XObject (null for inline images). */
  ref: PDFObject | null
  xref: number
  /** Image space (unit square) -> page space. */
  matrix: Matrix
  clip: Rect | null
  width: number
  height: number
  loc: number[]
}

export interface Scene {
  page: number
  pageModel: StreamModel
  images: ImageOcc[]
  /** User space -> page space. */
  userToPage: Matrix
  bounds: Rect
}

const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])
const PATH_CONSTRUCT = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're'])
const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"'])
export const STATE_CARRY = new Set(['gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k', 'ri'])

const MAX_FORM_DEPTH = 8

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

function readStreamBytes(o: PDFObject): Uint8Array {
  return safe(() => o.readStream().asUint8Array().slice(), new Uint8Array(0))
}

function contentParts(s: Session, page: number): ContentPart[] {
  const obj = s.page(page).getObject()
  const contents = safe(() => obj.get('Contents'), null)
  if (isNullObj(contents)) return []
  const c = contents!.resolve()
  const refs: PDFObject[] = []
  if (c.isArray()) for (let i = 0; i < c.length; i++) refs.push(c.get(i))
  else refs.push(contents!)
  return refs.map((ref) => {
    const isStream = safe(() => ref.isStream(), false)
    const name = (key: string) =>
      isStream
        ? safe(() => {
            const v = ref.get(key)
            return v.isName() ? v.asName() : null
          }, null)
        : null
    if (name(MARK_KEY)) return { ref, role: 'mark', behind: safe(() => ref.get(BEHIND_KEY).asBoolean(), false) }
    const wrap = name(WRAP_KEY)
    if (wrap === 'Begin') return { ref, role: 'wrapBegin', behind: false }
    if (wrap === 'End') return { ref, role: 'wrapEnd', behind: false }
    return { ref, role: 'content', behind: false }
  })
}

/** The page's own content: its content streams (without page marks), concatenated. */
export function pageContent(s: Session, page: number): { bytes: Uint8Array; parts: ContentPart[]; wrap: Matrix } {
  const parts = contentParts(s, page)
  const bytes = concatStreams(parts.filter((p) => p.role === 'content').map((p) => readStreamBytes(p.ref)))
  // the wrapper of page marks may shrink the page content to make room for headers and footers
  let wrap: Matrix = [...IDENTITY] as Matrix
  const begin = parts.find((p) => p.role === 'wrapBegin')
  if (begin) {
    for (const o of parseContent(readStreamBytes(begin.ref))) {
      if (o.op === 'cm' && o.args.length >= 6) wrap = multiplyMatrix(o.args.slice(-6).map((x) => opNum(x)) as Matrix, wrap)
    }
  }
  return { bytes: parts.some((p) => p.role === 'content') ? bytes : new Uint8Array(0), parts, wrap }
}

/**
 * Replaces the page's own content streams by `stream`, keeping page marks and their wrapper as
 * they are (new content goes inside the wrapper, or between marks behind and in front of it).
 */
export function setPageContent(s: Session, page: number, parts: ContentPart[], stream: PDFObject) {
  const pageObj = s.page(page).getObject()
  if (parts.every((p) => p.role === 'content')) {
    pageObj.put('Contents', stream)
    return
  }
  const list: PDFObject[] = []
  let placed = false
  if (!parts.some((p) => p.role === 'content')) {
    const afterWrap = parts.findIndex((p) => p.role === 'wrapBegin') + 1
    const front = parts.findIndex((p) => p.role === 'mark' && !p.behind)
    const at = afterWrap > 0 ? afterWrap : front >= 0 ? front : parts.length
    parts.forEach((p, i) => {
      if (i === at) list.push(stream)
      list.push(p.ref)
    })
    if (at >= parts.length) list.push(stream)
  } else {
    for (const p of parts) {
      if (p.role !== 'content') list.push(p.ref)
      else if (!placed) {
        list.push(stream)
        placed = true
      }
    }
  }
  const arr = s.pdf.newArray()
  for (const r of list) arr.push(r)
  pageObj.put('Contents', arr)
}

export function pageResources(s: Session, page: number): PDFObject | null {
  const obj = s.page(page).getObject()
  const r = safe(() => obj.getInheritable('Resources'), null)
  return isNullObj(r) ? null : r!.resolve()
}

function readMatrix(o: PDFObject | null): Matrix {
  if (isNullObj(o)) return [...IDENTITY] as Matrix
  const a = o!.resolve()
  if (!a.isArray() || a.length < 6) return [...IDENTITY] as Matrix
  const m: number[] = []
  for (let i = 0; i < 6; i++) m.push(safe(() => a.get(i).asNumber(), i === 0 || i === 3 ? 1 : 0))
  return m as Matrix
}

function readRectObj(o: PDFObject | null): Rect | null {
  if (isNullObj(o)) return null
  const a = o!.resolve()
  if (!a.isArray() || a.length < 4) return null
  const v = [0, 1, 2, 3].map((i) => safe(() => a.get(i).asNumber(), 0))
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]
}

function clipWith(clip: Rect | null, r: Rect | null): Rect | null {
  if (!r) return clip
  if (!clip) return r
  return rectIntersection(clip, r) ?? [clip[0], clip[1], clip[0], clip[1]]
}

function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

const UNIT: Rect = [0, 0, 1, 1]

function xobjectEntry(resources: PDFObject | null, name: string): PDFObject | null {
  if (!resources) return null
  const xo = safe(() => resources.get('XObject'), null)
  if (isNullObj(xo)) return null
  const v = safe(() => xo!.resolve().get(name), null)
  return isNullObj(v) ? null : v
}

function subtypeOf(o: PDFObject): string | null {
  return safe(() => {
    const st = o.resolve().get('Subtype')
    return st.isName() ? st.asName() : null
  }, null)
}

interface Ctx {
  s: Session
  images: ImageOcc[]
  visiting: Set<number>
  formDepth: number
}

interface GState {
  ctm: Matrix
  clip: Rect | null
}

function interpret(
  ctx: Ctx,
  model: Omit<
    StreamModel,
    'ops' | 'depth' | 'ctm' | 'clip' | 'paints' | 'paintBox' | 'match' | 'parentQ' | 'endDepth' | 'endRootCtm' | 'endRootClip'
  >
): StreamModel {
  const ops = parseContent(model.bytes)
  const n = ops.length
  const m: StreamModel = {
    ...model,
    ops,
    depth: new Int32Array(n),
    ctm: new Array(n),
    clip: new Array(n),
    paints: new Uint8Array(n),
    paintBox: new Array(n).fill(null),
    match: new Int32Array(n).fill(-1),
    parentQ: new Int32Array(n).fill(-1),
    endDepth: 0,
    endRootCtm: [...IDENTITY] as Matrix,
    endRootClip: model.initialClip
  }
  let st: GState = { ctm: [...IDENTITY] as Matrix, clip: model.initialClip }
  const stack: GState[] = []
  const qStack: number[] = []
  let path: Rect | null = null
  let pendingClip = false
  // text state
  let tm: Matrix = [...IDENTITY] as Matrix
  let tlm: Matrix = [...IDENTITY] as Matrix
  let fontSize = 12
  let leading = 0
  let hscale = 1
  let charSpace = 0
  const toPage = (p: Point): Point => transformPoint(transformPoint(p, st.ctm), model.base)
  const addPoint = (x: number, y: number) => {
    const p = toPage([x, y])
    path = path ? [Math.min(path[0], p[0]), Math.min(path[1], p[1]), Math.max(path[2], p[0]), Math.max(path[3], p[1])] : [p[0], p[1], p[0], p[1]]
  }
  const endPath = () => {
    if (pendingClip) st = { ...st, clip: clipWith(st.clip, path ?? [0, 0, 0, 0]) }
    pendingClip = false
    path = null
  }
  const textMove = (tx: number, ty: number) => {
    tlm = multiplyMatrix([1, 0, 0, 1, tx, ty], tlm)
    tm = [...tlm] as Matrix
  }
  const showText = (i: number, chars: number, adjust: number) => {
    const width = Math.max(0, (chars * 0.5 * fontSize + chars * charSpace) * hscale - (adjust / 1000) * fontSize * hscale)
    const box: Rect = [0, -0.25 * fontSize, width, 0.95 * fontSize]
    const full = multiplyMatrix(multiplyMatrix(tm, st.ctm), model.base)
    m.paintBox[i] = clipWith(st.clip, transformRect(box, full))
    m.paints[i] = 1
    tm = multiplyMatrix([1, 0, 0, 1, width, 0], tm)
  }
  for (let i = 0; i < n; i++) {
    const o = ops[i]
    const a = o.args
    m.depth[i] = stack.length
    m.ctm[i] = st.ctm
    m.clip[i] = st.clip
    m.parentQ[i] = qStack.length ? qStack[qStack.length - 1] : -1
    switch (o.op) {
      case 'q':
        stack.push(st)
        qStack.push(i)
        break
      case 'Q':
        if (stack.length) {
          st = stack.pop()!
          m.match[qStack.pop()!] = i
        }
        break
      case 'cm':
        if (a.length >= 6) st = { ...st, ctm: multiplyMatrix(a.slice(-6).map((x) => opNum(x)) as Matrix, st.ctm) }
        break
      case 'm':
      case 'l':
        addPoint(opNum(a[0]), opNum(a[1]))
        break
      case 'c':
        addPoint(opNum(a[0]), opNum(a[1]))
        addPoint(opNum(a[2]), opNum(a[3]))
        addPoint(opNum(a[4]), opNum(a[5]))
        break
      case 'v':
      case 'y':
        addPoint(opNum(a[0]), opNum(a[1]))
        addPoint(opNum(a[2]), opNum(a[3]))
        break
      case 're': {
        const [x, y, w, h] = [opNum(a[0]), opNum(a[1]), opNum(a[2]), opNum(a[3])]
        addPoint(x, y)
        addPoint(x + w, y)
        addPoint(x, y + h)
        addPoint(x + w, y + h)
        break
      }
      case 'W':
      case 'W*':
        pendingClip = true
        break
      case 'n':
        endPath()
        break
      case 'BT':
        tm = [...IDENTITY] as Matrix
        tlm = [...IDENTITY] as Matrix
        break
      case 'Tf':
        fontSize = Math.abs(opNum(a[1], 12)) || 12
        break
      case 'TL':
        leading = opNum(a[0])
        break
      case 'Tz':
        hscale = opNum(a[0], 100) / 100
        break
      case 'Tc':
        charSpace = opNum(a[0])
        break
      case 'Td':
        textMove(opNum(a[0]), opNum(a[1]))
        break
      case 'TD':
        leading = -opNum(a[1])
        textMove(opNum(a[0]), opNum(a[1]))
        break
      case 'Tm':
        if (a.length >= 6) {
          tlm = a.slice(-6).map((x) => opNum(x)) as Matrix
          tm = [...tlm] as Matrix
        }
        break
      case 'T*':
        textMove(0, -leading)
        break
      case 'Tj':
        showText(i, a[0]?.k === 'str' ? a[0].n : 0, 0)
        break
      case "'":
        textMove(0, -leading)
        showText(i, a[0]?.k === 'str' ? a[0].n : 0, 0)
        break
      case '"':
        charSpace = opNum(a[1])
        textMove(0, -leading)
        showText(i, a[2]?.k === 'str' ? a[2].n : 0, 0)
        break
      case 'TJ': {
        let chars = 0
        let adjust = 0
        const arr = a[0]
        if (arr?.k === 'arr') {
          for (const it of arr.items) {
            if (it.k === 'str') chars += it.n
            else if (it.k === 'num') adjust += it.v
          }
        }
        showText(i, chars, adjust)
        break
      }
      case 'sh':
        m.paints[i] = 1
        m.paintBox[i] = st.clip
        break
      case 'Do': {
        m.paints[i] = 1
        const name = opName(a[a.length - 1])
        const entry = name ? xobjectEntry(model.resources, name) : null
        if (!entry) break
        const sub = subtypeOf(entry)
        const full = multiplyMatrix(st.ctm, model.base)
        if (sub === 'Image') {
          const box = transformRect(UNIT, full)
          m.paintBox[i] = clipWith(st.clip, box)
          const dict = entry.resolve()
          ctx.images.push({
            index: ctx.images.length,
            model: m,
            opIndex: i,
            kind: 'xobject',
            name,
            ref: entry,
            xref: safe(() => (entry.isIndirect() ? entry.asIndirect() : 0), 0),
            matrix: full,
            clip: st.clip,
            width: safe(() => dict.get('Width').asNumber(), 0),
            height: safe(() => dict.get('Height').asNumber(), 0),
            loc: [...model.locPrefix, o.start]
          })
        } else if (sub === 'Form') {
          const dict = entry.resolve()
          const fm = readMatrix(safe(() => dict.get('Matrix'), null))
          const bbox = readRectObj(safe(() => dict.get('BBox'), null))
          const formBase = multiplyMatrix(multiplyMatrix(fm, st.ctm), model.base)
          const formClip = clipWith(st.clip, bbox ? transformRect(bbox, formBase) : null)
          m.paintBox[i] = formClip
          const num = safe(() => (entry.isIndirect() ? entry.asIndirect() : 0), 0)
          if (ctx.formDepth >= MAX_FORM_DEPTH || (num && ctx.visiting.has(num))) break
          const res = safe(() => dict.get('Resources'), null)
          if (num) ctx.visiting.add(num)
          ctx.formDepth++
          try {
            interpret(ctx, {
              kind: 'form',
              bytes: readStreamBytes(entry),
              base: formBase,
              resources: isNullObj(res) ? model.resources : res!.resolve(),
              form: entry,
              parent: { model: m, opIndex: i },
              locPrefix: [...model.locPrefix, o.start],
              initialClip: formClip
            })
          } finally {
            ctx.formDepth--
            if (num) ctx.visiting.delete(num)
          }
        }
        break
      }
      case 'BI': {
        m.paints[i] = 1
        const d = o.inline!.dict
        const full = multiplyMatrix(st.ctm, model.base)
        m.paintBox[i] = clipWith(st.clip, transformRect(UNIT, full))
        ctx.images.push({
          index: ctx.images.length,
          model: m,
          opIndex: i,
          kind: 'inline',
          name: null,
          ref: null,
          xref: 0,
          matrix: full,
          clip: st.clip,
          width: opNum(d.W ?? d.Width),
          height: opNum(d.H ?? d.Height),
          loc: [...model.locPrefix, o.start]
        })
        break
      }
      default:
        if (PATH_PAINT.has(o.op)) {
          m.paints[i] = 1
          m.paintBox[i] = clipWith(st.clip, path)
          endPath()
        } else if (TEXT_SHOW.has(o.op)) m.paints[i] = 1
    }
  }
  m.endDepth = stack.length
  const root = stack.length ? stack[0] : st
  m.endRootCtm = root.ctm
  m.endRootClip = root.clip
  return m
}

/** Builds the scene of a page: every image draw in paint order (page marks are left out). */
export function buildScene(s: Session, page: number): Scene {
  const bounds = s.pageBounds(page)
  const userToPage = s.userToPage(page)
  const ctx: Ctx = { s, images: [], visiting: new Set(), formDepth: 0 }
  const content = pageContent(s, page)
  const pageModel = interpret(ctx, {
    kind: 'page',
    bytes: content.bytes,
    base: multiplyMatrix(content.wrap, userToPage),
    resources: pageResources(s, page),
    form: null,
    parent: null,
    locPrefix: [],
    initialClip: bounds,
    parts: content.parts
  })
  return { page, pageModel, images: ctx.images, userToPage, bounds }
}

// ---- structure queries ----------------------------------------------------------------------

/** True when ops (from, to) exclusive paint nothing outside [skipS, skipE] and are balanced. */
function onlyPaints(m: StreamModel, from: number, to: number, skipS: number, skipE: number): boolean {
  let mc = 0
  let bt = 0
  for (let j = from + 1; j < to; j++) {
    if (j >= skipS && j <= skipE) continue
    if (m.paints[j]) return false
    const op = m.ops[j].op
    if (op === 'BMC' || op === 'BDC') mc++
    else if (op === 'EMC') {
      mc--
      if (mc < 0) return false
    } else if (op === 'BT') bt++
    else if (op === 'ET') {
      bt--
      if (bt < 0) return false
    }
  }
  return mc === 0 && bt === 0
}

/**
 * The chain of q..Q groups that belong to the image painted by op k only (innermost first). The
 * last entry is the largest group whose content paints just this image; it can be moved, deleted
 * or transformed as a unit without affecting anything else.
 */
export function ownedGroups(m: StreamModel, k: number): [number, number][] {
  const out: [number, number][] = [[k, k]]
  let s = k
  let e = k
  for (;;) {
    const q = m.parentQ[s]
    if (q < 0) break
    const qe = m.match[q]
    if (qe < 0 || qe < e) break
    if (!onlyPaints(m, q, qe, s, e)) break
    s = q
    e = qe
    out.push([s, e])
  }
  return out
}

export interface RootItem {
  start: number
  end: number
  bbox: Rect | null
}

/** Top-level items of a stream: q..Q groups, text objects, paths and single painting ops. */
export function rootItems(m: StreamModel): RootItem[] {
  const items: RootItem[] = []
  const n = m.ops.length
  let i = 0
  while (i < n) {
    if (m.depth[i] !== 0) {
      i++
      continue
    }
    const op = m.ops[i].op
    let end = -1
    if (op === 'q') end = m.match[i] >= 0 ? m.match[i] : n - 1
    else if (op === 'BT') {
      end = i
      while (end < n - 1 && m.ops[end].op !== 'ET') end++
    } else if (PATH_CONSTRUCT.has(op)) {
      end = i
      while (end < n - 1 && !PATH_PAINT.has(m.ops[end].op) && m.ops[end].op !== 'n') end++
    } else if (m.paints[i]) end = i
    if (end < 0) {
      i++
      continue
    }
    let bbox: Rect | null = null
    let paints = false
    for (let j = i; j <= end; j++) {
      if (m.paints[j]) {
        paints = true
        bbox = unionRect(bbox, m.paintBox[j])
      }
    }
    if (paints) items.push({ start: i, end, bbox })
    i = end + 1
  }
  return items
}

/** Index of the root item containing op k. */
export function rootItemOf(items: RootItem[], k: number): number {
  for (let i = 0; i < items.length; i++) if (items[i].start <= k && items[i].end >= k) return i
  return -1
}

/**
 * Byte ranges of the state operators (ExtGState, fill colour) in effect at op k, so that an image
 * moved elsewhere in the stream keeps its opacity, blend mode and (for stencil masks) colour.
 * Inside enclosing groups every such operator is kept; at the root only ExtGState operators and the
 * last fill colour.
 */
export function carriedState(m: StreamModel, k: number): [number, number][] {
  const rootGs: [number, number][] = []
  let rootCs: [number, number] | null = null
  let rootColor: [number, number] | null = null
  const levels: [number, number][][] = []
  for (let j = 0; j < k; j++) {
    const o = m.ops[j]
    const op = o.op
    const range: [number, number] = [o.start, o.end]
    if (op === 'q') levels.push([])
    else if (op === 'Q') levels.pop()
    else if (!STATE_CARRY.has(op)) continue
    else if (levels.length) levels[levels.length - 1].push(range)
    else if (op === 'gs') rootGs.push(range)
    else if (op === 'g' || op === 'rg' || op === 'k') {
      rootCs = null
      rootColor = range
    } else if (op === 'cs') {
      rootCs = range
      rootColor = null
    } else if (op === 'sc' || op === 'scn') rootColor = range
  }
  const rootFill = [rootCs, rootColor].filter((r): r is [number, number] => r !== null)
  return [...rootGs, ...rootFill, ...levels.flat()]
}

export function pageSpaceOf(m: StreamModel, opIndex: number): Matrix {
  return multiplyMatrix(m.ctm[opIndex], m.base)
}

export { invertMatrix }

export function operandList(o: ContentOp): Operand[] {
  return o.args
}
