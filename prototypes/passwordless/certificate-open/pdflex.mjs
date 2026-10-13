// Minimal PDF object reader for files MuPDF refuses to open (it throws on /Adobe.PubSec).
// Reads just enough: the last trailer (classic or xref stream) and one top-level object.
const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)))
export const isRef = (v) => v && typeof v === 'object' && 'ref' in v
export const isName = (v) => v && typeof v === 'object' && 'name' in v
export const isStr = (v) => v && typeof v === 'object' && 'str' in v

function skipWs(b, i) {
  for (;;) {
    while (i < b.length && WS.has(b[i])) i++
    if (b[i] !== 0x25) return i // %
    while (i < b.length && b[i] !== 10 && b[i] !== 13) i++
  }
}
function token(b, i) {
  const s = i
  while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++
  return [String.fromCharCode(...b.subarray(s, i)), i]
}
function literal(b, i) {
  const out = []
  let depth = 1
  i++
  while (i < b.length) {
    const c = b[i++]
    if (c === 0x5c) {
      const e = b[i++]
      const map = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }
      if (e in map) out.push(map[e])
      else if (e >= 0x30 && e <= 0x37) {
        let v = e - 0x30
        for (let k = 0; k < 2 && b[i] >= 0x30 && b[i] <= 0x37; k++) v = v * 8 + (b[i++] - 0x30)
        out.push(v & 0xff)
      } else if (e === 13) { if (b[i] === 10) i++ } else if (e !== 10) out.push(e)
    } else if (c === 0x28) { depth++; out.push(c) }
    else if (c === 0x29) { if (--depth === 0) break; out.push(c) }
    else out.push(c)
  }
  return [{ str: Uint8Array.from(out) }, i]
}
function hexString(b, i) {
  let h = ''
  i++
  while (b[i] !== 0x3e) { if (!WS.has(b[i])) h += String.fromCharCode(b[i]); i++ }
  if (h.length % 2) h += '0'
  return [{ str: Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)) }, i + 1]
}
/** Parses one object at `i`. Returns [value, nextIndex]. */
export function parseValue(b, i) {
  i = skipWs(b, i)
  const c = b[i]
  if (c === 0x2f) { const [t, j] = token(b, i + 1); return [{ name: t }, j] }
  if (c === 0x28) return literal(b, i)
  if (c === 0x3c && b[i + 1] === 0x3c) {
    const d = new Map()
    i += 2
    for (;;) {
      i = skipWs(b, i)
      if (b[i] === 0x3e && b[i + 1] === 0x3e) return [d, i + 2]
      const [k, j] = parseValue(b, i)
      const [v, j2] = parseValue(b, j)
      d.set(k.name, v)
      i = j2
    }
  }
  if (c === 0x3c) return hexString(b, i)
  if (c === 0x5b) {
    const a = []
    i++
    for (;;) {
      i = skipWs(b, i)
      if (b[i] === 0x5d) return [a, i + 1]
      const [v, j] = parseValue(b, i)
      a.push(v)
      i = j
    }
  }
  const [t, j] = token(b, i)
  if (t === 'true' || t === 'false') return [t === 'true', j]
  if (t === 'null') return [null, j]
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) {
    // "n g R" lookahead
    const m = /^\s*(\d+)\s+R(?![^\s/<>\[\]()%])/.exec(latin(b.subarray(j, j + 24)))
    if (/^\d+$/.test(t) && m) return [{ ref: [Number(t), Number(m[1])] }, j + m[0].length]
    return [Number(t), j]
  }
  throw new Error(`PDF syntax error at ${i}: ${JSON.stringify(t || String.fromCharCode(c))}`)
}
export const latin = (u) => { let s = ''; for (let k = 0; k < u.length; k += 8192) s += String.fromCharCode(...u.subarray(k, k + 8192)); return s }

/** The newest trailer dictionary: classic `trailer <<>>` or the xref stream's dictionary. */
export function lastTrailer(b) {
  const text = latin(b.subarray(Math.max(0, b.length - 2048)))
  const all = [...text.matchAll(/startxref\s+(\d+)/g)]
  const m = all[all.length - 1]
  if (!m) throw new Error('no startxref')
  const off = Number(m[1])
  let i = skipWs(b, off)
  if (latin(b.subarray(i, i + 4)) === 'xref') {
    const t = latin(b.subarray(i)).indexOf('trailer')
    const [d] = parseValue(b, i + t + 7)
    return { dict: d, offset: off, kind: 'table' }
  }
  const om = /^(\d+)\s+(\d+)\s+obj/.exec(latin(b.subarray(i, i + 40)))
  if (!om) throw new Error('startxref does not point at an xref section')
  const [d] = parseValue(b, i + om[0].length)
  return { dict: d, offset: off, kind: 'stream' }
}

/** Finds the last top-level definition of object `num gen` by scanning (the encryption dictionary
 * is never inside an object stream: ISO 32000-2 7.5.7). */
export function findObject(b, num, gen) {
  const text = latin(b)
  const re = new RegExp(`(?:^|[\\s>\\]])${num}\\s+${gen}\\s+obj`, 'g')
  let last = -1
  for (const m of text.matchAll(re)) last = m.index + m[0].length
  if (last < 0) throw new Error(`object ${num} ${gen} not found`)
  return parseValue(b, last)[0]
}

/** PDF source text for a parsed value (used to write the appended trailer). */
export function serialise(v) {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (isRef(v)) return `${v.ref[0]} ${v.ref[1]} R`
  if (isName(v)) return `/${v.name}`
  if (isStr(v)) return `<${[...v.str].map((x) => x.toString(16).padStart(2, '0')).join('')}>`
  if (Array.isArray(v)) return `[${v.map(serialise).join(' ')}]`
  if (v instanceof Map) return `<<${[...v].map(([k, x]) => `/${k} ${serialise(x)}`).join('')}>>`
  throw new Error('cannot serialise')
}
