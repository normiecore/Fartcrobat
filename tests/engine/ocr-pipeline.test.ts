import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorker, OEM, type Worker } from 'tesseract.js'
import type { Rect } from '@shared/geometry'
import { quadToRect } from '@shared/geometry'
import type textOps from '@engine/ops/text'
import type ocrOps from '@features/ocr/engine'
import { imageToPage, keepWord, tesseractToLines, type TessBlock } from '@features/ocr/layout'
import { parsePageRange } from '@features/ocr/pageRange'
import { CancelledError, pageHasText, recognizePages, type Recognizer } from '@features/ocr/pipeline'
import { FIXTURES, fixture, openFixture, type OpenedEngine } from './helpers'

const LANG_PATH = resolve(__dirname, '../../node_modules/@tesseract.js-data/eng/4.0.0_best_int')

describe('ocr layout: Tesseract boxes to page space', () => {
  const image = { dpi: 300, width: 2550, height: 3300, origin: [0, 0] as [number, number] }

  it('scales pixels to points', () => {
    const toPage = imageToPage(image)
    expect(toPage([300, 600])).toEqual([72, 144])
    const shifted = imageToPage({ ...image, origin: [10, 20] })
    expect(shifted([0, 0])).toEqual([10, 20])
  })

  it('undoes Tesseract’s deskew rotation about the image centre', () => {
    const r = 0.05
    const toPage = imageToPage(image, r)
    // The centre does not move.
    const c = toPage([1275, 1650])
    expect(c[0]).toBeCloseTo((1275 * 72) / 300, 6)
    expect(c[1]).toBeCloseTo((1650 * 72) / 300, 6)
    // A point to the right of the centre in the deskewed image was higher up in the original
    // (the scan was turned counterclockwise).
    const p = toPage([1275 + 1000, 1650])
    expect(p[1]).toBeLessThan(c[1])
    expect(p[0] - c[0]).toBeCloseTo(((1000 * Math.cos(r)) * 72) / 300, 6)
  })

  it('keeps words with letters, drops noise', () => {
    expect(keepWord('Invoice', 90)).toBe(true)
    expect(keepWord('Invoice', 10)).toBe(false)
    expect(keepWord('|', 40)).toBe(false)
    expect(keepWord('—', 80)).toBe(true)
    expect(keepWord('  ', 99)).toBe(false)
  })

  it('gives all words of a line the line’s height', () => {
    const blocks: TessBlock[] = [
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  { text: 'Typing', confidence: 95, bbox: { x0: 300, y0: 300, x1: 500, y1: 360 } },
                  { text: 'tea', confidence: 92, bbox: { x0: 540, y0: 310, x1: 620, y1: 345 } },
                  { text: '~', confidence: 5, bbox: { x0: 700, y0: 310, x1: 720, y1: 345 } }
                ]
              },
              { words: [{ text: '..', confidence: 20, bbox: { x0: 300, y0: 600, x1: 330, y1: 610 } }] }
            ]
          }
        ]
      },
      { paragraphs: null }
    ]
    const res = tesseractToLines(blocks, image)
    expect(res.words).toBe(2)
    expect(res.lines).toHaveLength(1)
    expect(res.confidence).toBeCloseTo(93.5)
    const [a, b] = res.lines[0].words
    const close = (r: Rect, want: Rect) => r.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6))
    close(quadToRect(a.quad), [72, 72, 120, 86.4])
    close(quadToRect(b.quad), [129.6, 72, 148.8, 86.4])
  })
})

describe('page ranges', () => {
  it('parses pages and ranges', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual([0, 1, 2, 4])
    expect(parsePageRange('8-', 10)).toEqual([7, 8, 9])
    expect(parsePageRange('-2', 10)).toEqual([0, 1])
    expect(parsePageRange('2 to 3; 3', 10)).toEqual([1, 2])
    expect(parsePageRange('4–4', 5)).toEqual([3])
    expect(parsePageRange('', 3)).toMatch(/Enter the pages/)
    expect(parsePageRange('0', 3)).toMatch(/pages 1 to 3/)
    expect(parsePageRange('5', 3)).toMatch(/pages 1 to 3/)
    expect(parsePageRange('3-1', 3)).toMatch(/backwards/)
    expect(parsePageRange('a', 3)).toMatch(/not a page/)
  })
})

// ---- the whole pipeline with Tesseract running in Node --------------------------------------

let worker: Worker
let progressEvents = 0

/** The Node counterpart of the app's Tesseract session. */
function nodeRecognizer(): Recognizer {
  return {
    async recognize(png, opts, onProgress) {
      onProgress(0)
      const res = await worker.recognize(
        Buffer.from(png),
        { rotateAuto: true, user_defined_dpi: String(opts.dpi) } as any,
        { blocks: true, text: false }
      )
      onProgress(1)
      progressEvents++
      return { blocks: (res.data.blocks ?? null) as TessBlock[] | null, rotateRadians: Number((res.data as any).rotateRadians) || 0 }
    }
  }
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  return w > 0 && h > 0 ? (w * h) / ((a[2] - a[0]) * (a[3] - a[1])) : 0
}

/** Rectangle of the first occurrence of `word` in the page text. */
async function foundRect(e: OpenedEngine, page: number, word: string): Promise<Rect | null> {
  const t = await e.ops<typeof textOps>('text').page(page)
  const i = t.text.indexOf(word)
  if (i < 0) return null
  let r: Rect | null = null
  for (let k = i; k < i + word.length; k++) {
    const c = quadToRect(Array.from(t.quads.slice(k * 8, k * 8 + 8)) as any)
    r = r ? [Math.min(r[0], c[0]), Math.min(r[1], c[1]), Math.max(r[2], c[2]), Math.max(r[3], c[3])] : c
  }
  return r
}

const expected = JSON.parse(readFileSync(resolve(FIXTURES, 'ocr/scanned-pages.json'), 'utf8')) as {
  words: Record<string, { text: string; rect: Rect }[]>
}
const expectedRect = (page: number, word: string) => expected.words[page].find((w) => w.text === word)!.rect

/** Page 4 of scanned-pages.pdf was turned 2° counterclockwise about the page centre. */
function skewed(r: Rect): Rect {
  const a = (2 * Math.PI) / 180
  const [cx, cy] = [306, 396]
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]]
  ].map(([x, y]) => [cx + (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a), cy - (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

describe('ocr pipeline with Tesseract', () => {
  beforeAll(async () => {
    worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: LANG_PATH, cacheMethod: 'none', gzip: true })
  }, 60_000)
  afterAll(async () => {
    await worker?.terminate()
  })

  it('recognizes scan.png (the fixture image) as “Scanned Document”', async () => {
    const res = await worker.recognize(Buffer.from(fixture('scan.png')), {}, { text: true })
    expect(res.data.text).toContain('Scanned Document')
  }, 60_000)

  it('makes scanned.pdf searchable: words land on the words of the image', async () => {
    const e = await openFixture('scanned.pdf')
    const ops = e.ops<typeof ocrOps>('ocr')
    const run = await recognizePages(ops, nodeRecognizer(), { pages: [0], language: 'eng', dpi: 300, skipPagesWithText: true })
    expect(run.cancelled).toBe(false)
    expect(run.skipped).toEqual([])
    expect(run.results[0].dpi).toBe(300)
    expect(run.results[0].confidence).toBeGreaterThan(80)
    const applied = await ops.addTextLayer(run.results)
    expect(applied[0].words).toBeGreaterThanOrEqual(15)
    const plain = await e.ops<typeof textOps>('text').plain(0)
    expect(plain).toContain('Scanned Document')
    expect(plain).toContain('searchable and selectable.')
    // "searchable" in scan.png (150 dpi): x 150..369, y 398..428 px.
    const r = await foundRect(e, 0, 'searchable')
    const want: Rect = [150 * 0.48, 398 * 0.48, 369 * 0.48, 428 * 0.48]
    expect(overlap(r!, want)).toBeGreaterThan(0.75)
    expect(overlap(want, r!)).toBeGreaterThan(0.75)
    // Running again skips the page: it has text now.
    const again = await recognizePages(ops, nodeRecognizer(), { pages: [0], language: 'eng', dpi: 300, skipPagesWithText: true })
    expect(again.skipped).toEqual([0])
    expect(again.results).toEqual([])
  }, 120_000)

  it('handles rotated and skewed pages and skips pages with real text', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    const ops = e.ops<typeof ocrOps>('ocr')
    const states: string[] = []
    const run = await recognizePages(
      ops,
      nodeRecognizer(),
      { pages: [0, 1, 2, 3], language: 'eng', dpi: 200, skipPagesWithText: true },
      { onPage: (p) => states.push(`${p.page}:${p.state}`) }
    )
    expect(run.skipped).toEqual([2])
    expect(run.results.map((r) => r.page)).toEqual([0, 1, 3])
    expect(states).toContain('2:skipped')
    expect(states).toContain('1:recognizing')
    expect(states).toContain('3:done')
    await ops.addTextLayer(run.results)
    const t = e.ops<typeof textOps>('text')
    expect(await t.plain(0)).toContain('Quarterly Report')
    expect(await t.plain(1)).toContain('Rotated Page')
    expect(await t.plain(3)).toContain('Skewed Scan')
    // The page with real text is untouched.
    expect((await ops.status([2]))[0].hasOcrLayer).toBe(false)
    // Words land where the image shows them, on the rotated page too.
    for (const [page, word] of [
      [0, 'Revenue'],
      [1, 'Rotated'],
      [1, 'sideways.'],
      [3, 'Skewed']
    ] as const) {
      const r = await foundRect(e, page, word)
      expect(r, `${word} on page ${page + 1}`).not.toBeNull()
      const want = page === 3 ? skewed(expectedRect(page, word)) : expectedRect(page, word)
      expect(overlap(want, r!), `${word} on page ${page + 1}`).toBeGreaterThan(0.6)
    }
    // The skewed page: the second line rises to the right like the scan (turned 2° counterclockwise).
    const st = e.session.page(3).toStructuredText('preserve-whitespace')
    const lines: number[][] = []
    st.walk({ beginLine: (_b, _w, dir) => lines.push(dir as number[]) })
    st.destroy()
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[1][1]).toBeLessThan(-0.02)
  }, 180_000)

  it('stops when cancelled and reports what was done', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    const ctrl = new AbortController()
    const base = nodeRecognizer()
    let calls = 0
    const recognizer: Recognizer = {
      async recognize(png, opts, onProgress) {
        calls++
        const out = await base.recognize(png, opts, onProgress)
        if (calls === 1) ctrl.abort()
        return out
      }
    }
    const run = await recognizePages(
      e.ops<typeof ocrOps>('ocr'),
      recognizer,
      { pages: [0, 1, 3], language: 'eng', dpi: 150, skipPagesWithText: false },
      { signal: ctrl.signal }
    )
    expect(run.cancelled).toBe(true)
    expect(run.results.map((r) => r.page)).toEqual([0])
    expect(calls).toBe(1)
    // A recognizer that rejects with CancelledError also ends the run as cancelled.
    const ctrl2 = new AbortController()
    const run2 = await recognizePages(
      e.ops<typeof ocrOps>('ocr'),
      {
        recognize: async () => {
          ctrl2.abort()
          throw new CancelledError()
        }
      },
      { pages: [0], language: 'eng', dpi: 150, skipPagesWithText: false },
      { signal: ctrl2.signal }
    )
    expect(run2).toEqual({ results: [], skipped: [], cancelled: true })
    expect(progressEvents).toBeGreaterThan(0)
  }, 120_000)

  it('treats pages with an OCR layer or their own text as having text', () => {
    const base = { page: 0, textChars: 0, ocrChars: 0, hasOcrLayer: false, imageCoverage: 1 }
    expect(pageHasText(base)).toBe(false)
    expect(pageHasText({ ...base, textChars: 5 })).toBe(false)
    expect(pageHasText({ ...base, textChars: 200 })).toBe(true)
    expect(pageHasText({ ...base, textChars: 200, ocrChars: 200, hasOcrLayer: true })).toBe(true)
  })
})
