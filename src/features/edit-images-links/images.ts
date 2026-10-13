/**
 * Precise image editing on page content. Every edit rewrites only the operators that paint the
 * edited image instance (plus the q..Q group that exclusively belongs to it), so the rest of the
 * page stays byte-for-byte identical. Images inside form XObjects are edited in a page-private copy
 * of the form (copy-on-write), so other pages using the same form are not affected.
 */
import type { Matrix, Point, Quad, Rect } from '@shared/geometry'
import { IDENTITY, invertMatrix, multiplyMatrix, rectIntersection, transformPoint, transformRect } from '@shared/geometry'
import { EngineError } from '@engine/define'
import type { PDFObject, Session } from '@engine/session'
import { applySplices, fmt, fmtMatrix, opNum, type Splice, type SpliceResult } from './content'
import {
  buildScene,
  carriedState,
  ownedGroups,
  pageSpaceOf,
  rootItemOf,
  rootItems,
  setPageContent,
  type ImageOcc,
  type Scene,
  type StreamModel
} from './scene'

export interface PageImage {
  /** Position in paint order on the page (0 = painted first, at the back). */
  index: number
  kind: 'xobject' | 'inline'
  /** Object number of the image XObject (0 for inline images). */
  xref: number
  name: string | null
  /** Image space (unit square, PDF convention) -> page space. */
  matrix: Matrix
  /** Corners of the image as displayed, in page space: upper-left, upper-right, lower-left, lower-right. */
  quad: Quad
  bbox: Rect
  /** Part of the image that is not hidden by clipping (what the user sees). */
  visible: Rect
  /** Pixel size. */
  width: number
  height: number
  /** Inside a form XObject. */
  nested: boolean
  /** Locator: offsets of the operators from the page content down to the image draw. */
  loc: number[]
  /** Effective resolution in pixels per inch. */
  dpi: number
  /** Rotation of the image's x axis in degrees, clockwise on screen. */
  rotation: number
  flipped: boolean
  cropped: boolean
}

/** Identifies an image instance between calls. */
export interface ImageRef {
  index: number
  xref: number
  loc: number[]
}

export type ArrangeWhere = 'front' | 'forward' | 'backward' | 'back'
export type TransformKind = 'move' | 'resize' | 'rotate' | 'flip'

// ---- helpers --------------------------------------------------------------------------------

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

function area(r: Rect | null): number {
  return r ? Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]) : 0
}

function intersect(a: Rect, b: Rect | null): Rect | null {
  return b ? rectIntersection(a, b) : a
}

export function quadOf(m: Matrix): Quad {
  const ul = transformPoint([0, 1], m)
  const ur = transformPoint([1, 1], m)
  const ll = transformPoint([0, 0], m)
  const lr = transformPoint([1, 0], m)
  return [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]]
}

const UNIT: Rect = [0, 0, 1, 1]

export function toPageImage(occ: ImageOcc): PageImage {
  const m = occ.matrix
  const bbox = transformRect(UNIT, m)
  const visible = intersect(bbox, occ.clip) ?? [bbox[0], bbox[1], bbox[0], bbox[1]]
  const widthPt = Math.hypot(m[0], m[1])
  const det = m[0] * m[3] - m[1] * m[2]
  return {
    index: occ.index,
    kind: occ.kind,
    xref: occ.xref,
    name: occ.name,
    matrix: m,
    quad: quadOf(m),
    bbox,
    visible,
    width: occ.width,
    height: occ.height,
    nested: occ.model.kind === 'form',
    loc: occ.loc,
    dpi: widthPt > 0 ? Math.round((occ.width * 72) / widthPt) : 0,
    rotation: Math.round(((Math.atan2(m[1], m[0]) * 180) / Math.PI + 360) % 360),
    // page space has y down: an upright, unmirrored image has a negative determinant
    flipped: det > 0,
    cropped: area(visible) < area(bbox) * 0.995
  }
}

export function listPageImages(s: Session, page: number): PageImage[] {
  return buildScene(s, page).images.map(toPageImage)
}

function sameLoc(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function findImage(scene: Scene, ref: ImageRef): ImageOcc {
  const byLoc = scene.images.find((i) => sameLoc(i.loc, ref.loc) && i.xref === ref.xref)
  if (byLoc) return byLoc
  const byIndex = scene.images[ref.index]
  if (byIndex && byIndex.xref === ref.xref && byIndex.loc.length === ref.loc.length) return byIndex
  throw new EngineError('The image could not be found. The page may have changed; select the image again.', 'NO_IMAGE')
}

function copyValue(s: Session, v: PDFObject): PDFObject {
  if (safe(() => v.isIndirect(), false)) return v
  if (v.isDictionary()) return copyDict(s, v)
  if (v.isArray()) {
    const a = s.pdf.newArray()
    for (let i = 0; i < v.length; i++) a.push(copyValue(s, v.get(i)))
    return a
  }
  return v
}

function copyDict(s: Session, src: PDFObject, skip: Set<string> = new Set()): PDFObject {
  const d = s.pdf.newDictionary()
  src.forEach((v, k) => {
    if (!skip.has(String(k))) d.put(String(k), copyValue(s, v))
  })
  return d
}

/** Names already used in a resources dictionary's /XObject subdictionary. */
function xobjectDictOf(resources: PDFObject | null): PDFObject | null {
  if (!resources) return null
  const xo = safe(() => resources.get('XObject'), null)
  return isNullObj(xo) ? null : xo!.resolve()
}

function uniqueName(dicts: (PDFObject | null)[], prefix: string): string {
  for (let i = 1; i < 100000; i++) {
    const name = `${prefix}${i}`
    if (dicts.every((d) => !d || isNullObj(safe(() => d.get(name), null)))) return name
  }
  throw new EngineError('Too many resources on this page', 'RESOURCES')
}

/** The page's /XObject dictionary, created when missing (resources may be inherited and shared). */
function pageXObjects(s: Session, page: number): PDFObject {
  const pageObj = s.page(page).getObject()
  let res = safe(() => pageObj.getInheritable('Resources'), null)
  if (isNullObj(res)) {
    pageObj.put('Resources', s.pdf.newDictionary())
    res = pageObj.get('Resources')
  }
  res = res!.resolve()
  let xo = res.get('XObject')
  if (isNullObj(xo)) {
    res.put('XObject', s.pdf.newDictionary())
    xo = res.get('XObject')
  }
  return xo.resolve()
}

interface XAdd {
  name: string
  ref: PDFObject
}

const FORM_SKIP = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms'])

/** A page-private copy of a form XObject with new content (and extra XObject resources). */
function cloneForm(s: Session, model: StreamModel, bytes: Uint8Array, add: XAdd[]): PDFObject {
  const src = model.form!.resolve()
  const dict = copyDict(s, src, FORM_SKIP)
  if (add.length) {
    const res = model.resources ? copyDict(s, model.resources) : s.pdf.newDictionary()
    const oldXo = xobjectDictOf(model.resources)
    const xo = oldXo ? copyDict(s, oldXo) : s.pdf.newDictionary()
    for (const a of add) xo.put(a.name, a.ref)
    res.put('XObject', xo)
    dict.put('Resources', res)
  }
  return s.pdf.addStream(bytes, dict)
}

/** Writes edited stream data back: page content, or a copy of the form plus the edited parent. */
function commit(
  s: Session,
  page: number,
  model: StreamModel,
  splices: Splice[],
  add: XAdd[],
  pageExtra: { splices: Splice[]; add: XAdd[] } | null = null
): SpliceResult {
  if (model.kind === 'page') {
    const all = pageExtra ? [...splices, ...pageExtra.splices] : splices
    const adds = pageExtra ? [...add, ...pageExtra.add] : add
    const result = applySplices(model.bytes, all)
    if (adds.length) {
      const xo = pageXObjects(s, page)
      for (const a of adds) xo.put(a.name, a.ref)
    }
    setPageContent(s, page, model.parts ?? [], s.pdf.addStream(result.bytes, s.pdf.newDictionary()))
    return result
  }
  const result = applySplices(model.bytes, splices)
  const clone = cloneForm(s, model, result.bytes, add)
  const parent = model.parent!
  const pm = parent.model
  const pdo = pm.ops[parent.opIndex]
  const parentXo = pm.kind === 'page' ? pageXObjects(s, page) : xobjectDictOf(pm.resources)
  const name = uniqueName([parentXo], 'FcFm')
  commit(s, page, pm, [{ start: pdo.start, end: pdo.end, parts: [`/${name} Do`] }], [{ name, ref: clone }], pageExtra)
  return result
}

/** Finds the edited image again after a commit (its locator changes when bytes move). */
function relocate(s: Session, page: number, occ: ImageOcc, newLast: number | null): PageImage | null {
  const scene = buildScene(s, page)
  if (newLast !== null) {
    const loc = [...occ.loc.slice(0, -1), newLast]
    const found = scene.images.find((i) => sameLoc(i.loc, loc))
    if (found) return toPageImage(found)
  }
  return null
}

function groupRange(m: StreamModel, g: [number, number]): [number, number] {
  return [m.ops[g[0]].start, m.ops[g[1]].end]
}

function wrapWithMatrix(m: StreamModel, g: [number, number], x: Matrix): Splice {
  const [gs, ge] = g
  // Fold into the group's own leading `cm` when it has one: q A cm ... Q -> q (A x X) cm ... Q
  const cm = m.ops[gs + 1]
  if (m.ops[gs].op === 'q' && gs + 1 < ge && cm.op === 'cm' && cm.args.length === 6) {
    const a = cm.args.map((v) => opNum(v)) as Matrix
    return { start: cm.start, end: cm.end, parts: [`${fmtMatrix(multiplyMatrix(a, x))} cm`] }
  }
  return { start: m.ops[gs].start, end: m.ops[ge].end, parts: [`\nq ${fmtMatrix(x)} cm\n`, groupRange(m, g), '\nQ\n'] }
}

function isIdentity(m: Matrix): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-6)
}

/**
 * Moves group g to `at` (a byte offset at the root of the same stream) where the CTM is `ctmAt`,
 * keeping its page-space placement multiplied by `dp`.
 */
function moveGroup(m: StreamModel, g: [number, number], at: number, ctmAt: Matrix, dp: Matrix, closeDepth = 0): Splice[] {
  const w = pageSpaceOf(m, g[0])
  const x = multiplyMatrix(multiplyMatrix(w, dp), invertMatrix(multiplyMatrix(ctmAt, m.base)))
  const state = carriedState(m, g[0])
  const parts: (string | [number, number])[] = ['\n' + 'Q\n'.repeat(closeDepth) + 'q\n']
  if (!isIdentity(x)) parts.push(`${fmtMatrix(x)} cm\n`)
  for (const r of state) parts.push(r, '\n')
  parts.push(groupRange(m, g), '\nQ\n')
  const [s0, e0] = groupRange(m, g)
  return [
    { start: s0, end: e0, parts: ['\n'] },
    { start: at, end: at, parts }
  ]
}

function visibleOf(occ: ImageOcc): Rect {
  const bbox = transformRect(UNIT, occ.matrix)
  return intersect(bbox, occ.clip) ?? [bbox[0], bbox[1], bbox[0], bbox[1]]
}

/** Visible area of `box` under `clip`, compared with the area under `rootClip` (not escapable). */
function cutByClip(box: Rect, clip: Rect | null, rootClip: Rect | null): boolean {
  const a = area(intersect(box, clip))
  const b = area(intersect(box, rootClip))
  return a < b * 0.98 - 0.5
}

/** The page-level root item containing an image (following the chain of form invocations). */
function topLevel(occ: ImageOcc): { model: StreamModel; opIndex: number } {
  let model = occ.model
  let opIndex = occ.opIndex
  while (model.parent) {
    opIndex = model.parent.opIndex
    model = model.parent.model
  }
  return { model, opIndex }
}

// ---- edits ----------------------------------------------------------------------------------

/** Applies a page-space transformation (move, resize, rotate, flip) to an image. */
export function transformImage(s: Session, page: number, ref: ImageRef, dp: Matrix): PageImage | null {
  const scene = buildScene(s, page)
  const occ = findImage(scene, ref)
  const m = occ.model
  const groups = ownedGroups(m, occ.opIndex)
  const g = groups[groups.length - 1]
  const opStart = m.ops[occ.opIndex].start
  const oldBox = transformRect(UNIT, occ.matrix)
  const newBox = transformRect(UNIT, multiplyMatrix(occ.matrix, dp))
  const top = topLevel(occ)
  const pageItems = rootItems(top.model)
  const topItem = pageItems[rootItemOf(pageItems, top.opIndex)]
  const rootClip = topItem ? top.model.clip[topItem.start] : scene.bounds
  const gClip = m.clip[g[0]]
  const escape = !cutByClip(oldBox, gClip, rootClip) && cutByClip(newBox, gClip, rootClip)

  if (escape && m.kind === 'page' && topItem) {
    // An enclosing (non-root) clip would hide the moved image: lift its group out to the root,
    // right after the top-level item that contained it.
    const at = m.ops[topItem.end].end
    const splices = moveGroup(m, g, at, m.ctm[topItem.start], dp)
    const res = commit(s, page, m, splices, [])
    s.touch(page)
    return relocate(s, page, occ, res.map(opStart))
  }
  if (escape && m.kind === 'form' && topItem) {
    // The image is inside a form whose bounds (or clip) would hide it: draw it from the page
    // content instead, right after the form, and remove it from (a copy of) the form.
    const pm = top.model
    const at = pm.ops[topItem.end].end
    const ctmAt = pm.ctm[topItem.start]
    const x = multiplyMatrix(multiplyMatrix(occ.matrix, dp), invertMatrix(multiplyMatrix(ctmAt, pm.base)))
    const add: XAdd[] = []
    let draw: (string | Uint8Array)[]
    if (occ.kind === 'xobject') {
      const name = uniqueName([pageXObjects(s, page)], 'FcIm')
      add.push({ name, ref: occ.ref! })
      draw = [`\nq ${fmtMatrix(x)} cm /${name} Do Q\n`]
    } else {
      // the inline image's bytes live in the form stream: copy them into the page stream
      const o = m.ops[occ.opIndex]
      draw = [`\nq ${fmtMatrix(x)} cm\n`, m.bytes.slice(o.start, o.end), '\nQ\n']
    }
    const [s0, e0] = groupRange(m, g)
    commit(s, page, m, [{ start: s0, end: e0, parts: ['\n'] }], [], { splices: [{ start: at, end: at, parts: draw }], add })
    s.touch(page)
    const after = buildScene(s, page)
    const target = multiplyMatrix(occ.matrix, dp)
    const lifted = after.images.filter((i) => i.model.kind === 'page' && i.xref === occ.xref)
    const best = lifted.sort((a, b) => dist(a.matrix, target) - dist(b.matrix, target))[0]
    return best ? toPageImage(best) : null
  }
  const x = multiplyMatrix(multiplyMatrix(pageSpaceOf(m, g[0]), dp), invertMatrix(pageSpaceOf(m, g[0])))
  const splice = wrapWithMatrix(m, g, x)
  const res = commit(s, page, m, [splice], [])
  s.touch(page)
  return relocate(s, page, occ, res.map(opStart))
}

function dist(a: Matrix, b: Matrix): number {
  return a.reduce((acc, v, i) => acc + Math.abs(v - b[i]), 0)
}

export function deleteImage(s: Session, page: number, ref: ImageRef) {
  const scene = buildScene(s, page)
  const occ = findImage(scene, ref)
  const m = occ.model
  const groups = ownedGroups(m, occ.opIndex)
  const [s0, e0] = groupRange(m, groups[groups.length - 1])
  commit(s, page, m, [{ start: s0, end: e0, parts: ['\n'] }], [])
  s.touch(page)
}

/** Replaces the picture of an image instance, fitting the new picture inside the old bounds. */
export function replaceImage(s: Session, page: number, ref: ImageRef, bytes: Uint8Array): PageImage | null {
  const scene = buildScene(s, page)
  const occ = findImage(scene, ref)
  const m = occ.model
  const img = loadImage(s, bytes)
  const w = img.getWidth()
  const h = img.getHeight()
  const newRef = s.pdf.addImage(img)
  const xo = m.kind === 'page' ? pageXObjects(s, page) : xobjectDictOf(m.resources)
  const name = uniqueName([xo], 'FcIm')
  // Fit the new aspect ratio inside the displayed width/height, centred, keeping rotation/flip.
  const mm = occ.matrix
  const W = Math.hypot(mm[0], mm[1])
  const H = Math.hypot(mm[2], mm[3])
  let sx = 1
  let sy = 1
  if (W > 0 && H > 0 && w > 0 && h > 0) {
    const r = w / h
    if (r > W / H) sy = W / r / H
    else sx = (H * r) / W
  }
  const fit: Matrix = [sx, 0, 0, sy, (1 - sx) / 2, (1 - sy) / 2]
  const o = m.ops[occ.opIndex]
  const cm = isIdentity(fit) ? '' : `${fmtMatrix(fit)} cm `
  const text = `\nq ${cm}/${name} Do Q\n`
  const res = commit(s, page, m, [{ start: o.start, end: o.end, parts: [text] }], [{ name, ref: newRef }])
  s.touch(page)
  return relocate(s, page, occ, res.placed(0) + text.indexOf('/'))
}

/** Crops an image to a page-space rectangle (a clip path that moves with the image). */
export function cropImage(s: Session, page: number, ref: ImageRef, rect: Rect): PageImage | null {
  const scene = buildScene(s, page)
  const occ = findImage(scene, ref)
  const m = occ.model
  const bbox = transformRect(UNIT, occ.matrix)
  const r = rectIntersection(rect, bbox)
  if (!r || r[2] - r[0] < 0.5 || r[3] - r[1] < 0.5) throw new EngineError('The crop area must overlap the image', 'BAD_CROP')
  const groups = ownedGroups(m, occ.opIndex)
  const opStart = m.ops[occ.opIndex].start
  const pathIn = (ctmAt: Matrix) => {
    const inv = invertMatrix(multiplyMatrix(ctmAt, m.base))
    const pts: Point[] = [
      [r[0], r[1]],
      [r[2], r[1]],
      [r[2], r[3]],
      [r[0], r[3]]
    ].map((p) => transformPoint(p as Point, inv))
    return `${fmt(pts[0][0])} ${fmt(pts[0][1])} m ${fmt(pts[1][0])} ${fmt(pts[1][1])} l ${fmt(pts[2][0])} ${fmt(pts[2][1])} l ${fmt(pts[3][0])} ${fmt(pts[3][1])} l h W n`
  }
  // Reuse an existing crop group written by us: q x y m x y l x y l x y l h W n ...
  for (const [gs] of groups) {
    const seq = m.ops.slice(gs, gs + 8).map((o) => o.op)
    if (seq.join(' ') === 'q m l l l h W n') {
      const res = commit(s, page, m, [{ start: m.ops[gs + 1].start, end: m.ops[gs + 7].end, parts: [pathIn(m.ctm[gs])] }], [])
      s.touch(page)
      return relocate(s, page, occ, res.map(opStart))
    }
  }
  const g = groups[groups.length - 1]
  const [s0, e0] = groupRange(m, g)
  const res = commit(s, page, m, [{ start: s0, end: e0, parts: [`\nq ${pathIn(m.ctm[g[0]])}\n`, [s0, e0], '\nQ\n'] }], [])
  s.touch(page)
  return relocate(s, page, occ, res.map(opStart))
}

/** Changes the stacking order of an image relative to other page content. */
export function arrangeImage(s: Session, page: number, ref: ImageRef, where: ArrangeWhere): PageImage | null {
  const scene = buildScene(s, page)
  const occ = findImage(scene, ref)
  const m = occ.model
  const groups = ownedGroups(m, occ.opIndex)
  const g = groups[groups.length - 1]
  const opStart = m.ops[occ.opIndex].start
  const items = rootItems(m)
  const ri = rootItemOf(items, g[0])
  if (ri < 0) throw new EngineError('This image cannot be rearranged.', 'NO_CHANGE')
  const vis = visibleOf(occ)
  const overlaps = (r: Rect | null) => !!r && !!rectIntersection(r, vis)
  let at: number
  let ctmAt: Matrix
  let closeDepth = 0
  if (where === 'front') {
    const last = items[items.length - 1]
    if (ri === items.length - 1 && last?.start === g[0] && last.end === g[1])
      throw new EngineError('The image is already in front of everything else.', 'NO_CHANGE')
    at = m.bytes.length
    ctmAt = m.endRootCtm
    closeDepth = m.endDepth
  } else if (where === 'back') {
    if (ri === 0 && items[0].start === g[0] && items[0].end === g[1])
      throw new EngineError('The image is already behind everything else.', 'NO_CHANGE')
    at = 0
    ctmAt = [...IDENTITY] as Matrix
  } else if (where === 'forward') {
    let k = ri + 1
    while (k < items.length && !overlaps(items[k].bbox)) k++
    if (k >= items.length) throw new EngineError('Nothing is in front of the image.', 'NO_CHANGE')
    at = m.ops[items[k].end].end
    ctmAt = m.ctm[items[k].start]
  } else {
    let k = ri - 1
    while (k >= 0 && !overlaps(items[k].bbox)) k--
    if (k < 0) throw new EngineError('Nothing is behind the image.', 'NO_CHANGE')
    at = m.ops[items[k].start].start
    ctmAt = m.ctm[items[k].start]
  }
  const splices = moveGroup(m, g, at, ctmAt, [...IDENTITY] as Matrix, closeDepth)
  const res = commit(s, page, m, splices, [])
  s.touch(page)
  return relocate(s, page, occ, res.map(opStart))
}

export function loadImage(s: Session, bytes: Uint8Array) {
  try {
    return new s.mupdf.Image(bytes)
  } catch {
    throw new EngineError('This image format is not supported. Use a PNG, JPEG, GIF, BMP or TIFF image.', 'BAD_IMAGE')
  }
}

/** Adds an image as page content, filling `rect` (page space) upright. */
export function addImage(s: Session, page: number, bytes: Uint8Array, rect: Rect): PageImage | null {
  const img = loadImage(s, bytes)
  const scene = buildScene(s, page)
  const m = scene.pageModel
  const ref = s.pdf.addImage(img)
  const name = uniqueName([pageXObjects(s, page)], 'FcIm')
  const [x0, y0, x1, y1] = rect
  const mPage: Matrix = [x1 - x0, 0, 0, -(y1 - y0), x0, y1]
  // page space -> the content stream's own space (user space, or inside the page marks' wrapper)
  const mStream = multiplyMatrix(mPage, invertMatrix(m.base))
  const clean =
    m.endDepth === 0 &&
    isIdentity(m.endRootCtm) &&
    (!m.endRootClip || area(intersect(scene.bounds, m.endRootClip)) >= area(scene.bounds) * 0.999)
  const draw = `\nq ${fmtMatrix(mStream)} cm /${name} Do Q\n`
  const len = m.bytes.length
  const splices: Splice[] = clean
    ? [{ start: len, end: len, parts: [draw] }]
    : [
        { start: 0, end: 0, parts: ['q\n'] },
        { start: len, end: len, parts: ['\n' + 'Q\n'.repeat(m.endDepth) + 'Q\n' + draw] }
      ]
  commit(s, page, m, splices, [{ name, ref }])
  s.touch(page)
  const after = buildScene(s, page)
  const mine = after.images.filter((i) => i.xref === ref.asIndirect() && i.model.kind === 'page')
  return mine.length ? toPageImage(mine[mine.length - 1]) : null
}

// ---- pixels ---------------------------------------------------------------------------------

/** The image's pixels as PNG (with transparency from its soft mask, if any). */
export function imagePng(s: Session, page: number, ref: ImageRef): { png: Uint8Array; width: number; height: number } {
  const scene = buildScene(s, page)
  const occ = findImage(scene, ref)
  const m = s.mupdf
  let image: InstanceType<typeof m.Image> | null = null
  if (occ.kind === 'xobject' && occ.ref) image = safe(() => s.pdf.loadImage(occ.ref!), null)
  if (!image) {
    // inline image (or one MuPDF could not load directly): capture it while running the page
    const want = multiplyMatrix([1, 0, 0, -1, 0, 1], occ.matrix)
    let best: { image: InstanceType<typeof m.Image>; d: number } | null = null
    const dev = new m.Device({
      fillImage(img: InstanceType<typeof m.Image>, ctm: Matrix) {
        const d = dist(ctm as Matrix, want)
        if (!best || d < best.d) best = { image: img, d }
      },
      fillImageMask(img: InstanceType<typeof m.Image>, ctm: Matrix) {
        const d = dist(ctm as Matrix, want)
        if (!best || d < best.d) best = { image: img, d }
      }
    } as any)
    try {
      s.page(page).runPageContents(dev, m.Matrix.identity)
      dev.close()
    } finally {
      dev.destroy()
    }
    image = (best as { image: InstanceType<typeof m.Image> } | null)?.image ?? null
  }
  if (!image) throw new EngineError('The image data could not be read', 'BAD_IMAGE')
  return encodePng(s, image)
}

function encodePng(s: Session, image: InstanceType<Session['mupdf']['Image']>) {
  const m = s.mupdf
  const w = image.getWidth()
  const h = image.getHeight()
  let pix = image.toPixmap()
  const toFree: { destroy(): void }[] = [pix]
  try {
    if (image.getImageMask()) {
      // stencil mask: black where painted
      const out = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true)
      toFree.push(out)
      const src = pix.getPixels()
      const n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0)
      const dst = out.getPixels()
      for (let i = 0; i < w * h; i++) {
        const a = pix.getAlpha() ? src[i * n + n - 1] : 255 - src[i * n]
        dst[i * 4] = 0
        dst[i * 4 + 1] = 0
        dst[i * 4 + 2] = 0
        dst[i * 4 + 3] = a
      }
      return { png: out.asPNG().slice(), width: w, height: h }
    }
    const cs = pix.getColorSpace()
    if (!cs || (cs.getName() !== 'DeviceRGB' && cs.getName() !== 'DeviceGray')) {
      pix = pix.convertToColorSpace(m.ColorSpace.DeviceRGB, !!pix.getAlpha())
      toFree.push(pix)
    }
    const mask = safe(() => image.getMask(), null)
    if (!mask || pix.getAlpha()) return { png: pix.asPNG().slice(), width: w, height: h }
    // combine colour + soft mask into a premultiplied RGBA pixmap
    let mpix = mask.toPixmap()
    toFree.push(mpix)
    if (mpix.getNumberOfComponents() !== 1 || mpix.getAlpha()) {
      mpix = mpix.convertToColorSpace(m.ColorSpace.DeviceGray, false)
      toFree.push(mpix)
    }
    const rgb = pix.getColorSpace()?.getName() === 'DeviceGray' ? pix.convertToColorSpace(m.ColorSpace.DeviceRGB, false) : pix
    if (rgb !== pix) toFree.push(rgb)
    const out = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true)
    toFree.push(out)
    const src = rgb.getPixels()
    const srcStride = rgb.getStride()
    const al = mpix.getPixels()
    const mw = mpix.getWidth()
    const mh = mpix.getHeight()
    const mStride = mpix.getStride()
    const dst = out.getPixels()
    const dStride = out.getStride()
    for (let y = 0; y < h; y++) {
      const my = Math.min(mh - 1, Math.floor((y * mh) / h))
      for (let x = 0; x < w; x++) {
        const mx = Math.min(mw - 1, Math.floor((x * mw) / w))
        const a = al[my * mStride + mx]
        const si = y * srcStride + x * 3
        const di = y * dStride + x * 4
        dst[di] = Math.round((src[si] * a) / 255)
        dst[di + 1] = Math.round((src[si + 1] * a) / 255)
        dst[di + 2] = Math.round((src[si + 2] * a) / 255)
        dst[di + 3] = a
      }
    }
    return { png: out.asPNG().slice(), width: w, height: h }
  } finally {
    for (const f of toFree) safe(() => f.destroy(), undefined)
  }
}

/** Size and resolution of image file bytes (for placing an image at its natural size). */
export function probeImage(s: Session, bytes: Uint8Array): { width: number; height: number; dpiX: number; dpiY: number } {
  const img = loadImage(s, bytes)
  try {
    const declared = declaredDpi(bytes)
    return { width: img.getWidth(), height: img.getHeight(), dpiX: declared?.[0] ?? 72, dpiY: declared?.[1] ?? 72 }
  } finally {
    safe(() => img.destroy(), undefined)
  }
}

/** Resolution stored in a PNG pHYs chunk or a JPEG JFIF header, if any. */
export function declaredDpi(b: Uint8Array): [number, number] | null {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  if (b.length > 33 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    let i = 8
    while (i + 12 <= b.length) {
      const len = u32(i)
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
      if (type === 'pHYs' && len >= 9) {
        const px = u32(i + 8)
        const py = u32(i + 12)
        if (b[i + 16] === 1 && px > 0 && py > 0) {
          const dx = px * 0.0254
          const dy = py * 0.0254
          if (dx >= 30 && dy >= 30) return [dx, dy]
        }
        return null
      }
      if (type === 'IDAT' || type === 'IEND') return null
      i += 12 + len
    }
    return null
  }
  if (b.length > 18 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 4 < b.length && b[i] === 0xff) {
      const marker = b[i + 1]
      const len = (b[i + 2] << 8) | b[i + 3]
      if (marker === 0xe0 && b[i + 4] === 0x4a && b[i + 5] === 0x46 && b[i + 6] === 0x49 && b[i + 7] === 0x46) {
        const units = b[i + 11]
        const dx = (b[i + 12] << 8) | b[i + 13]
        const dy = (b[i + 14] << 8) | b[i + 15]
        if (units === 1 && dx >= 30 && dy >= 30) return [dx, dy]
        if (units === 2 && dx >= 12 && dy >= 12) return [dx * 2.54, dy * 2.54]
        return null
      }
      if (marker === 0xda) return null
      i += 2 + len
    }
  }
  return null
}


