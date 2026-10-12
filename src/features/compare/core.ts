/**
 * The comparison itself: page alignment, word-level diff, change classification and the visual
 * (pixel) diff. Pure functions with no DOM or engine access, so they run in the compare Web Worker
 * and in unit tests alike.
 */
import { diffArrays } from 'diff'
import type { Rect } from '@shared/geometry'
import {
  categoryOf,
  THUMB_H,
  THUMB_W,
  type AlignRow,
  type Change,
  type ChangeCategory,
  type ChangeSide,
  type ChangeType,
  type CompareOptions,
  type CompareResult,
  type PageTokens,
  type Raster,
  type TextCompareResult,
  type Token,
  type VisualRegion
} from './types'

const FONT_BOLD = 1
const FONT_ITALIC = 2

/** Pages less similar than this are never paired as "the same page". */
export const MIN_PAGE_SIMILARITY = 0.12
/** Out-of-order pages at least this similar are reported as moved. */
export const MOVE_SIMILARITY = 0.5
/** Share of a page's words that must be new (or gone) to call it an added (removed) page. */
const PAGE_CHANGE_SHARE = 0.8
/** Above this many page pairs the similarity matrix is skipped and pages are paired in order. */
const MAX_MATRIX_CELLS = 4_000_000

export type ProgressFn = (fraction: number, message: string) => void

// ---- tokens -------------------------------------------------------------------------------------

/** The string two tokens are compared by. */
export function tokenKey(t: Token, opts: Pick<CompareOptions, 'ignoreCase' | 'ignoreWhitespace'>): string {
  const w = opts.ignoreCase ? t.norm.toLowerCase() : t.norm
  return opts.ignoreWhitespace ? w : t.ws + w
}

/** Joins tokens back into readable text. */
export function joinTokens(toks: Token[]): string {
  let s = ''
  toks.forEach((t, i) => {
    s += (i > 0 && t.ws ? ' ' : '') + t.text
  })
  return s
}

function isWordish(w: string) {
  return /[\p{L}\p{N}]/u.test(w)
}

// ---- page alignment -----------------------------------------------------------------------------

function wordBag(p: PageTokens): Map<string, number> {
  const words = p.tokens.map((t) => t.norm.toLowerCase()).filter(isWordish)
  const bag = new Map<string, number>()
  if (words.length < 3) {
    for (const w of words) bag.set(w, (bag.get(w) ?? 0) + 1)
  } else {
    for (let i = 0; i + 1 < words.length; i++) {
      const k = words[i] + ' ' + words[i + 1]
      bag.set(k, (bag.get(k) ?? 0) + 1)
    }
  }
  return bag
}

function thumbSimilarity(a: Uint8Array | null, b: Uint8Array | null): number | null {
  if (!a || !b || a.length !== b.length || a.length !== THUMB_W * THUMB_H) return null
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  const mad = sum / a.length
  return Math.max(0, 1 - mad / 48)
}

/**
 * Similarity (0..1) of every old page with every new page: Dice coefficient of their word-pair
 * multisets. Word pairs that occur on a large share of pages (running headers, boilerplate) are
 * ignored in long documents. Pages without words are compared by thumbnail.
 */
export function similarityMatrix(oldPages: PageTokens[], newPages: PageTokens[]): Float32Array {
  const N = oldPages.length
  const M = newPages.length
  const sim = new Float32Array(N * M)
  const newBags = newPages.map(wordBag)
  const index = new Map<string, { j: number; c: number }[]>()
  newBags.forEach((bag, j) => {
    for (const [k, c] of bag) {
      let postings = index.get(k)
      if (!postings) index.set(k, (postings = []))
      postings.push({ j, c })
    }
  })
  const maxDf = M > 20 ? Math.max(8, Math.ceil(M * 0.3)) : Infinity
  const usable = (k: string) => {
    const p = index.get(k)
    return !p || p.length <= maxDf
  }
  const newTotals = newBags.map((bag) => {
    let t = 0
    for (const [k, c] of bag) if (usable(k)) t += c
    return t
  })
  const inter = new Float64Array(M)
  for (let i = 0; i < N; i++) {
    inter.fill(0)
    const bag = wordBag(oldPages[i])
    let total = 0
    for (const [k, c] of bag) {
      if (!usable(k)) continue
      total += c
      const postings = index.get(k)
      if (!postings) continue
      for (const { j, c: c2 } of postings) inter[j] += Math.min(c, c2)
    }
    for (let j = 0; j < M; j++) {
      const denom = total + newTotals[j]
      let s: number
      if (total === 0 && newTotals[j] === 0) {
        s = thumbSimilarity(oldPages[i].thumb, newPages[j].thumb) ?? 0.6
      } else if (total === 0 || newTotals[j] === 0) {
        s = 0
      } else {
        s = (2 * inter[j]) / denom
      }
      sim[i * M + j] = s
    }
  }
  return sim
}

export interface Alignment {
  /** In-order pairs (old index, new index) into the page arrays. */
  pairs: [number, number][]
  /** Pages that moved: (old index, new index). */
  moved: [number, number][]
  /** Rows for the side-by-side view, as indices into the page arrays. */
  rows: AlignRow[]
}

/**
 * Matches old pages to new pages. An order-preserving alignment (maximum total similarity, like a
 * sequence alignment) finds pages that stayed in place; the remaining very similar pages are
 * reported as moved. Everything else is an added or removed page (or a rewritten one).
 */
export function alignPages(oldPages: PageTokens[], newPages: PageTokens[]): Alignment {
  const N = oldPages.length
  const M = newPages.length
  const pairs: [number, number][] = []
  let sim: Float32Array | null = null
  if (N * M <= MAX_MATRIX_CELLS) {
    sim = similarityMatrix(oldPages, newPages)
    const dirs = new Uint8Array(N * M)
    let prev = new Float64Array(M + 1)
    let cur = new Float64Array(M + 1)
    for (let i = 1; i <= N; i++) {
      cur[0] = 0
      for (let j = 1; j <= M; j++) {
        let best = prev[j]
        let dir = 1
        if (cur[j - 1] > best) {
          best = cur[j - 1]
          dir = 2
        }
        const w = sim[(i - 1) * M + (j - 1)]
        if (w >= MIN_PAGE_SIMILARITY) {
          // Among equally good alignments prefer pages that stayed near their old position, so
          // the page that actually moved is the one reported as moved.
          const cand = prev[j - 1] + w - 0.01 * Math.abs((i - 1) / N - (j - 1) / M)
          if (cand >= best - 1e-9) {
            best = cand
            dir = 0
          }
        }
        cur[j] = best
        dirs[(i - 1) * M + (j - 1)] = dir
      }
      ;[prev, cur] = [cur, prev]
    }
    let i = N
    let j = M
    while (i > 0 && j > 0) {
      const d = dirs[(i - 1) * M + (j - 1)]
      if (d === 0) {
        pairs.push([i - 1, j - 1])
        i--
        j--
      } else if (d === 1) i--
      else j--
    }
    pairs.reverse()
  } else {
    // Huge documents: pair pages in order.
    for (let k = 0; k < Math.min(N, M); k++) pairs.push([k, k])
  }

  // Moved pages: unmatched pages that are very similar to an unmatched page on the other side.
  const moved: [number, number][] = []
  if (sim) {
    const matchedOld = new Set(pairs.map((p) => p[0]))
    const matchedNew = new Set(pairs.map((p) => p[1]))
    const cands: [number, number, number][] = []
    for (let i = 0; i < N; i++) {
      if (matchedOld.has(i)) continue
      for (let j = 0; j < M; j++) {
        if (matchedNew.has(j)) continue
        const s = sim[i * M + j]
        const textless = oldPages[i].tokens.length === 0 || newPages[j].tokens.length === 0
        const enough = textless
          ? (thumbSimilarity(oldPages[i].thumb, newPages[j].thumb) ?? 0) >= 0.92
          : oldPages[i].tokens.length >= 4 && newPages[j].tokens.length >= 4
        if (s >= MOVE_SIMILARITY && enough) cands.push([i, j, s])
      }
    }
    cands.sort((a, b) => b[2] - a[2])
    const usedOld = new Set<number>()
    const usedNew = new Set<number>()
    for (const [i, j] of cands) {
      if (usedOld.has(i) || usedNew.has(j)) continue
      usedOld.add(i)
      usedNew.add(j)
      moved.push([i, j])
    }
  }

  // Rows: matched pairs in order; between them, the unmatched pages of that stretch side by side.
  const movedOld = new Map(moved.map(([i, j]) => [i, j]))
  const movedNew = new Map(moved.map(([i, j]) => [j, i]))
  const rows: AlignRow[] = []
  let pi = 0
  let pj = 0
  for (const [i, j] of [...pairs, [N, M] as [number, number]]) {
    const gapOld: number[] = []
    for (let k = pi; k < i; k++) if (!movedOld.has(k)) gapOld.push(k)
    let q = 0
    for (let k = pj; k < j; k++) {
      if (movedNew.has(k)) rows.push({ old: movedNew.get(k)!, new: k, kind: 'moved' })
      else rows.push({ old: q < gapOld.length ? gapOld[q++] : null, new: k, kind: 'gap' })
    }
    while (q < gapOld.length) rows.push({ old: gapOld[q++], new: null, kind: 'gap' })
    if (i < N && j < M) rows.push({ old: i, new: j, kind: 'match' })
    pi = i + 1
    pj = j + 1
  }
  return { pairs, moved, rows }
}

// ---- word diff ----------------------------------------------------------------------------------

interface STok {
  tok: Token
  /** Page index in the document. */
  page: number
}

interface Piece {
  page: number
  toks: STok[]
}

interface RawChange {
  type: ChangeType
  oldToks: STok[]
  newToks: STok[]
  old: ChangeSide | null
  new: ChangeSide | null
  detail: string
  oldText?: string
  newText?: string
}

function splitByPage(toks: STok[]): Piece[] {
  const out: Piece[] = []
  for (const t of toks) {
    const last = out[out.length - 1]
    if (last && last.page === t.page) last.toks.push(t)
    else out.push({ page: t.page, toks: [t] })
  }
  return out
}

function sideOf(piece: Piece): ChangeSide {
  return { page: piece.page, rects: mergeLineRects(piece.toks.flatMap((t) => t.tok.rects)) }
}

/** Merges word boxes on the same line into one box per line run (tidier highlights). */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const out: Rect[] = []
  for (const r of rects) {
    const last = out[out.length - 1]
    if (last) {
      const h = Math.min(last[3] - last[1], r[3] - r[1])
      const overlapY = Math.min(last[3], r[3]) - Math.max(last[1], r[1])
      const gap = r[0] - last[2]
      if (overlapY > h * 0.5 && gap > -2 && gap < Math.max(12, h * 1.5)) {
        out[out.length - 1] = [Math.min(last[0], r[0]), Math.min(last[1], r[1]), Math.max(last[2], r[2]), Math.max(last[3], r[3])]
        continue
      }
    }
    out.push([...r] as Rect)
  }
  return out
}

/**
 * A position marker in a stream: right after token `before`, or right before token `after`.
 * Prefers the token on `preferPage` (the page shown next to the change).
 */
function anchorAt(stream: STok[], before: number, after: number, preferPage: number | null): ChangeSide | null {
  const prev = before >= 0 && before < stream.length ? stream[before] : null
  const next = after >= 0 && after < stream.length ? stream[after] : null
  let usePrev = !!prev
  if (prev && next && preferPage !== null && prev.page !== preferPage && next.page === preferPage) usePrev = false
  if (usePrev && prev) {
    const r = prev.tok.rects[prev.tok.rects.length - 1]
    return { page: prev.page, rects: [[r[2], r[1], r[2] + 1, r[3]]], anchor: true }
  }
  if (next) {
    const r = next.tok.rects[0]
    return { page: next.page, rects: [[r[0] - 1, r[1], r[0], r[3]]], anchor: true }
  }
  return null
}

function fontLabel(t: Token): string {
  let name = t.font || 'unknown font'
  if (t.flags & FONT_BOLD && !/bold|black|heavy/i.test(name)) name += ' Bold'
  if (t.flags & FONT_ITALIC && !/italic|oblique/i.test(name)) name += ' Italic'
  return name
}

function hexColor(c: number) {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase()
}

function colorDistance(a: number, b: number) {
  const d = (s: number) => Math.abs(((a >> s) & 255) - ((b >> s) & 255))
  return Math.max(d(16), d(8), d(0))
}

/** Plain-language description of how two occurrences of the same word are formatted differently. */
export function formattingDifference(a: Token, b: Token): string | null {
  if (!a.font || !b.font) return null
  const parts: string[] = []
  if (fontLabel(a) !== fontLabel(b)) parts.push(`font ${fontLabel(a)} → ${fontLabel(b)}`)
  if (Math.abs(a.size - b.size) > 0.25) parts.push(`size ${+a.size.toFixed(1)} → ${+b.size.toFixed(1)} pt`)
  if (colorDistance(a.color, b.color) > 48) parts.push(`colour ${hexColor(a.color)} → ${hexColor(b.color)}`)
  if (!parts.length) return null
  const s = parts.join('; ')
  return s[0].toUpperCase() + s.slice(1)
}

interface SegmentResult {
  changes: RawChange[]
  ok: boolean
}

interface SegmentContext {
  opts: CompareOptions
  /** Page shown next to an old page (and vice versa), for choosing anchors. */
  oldToNew: Map<number, number>
  newToOld: Map<number, number>
}

function squash(toks: STok[], opts: CompareOptions) {
  return toks.map((t) => (opts.ignoreCase ? t.tok.norm.toLowerCase() : t.tok.norm)).join('')
}

interface Block {
  eq: boolean
  o0: number
  o1: number
  n0: number
  n1: number
}

const charLen = (s: STok[], from: number, to: number) => {
  let n = 0
  for (let k = from; k < to; k++) n += s[k].tok.norm.length
  return n
}

/** How well an inserted/deleted run [s0, s1) of a stream lines up with page and line breaks. */
function boundaryScore(S: STok[], s0: number, s1: number): number {
  const pageStart = s0 === 0 || S[s0].page !== S[s0 - 1].page
  const pageEnd = s1 >= S.length || S[s1 - 1].page !== S[s1].page
  const lineStart = pageStart || S[s0].tok.line !== S[s0 - 1].tok.line
  const lineEnd = pageEnd || S[s1 - 1].tok.line !== S[s1].tok.line
  return (pageStart ? 4 : 0) + (pageEnd ? 4 : 0) + (lineStart ? 1 : 0) + (lineEnd ? 1 : 0)
}

/**
 * A pure insertion or deletion next to equal words can often be placed in several equivalent
 * positions ("Section 40 … Section" vs "… Section 41"). Slides each one to the position that
 * best matches page and line breaks, so a removed page is reported as exactly that page.
 */
function slideEdits(blocks: Block[], oldS: STok[], newS: STok[]) {
  const key = (S: STok[], i: number) => S[i].tok.norm
  for (let k = 0; k < blocks.length; k++) {
    const e = blocks[k]
    if (e.eq) continue
    const del = e.n0 === e.n1
    const ins = e.o0 === e.o1
    if (del === ins) continue
    const prev = blocks[k - 1]?.eq ? blocks[k - 1] : null
    const next = blocks[k + 1]?.eq ? blocks[k + 1] : null
    const S = del ? oldS : newS
    const s0 = del ? e.o0 : e.n0
    const s1 = del ? e.o1 : e.n1
    let left = 0
    while (prev && prev.o1 - prev.o0 - left > 1 && key(S, s0 - left - 1) === key(S, s1 - left - 1)) left++
    let right = 0
    while (next && next.o1 - next.o0 - right > 1 && s1 + right < S.length && key(S, s0 + right) === key(S, s1 + right)) right++
    if (!left && !right) continue
    let best = 0
    let bestScore = boundaryScore(S, s0, s1)
    for (let d = -left; d <= right; d++) {
      const sc = boundaryScore(S, s0 + d, s1 + d)
      if (sc > bestScore || (sc === bestScore && Math.abs(d) < Math.abs(best))) {
        best = d
        bestScore = sc
      }
    }
    if (!best) continue
    if (prev) {
      prev.o1 += best
      prev.n1 += best
    }
    e.o0 += best
    e.o1 += best
    e.n0 += best
    e.n1 += best
    if (next) {
      next.o0 += best
      next.n0 += best
    }
  }
}

/**
 * Turns diff parts into hunks, first absorbing short runs of equal words that sit between larger
 * edits ("…days. Late payments incur a fee of 2%." vs "…days of the invoice date." should not
 * keep the lone "of" in common). Same rule as diff-match-patch's semantic cleanup.
 */
function cleanupSemantic(
  parts: { added: boolean; removed: boolean; count: number }[],
  oldS: STok[],
  newS: STok[]
): { hunks: { o0: number; o1: number; n0: number; n1: number }[]; common: [number, number][] } {
  const blocks: Block[] = []
  let oi = 0
  let ni = 0
  for (const p of parts) {
    const eq = !p.added && !p.removed
    const last = blocks[blocks.length - 1]
    const b: Block = last && !last.eq && !eq ? last : { eq, o0: oi, o1: oi, n0: ni, n1: ni }
    if (b !== last) blocks.push(b)
    if (p.added) ni += p.count
    else if (p.removed) oi += p.count
    else {
      oi += p.count
      ni += p.count
    }
    b.o1 = oi
    b.n1 = ni
  }
  slideEdits(blocks, oldS, newS)
  const editSize = (b: Block) => Math.max(charLen(oldS, b.o0, b.o1), charLen(newS, b.n0, b.n1))
  let changed = true
  while (changed) {
    changed = false
    for (let k = 1; k + 1 < blocks.length; k++) {
      const e = blocks[k]
      if (!e.eq || blocks[k - 1].eq || blocks[k + 1].eq) continue
      const len = charLen(oldS, e.o0, e.o1)
      if (e.o1 - e.o0 <= 4 && len < editSize(blocks[k - 1]) && len < editSize(blocks[k + 1])) {
        const p = blocks[k - 1]
        const n = blocks[k + 1]
        blocks.splice(k - 1, 3, { eq: false, o0: p.o0, o1: n.o1, n0: p.n0, n1: n.n1 })
        changed = true
        break
      }
    }
  }
  const hunks: { o0: number; o1: number; n0: number; n1: number }[] = []
  const common: [number, number][] = []
  for (const b of blocks) {
    if (b.eq) for (let k = 0; k < b.o1 - b.o0; k++) common.push([b.o0 + k, b.n0 + k])
    else hunks.push({ o0: b.o0, o1: b.o1, n0: b.n0, n1: b.n1 })
  }
  return { hunks, common }
}

/** Diffs two token streams. Returns ok=false when the diff gave up (timeout). */
function diffSegment(oldS: STok[], newS: STok[], ctx: SegmentContext, timeout: number): SegmentResult {
  const { opts } = ctx
  const a = oldS.map((t) => tokenKey(t.tok, opts))
  const b = newS.map((t) => tokenKey(t.tok, opts))
  const parts = diffArrays(a, b, { timeout })
  if (!parts) return { changes: [], ok: false }
  const { hunks, common } = cleanupSemantic(parts, oldS, newS)

  const changes: RawChange[] = []
  for (const h of hunks) {
    const R = oldS.slice(h.o0, h.o1)
    const A = newS.slice(h.n0, h.n1)
    if (R.length && A.length) {
      const same = squash(R, opts) === squash(A, opts)
      // The same characters split differently by spaces.
      if (same && opts.ignoreWhitespace) continue
      if (same) {
        changes.push({
          type: 'formatting',
          oldToks: R,
          newToks: A,
          old: sideOf(splitByPage(R)[0]),
          new: sideOf(splitByPage(A)[0]),
          detail: 'Spacing changed'
        })
        continue
      }
    }
    const rp = splitByPage(R)
    const ap = splitByPage(A)
    for (let k = 0; k < Math.max(rp.length, ap.length); k++) {
      const r = rp[k]
      const n = ap[k]
      if (r && n) {
        changes.push({ type: 'replaced', oldToks: r.toks, newToks: n.toks, old: sideOf(r), new: sideOf(n), detail: '' })
      } else if (r) {
        const before = A.length ? h.n1 - 1 : h.n0 - 1
        const anchor = anchorAt(newS, before, h.n1, ctx.oldToNew.get(r.page) ?? null)
        changes.push({ type: 'deleted', oldToks: r.toks, newToks: [], old: sideOf(r), new: anchor, detail: '' })
      } else if (n) {
        const before = R.length ? h.o1 - 1 : h.o0 - 1
        const anchor = anchorAt(oldS, before, h.o1, ctx.newToOld.get(n.page) ?? null)
        changes.push({ type: 'inserted', oldToks: [], newToks: n.toks, old: anchor, new: sideOf(n), detail: '' })
      }
    }
  }

  // Same words, different look.
  if (opts.formatting) {
    let group: { o: STok[]; n: STok[]; detail: string; lastO: number; lastN: number } | null = null
    const flush = () => {
      if (!group) return
      changes.push({
        type: 'formatting',
        oldToks: group.o,
        newToks: group.n,
        old: sideOf(splitByPage(group.o)[0]),
        new: sideOf(splitByPage(group.n)[0]),
        detail: group.detail
      })
      group = null
    }
    for (const [o, n] of common) {
      const ot = oldS[o]
      const nt = newS[n]
      const detail = formattingDifference(ot.tok, nt.tok)
      if (!detail) {
        flush()
        continue
      }
      const g = group as { o: STok[]; n: STok[]; detail: string; lastO: number; lastN: number } | null
      if (
        g &&
        g.detail === detail &&
        g.lastO === o - 1 &&
        g.lastN === n - 1 &&
        g.o[0].page === ot.page &&
        g.n[0].page === nt.page
      ) {
        g.o.push(ot)
        g.n.push(nt)
        g.lastO = o
        g.lastN = n
      } else {
        flush()
        group = { o: [ot], n: [nt], detail, lastO: o, lastN: n }
      }
    }
    flush()
  }
  return { changes, ok: true }
}

function streamOf(pages: PageTokens[], indices: number[]): STok[] {
  const out: STok[] = []
  for (const i of indices) for (const tok of pages[i].tokens) out.push({ tok, page: pages[i].page })
  return out
}

/** Whole-page replacement used when even a page-by-page diff gives up. */
function wholeReplace(oldS: STok[], newS: STok[]): RawChange[] {
  if (!oldS.length && !newS.length) return []
  if (!oldS.length) {
    const n = splitByPage(newS)[0]
    return [{ type: 'inserted', oldToks: [], newToks: newS, old: null, new: sideOf(n), detail: '' }]
  }
  if (!newS.length) {
    const r = splitByPage(oldS)[0]
    return [{ type: 'deleted', oldToks: oldS, newToks: [], old: sideOf(r), new: null, detail: '' }]
  }
  return [
    {
      type: 'replaced',
      oldToks: oldS,
      newToks: newS,
      old: sideOf(splitByPage(oldS)[0]),
      new: sideOf(splitByPage(newS)[0]),
      detail: ''
    }
  ]
}

function pageRect(p: PageTokens): Rect {
  return [0, 0, p.width, p.height]
}

/**
 * Compares the text of two documents. `oldPages`/`newPages` hold the pages to compare (after the
 * page range was applied). Returns rows for the side-by-side view and every text and page change.
 */
export function compareText(
  oldPages: PageTokens[],
  newPages: PageTokens[],
  opts: CompareOptions,
  progress?: ProgressFn,
  timeouts = { whole: 4000, page: 1500 }
): TextCompareResult {
  progress?.(0, 'Matching pages')
  const al = alignPages(oldPages, newPages)
  const oldIdx = new Map(oldPages.map((p, i) => [p.page, i]))
  const newIdx = new Map(newPages.map((p, i) => [p.page, i]))

  const oldToNew = new Map<number, number>()
  const newToOld = new Map<number, number>()
  for (const r of al.rows) {
    if (r.old !== null && r.new !== null) {
      oldToNew.set(oldPages[r.old].page, newPages[r.new].page)
      newToOld.set(newPages[r.new].page, oldPages[r.old].page)
    }
  }
  const ctx: SegmentContext = { opts, oldToNew, newToOld }

  progress?.(0.2, 'Comparing text')
  const movedOld = new Set(al.moved.map((m) => m[0]))
  const movedNew = new Set(al.moved.map((m) => m[1]))
  const mainOld = oldPages.map((_, i) => i).filter((i) => !movedOld.has(i))
  const mainNew = newPages.map((_, i) => i).filter((i) => !movedNew.has(i))
  let raw: RawChange[] = []
  let pageByPage = false
  const whole = diffSegment(streamOf(oldPages, mainOld), streamOf(newPages, mainNew), ctx, timeouts.whole)
  if (whole.ok) raw.push(...whole.changes)
  else {
    // Too different for a whole-document diff: compare row by row.
    pageByPage = true
    al.rows.forEach((r, k) => {
      if (r.kind === 'moved') return
      const o = r.old !== null ? streamOf(oldPages, [r.old]) : []
      const n = r.new !== null ? streamOf(newPages, [r.new]) : []
      const seg = diffSegment(o, n, ctx, timeouts.page)
      raw.push(...(seg.ok ? seg.changes : wholeReplace(o, n)))
      progress?.(0.2 + (0.6 * (k + 1)) / al.rows.length, 'Comparing text page by page')
    })
  }
  for (const [i, j] of al.moved) {
    const o = streamOf(oldPages, [i])
    const n = streamOf(newPages, [j])
    const seg = diffSegment(o, n, ctx, timeouts.page)
    raw.push(...(seg.ok ? seg.changes : wholeReplace(o, n)))
  }
  progress?.(0.85, 'Classifying changes')

  // Page-level changes: pages in unmatched rows whose text is (almost) all new or all gone.
  const pageChanges: RawChange[] = []
  const addedPages = new Set<number>()
  const removedPages = new Set<number>()
  const tokenCount = (pages: PageTokens[], idx: Map<number, number>, page: number) => pages[idx.get(page)!].tokens.length
  for (const r of al.rows) {
    if (r.kind !== 'gap') continue
    if (r.new !== null) {
      const page = newPages[r.new].page
      const total = tokenCount(newPages, newIdx, page)
      const covered = raw
        .filter((c) => c.type === 'inserted' || c.type === 'replaced')
        .reduce((acc, c) => acc + c.newToks.filter((t) => t.page === page).length, 0)
      if (total === 0 || covered / total >= PAGE_CHANGE_SHARE) addedPages.add(page)
    }
    if (r.old !== null) {
      const page = oldPages[r.old].page
      const total = tokenCount(oldPages, oldIdx, page)
      const covered = raw
        .filter((c) => c.type === 'deleted' || c.type === 'replaced')
        .reduce((acc, c) => acc + c.oldToks.filter((t) => t.page === page).length, 0)
      if (total === 0 || covered / total >= PAGE_CHANGE_SHARE) removedPages.add(page)
    }
  }
  if (addedPages.size || removedPages.size) {
    const onAdded = (c: RawChange) => c.newToks.length > 0 && c.newToks.every((t) => addedPages.has(t.page))
    const onRemoved = (c: RawChange) => c.oldToks.length > 0 && c.oldToks.every((t) => removedPages.has(t.page))
    raw = raw.flatMap((c): RawChange[] => {
      const a = onAdded(c)
      const r = onRemoved(c)
      if (c.type === 'inserted' && a) return []
      if (c.type === 'deleted' && r) return []
      if (c.type === 'replaced' || c.type === 'formatting') {
        if (a && r) return []
        if (a) return c.type === 'replaced' ? [{ ...c, type: 'deleted', newToks: [], new: null }] : []
        if (r) return c.type === 'replaced' ? [{ ...c, type: 'inserted', oldToks: [], old: null }] : []
      }
      return [c]
    })
    for (const page of removedPages) {
      const p = oldPages[oldIdx.get(page)!]
      pageChanges.push({ type: 'pageRemoved', oldToks: [], newToks: [], old: { page, rects: [pageRect(p)] }, new: null, detail: '' })
    }
    for (const page of addedPages) {
      const p = newPages[newIdx.get(page)!]
      pageChanges.push({ type: 'pageAdded', oldToks: [], newToks: [], old: null, new: { page, rects: [pageRect(p)] }, detail: '' })
    }
  }
  for (const [i, j] of al.moved) {
    pageChanges.push({
      type: 'pageMoved',
      oldToks: [],
      newToks: [],
      old: { page: oldPages[i].page, rects: [pageRect(oldPages[i])] },
      new: { page: newPages[j].page, rects: [pageRect(newPages[j])] },
      detail: ''
    })
  }

  const rows: AlignRow[] = al.rows.map((r) => ({
    old: r.old === null ? null : oldPages[r.old].page,
    new: r.new === null ? null : newPages[r.new].page,
    kind: r.kind
  }))
  const visualPairs = rows
    .filter((r) => (r.kind === 'match' || r.kind === 'moved') && r.old !== null && r.new !== null)
    .map((r) => [r.old!, r.new!] as [number, number])
  const changes: Change[] = [...pageChanges, ...raw].map((c) => ({
    id: 0,
    type: c.type,
    oldText: c.oldText ?? joinTokens(c.oldToks.map((t) => t.tok)),
    newText: c.newText ?? joinTokens(c.newToks.map((t) => t.tok)),
    detail: c.detail,
    old: c.old,
    new: c.new
  }))
  progress?.(1, 'Done')
  return { rows, changes, visualPairs, pageByPage }
}

// ---- visual diff ----------------------------------------------------------------------------------

const CELL = 4

/**
 * Finds areas where two page renders differ, ignoring text (text is compared word by word).
 * Both rasters must be rendered at the same pixel width. Returns rectangles in each page's space.
 */
export function visualDiff(
  a: Raster,
  b: Raster,
  oldPage: { width: number; height: number; textRects: Rect[]; imageRects: Rect[] },
  newPage: { width: number; height: number; textRects: Rect[]; imageRects: Rect[] }
): VisualRegion[] {
  const W = Math.min(a.width, b.width)
  const H = Math.max(a.height, b.height)
  if (W <= 0 || H <= 0) return []
  const sxA = a.width / oldPage.width
  const syA = a.height / oldPage.height
  const sxB = b.width / newPage.width
  const syB = b.height / newPage.height
  const mask = new Uint8Array(W * H)
  const paint = (r: Rect, sx: number, sy: number) => {
    const pad = 1.5
    const x0 = Math.max(0, Math.floor(r[0] * sx - pad))
    const y0 = Math.max(0, Math.floor(r[1] * sy - pad))
    const x1 = Math.min(W, Math.ceil(r[2] * sx + pad))
    const y1 = Math.min(H, Math.ceil(r[3] * sy + pad))
    for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, y * W + Math.max(x0, x1))
  }
  for (const r of oldPage.textRects) paint(r, sxA, syA)
  for (const r of newPage.textRects) paint(r, sxB, syB)

  const cw = Math.ceil(W / CELL)
  const ch = Math.ceil(H / CELL)
  const cells = new Uint16Array(cw * ch)
  const strideA = a.width * 3
  const strideB = b.width * 3
  for (let y = 0; y < H; y++) {
    const inA = y < a.height
    const inB = y < b.height
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) continue
      let ra = 255,
        ga = 255,
        ba = 255,
        rb = 255,
        gb = 255,
        bb = 255
      if (inA) {
        const k = y * strideA + x * 3
        ra = a.data[k]
        ga = a.data[k + 1]
        ba = a.data[k + 2]
      }
      if (inB) {
        const k = y * strideB + x * 3
        rb = b.data[k]
        gb = b.data[k + 1]
        bb = b.data[k + 2]
      }
      const d = Math.max(Math.abs(ra - rb), Math.abs(ga - gb), Math.abs(ba - bb))
      if (d > 40) cells[((y / CELL) | 0) * cw + ((x / CELL) | 0)]++
    }
  }
  const on = new Uint8Array(cw * ch)
  for (let i = 0; i < on.length; i++) on[i] = cells[i] >= 2 ? 1 : 0
  // Dilate by one cell so nearby specks join one region.
  const grown = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      if (!on[y * cw + x]) continue
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) grown[yy * cw + xx] = 1
        }
    }
  const label = new Int32Array(cw * ch).fill(-1)
  let boxes: { x0: number; y0: number; x1: number; y1: number; px: number }[] = []
  const stack: number[] = []
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || label[start] >= 0) continue
    const id = boxes.length
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, px: 0 }
    label[start] = id
    stack.push(start)
    while (stack.length) {
      const c = stack.pop()!
      const x = c % cw
      const y = (c / cw) | 0
      if (on[c]) {
        box.x0 = Math.min(box.x0, x)
        box.y0 = Math.min(box.y0, y)
        box.x1 = Math.max(box.x1, x + 1)
        box.y1 = Math.max(box.y1, y + 1)
        box.px += cells[c]
      }
      const nb = [x > 0 ? c - 1 : -1, x < cw - 1 ? c + 1 : -1, y > 0 ? c - cw : -1, y < ch - 1 ? c + cw : -1]
      for (const n of nb) {
        if (n >= 0 && grown[n] && label[n] < 0) {
          label[n] = id
          stack.push(n)
        }
      }
    }
    boxes.push(box)
  }
  boxes = boxes.filter((bx) => bx.px >= 8 && Number.isFinite(bx.x0))
  // Merge boxes that touch or nearly touch.
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i]
        const q = boxes[j]
        if (p.x0 <= q.x1 + 2 && q.x0 <= p.x1 + 2 && p.y0 <= q.y1 + 2 && q.y0 <= p.y1 + 2) {
          boxes[i] = {
            x0: Math.min(p.x0, q.x0),
            y0: Math.min(p.y0, q.y0),
            x1: Math.max(p.x1, q.x1),
            y1: Math.max(p.y1, q.y1),
            px: p.px + q.px
          }
          boxes.splice(j, 1)
          merged = true
          break outer
        }
      }
  }
  const intersects = (r: Rect, s: Rect) => r[0] < s[2] && r[2] > s[0] && r[1] < s[3] && r[3] > s[1]
  return boxes
    .sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0)
    .map((bx) => {
      const px: Rect = [bx.x0 * CELL, bx.y0 * CELL, Math.min(W, bx.x1 * CELL), Math.min(H, bx.y1 * CELL)]
      const clamp = (r: Rect, w: number, h: number): Rect => [
        Math.max(0, r[0]),
        Math.max(0, r[1]),
        Math.min(w, r[2]),
        Math.min(h, r[3])
      ]
      const oldRect = clamp([px[0] / sxA, px[1] / syA, px[2] / sxA, px[3] / syA], oldPage.width, oldPage.height)
      const newRect = clamp([px[0] / sxB, px[1] / syB, px[2] / sxB, px[3] / syB], newPage.width, newPage.height)
      const inOld = oldPage.imageRects.some((r) => intersects(r, oldRect))
      const inNew = newPage.imageRects.some((r) => intersects(r, newRect))
      const detail = inOld && inNew ? 'Image changed' : inNew ? 'Image added' : inOld ? 'Image removed' : 'Graphics changed'
      return { oldRect, newRect, detail }
    })
}

// ---- results ------------------------------------------------------------------------------------

export function emptyCounts(): Record<ChangeCategory, number> {
  return { replaced: 0, inserted: 0, deleted: 0, formatting: 0, image: 0, page: 0 }
}

/** Orders changes as they appear in the side-by-side view, numbers them and counts them. */
export function finalizeResult(
  text: TextCompareResult,
  visual: { oldPage: number; newPage: number; regions: VisualRegion[] }[],
  meta: { options: CompareOptions; oldPages: number[]; newPages: number[]; elapsed: number }
): CompareResult {
  const imageChanges: Change[] = visual.flatMap((v) =>
    v.regions.map((r) => ({
      id: 0,
      type: 'image' as const,
      oldText: '',
      newText: '',
      detail: r.detail,
      old: { page: v.oldPage, rects: [r.oldRect] },
      new: { page: v.newPage, rects: [r.newRect] }
    }))
  )
  const oldRow = new Map<number, number>()
  const newRow = new Map<number, number>()
  text.rows.forEach((r, i) => {
    if (r.old !== null) oldRow.set(r.old, i)
    if (r.new !== null) newRow.set(r.new, i)
  })
  const isPage = (c: Change) => c.type === 'pageAdded' || c.type === 'pageRemoved' || c.type === 'pageMoved'
  const pos = (c: Change): [number, number, number] => {
    const side = c.new && newRow.has(c.new.page) ? c.new : c.old
    const row = side ? ((side === c.new ? newRow.get(side.page) : oldRow.get(side.page)) ?? 0) : 0
    const y = isPage(c) ? -1 : side ? Math.min(...side.rects.map((r) => r[1])) : 0
    const x = side && !isPage(c) ? Math.min(...side.rects.map((r) => r[0])) : 0
    return [row, y, x]
  }
  const all = [...text.changes, ...imageChanges]
  const keyed = all.map((c) => ({ c, k: pos(c) }))
  keyed.sort((p, q) => p.k[0] - q.k[0] || p.k[1] - q.k[1] || p.k[2] - q.k[2])
  const changes = keyed.map(({ c }, i) => ({ ...c, id: i + 1 }))
  const counts = emptyCounts()
  for (const c of changes) counts[categoryOf(c.type)]++
  return { ...text, changes, counts, ...meta }
}

function quoted(s: string, max: number) {
  const clean = s.replace(/\s+/g, ' ').trim()
  return `“${clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean}”`
}

/** One-line description of a change, for the results list and the report. */
export function describeChange(c: Change, max = 60): string {
  switch (c.type) {
    case 'replaced':
      return `Replaced ${quoted(c.oldText, max)} with ${quoted(c.newText, max)}`
    case 'inserted':
      return `Inserted ${quoted(c.newText, max)}`
    case 'deleted':
      return `Deleted ${quoted(c.oldText, max)}`
    case 'formatting':
      return `Formatting changed in ${quoted(c.newText || c.oldText, max)}`
    case 'image':
      return c.detail || 'Image changed'
    case 'pageAdded':
      return `Page ${c.new!.page + 1} added`
    case 'pageRemoved':
      return `Page ${c.old!.page + 1} removed`
    case 'pageMoved':
      return `Page ${c.old!.page + 1} moved to page ${c.new!.page + 1}`
  }
}

/** "Old page 2 · New page 3" */
export function describeLocation(c: Change): string {
  const parts: string[] = []
  if (c.old && !c.old.anchor) parts.push(`Old page ${c.old.page + 1}`)
  if (c.new && !c.new.anchor) parts.push(`New page ${c.new.page + 1}`)
  if (!parts.length) {
    if (c.new) parts.push(`New page ${c.new.page + 1}`)
    else if (c.old) parts.push(`Old page ${c.old.page + 1}`)
  }
  return parts.join(' · ')
}

// ---- page ranges --------------------------------------------------------------------------------

/**
 * Parses "1-3, 5, 8-" into 0-based page indices. Returns an error message for invalid input.
 */
export function parsePageRange(input: string, pageCount: number): { pages: number[] } | { error: string } {
  const text = input.trim()
  if (!text) return { error: 'Enter pages, for example 1-3, 5' }
  const set = new Set<number>()
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part)
    let a: number
    let b: number
    if (m && (m[1] || m[2])) {
      a = m[1] ? parseInt(m[1], 10) : 1
      b = m[2] ? parseInt(m[2], 10) : pageCount
    } else if (/^\d+$/.test(part)) {
      a = b = parseInt(part, 10)
    } else {
      return { error: `“${part}” is not a page or range` }
    }
    if (a < 1 || b < 1) return { error: 'Page numbers start at 1' }
    if (a > b) [a, b] = [b, a]
    if (b > pageCount) return { error: `Page ${b} does not exist (the document has ${pageCount} page${pageCount === 1 ? '' : 's'})` }
    for (let p = a; p <= b; p++) set.add(p - 1)
  }
  if (!set.size) return { error: 'Enter pages, for example 1-3, 5' }
  return { pages: [...set].sort((x, y) => x - y) }
}
