// Writing a PDF file byte by byte: objects as PDF source (and raw stream data), one classic
// cross-reference table and a trailer. Used where MuPDF's own writer cannot be: certificate-encrypted
// output (src/engine/crypt/pubsecWrite.ts) holds data that is already encrypted and must be written
// exactly as it is.
import { latin1 } from '../crypt/primitives'

/** One object: a body (PDF source), or a stream dictionary and its raw data. Undefined = free. */
export type WrittenObject = { body: string } | { dict: string; stream: Uint8Array } | undefined

interface XrefEntry {
  offset: number
  inUse: boolean
}

function xrefTable(entries: (XrefEntry | undefined)[]): string {
  let s = `xref\n0 ${entries.length}\n`
  for (let n = 0; n < entries.length; n++) {
    const e = entries[n]
    s += e?.inUse ? `${String(e.offset).padStart(10, '0')} 00000 n \n` : `0000000000 ${n === 0 ? '65535' : '00000'} f \n`
  }
  return s
}

/**
 * Serialises objects 1..n-1 (index 0 is unused; undefined entries are free) with generation 0 and
 * a classic cross-reference table. `trailer` is the trailer dictionary as PDF source; source text
 * must be bytes 0-255 (MuPDF's toString with ascii output, or hex strings).
 */
export function writePdf(version: string, objects: WrittenObject[], trailer: string): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  let pos = 0
  const push = (b: Uint8Array) => {
    parts.push(b)
    pos += b.length
  }
  push(latin1(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`))
  const entries: (XrefEntry | undefined)[] = new Array(Math.max(1, objects.length))
  for (let n = 1; n < objects.length; n++) {
    const o = objects[n]
    if (!o) continue
    entries[n] = { offset: pos, inUse: true }
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
