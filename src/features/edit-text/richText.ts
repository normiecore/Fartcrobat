/**
 * Converts between styled runs and the DOM of the contenteditable editor, and between DOM
 * selections and character offsets.
 *
 * The DOM is read back through computed styles, so whatever markup the browser produces while
 * typing (split spans, copied inline styles) still maps to the right run styles.
 */
import { cssFamily, fontKeyFromCss } from './fonts'
import { normalizeHex, normalizeRuns, type FontChoice, type Run, type RunStyle } from './model'

export function applyRunCss(el: HTMLElement, style: RunStyle, scale: number, fonts: FontChoice[]) {
  el.style.fontFamily = cssFamily(style.font, fonts)
  el.style.fontSize = `${style.size * scale}px`
  el.style.color = style.color
  el.style.fontWeight = style.bold ? '700' : '400'
  el.style.fontStyle = style.italic ? 'italic' : 'normal'
  el.style.textDecoration = style.underline ? 'underline' : 'none'
}

/** Replaces the editor content with the runs. */
export function renderRuns(root: HTMLElement, runs: Run[], scale: number, fonts: FontChoice[]) {
  root.textContent = ''
  for (const r of runs) {
    if (!r.text) continue
    const span = document.createElement('span')
    applyRunCss(span, r, scale, fonts)
    span.textContent = r.text
    root.append(span)
  }
  const text = runs.map((r) => r.text).join('')
  // a trailing line break needs a placeholder to show the empty last line (and the caret on it)
  if (!text || text.endsWith('\n')) {
    const br = document.createElement('br')
    br.dataset.fcPlaceholder = '1'
    root.append(br)
  }
}

interface Token {
  /** The text node or <br> (null for a virtual break between block elements). */
  node: Node | null
  text: string
  el: HTMLElement
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE'])

/** Leaves of the editor in document order, with the text each one stands for. */
function tokens(root: HTMLElement): Token[] {
  const out: Token[] = []
  const endsWithBreak = () => out.length === 0 || /\n$/.test(out[out.length - 1].text)
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child as Text).data.replace(/\u200b/g, '')
        out.push({ node: child, text: t, el: (child.parentElement ?? root) as HTMLElement })
      } else if (child instanceof HTMLBRElement) {
        out.push({ node: child, text: '\n', el: (child.parentElement ?? root) as HTMLElement })
      } else if (child instanceof HTMLElement) {
        const block = BLOCK_TAGS.has(child.tagName)
        if (block && !endsWithBreak()) out.push({ node: null, text: '\n', el: child })
        visit(child)
        if (block && !endsWithBreak()) out.push({ node: null, text: '\n', el: child })
      }
    }
  }
  visit(root)
  // the last <br> (or block break) only holds the empty last line open
  const last = out[out.length - 1]
  if (last && (last.node === null || last.node instanceof HTMLBRElement)) out.pop()
  return out
}

function rgbToHexCss(c: string): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c)
  if (!m) return normalizeHex(c)
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
}

function underlined(el: HTMLElement, root: HTMLElement): boolean {
  let cur: HTMLElement | null = el
  while (cur && cur !== root.parentElement) {
    const line = getComputedStyle(cur).textDecorationLine || ''
    if (line.includes('underline')) return true
    if (cur === root) break
    cur = cur.parentElement
  }
  return false
}

function styleFromElement(el: HTMLElement, root: HTMLElement, scale: number, fallback: RunStyle, sizes: number[]): RunStyle {
  const cs = getComputedStyle(el)
  const font = fontKeyFromCss(cs.fontFamily) ?? fallback.font
  let size = Math.round((parseFloat(cs.fontSize) / scale) * 100) / 100
  const near = sizes.find((s) => Math.abs(s - size) < 0.06)
  if (near !== undefined) size = near
  if (!Number.isFinite(size) || size <= 0) size = fallback.size
  return {
    font,
    size,
    color: rgbToHexCss(cs.color),
    bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
    italic: cs.fontStyle !== 'normal',
    underline: underlined(el, root)
  }
}

/** Reads the editor content back into runs. */
export function readRuns(root: HTMLElement, scale: number, previous: Run[]): Run[] {
  const fallback = previous[0] ?? { font: 'Helvetica', size: 12, color: '#000000', bold: false, italic: false, underline: false, text: '' }
  const sizes = [...new Set(previous.map((r) => r.size))]
  const cache = new Map<HTMLElement, RunStyle>()
  const runs: Run[] = []
  for (const t of tokens(root)) {
    if (!t.text) continue
    let st = cache.get(t.el)
    if (!st) {
      st = styleFromElement(t.el, root, scale, fallback, sizes)
      cache.set(t.el, st)
    }
    runs.push({ ...st, text: t.text })
  }
  if (!runs.length) return [{ ...fallback, text: '' }]
  return normalizeRuns(runs)
}

/** Character offset of a DOM position inside the editor. */
function offsetOf(root: HTMLElement, toks: Token[], node: Node, offset: number): number {
  let acc = 0
  if (node.nodeType === Node.TEXT_NODE) {
    for (const t of toks) {
      if (t.node === node) {
        const raw = (node as Text).data
        return acc + raw.slice(0, offset).replace(/\u200b/g, '').length
      }
      acc += t.text.length
    }
    return acc
  }
  // element position: before child[offset]
  const child = node.childNodes[offset] ?? null
  for (const t of toks) {
    if (child && t.node && (t.node === child || child.contains(t.node))) return acc
    if (!child && t.node && !node.contains(t.node) && precedes(node, t.node)) return acc
    acc += t.text.length
  }
  return acc
}

function precedes(a: Node, b: Node): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const toks = tokens(root)
  const a = offsetOf(root, toks, range.startContainer, range.startOffset)
  const b = offsetOf(root, toks, range.endContainer, range.endOffset)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

function domPoint(root: HTMLElement, toks: Token[], offset: number): { node: Node; offset: number } {
  let acc = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const len = t.text.length
    if (t.node && t.node.nodeType === Node.TEXT_NODE && offset <= acc + len) {
      // prefer the end of a text node over the start of the next element
      return { node: t.node, offset: Math.min(offset - acc, (t.node as Text).data.length) }
    }
    if (t.node instanceof HTMLBRElement && offset === acc) {
      const parent = t.node.parentNode!
      return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, t.node) }
    }
    acc += len
  }
  // after everything: before a trailing placeholder <br>, else at the end
  const last = root.lastChild
  if (last instanceof HTMLBRElement) return { node: root, offset: root.childNodes.length - 1 }
  if (last && last.nodeType === Node.TEXT_NODE) return { node: last, offset: (last as Text).data.length }
  if (last instanceof HTMLElement && last.lastChild?.nodeType === Node.TEXT_NODE)
    return { node: last.lastChild, offset: (last.lastChild as Text).data.length }
  return { node: root, offset: root.childNodes.length }
}

export function setSelectionOffsets(root: HTMLElement, start: number, end: number) {
  const toks = tokens(root)
  const a = domPoint(root, toks, start)
  const b = start === end ? a : domPoint(root, toks, end)
  const sel = document.getSelection()
  if (!sel) return
  const range = document.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {}
}

/** Puts the caret at a screen point, when the point is inside the editor. */
export function caretFromPoint(root: HTMLElement, x: number, y: number): boolean {
  const range = document.caretRangeFromPoint?.(x, y)
  if (!range || !root.contains(range.startContainer)) return false
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  return true
}
