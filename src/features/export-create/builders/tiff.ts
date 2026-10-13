/**
 * A small baseline TIFF writer for Export > Image > TIFF: one page per image file directory,
 * RGB or grayscale, uncompressed or Deflate (Adobe Deflate with the horizontal predictor).
 */
import type { PageRaster } from '../content'

const SHORT = 3
const LONG = 4
const RATIONAL = 5

interface Entry {
  tag: number
  type: number
  values: number[]
}

/** zlib-wrapped deflate (TIFF compression 8) using the platform's CompressionStream. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Horizontal differencing (TIFF predictor 2): makes scanned and rendered pages compress better. */
function predict(r: PageRaster): Uint8Array {
  const out = new Uint8Array(r.pixels.length)
  const n = r.channels
  const stride = r.width * n
  for (let y = 0; y < r.height; y++) {
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const v = r.pixels[row + i]
      out[row + i] = i < n ? v : (v - r.pixels[row + i - n]) & 255
    }
  }
  return out
}

export async function encodeTiff(pages: PageRaster[], opts: { dpi: number; compression: 'deflate' | 'none' }): Promise<Uint8Array> {
  const strips: Uint8Array[] = []
  for (const p of pages) strips.push(opts.compression === 'deflate' ? await deflate(predict(p)) : p.pixels)
  // Layout: header, then for each page: strip data, extra values, IFD.
  const chunks: Uint8Array[] = []
  let offset = 8
  const header = new Uint8Array(8)
  const hv = new DataView(header.buffer)
  header[0] = 0x49
  header[1] = 0x49
  hv.setUint16(2, 42, true)
  chunks.push(header)
  let prevNextPointer = 4
  const patches: { at: number; value: number }[] = []
  pages.forEach((p, k) => {
    const strip = strips[k]
    const stripOffset = offset
    chunks.push(strip)
    offset += strip.length
    if (offset % 2) {
      chunks.push(new Uint8Array(1))
      offset++
    }
    // Values that do not fit in an entry: bits per sample (RGB) and the resolutions.
    const extra: number[] = []
    const extraStart = offset
    let bpsOffset = 0
    if (p.channels === 3) {
      bpsOffset = extraStart
      extra.push(8, 8, 8, 0) // 3 shorts, padded
    }
    const resOffset = extraStart + extra.length * 2
    const extraBytes = new Uint8Array(extra.length * 2 + 16)
    const ev = new DataView(extraBytes.buffer)
    extra.forEach((v, i) => ev.setUint16(i * 2, v, true))
    const ro = extra.length * 2
    ev.setUint32(ro, Math.round(opts.dpi * 100), true)
    ev.setUint32(ro + 4, 100, true)
    ev.setUint32(ro + 8, Math.round(opts.dpi * 100), true)
    ev.setUint32(ro + 12, 100, true)
    chunks.push(extraBytes)
    offset += extraBytes.length
    const entries: Entry[] = [
      { tag: 254, type: LONG, values: [pages.length > 1 ? 2 : 0] },
      { tag: 256, type: LONG, values: [p.width] },
      { tag: 257, type: LONG, values: [p.height] },
      { tag: 258, type: SHORT, values: p.channels === 3 ? [bpsOffset] : [8] },
      { tag: 259, type: SHORT, values: [opts.compression === 'deflate' ? 8 : 1] },
      { tag: 262, type: SHORT, values: [p.channels === 3 ? 2 : 1] },
      { tag: 273, type: LONG, values: [stripOffset] },
      { tag: 277, type: SHORT, values: [p.channels] },
      { tag: 278, type: LONG, values: [p.height] },
      { tag: 279, type: LONG, values: [strip.length] },
      { tag: 282, type: RATIONAL, values: [resOffset] },
      { tag: 283, type: RATIONAL, values: [resOffset + 8] },
      { tag: 284, type: SHORT, values: [1] },
      { tag: 296, type: SHORT, values: [2] },
      { tag: 297, type: SHORT, values: [k, pages.length] },
      ...(opts.compression === 'deflate' ? [{ tag: 317, type: SHORT, values: [2] }] : [])
    ]
    const ifdOffset = offset
    patches.push({ at: prevNextPointer, value: ifdOffset })
    const ifd = new Uint8Array(2 + entries.length * 12 + 4)
    const iv = new DataView(ifd.buffer)
    iv.setUint16(0, entries.length, true)
    entries.forEach((e, i) => {
      const o = 2 + i * 12
      iv.setUint16(o, e.tag, true)
      iv.setUint16(o + 2, e.type, true)
      const pointer = (e.tag === 258 && p.channels === 3) || e.type === RATIONAL
      const count = e.tag === 258 && p.channels === 3 ? 3 : e.type === RATIONAL ? 1 : e.values.length
      iv.setUint32(o + 4, count, true)
      if (pointer) iv.setUint32(o + 8, e.values[0], true)
      else if (e.type === SHORT) e.values.forEach((v, j) => iv.setUint16(o + 8 + j * 2, v, true))
      else iv.setUint32(o + 8, e.values[0], true)
    })
    chunks.push(ifd)
    prevNextPointer = ifdOffset + 2 + entries.length * 12
    offset += ifd.length
  })
  const out = new Uint8Array(offset)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  const view = new DataView(out.buffer)
  for (const p of patches) view.setUint32(p.at, p.value, true)
  return out
}
