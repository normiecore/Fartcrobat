// The small PDF reader behind certificate encryption (src/engine/crypt/pdfLex.ts): objects, the
// newest trailer, cross-reference tables and streams, and damaged files.
import { zlibSync } from 'fflate'
import * as mupdf from 'mupdf'
import { describe, expect, it } from 'vitest'
import {
  decodeStream,
  lastTrailer,
  objectAt,
  parseValue,
  PdfName,
  PdfRef,
  PdfString,
  readXref,
  serialise,
  type PdfDict,
  type PdfValue
} from '@engine/crypt/pdfLex'
import { readPubSec } from '@engine/crypt'
import { latin1 } from '@engine/crypt/primitives'
import { expected, keyFor, openWithKey, pubsecFixture } from './passwordless-helpers'

const parse = (s: string | Uint8Array): PdfValue => parseValue(typeof s === 'string' ? latin1(s) : s, 0)[0]
const str = (v: PdfValue) => Buffer.from((v as PdfString).bytes).toString('latin1')

/** Builds a file from pieces, remembering where each object starts. */
class Builder {
  private parts: Uint8Array[] = []
  pos = 0
  readonly offsets = new Map<number, number>()
  add(piece: string | Uint8Array): this {
    const b = typeof piece === 'string' ? latin1(piece) : piece
    this.parts.push(b)
    this.pos += b.length
    return this
  }
  obj(num: number, body: string): this {
    this.offsets.set(num, this.pos)
    return this.add(`${num} 0 obj\n${body}\nendobj\n`)
  }
  stream(num: number, dict: string, data: Uint8Array): this {
    this.offsets.set(num, this.pos)
    return this.add(`${num} 0 obj\n${dict.replace('>>', ` /Length ${data.length} >>`)}\nstream\n`).add(data).add('\nendstream\nendobj\n')
  }
  table(size: number, free: number[] = []): string {
    let s = `xref\n0 ${size}\n0000000000 65535 f\r\n`
    for (let n = 1; n < size; n++) {
      const at = this.offsets.get(n)
      s += at === undefined || free.includes(n) ? '0000000000 00001 f\r\n' : `${String(at).padStart(10, '0')} 00000 n\r\n`
    }
    return s
  }
  bytes(): Uint8Array {
    return Buffer.concat(this.parts)
  }
}

function openInMupdf(bytes: Uint8Array): { title: string; repaired: boolean; pages: number } {
  const doc = new mupdf.PDFDocument(bytes)
  try {
    return { title: doc.getMetaData('info:Title') ?? '', repaired: doc.wasRepaired(), pages: doc.countPages() }
  } finally {
    doc.destroy()
  }
}

describe('objects', () => {
  it('literal strings: every escape, nesting and line endings', () => {
    expect(str(parse('(a\\nb\\rc\\td\\be\\ff)'))).toBe('a\nb\rc\td\be\ff')
    expect(str(parse('(\\(\\)\\\\)'))).toBe('()\\')
    expect(str(parse('(\\053\\53\\0053\\7x\\101)'))).toBe('++\x053\x07xA')
    expect(str(parse('(\\q\\%)'))).toBe('q%')
    expect(str(parse('(a(b(c))d)'))).toBe('a(b(c))d')
    expect(str(parse('(one\\\r\ntwo\\\nthree\\\rfour)'))).toBe('onetwothreefour')
    expect(str(parse('(a\r\nb\rc\nd)'))).toBe('a\nb\nc\nd')
    expect(str(parse('(\\0)'))).toBe('\0')
    expect(str(parse('(\\777)'))).toBe('\xff')
    expect(str(parse('()'))).toBe('')
    expect(() => parse('(unterminated')).toThrow(/Unterminated/)
  })

  it('hex strings', () => {
    expect(str(parse('<48 65\n6C6c 6F>'))).toBe('Hello')
    expect(str(parse('<48656C6C6F2>'))).toBe('Hello ')
    expect(str(parse('<>'))).toBe('')
    expect(() => parse('<4G>')).toThrow(/hex/)
  })

  it('names, numbers, booleans and null', () => {
    expect(parse('/Adobe.PubSec')).toEqual(new PdfName('Adobe.PubSec'))
    expect(parse('/A#20B#2f')).toEqual(new PdfName('A B/'))
    expect(parse('/A#2')).toEqual(new PdfName('A#2'))
    expect(parse('/')).toEqual(new PdfName(''))
    expect(parse('[1 -2 +3 4.5 -.5 .25 6. true false null]')).toEqual([1, -2, 3, 4.5, -0.5, 0.25, 6, true, false, null])
  })

  it('nested containers, references and comments', () => {
    const v = parse(
      '<< /A [1 2 R 3 /N [ << /K true % a comment\n /L (x) >> ] <41> ] /R 12 0 R /S 5 /T [6 7 /U] /U 8 0 R>> trailing'
    ) as PdfDict
    expect(v.get('A')).toEqual([new PdfRef(1, 2), 3, new PdfName('N'), [new Map<string, PdfValue>([['K', true], ['L', new PdfString(latin1('x'))]])], new PdfString(latin1('A'))])
    expect(v.get('R')).toEqual(new PdfRef(12, 0))
    expect(v.get('S')).toBe(5)
    // Two numbers that are not followed by R stay numbers.
    expect(v.get('T')).toEqual([6, 7, new PdfName('U')])
    expect(v.get('U')).toEqual(new PdfRef(8, 0))
    expect(parse('[4 0 R]')).toEqual([new PdfRef(4, 0)])
    expect(parse('[4 0 R/X]')).toEqual([new PdfRef(4, 0), new PdfName('X')])
    expect(parse('[4 0]')).toEqual([4, 0])
    // Only "integer integer R" is a reference.
    expect(() => parse('[1.5 0 R]')).toThrow(/Unexpected "R"/)
    expect(() => parse('[4 0 Rx]')).toThrow(/Unexpected "Rx"/)
    expect(() => parse('<< 1 2 >>')).toThrow(/not a name/)
    expect(() => parse('[1 2')).toThrow(/Unterminated/)
  })

  it('serialises to source that parses back to the same value', () => {
    const v = parse('<< /A [1 2 R 3.25 /N#20x (x\\)y) <00ff> true null] /B << /C -7 >> >>')
    expect(serialise(v)).toBe('<</A [1 2 R 3.25 /N#20x <78297a>'.replace('7a', '79') + ' <00ff> true null]/B <</C -7>>>>')
    expect(parse(serialise(v))).toEqual(v)
  })
})

describe('the newest trailer and the cross-reference data', () => {
  it('classic table (v5-classic)', () => {
    const bytes = pubsecFixture('v5-classic.pdf')
    const t = lastTrailer(bytes)
    expect(t.kind).toBe('table')
    expect(t.dict.get('Encrypt')).toBeInstanceOf(PdfRef)
    const xref = readXref(bytes)
    expect(xref.damaged).toBe(false)
    expect(xref.kind).toBe('table')
    const enc = objectAt(bytes, xref, (t.dict.get('Encrypt') as PdfRef).num)
    expect((enc?.value as PdfDict).get('Filter')).toEqual(new PdfName('Adobe.PubSec'))
  })

  it('xref stream with object streams (v5-objstm)', () => {
    const bytes = pubsecFixture('v5-objstm.pdf')
    const xref = readXref(bytes)
    expect(xref.kind).toBe('stream')
    expect(xref.trailer.get('Type')).toEqual(new PdfName('XRef'))
    const inStreams = [...xref.entries.values()].filter((e) => e.type === 2)
    expect(inStreams.length).toBeGreaterThan(3)
    // The catalog is in an object stream: objectAt does not look into those.
    const root = xref.trailer.get('Root') as PdfRef
    expect(xref.entries.get(root.num)?.type).toBe(2)
    expect(objectAt(bytes, xref, root.num)).toBeNull()
  })

  it('incremental update: the LAST startxref wins (the spike took the first one in the tail)', () => {
    const bytes = pubsecFixture('v5-incremental.pdf')
    const text = Buffer.from(bytes).toString('latin1')
    const all = [...text.matchAll(/startxref\s+(\d+)/g)].map((m) => Number(m[1]))
    expect(all.length).toBe(2)
    // Both are in the last 2 KB, which is what misled the spike.
    expect(text.lastIndexOf('startxref') - text.indexOf('startxref', text.length - 2048)).toBeGreaterThan(0)
    const t = lastTrailer(bytes)
    expect(t.offset).toBe(all[1])
    expect(t.dict.get('Prev')).toBe(all[0])
    const xref = readXref(bytes)
    expect(xref.trailers.length).toBe(2)
    expect(xref.startxref).toBe(all[1])
    // The Info object (19) is redefined by the update; the newest entry wins.
    const older = readXref(bytes.subarray(0, all[1]))
    expect(xref.entries.get(19)).not.toEqual(older.entries.get(19))
    expect(expected('v5-incremental.pdf').expectedTitle).toBe('Updated secret title')
  })

  it('a small update appended to a classic file', () => {
    const base = new Builder()
      .add('%PDF-1.7\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>')
      .obj(4, '<< /Title (Old title) >>')
    const xrefAt = base.pos
    base.add(`${base.table(5)}trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
    const update = base.obj(4, '<< /Title (New title) >>')
    const at4 = update.offsets.get(4)!
    const xref2 = update.pos
    update.add(`xref\n0 1\n0000000000 65535 f\r\n4 1\n${String(at4).padStart(10, '0')} 00000 n\r\n`)
    update.add(`trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R /Prev ${xrefAt} >>\nstartxref\n${xref2}\n%%EOF\n`)
    const bytes = update.bytes()
    expect(openInMupdf(bytes)).toMatchObject({ title: 'New title', repaired: false })
    const xref = readXref(bytes)
    expect(str((objectAt(bytes, xref, 4)!.value as PdfDict).get('Title')!)).toBe('New title')
    expect(xref.entries.get(1)).toEqual({ type: 1, offset: update.offsets.get(1), gen: 0 })
  })

  it('hybrid file: the table and its /XRefStm', () => {
    const b = new Builder()
      .add('%PDF-1.5\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>')
    const header = '4 0 '
    b.stream(5, `<< /Type /ObjStm /N 1 /First ${header.length} >>`, latin1(`${header}<< /Title (Hybrid title) >>`))
    b.stream(6, '<< /Type /XRef /Size 7 /W [1 2 1] /Index [4 1] >>', Uint8Array.of(2, 0, 5, 0))
    const xrefAt = b.pos
    // The table leaves out object 4, which only the stream named by /XRefStm lists.
    const entry = (n: number) => `${String(b.offsets.get(n)).padStart(10, '0')} 00000 n\r\n`
    const table = `xref\n0 4\n0000000000 65535 f\r\n${entry(1)}${entry(2)}${entry(3)}5 2\n${entry(5)}${entry(6)}`
    b.add(`${table}trailer\n<< /Size 7 /Root 1 0 R /Info 4 0 R /XRefStm ${b.offsets.get(6)} >>\nstartxref\n${xrefAt}\n%%EOF\n`)
    const bytes = b.bytes()
    expect(openInMupdf(bytes)).toMatchObject({ title: 'Hybrid title', repaired: false, pages: 1 })
    const t = lastTrailer(bytes)
    expect(t.kind).toBe('table')
    expect(t.dict.get('XRefStm')).toBe(b.offsets.get(6))
    const xref = readXref(bytes)
    expect(xref.damaged).toBe(false)
    expect(xref.entries.get(4)).toEqual({ type: 2, stream: 5, index: 0 })
    expect(xref.entries.get(5)).toEqual({ type: 1, offset: b.offsets.get(5), gen: 0 })
  })

  it('xref stream with PNG predictors (every row filter), several subsections and a default type', () => {
    // Rows of 5 bytes: type (1), offset (3), generation (1); then rows with W [0 3 1].
    const b = new Builder()
      .add('%PDF-1.5\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>')
      .obj(10, '<< /Title (Predicted) >>')
    const xrefAt = b.pos
    const rows: number[][] = [
      [0, 0, 0, 0, 255],
      ...[1, 2, 3].map((n) => [1, 0, (b.offsets.get(n)! >> 8) & 255, b.offsets.get(n)! & 255, 0]),
      [1, 0, (b.offsets.get(10)! >> 8) & 255, b.offsets.get(10)! & 255, 0],
      [1, 0, (xrefAt >> 8) & 255, xrefAt & 255, 0]
    ]
    // PNG-encode each row with a different filter (None, Sub, Up, Average, Paeth, Up).
    const types = [0, 1, 2, 3, 4, 2]
    const encoded: number[] = []
    rows.forEach((row, r) => {
      const prev = r ? rows[r - 1] : [0, 0, 0, 0, 0]
      encoded.push(types[r])
      row.forEach((v, k) => {
        const left = k ? row[k - 1] : 0
        const up = prev[k]
        const upLeft = k ? prev[k - 1] : 0
        let pred = 0
        if (types[r] === 1) pred = left
        else if (types[r] === 2) pred = up
        else if (types[r] === 3) pred = (left + up) >> 1
        else if (types[r] === 4) {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        }
        encoded.push((v - pred) & 255)
      })
    })
    const data = zlibSync(Uint8Array.from(encoded))
    b.stream(11, `<< /Type /XRef /Size 12 /W [1 3 1] /Index [0 4 10 2] /Root 1 0 R /Info 10 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >> >>`, data)
    b.add(`startxref\n${xrefAt}\n%%EOF\n`)
    const bytes = b.bytes()
    expect(openInMupdf(bytes)).toMatchObject({ title: 'Predicted', repaired: false })
    const xref = readXref(bytes)
    expect(xref.damaged).toBe(false)
    expect(xref.kind).toBe('stream')
    for (const n of [1, 2, 3, 10]) expect(xref.entries.get(n)).toEqual({ type: 1, offset: b.offsets.get(n), gen: 0 })
    expect(xref.entries.get(11)).toEqual({ type: 1, offset: xrefAt, gen: 0 })
    expect(xref.entries.get(0)).toEqual({ type: 0 })
    expect(xref.entries.has(5)).toBe(false)
    expect(str((objectAt(bytes, xref, 10)!.value as PdfDict).get('Title')!)).toBe('Predicted')
  })

  it('TIFF predictor and a default /W type', () => {
    const raw = Uint8Array.of(1, 2, 3, 10, 20, 30)
    const diff = Uint8Array.of(1, 1, 1, 10, 10, 10)
    const dict = parse('<< /Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 3 >> >>') as PdfDict
    expect(decodeStream(zlibSync(diff), dict)).toEqual(raw)
    expect(decodeStream(raw, new Map())).toEqual(raw)
  })

  it('stream data: indirect /Length, and a wrong /Length falls back to endstream', () => {
    const b = new Builder().add('%PDF-1.7\n')
    b.offsets.set(1, b.pos)
    b.add('1 0 obj\n<< /Length 2 0 R >>\nstream\r\nabcdef\r\nendstream\nendobj\n')
    b.obj(2, '6')
    b.offsets.set(3, b.pos)
    b.add('3 0 obj\n<< /Length 99 >>\nstream\nxyz\nendstream\nendobj\n')
    const xrefAt = b.pos
    b.add(`${b.table(4)}trailer\n<< /Size 4 >>\nstartxref\n${xrefAt}\n%%EOF\n`)
    const bytes = b.bytes()
    const xref = readXref(bytes)
    const one = objectAt(bytes, xref, 1)!
    expect(Buffer.from(bytes.subarray(one.stream!.start, one.stream!.end)).toString()).toBe('abcdef')
    const three = objectAt(bytes, xref, 3)!
    expect(Buffer.from(bytes.subarray(three.stream!.start, three.stream!.end)).toString()).toBe('xyz')
  })

  it('a direct /Encrypt dictionary (v5-direct-encrypt)', () => {
    const bytes = pubsecFixture('v5-direct-encrypt.pdf')
    const enc = lastTrailer(bytes).dict.get('Encrypt')
    expect(enc).toBeInstanceOf(Map)
    expect((enc as PdfDict).get('Filter')).toEqual(new PdfName('Adobe.PubSec'))
    const info = readPubSec(bytes)!
    expect(info.encryptRef).toBeNull()
    expect(info.recipients.length).toBe(1)
    expect(Buffer.from(info.recipients[0]).equals(Buffer.from(readPubSec(pubsecFixture('v5-classic.pdf'))!.recipients[0]))).toBe(true)
  })
})

describe('damaged files', () => {
  /** v5-classic with its startxref pointing into the middle of an object. */
  function damaged(): Uint8Array {
    const bytes = pubsecFixture('v5-classic.pdf').slice()
    const text = Buffer.from(bytes).toString('latin1')
    const at = text.lastIndexOf('startxref')
    const m = /startxref\s+(\d+)/.exec(text.slice(at))!
    const digits = at + m[0].length - m[1].length
    const wrong = String(Number(m[1]) - 7).padStart(m[1].length, '0')
    bytes.set(latin1(wrong), digits)
    return bytes
  }

  it('falls back to scanning for object headers; the last definition wins', () => {
    const bytes = damaged()
    const xref = readXref(bytes)
    expect(xref.damaged).toBe(true)
    expect(xref.trailer.get('Root')).toBeInstanceOf(PdfRef)
    const info = readPubSec(bytes)!
    expect(info.recipients.length).toBe(1)
    expect(info.encryptRef).not.toBeNull()
  })

  it('scanning keeps the last definition of an object number', () => {
    const b = new Builder()
      .add('%PDF-1.7\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [] /Count 0 >>')
      .obj(4, '<< /Title (First) >>')
      .obj(4, '<< /Title (Second) >>')
      .add('trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\nstartxref\n999999\n%%EOF\n')
    const bytes = b.bytes()
    const xref = readXref(bytes)
    expect(xref.damaged).toBe(true)
    expect(str((objectAt(bytes, xref, 4)!.value as PdfDict).get('Title')!)).toBe('Second')
  })

  it('a damaged certificate-encrypted file is reported, not opened half-repaired', async () => {
    const bytes = damaged()
    await expect(openWithKey(bytes, keyFor('v5-classic.pdf', 'alice'))).rejects.toThrow(/could not be opened/)
  })
})
