/**
 * A small PDF content stream tokenizer and the filter that removes what is drawn on hidden
 * optional-content layers. Content streams are handled as "binary strings" (one char per byte).
 *
 * Inside a hidden layer the painting operators are neutralised (paths end with `n`, which keeps any
 * clipping), and shadings, XObjects and inline images are dropped. Graphics and text state operators
 * are kept so the content that follows is unaffected. Text drawn on hidden layers is made invisible
 * and then removed with MuPDF's redaction filter, which keeps text positions intact.
 */

export interface Operand {
  kind: 'name' | 'number' | 'string' | 'hex' | 'array' | 'dict' | 'keyword'
  text: string
}

export interface ContentOp {
  /** Offset of the first operand (or of the operator when there are none). */
  start: number
  /** Offset just after the operator (after EI for inline images). */
  end: number
  op: string
  operands: Operand[]
}

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIMS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

function isWs(src: string, i: number) {
  return WS.has(src.charCodeAt(i))
}

function isRegular(src: string, i: number) {
  return i < src.length && !isWs(src, i) && !DELIMS.has(src[i])
}

function skipWsAndComments(src: string, i: number): number {
  const n = src.length
  while (i < n) {
    if (isWs(src, i)) i++
    else if (src[i] === '%') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
    } else break
  }
  return i
}

function skipString(src: string, i: number): number {
  // src[i] === '('
  let depth = 0
  const n = src.length
  for (; i < n; i++) {
    const c = src[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return n
}

function skipHex(src: string, i: number): number {
  const end = src.indexOf('>', i + 1)
  return end < 0 ? src.length : end + 1
}

/** Skips one object (any kind) starting at i; returns the offset after it. */
function skipObject(src: string, i: number): number {
  const n = src.length
  const c = src[i]
  if (c === '(') return skipString(src, i)
  if (c === '<' && src[i + 1] === '<') {
    i += 2
    for (;;) {
      i = skipWsAndComments(src, i)
      if (i >= n) return n
      if (src[i] === '>' && src[i + 1] === '>') return i + 2
      const next = skipObject(src, i)
      i = next > i ? next : i + 1
    }
  }
  if (c === '<') return skipHex(src, i)
  if (c === '[') {
    i++
    for (;;) {
      i = skipWsAndComments(src, i)
      if (i >= n) return n
      if (src[i] === ']') return i + 1
      const next = skipObject(src, i)
      i = next > i ? next : i + 1
    }
  }
  if (c === '/') {
    i++
    while (isRegular(src, i)) i++
    return i
  }
  if (c === '{') {
    // PostScript calculator braces are not legal in content, but be tolerant
    i++
    let depth = 1
    while (i < n && depth > 0) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    return i
  }
  while (isRegular(src, i)) i++
  return i
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

/** Finds the end of inline image data that starts at `i` (just after "ID" and one white-space byte). */
function inlineImageEnd(src: string, i: number): number {
  const n = src.length
  let k = i
  for (;;) {
    k = src.indexOf('EI', k)
    if (k < 0) return n
    const before = k === i || isWs(src, k - 1)
    const after = k + 2 >= n || isWs(src, k + 2) || DELIMS.has(src[k + 2])
    if (before && after) return k + 2
    k += 2
  }
}

/** Splits a content stream into operations (operands + operator). */
export function tokenize(src: string): ContentOp[] {
  const ops: ContentOp[] = []
  const n = src.length
  let operands: Operand[] = []
  let start = -1
  let i = 0
  for (;;) {
    i = skipWsAndComments(src, i)
    if (i >= n) break
    const c = src[i]
    if (start < 0) start = i
    if (c === '/' || c === '(' || c === '<' || c === '[' || c === '{') {
      const end = skipObject(src, i)
      const kind: Operand['kind'] =
        c === '/' ? 'name' : c === '(' ? 'string' : c === '[' ? 'array' : c === '<' && src[i + 1] === '<' ? 'dict' : c === '<' ? 'hex' : 'keyword'
      operands.push({ kind, text: src.slice(i, end) })
      i = Math.max(end, i + 1)
      continue
    }
    if (!isRegular(src, i)) {
      // stray delimiter: skip it
      i++
      continue
    }
    let end = i
    while (isRegular(src, end)) end++
    const word = src.slice(i, end)
    if (NUMBER.test(word) || word === 'true' || word === 'false' || word === 'null') {
      operands.push({ kind: NUMBER.test(word) ? 'number' : 'keyword', text: word })
      i = end
      continue
    }
    if (word === 'BI') {
      // inline image: key/value pairs up to ID, then binary data up to EI
      let j = end
      for (;;) {
        j = skipWsAndComments(src, j)
        if (j >= n) break
        if (src.startsWith('ID', j) && !isRegular(src, j + 2)) {
          j += 2
          break
        }
        const next = skipObject(src, j)
        j = next > j ? next : j + 1
      }
      if (j < n && isWs(src, j)) j++
      const imgEnd = inlineImageEnd(src, j)
      ops.push({ start, end: imgEnd, op: 'BI', operands })
      operands = []
      start = -1
      i = imgEnd
      continue
    }
    ops.push({ start, end, op: word, operands })
    operands = []
    start = -1
    i = end
  }
  return ops
}

const PAINT = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's'])
const SHOW_TEXT = new Set(['Tj', 'TJ', "'", '"'])

/** Tag that replaces /OC on blocks whose content was neutralised. */
export const NEUTRALISED_TAG = '/FcHiddenLayer'

export interface HiddenFilterContext {
  /** True when the /Properties resource with this name is a hidden OCG or OCMD. */
  isHiddenProperty(name: string): boolean
  /** True when the XObject resource with this name carries a hidden /OC. */
  isHiddenXObject(name: string): boolean
}

export interface FilterResult {
  out: string
  /** Number of painting operations removed. */
  removed: number
  /** Number of text-showing operations made invisible (to be removed by the redaction filter). */
  hiddenText: number
  /** Names of form XObjects drawn outside hidden layers (to filter recursively). */
  visibleForms: string[]
}

/**
 * Neutralises everything drawn on hidden layers in a content stream: drawings and images are
 * removed, text becomes invisible (render mode 3) so it can then be removed precisely by MuPDF's
 * redaction filter, and the hidden blocks stop being optional content.
 */
export function filterHiddenLayers(src: string, ctx: HiddenFilterContext): FilterResult {
  const ops = tokenize(src)
  const stack: boolean[] = []
  let hidden = 0
  let removed = 0
  let hiddenText = 0
  let tr = 0
  const trStack: number[] = []
  const visibleForms: string[] = []
  let out = ''
  let last = 0
  const replace = (op: ContentOp, text: string) => {
    out += src.slice(last, op.start) + text
    last = op.end
  }
  for (const op of ops) {
    switch (op.op) {
      case 'q':
        trStack.push(tr)
        break
      case 'Q':
        if (trStack.length) tr = trStack.pop()!
        break
      case 'Tr': {
        const v = parseFloat(op.operands[0]?.text ?? '')
        if (Number.isFinite(v)) tr = v
        break
      }
      case 'BMC':
        stack.push(false)
        continue
      case 'BDC': {
        const tag = op.operands[0]
        const prop = op.operands[1]
        const h = tag?.text === '/OC' && prop?.kind === 'name' && ctx.isHiddenProperty(prop.text.slice(1))
        stack.push(h)
        if (h) {
          hidden++
          replace(op, `${NEUTRALISED_TAG} BMC`)
        }
        continue
      }
      case 'EMC':
        if (stack.pop()) hidden--
        continue
    }
    if (hidden > 0) {
      if (PAINT.has(op.op)) {
        replace(op, 'n')
        removed++
      } else if (op.op === 'sh' || op.op === 'Do' || op.op === 'BI') {
        replace(op, '')
        removed++
      } else if (SHOW_TEXT.has(op.op)) {
        replace(op, `3 Tr ${src.slice(op.start, op.end)} ${tr} Tr`)
        hiddenText++
      }
      continue
    }
    if (op.op === 'Do') {
      const name = op.operands[0]
      if (name?.kind === 'name') {
        const n = name.text.slice(1)
        if (ctx.isHiddenXObject(n)) {
          replace(op, '')
          removed++
        } else visibleForms.push(n)
      }
    }
  }
  out += src.slice(last)
  return { out, removed, hiddenText, visibleForms }
}

/** Decodes PDF name escapes (#xx). */
export function decodeName(name: string): string {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
}

export function bytesToBinary(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return s
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
