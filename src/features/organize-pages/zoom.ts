/** Thumbnail size, fit presets and zoom anchoring for the Organize Pages grid (pure, unit tested). */
import { cellPosition, GRID, gridMetrics, SQUARE, type BoxAspect, type GridMetrics } from './order'

/** Smallest thumbnail (the long side of a page box, CSS pixels). */
export const MIN_THUMB = 80
/** Largest thumbnail on any screen; the real maximum is one page filling the grid's width. */
export const ABS_MAX_THUMB = 4000
export const DEFAULT_THUMB = 170
/** Thumbnails never get smaller than this maximum, even in a very narrow window. */
const MIN_MAX_THUMB = 160

/** Fit presets: one page per row, two per row, or a whole page in the view's height. */
export type FitMode = 'width' | 'two' | 'page'
export const FIT_MODES: FitMode[] = ['width', 'two', 'page']

export function isFitMode(v: unknown): v is FitMode {
  return v === 'width' || v === 'two' || v === 'page'
}

export interface Viewport {
  width: number
  height: number
}

/** Largest whole thumbnail size that still lays out at least `columns` columns. */
export function thumbForColumns(columns: number, viewportWidth: number, aspect: BoxAspect = SQUARE): number {
  const n = Math.max(1, Math.floor(columns))
  const usable = viewportWidth - GRID.padX * 2 - (n - 1) * GRID.gapX
  let t = Math.floor((usable / n - GRID.cellExtraW) / aspect.w)
  // Rounding of the box width can cost a column; step down until the layout has them.
  for (let k = 0; k < 4 && t > 1 && gridMetrics(n, viewportWidth, t, aspect).columns < n; k++) t--
  return Math.max(1, t)
}

/** Thumbnail size at which a whole page (with its number) fits in the view's height. */
export function thumbForHeight(viewportHeight: number, aspect: BoxAspect = SQUARE): number {
  return Math.max(1, Math.floor((viewportHeight - GRID.padY * 2 - GRID.cellExtraH) / aspect.h))
}

/** The largest thumbnail for this view: one page filling the grid's width. */
export function maxThumb(viewportWidth: number, aspect: BoxAspect = SQUARE): number {
  return Math.min(ABS_MAX_THUMB, Math.max(MIN_MAX_THUMB, thumbForColumns(1, viewportWidth, aspect)))
}

export function clampThumb(size: number, viewportWidth: number, aspect: BoxAspect = SQUARE): number {
  if (!Number.isFinite(size)) return DEFAULT_THUMB
  return Math.max(MIN_THUMB, Math.min(maxThumb(viewportWidth, aspect), Math.round(size)))
}

/** Thumbnail size a fit preset gives in this view. */
export function fitThumb(fit: FitMode, view: Viewport, aspect: BoxAspect = SQUARE): number {
  const size =
    fit === 'width'
      ? thumbForColumns(1, view.width, aspect)
      : fit === 'two'
        ? thumbForColumns(2, view.width, aspect)
        : Math.min(thumbForHeight(view.height, aspect), thumbForColumns(1, view.width, aspect))
  return clampThumb(size, view.width, aspect)
}

/**
 * The size thumbnails are shown at: the fit preset's when one is chosen, otherwise the chosen size
 * limited to what the view allows. The chosen size itself is kept, so it comes back when the
 * window gets wider again.
 */
export function effectiveThumb(
  requested: number,
  fit: FitMode | null,
  view: Viewport,
  aspect: BoxAspect = SQUARE
): number {
  return fit ? fitThumb(fit, view, aspect) : clampThumb(requested, view.width, aspect)
}

/** Slider positions run 0..SLIDER_STEPS on a log scale, so small sizes stay fine-grained. */
export const SLIDER_STEPS = 1000

export function sizeToSlider(size: number, min: number, max: number): number {
  if (max <= min) return SLIDER_STEPS
  const s = Math.max(min, Math.min(max, size))
  return Math.round((Math.log(s / min) / Math.log(max / min)) * SLIDER_STEPS)
}

export function sliderToSize(pos: number, min: number, max: number): number {
  if (max <= min) return min
  const t = Math.max(0, Math.min(SLIDER_STEPS, pos)) / SLIDER_STEPS
  return Math.round(min * Math.pow(max / min, t))
}

/**
 * One arrow-key step of the size slider: 10 px or 5 %, whichever is more, kept within min..max.
 * The slider's own steps are too fine for that at small sizes (several positions round to the
 * same pixel size), so the arrow keys step the size and the slider follows.
 */
export function sliderKeyStep(size: number, direction: 1 | -1, min: number, max: number): number {
  const next = direction > 0 ? Math.max(size * 1.05, size + 10) : Math.min(size / 1.05, size - 10)
  return Math.max(min, Math.min(max, Math.round(next)))
}

/** One zoom step (buttons, Ctrl+= and Ctrl+-): 20 % bigger or smaller, at least 10 px. */
export function zoomStep(size: number, direction: 1 | -1): number {
  const next = direction > 0 ? size * 1.2 : size / 1.2
  return Math.round(direction > 0 ? Math.max(next, size + 10) : Math.min(next, size - 10))
}

/** Device pixels on the long side of a grid thumbnail's bitmap, at most. */
export const MAX_THUMB_RENDER_PX = 3072
/** ... and of the large page preview. */
export const MAX_PREVIEW_RENDER_PX = 4096

/**
 * Long side in device pixels to render a page shown `displayLong` CSS pixels long. Sizes are
 * rounded up to steps (40 px up to 400 px, then about 10 %) so small zoom changes reuse bitmaps;
 * big ones are capped, which only shows on very large, high-density screens.
 */
export function renderLongSide(displayLong: number, dpr: number, cap = MAX_THUMB_RENDER_PX): number {
  const L = Math.max(1, displayLong)
  let step: number
  if (L <= 400) step = Math.max(40, Math.ceil(L / 40) * 40)
  else step = Math.ceil(400 * Math.pow(1.1, Math.ceil(Math.log(L / 400) / Math.log(1.1) - 1e-9)))
  return Math.min(cap, Math.round(step * Math.max(1, dpr)))
}

/**
 * A point of the grid to keep in place while the thumbnail size changes: page `index`, the
 * fraction `fy` of its cell's height, which stays `viewY` pixels below the top of the view.
 * `reveal` also brings the whole page into view when it fits (the focused page).
 */
export interface ZoomAnchor {
  index: number
  fy: number
  viewY: number
  reveal: boolean
}

/** The page at a point of the view (`viewY` from its top, `x` in content coordinates). */
export function anchorAtPoint(
  m: GridMetrics,
  count: number,
  scrollTop: number,
  viewY: number,
  x?: number
): ZoomAnchor | null {
  if (count <= 0) return null
  const rowH = m.cellHeight + m.gapY
  const y = scrollTop + viewY
  const row = Math.max(0, Math.min(m.rows - 1, Math.floor((y - m.padY + m.gapY / 2) / rowH)))
  const col =
    x === undefined
      ? 0
      : Math.max(0, Math.min(m.columns - 1, Math.floor((x - m.offsetX + m.gapX / 2) / (m.cellWidth + m.gapX))))
  const index = Math.min(count - 1, row * m.columns + col)
  const top = cellPosition(m, index).top
  return { index, fy: (y - top) / m.cellHeight, viewY, reveal: false }
}

/** The focused page as an anchor when any of it is in view, else null. */
export function anchorForPage(
  m: GridMetrics,
  index: number,
  scrollTop: number,
  viewportHeight: number
): ZoomAnchor | null {
  if (index < 0) return null
  const top = cellPosition(m, index).top
  if (top + m.cellHeight <= scrollTop || top >= scrollTop + viewportHeight) return null
  return { index, fy: 0, viewY: top - scrollTop, reveal: true }
}

/** Scroll position that puts the anchor back where it was in the new layout. */
export function scrollForAnchor(m: GridMetrics, viewportHeight: number, a: ZoomAnchor): number {
  const top = cellPosition(m, a.index).top
  let s = top + a.fy * m.cellHeight - a.viewY
  if (a.reveal) {
    const margin = 12
    if (m.cellHeight + margin * 2 <= viewportHeight)
      s = Math.min(top - margin, Math.max(top + m.cellHeight + margin - viewportHeight, s))
    else s = top - margin
  }
  return Math.max(0, Math.min(Math.max(0, m.contentHeight - viewportHeight), Math.round(s)))
}
