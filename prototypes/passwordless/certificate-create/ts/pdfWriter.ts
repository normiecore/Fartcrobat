// Writing PDF files byte by byte, and editing MuPDF full saves (one classic xref table, no object
// streams). Proposed home: src/engine/util/pdfWriter.ts
import { latin1, toLatin1 } from './pdfCrypto'

export interface XrefEntry {
  offset: number
  gen: number
  inUse: boolean
}

export interface ClassicXref {
  xrefOffset: number
  entries: (XrefEntry | undefined)[]
  trailer: string
}

/** Index of `needle` in `hay` from `from`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = hay.length - needle.length
  for (let i = hay.indexOf(needle[0], from); i !== -1 && i <= last; i = hay.indexOf(needle[0], i + 1)) {
    let k = 1
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

/** Parses the single classic cross-reference section of a MuPDF full save. */
export function parseClassicXref(bytes: Uint8Array): ClassicXref {
  const tail = toLatin1(bytes.subarray(Math.max(0, bytes.length - 1024)))
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)
  if (!m) throw new Error('No startxref at the end of the file')
  const xrefOffset = Number(m[1])
  const text = toLatin1(bytes.subarray(xrefOffset))
  if (!text.startsWith('xref')) throw new Error('Not a classic cross-reference table')
  const trailerAt = text.indexOf('trailer')
  const trailer = text.slice(trailerAt + 7, text.indexOf('startxref', trailerAt)).trim()
  if (/\/(Prev|XRefStm)\s/.test(trailer)) throw new Error('The file has more than one cross-reference section')
  const entries: (XrefEntry | undefined)[] = []
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

/** A trailer entry's value as source text ("12 0 R", "[<..><..>]"), or null. */
export function trailerValue(trailer: string, key: string): string | null {
  return new RegExp(`/${key}\\s*(\\d+\\s+\\d+\\s+R|\\[[^\\]]*\\]|<[^>]*>)`).exec(trailer)?.[1] ?? null
}

function xrefTable(entries: (XrefEntry | undefined)[]): string {
  let s = `xref\n0 ${entries.length}\n`
  for (let n = 0; n < entries.length; n++) {
    const e = entries[n] ?? { offset: 0, gen: n === 0 ? 65535 : 0, inUse: false }
    s += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} ${e.inUse ? 'n' : 'f'} \n`
  }
  return s
}

/** The source text of object `num`, located through the xref table. */
export function objectSpan(bytes: Uint8Array, xref: ClassicXref, num: number): { start: number; end: number; text: string } {
  const e = xref.entries[num]
  if (!e?.inUse) throw new Error(`Object ${num} is not in the file`)
  let next = xref.xrefOffset
  for (const x of xref.entries) if (x?.inUse && x.offset > e.offset && x.offset < next) next = x.offset
  const region = toLatin1(bytes.subarray(e.offset, next))
  if (!region.startsWith(`${num} ${e.gen} obj`)) throw new Error(`Object ${num} is not where the xref says`)
  const end = region.lastIndexOf('endobj')
  if (end < 0) throw new Error(`Object ${num} has no endobj`)
  return { start: e.offset, end: e.offset + end + 6, text: region.slice(0, end + 6) }
}

/** Replaces the body of (non-stream) object `num` and rewrites the xref table to match. */
export function replaceObject(bytes: Uint8Array, num: number, body: string): Uint8Array {
  const xref = parseClassicXref(bytes)
  const span = objectSpan(bytes, xref, num)
  const replacement = latin1(`${num} ${xref.entries[num]!.gen} obj\n${body}\nendobj`)
  const delta = replacement.length - (span.end - span.start)
  const entries = xref.entries.map((e) => (e?.inUse && e.offset > span.start ? { ...e, offset: e.offset + delta } : e))
  const tail = latin1(`${xrefTable(entries)}trailer\n${xref.trailer}\nstartxref\n${xref.xrefOffset + delta}\n%%EOF\n`)
  const parts = [bytes.subarray(0, span.start), replacement, bytes.subarray(span.end, xref.xrefOffset), tail]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export type WrittenObject = { body: string } | { dict: string; stream: Uint8Array } | undefined

/** Serialises objects 1..n-1 (index 0 unused, undefined = free) with one classic xref table. */
export function writePdf(version: string, objects: WrittenObject[], trailer: string): Uint8Array {
  const parts: Uint8Array[] = []
  let pos = 0
  const push = (b: Uint8Array) => {
    parts.push(b)
    pos += b.length
  }
  push(latin1(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`))
  const entries: (XrefEntry | undefined)[] = new Array(objects.length)
  for (let n = 1; n < objects.length; n++) {
    const o = objects[n]
    if (!o) continue
    entries[n] = { offset: pos, gen: 0, inUse: true }
    if ('stream' in o) {
      push(latin1(`${n} 0 obj\n${o.dict}\nstream\n`))
      push(o.stream)
      push(latin1('\nendstream\nendobj\n'))
    } else {
      push(latin1(`${n} 0 obj\n${o.body}\nendobj\n`))
    }
  }
  const xrefAt = pos
  push(latin1(`${xrefTable(entries)}trailer\n${trailer}\nstartxref\n${xrefAt}\n%%EOF\n`))
  const out = new Uint8Array(pos)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
