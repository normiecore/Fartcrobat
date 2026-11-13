import { describe, expect, it } from 'vitest'
import type { PageInfo, PageLayoutMode, ZoomMode } from '@shared/types'
import { computeLayout, fitZoom, PAGE_GAP, VIEW_PADDING } from '@renderer/viewer/layout'

const page = (index: number, width: number, height: number): PageInfo => ({
  index,
  id: index + 1,
  width,
  height,
  rotation: 0,
  label: String(index + 1),
  mediaBox: [0, 0, width, height],
  cropBox: [0, 0, width, height]
})

const letter = (n: number) => Array.from({ length: n }, (_, i) => page(i, 612, 792))
// tests/fixtures/mixed-sizes.pdf: A4 portrait, A4 landscape, Letter (rotated)
const mixed = [page(0, 595, 842), page(1, 842, 595), page(2, 612, 792)]

const fit = (mode: ZoomMode, pages: PageInfo[], layout: PageLayoutMode, currentPage: number, cover = false, width = 1056, height = 800) =>
  fitZoom(mode, pages, { currentPage, rotation: 0, layout, cover, width, height })!

const layoutAt = (pages: PageInfo[], mode: PageLayoutMode, zoom: number, currentPage: number, cover = false, containerWidth = 1056) =>
  computeLayout(pages, { zoom, rotation: 0, mode, cover, containerWidth, currentPage })

describe('viewer layout', () => {
  it('fits continuous layouts to the whole document, not to the current page', () => {
    for (const mode of ['fit-width', 'fit-page'] as ZoomMode[]) {
      const zooms = [0, 1, 2].map((p) => fit(mode, mixed, 'continuous', p))
      expect(new Set(zooms).size).toBe(1)
    }
    // Fit Width: the widest page (A4 landscape) fits without a horizontal scrollbar
    const z = fit('fit-width', mixed, 'continuous', 0)
    const l = layoutAt(mixed, 'continuous', z, 0)
    expect(l.width).toBe(1056)
    for (const s of l.slots) expect(s.x).toBeGreaterThanOrEqual(VIEW_PADDING - 0.01)
    // Fit Page: every page fits in the viewport
    const zp = fit('fit-page', mixed, 'continuous', 0)
    const lp = layoutAt(mixed, 'continuous', zp, 0)
    for (const s of lp.slots) expect(s.height).toBeLessThanOrEqual(800 - VIEW_PADDING * 2 + 0.01)
  })

  it('does not let an outsized page set the fit zoom for the rest of the document', () => {
    // a brief of A4 pages with phone photos merged in (8160 x 6120 pt with /Rotate 90)
    const a4 = page(0, 595, 842)
    const photo = { ...page(0, 6120, 8160), rotation: 90 }
    const brief = [a4, a4, photo, photo, a4, page(0, 842, 595), a4].map((p, index) => ({ ...p, index, id: index + 1 }))
    const a4Only = [page(0, 595, 842), page(1, 842, 595)]
    for (const mode of ['fit-width', 'fit-page'] as ZoomMode[]) {
      // the same zoom as without the photos, whatever the current page
      const zooms = [0, 2, 6].map((p) => fit(mode, brief, 'continuous', p))
      expect(new Set(zooms).size).toBe(1)
      // (Fit Page leaves room for the horizontal scrollbar the photo brings)
      expect(zooms[0]).toBeCloseTo(fit(mode, a4Only, 'continuous', 0, false, 1056, mode === 'fit-page' ? 800 - 12 : 800), 6)
      expect(zooms[0]).toBeGreaterThan(0.5)
    }
    // the photo is wider than the viewport and scrolls; the A4 pages stay inside it
    const z = fit('fit-width', brief, 'continuous', 0)
    const l = layoutAt(brief, 'continuous', z, 0)
    expect(l.slots[2].width).toBeGreaterThan(1056)
    expect(l.slots[0].width).toBeLessThan(1056)
    // Single Page View on the photo still fits the photo
    expect(fit('fit-page', brief, 'single', 2)).toBeLessThan(0.1)
    // a document of mostly large pages fits those, and its small pages are simply smaller
    const big = [photo, photo, photo, a4].map((p, index) => ({ ...p, index, id: index + 1 }))
    expect(fit('fit-width', big, 'continuous', 3)).toBeCloseTo(fit('fit-width', [photo], 'continuous', 0), 6)
  })

  it('leaves room for the horizontal scrollbar an outsized page brings, at every viewport size', () => {
    const a4 = (n: number) => Array.from({ length: n }, (_, i) => page(i, 595, 842))
    const docs = [
      [...a4(4), page(4, 2011, 600)], // wide page near the Fit Page threshold
      [...a4(4), page(4, 6120, 8160)], // phone photo
      [...a4(4), page(4, 946, 2048)], // tall screenshot
      [...a4(3), page(3, 842, 595), page(4, 1086, 1528)],
      [page(0, 612, 792), page(1, 1008, 612), page(2, 612, 792)] // landscape Legal among Letter
    ]
    // fitZoom gets the height without a horizontal scrollbar, so the scrollbar cannot change the
    // zoom; when the content does scroll sideways, the pages that count still fit above the bar
    for (const pages of docs) {
      for (const width of [400, 600, 800, 1000, 1400]) {
        for (let h = 100; h <= 2000; h += 1) {
          const z = fit('fit-page', pages, 'continuous', 0, false, width, h)
          const l = layoutAt(pages, 'continuous', z, 0, false, width)
          if (l.width <= width) continue
          const keptHeights = l.slots.filter((s) => s.width <= width - VIEW_PADDING * 2).map((s) => s.height)
          for (const ht of keptHeights) expect(ht).toBeLessThanOrEqual(Math.max(100, h - VIEW_PADDING * 2 - 12) + 0.01)
        }
      }
    }
    // the wide page and the photo scroll; the A4 pages fit above the scrollbar
    const a4Fit = (h: number) => fit('fit-page', a4(4), 'continuous', 0, false, 1000, h)
    expect(fit('fit-page', docs[0], 'continuous', 0, false, 1000, 700)).toBeCloseTo(a4Fit(700 - 12), 6)
    expect(fit('fit-page', docs[1], 'continuous', 0, false, 1000, 700)).toBeCloseTo(a4Fit(700 - 12), 6)
    // the tall screenshot is narrow: it is left out of the height fit and scrolls down
    expect(fit('fit-page', docs[2], 'continuous', 0, false, 1000, 700)).toBeCloseTo(a4Fit(700), 6)
  })

  it('still fits the shown page in Single Page View', () => {
    expect(fit('fit-page', mixed, 'single', 1)).not.toBeCloseTo(fit('fit-page', mixed, 'single', 0), 2)
  })

  it('treats a lone cover page as half a spread', () => {
    const pages = letter(5)
    const zCover = fit('fit-width', pages, 'two-page', 0, true)
    const zSpread = fit('fit-width', pages, 'two-page', 1, true)
    expect(zCover).toBeCloseTo(zSpread, 6)
    for (const zoom of [zCover, 1]) {
      const l = layoutAt(pages, 'two-page', zoom, 0, true)
      const s = l.slots[0]
      // the cover sits in the right half and stays inside the content
      expect(s.x).toBeGreaterThanOrEqual(l.width / 2)
      expect(s.x + s.width).toBeLessThanOrEqual(l.width - VIEW_PADDING + 0.01)
      expect(l.width).toBe(Math.max(1056, 2 * s.width + PAGE_GAP + 2 * VIEW_PADDING))
    }
    // same in Two Page Scrolling
    const zc = fit('fit-width', pages, 'two-page-continuous', 0, true)
    const lc = layoutAt(pages, 'two-page-continuous', zc, 0, true)
    expect(lc.width).toBe(1056)
    expect(lc.slots[0].x + lc.slots[0].width).toBeLessThanOrEqual(lc.width - VIEW_PADDING + 0.01)
    expect(lc.slots[1].width).toBeCloseTo(lc.slots[0].width, 6)
  })

  it('keeps the zoom on a lone last page in Two Page View', () => {
    const pages = letter(5)
    expect(fit('fit-width', pages, 'two-page', 4)).toBeCloseTo(fit('fit-width', pages, 'two-page', 0), 6)
    expect(fit('fit-page', pages, 'two-page', 4)).toBeCloseTo(fit('fit-page', pages, 'two-page', 0), 6)
    // a one-page document is not a spread
    expect(fit('fit-width', letter(1), 'two-page', 0)).toBeCloseTo(fit('fit-width', letter(1), 'single', 0), 6)
  })
})
