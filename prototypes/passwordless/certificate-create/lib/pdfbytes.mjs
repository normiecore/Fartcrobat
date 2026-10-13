// Byte-level edits of a PDF that MuPDF wrote with a full (non-incremental) save: one classic
// cross-reference table, no object streams. That is what saveToBuffer() produces unless the
// "objstms"/"linearize"/"incremental" options are used, so these helpers refuse anything else
// instead of guessing.
import { latin1, toLatin1 } from './crypto.mjs'

/** Index of `needle` (bytes) in `hay` from `from`, or -1. */
export function indexOfBytes(hay, needle, from = 0) {
  const first = needle[0]
  const last = hay.length - needle.length
  for (let i = hay.indexOf(first, from); i !== -1 && i <= last; i = hay.indexOf(first, i + 1)) {
    let k = 1
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

/** Parses the single classic xref section of a MuPDF full save. */
export function parseClassicXref(bytes) {
  const tail = toLatin1(bytes.subarray(Math.max(0, bytes.length - 1024)))
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)
  if (!m) throw new Error('no startxref at the end of the file')
  const xrefOffset = Number(m[1])
  const text = toLatin1(bytes.subarray(xrefOffset))
  if (!text.startsWith('xref')) throw new Error('not a classic cross-reference table (object streams?)')
  const trailerAt = text.indexOf('trailer')
  const startxrefAt = text.indexOf('startxref', trailerAt)
  const trailer = text.slice(trailerAt + 7, startxrefAt).trim()
  if (/\/Prev\s/.test(trailer)) throw new Error('file has incremental updates')
  if (/\/XRefStm\s/.test(trailer)) throw new Error('hybrid cross-reference file')
  const entries = [] // index = object number: { offset, gen, inUse }
  const lines = text.slice(4, trailerAt).trim().split(/\r?\n|\r/)
  for (let i = 0; i < lines.length; ) {
    const [first, count] = lines[i++].trim().split(/\s+/).map(Number)
    for (let k = 0; k < count; k++, i++) {
      const [off, gen, kind] = lines[i].trim().split(/\s+/)
      entries[first + k] = { offset: Number(off), gen: Number(gen), inUse: kind === 'n' }
    }
  }
  return { xrefOffset, entries, trailer }
}

/** The trailer value of `key` as text, e.g. "12 0 R". */
export function trailerValue(trailer, key) {
  return new RegExp(`/${key}\\s*(\\d+\\s+\\d+\\s+R|\\[[^\\]]*\\]|<[^>]*>)`).exec(trailer)?.[1] ?? null
}

function buildXref(entries) {
  let s = `xref\n0 ${entries.length}\n`
  for (let n = 0; n < entries.length; n++) {
    const e = entries[n] ?? { offset: 0, gen: n === 0 ? 65535 : 0, inUse: false }
    s += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} ${e.inUse ? 'n' : 'f'} \n`
  }
  return s
}

/** The bytes of object `num` ("N G obj ... endobj"), located through the xref table. */
export function objectSpan(bytes, xref, num) {
  const e = xref.entries[num]
  if (!e?.inUse) throw new Error(`object ${num} is not in the file`)
  const next = Math.min(xref.xrefOffset, ...xref.entries.filter((x) => x?.inUse && x.offset > e.offset).map((x) => x.offset))
  const region = toLatin1(bytes.subarray(e.offset, next))
  if (!region.startsWith(`${num} ${e.gen} obj`)) throw new Error(`object ${num} is not where the xref says`)
  const end = region.lastIndexOf('endobj')
  if (end < 0) throw new Error(`object ${num} has no endobj`)
  return { start: e.offset, end: e.offset + end + 6, text: region.slice(0, end + 6) }
}

/**
 * Replaces the body of object `num` with `body` (PDF source text of a non-stream object) and
 * rewrites the cross-reference table so every offset is right again.
 */
export function replaceObject(bytes, num, body) {
  const xref = parseClassicXref(bytes)
  const span = objectSpan(bytes, xref, num)
  const replacement = latin1(`${num} ${xref.entries[num].gen} obj\n${body}\nendobj`)
  const delta = replacement.length - (span.end - span.start)
  const entries = xref.entries.map((e) => (e && e.inUse && e.offset > span.start ? { ...e, offset: e.offset + delta } : e))
  const head = bytes.subarray(0, span.start)
  const mid = bytes.subarray(span.end, xref.xrefOffset)
  const newXrefOffset = xref.xrefOffset + delta
  const tail = latin1(`${buildXref(entries)}trailer\n${xref.trailer}\nstartxref\n${newXrefOffset}\n%%EOF\n`)
  const out = new Uint8Array(head.length + replacement.length + mid.length + tail.length)
  out.set(head, 0)
  out.set(replacement, head.length)
  out.set(mid, head.length + replacement.length)
  out.set(tail, head.length + replacement.length + mid.length)
  return out
}

/**
 * Serialises a list of objects into a PDF with one classic xref table. `objects[n]` is
 * { body: string } or { dict: string, stream: Uint8Array } or undefined (free); index 0 unused.
 */
export function writePdf({ version = '1.7', objects, trailer }) {
  const parts = [latin1(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`)]
  let pos = parts[0].length
  const entries = []
  const push = (b) => {
    parts.push(b)
    pos += b.length
  }
  for (let n = 1; n < objects.length; n++) {
    const o = objects[n]
    if (!o) continue
    entries[n] = { offset: pos, gen: 0, inUse: true }
    if (o.stream) {
      push(latin1(`${n} 0 obj\n${o.dict}\nstream\n`))
      push(o.stream)
      push(latin1('\nendstream\nendobj\n'))
    } else {
      push(latin1(`${n} 0 obj\n${o.body}\nendobj\n`))
    }
  }
  entries.length = objects.length
  const xrefAt = pos
  push(latin1(`${buildXref(entries)}trailer\n${trailer}\nstartxref\n${xrefAt}\n%%EOF\n`))
  const out = new Uint8Array(pos)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
