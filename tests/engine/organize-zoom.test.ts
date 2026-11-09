import { describe, expect, it } from 'vitest'
import { boxAspect, cellPosition, gapAt, gridMetrics, rowGapTop, SQUARE } from '../../src/features/organize-pages/order'
import {
  ABS_MAX_THUMB,
  anchorAtPoint,
  anchorForPage,
  clampThumb,
  effectiveThumb,
  fitThumb,
  isFitMode,
  maxThumb,
  MAX_THUMB_RENDER_PX,
  MIN_THUMB,
  renderLongSide,
  scrollForAnchor,
  SLIDER_STEPS,
  sizeToSlider,
  sliderKeyStep,
  sliderToSize,
  thumbForColumns,
  thumbForHeight,
  zoomStep
} from '../../src/features/organize-pages/zoom'

const LETTER = { width: 612, height: 792 }
const LANDSCAPE = { width: 792, height: 612 }

describe('organize zoom: box shape', () => {
  it('uses narrow boxes for portrait documents and square ones for mixed documents', () => {
    expect(boxAspect([LETTER, LETTER])).toEqual({ w: 0.773, h: 1 })
    expect(boxAspect([LANDSCAPE])).toEqual({ w: 1, h: 0.773 })
    expect(boxAspect([LETTER, LANDSCAPE])).toEqual({ w: 1, h: 1 })
    expect(boxAspect([])).toEqual(SQUARE)
  })
  it('lays out boxes of that shape', () => {
    const m = gridMetrics(10, 1000, 200, { w: 0.773, h: 1 })
    expect(m.boxWidth).toBe(155)
    expect(m.boxHeight).toBe(200)
    expect(m.cellWidth).toBe(155 + 24)
    expect(m.cellHeight).toBe(244)
    // the default stays square, as before
    expect(gridMetrics(10, 800, 160).cellWidth).toBe(184)
  })
})

describe('organize zoom: fit presets', () => {
  const aspect = boxAspect([LETTER])
  it('fit width gives one column as wide as the view', () => {
    for (const width of [600, 1000, 1352, 2400]) {
      const t = thumbForColumns(1, width, aspect)
      const m = gridMetrics(50, width, t, aspect)
      expect(m.columns).toBe(1)
      // the page box fills the width up to the gutters (within rounding)
      expect(m.cellWidth).toBeLessThanOrEqual(width - 48)
      expect(m.cellWidth).toBeGreaterThan(width - 48 - 3)
      // one more pixel would not fit
      expect(gridMetrics(50, width, t + 2, aspect).cellWidth).toBeGreaterThan(width - 48)
    }
  })
  it('two per row gives exactly two columns', () => {
    for (const width of [500, 777, 1000, 1400, 2560]) {
      for (const a of [aspect, SQUARE, boxAspect([LANDSCAPE])]) {
        const t = thumbForColumns(2, width, a)
        expect(gridMetrics(50, width, t, a).columns).toBe(2)
        expect(gridMetrics(50, width, t + 3, a).columns).toBe(1)
      }
    }
  })
  it('fit page fits a whole cell in the view height', () => {
    const t = thumbForHeight(800, aspect)
    const m = gridMetrics(50, 3000, t, aspect)
    expect(m.cellHeight + 2 * m.padY).toBeLessThanOrEqual(800)
    expect(m.cellHeight + 2 * m.padY).toBeGreaterThan(797)
    // in a narrow, tall view the width limits it
    expect(fitThumb('page', { width: 400, height: 2000 }, aspect)).toBe(thumbForColumns(1, 400, aspect))
    expect(fitThumb('page', { width: 3000, height: 800 }, aspect)).toBe(t)
  })
  it('the maximum follows the width, and a chosen size survives a narrower window', () => {
    expect(maxThumb(1400, aspect)).toBe(thumbForColumns(1, 1400, aspect))
    expect(maxThumb(1400, aspect)).toBeGreaterThan(1000)
    expect(maxThumb(100, aspect)).toBe(160)
    expect(maxThumb(100000)).toBe(ABS_MAX_THUMB)
    const view = { width: 700, height: 600 }
    expect(effectiveThumb(1500, null, view, aspect)).toBe(maxThumb(700, aspect))
    expect(effectiveThumb(1500, null, { width: 3000, height: 600 }, aspect)).toBe(1500)
    expect(effectiveThumb(20, null, view, aspect)).toBe(MIN_THUMB)
    expect(effectiveThumb(300, 'width', view, aspect)).toBe(thumbForColumns(1, 700, aspect))
    expect(clampThumb(NaN, 700)).toBe(170)
    expect(isFitMode('two')).toBe(true)
    expect(isFitMode('wide')).toBe(false)
  })
})

describe('organize zoom: slider and steps', () => {
  it('maps the slider on a log scale, both ways', () => {
    expect(sliderToSize(0, 80, 1280)).toBe(80)
    expect(sliderToSize(SLIDER_STEPS, 80, 1280)).toBe(1280)
    expect(sliderToSize(SLIDER_STEPS / 2, 80, 1280)).toBe(320)
    for (const size of [80, 100, 170, 333, 900, 1280])
      expect(Math.abs(sliderToSize(sizeToSlider(size, 80, 1280), 80, 1280) - size)).toBeLessThanOrEqual(
        Math.ceil(size * 0.003)
      )
    // small sizes get more of the slider than large ones
    expect(sizeToSlider(160, 80, 1280) - sizeToSlider(80, 80, 1280)).toBe(250)
    expect(sizeToSlider(170, 80, 80)).toBe(SLIDER_STEPS)
  })
  it('zoom steps are relative and at least 10 px', () => {
    expect(zoomStep(100, 1)).toBe(120)
    expect(zoomStep(1000, 1)).toBe(1200)
    expect(zoomStep(1200, -1)).toBe(1000)
    expect(zoomStep(40, 1)).toBe(50)
    expect(zoomStep(40, -1)).toBe(30)
  })
  it('arrow keys on the slider always change the size, at least 10 px, within the range', () => {
    // At small sizes several slider positions round to the same pixel size; the key step does not.
    for (const size of [80, 81, 120, 170, 179, 400, 1200]) {
      expect(sliderKeyStep(size, 1, 80, 1280)).toBeGreaterThanOrEqual(size + 10)
      expect(sizeToSlider(sliderKeyStep(size, 1, 80, 1280), 80, 1280)).toBeGreaterThan(sizeToSlider(size, 80, 1280))
    }
    expect(sliderKeyStep(170, 1, 80, 1280)).toBe(180)
    expect(sliderKeyStep(1000, 1, 80, 1280)).toBe(1050)
    expect(sliderKeyStep(170, -1, 80, 1280)).toBe(160)
    expect(sliderKeyStep(85, -1, 80, 1280)).toBe(80)
    expect(sliderKeyStep(1275, 1, 80, 1280)).toBe(1280)
    expect(sliderKeyStep(80, -1, 80, 1280)).toBe(80)
  })
  it('renders at the displayed size times the screen density, in steps, with a cap', () => {
    expect(renderLongSide(170, 1)).toBe(200)
    expect(renderLongSide(170, 2)).toBe(400)
    expect(renderLongSide(10, 1)).toBe(40)
    // never below the displayed size
    for (const L of [401, 555, 999, 1234, 1700]) {
      expect(renderLongSide(L, 1)).toBeGreaterThanOrEqual(L)
      expect(renderLongSide(L, 1)).toBeLessThan(L * 1.11)
    }
    // close sizes share a bitmap
    expect(renderLongSide(1000, 1)).toBe(renderLongSide(1010, 1))
    expect(renderLongSide(2000, 2)).toBe(MAX_THUMB_RENDER_PX)
    expect(renderLongSide(2000, 2, 8000)).toBeGreaterThanOrEqual(4000)
  })
})

describe('organize zoom: keeping the place', () => {
  it('keeps the page under the pointer at the same height of the view', () => {
    const before = gridMetrics(100, 1200, 170)
    const after = gridMetrics(100, 1200, 400)
    const scrollTop = 1500
    const a = anchorAtPoint(before, 100, scrollTop, 300, 700)!
    const pageBefore = a.index
    const s = scrollForAnchor(after, 800, a)
    const back = anchorAtPoint(after, 100, s, 300, 0)!
    expect(Math.floor(back.index / after.columns)).toBe(Math.floor(pageBefore / after.columns))
    expect(back.fy).toBeCloseTo(a.fy, 2)
  })
  it('brings the focused page fully into view when it fits', () => {
    const before = gridMetrics(100, 1200, 170)
    const scrollTop = 2000
    const focus = 40
    const top = cellPosition(before, focus).top
    const a = anchorForPage(before, focus, scrollTop, 800)
    // partly above the view: still the anchor
    expect(top).toBeLessThan(scrollTop)
    expect(top + before.cellHeight).toBeGreaterThan(scrollTop)
    expect(a).not.toBeNull()
    for (const size of [300, 500, 700]) {
      const after = gridMetrics(100, 1200, size)
      const s = scrollForAnchor(after, 800, a!)
      const t = cellPosition(after, focus).top
      expect(t).toBeGreaterThanOrEqual(s)
      expect(t + after.cellHeight).toBeLessThanOrEqual(s + 800)
    }
    // a page bigger than the view shows its top
    const huge = gridMetrics(100, 1200, 1100)
    expect(scrollForAnchor(huge, 800, a!)).toBe(cellPosition(huge, focus).top - 12)
    // pages out of view are not anchors
    expect(anchorForPage(before, 0, scrollTop, 800)).toBeNull()
  })
  it('stays within the content', () => {
    const m = gridMetrics(3, 1200, 170)
    expect(scrollForAnchor(m, 800, { index: 2, fy: 0.5, viewY: 0, reveal: false })).toBe(0)
  })
})

describe('organize zoom: one page per row', () => {
  it('picks the gap by height and draws it between rows', () => {
    const m = gridMetrics(5, 800, thumbForColumns(1, 800))
    expect(m.columns).toBe(1)
    const c2 = cellPosition(m, 2)
    expect(gapAt(m, 5, c2.left + 5, c2.top + 10)).toMatchObject({ gap: 2, horizontal: true })
    expect(gapAt(m, 5, c2.left + m.cellWidth - 5, c2.top + 10).gap).toBe(2)
    expect(gapAt(m, 5, c2.left + 5, c2.top + m.cellHeight - 10).gap).toBe(3)
    expect(gapAt(m, 5, 0, 0).gap).toBe(0)
    expect(gapAt(m, 5, 0, 1e6).gap).toBe(5)
    expect(gapAt(m, 5, 0, c2.top).top).toBe(rowGapTop(m, 2))
    expect(rowGapTop(m, 2)).toBe(c2.top - m.gapY / 2)
  })
})
