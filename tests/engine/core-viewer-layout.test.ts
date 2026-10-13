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
