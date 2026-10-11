import type { Matrix, Point, Rect } from '@shared/geometry'
import {
  CSS_PX_PER_POINT,
  invertMatrix,
  multiplyMatrix,
  rotateMatrix,
  scaleMatrix,
  transformPoint,
  transformRect,
  translateMatrix
} from '@shared/geometry'

export interface CssRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Maps between page space (points, y down, as used by the engine) and CSS pixels inside a page
 * element, taking zoom and view rotation into account. Every page layer must use it.
 */
export class PageGeometry {
  /** CSS pixels per point. */
  readonly scale: number
  readonly cssWidth: number
  readonly cssHeight: number
  readonly matrix: Matrix
  readonly inverse: Matrix

  constructor(
    readonly pageIndex: number,
    /** Page size in points (rotation from /Rotate already applied). */
    readonly width: number,
    readonly height: number,
    /** Zoom factor, 1 = 100%. */
    readonly zoom: number,
    /** View rotation (View > Rotate View). */
    readonly rotation: 0 | 90 | 180 | 270 = 0
  ) {
    this.scale = zoom * CSS_PX_PER_POINT
    let m = multiplyMatrix(scaleMatrix(this.scale), rotateMatrix(rotation))
    const box = transformRect([0, 0, width, height], m)
    m = multiplyMatrix(m, translateMatrix(-box[0], -box[1]))
    this.matrix = m
    this.inverse = invertMatrix(m)
    this.cssWidth = box[2] - box[0]
    this.cssHeight = box[3] - box[1]
  }

  /** Page point -> CSS point (relative to the page element). */
  toCss(p: Point): Point {
    return transformPoint(p, this.matrix)
  }

  /** CSS point (relative to the page element) -> page point. */
  toPage(p: Point): Point {
    return transformPoint(p, this.inverse)
  }

  /** Page rect -> CSS rect relative to the page element. */
  rectToCss(r: Rect): CssRect {
    const t = transformRect(r, this.matrix)
    return { left: t[0], top: t[1], width: t[2] - t[0], height: t[3] - t[1] }
  }

  /** CSS rect -> page rect. */
  cssToRect(r: CssRect): Rect {
    return transformRect([r.left, r.top, r.left + r.width, r.top + r.height], this.inverse)
  }

  /** Converts a pointer event to page coordinates, given the page element. */
  eventToPage(e: { clientX: number; clientY: number }, pageElement: Element): Point {
    const b = pageElement.getBoundingClientRect()
    return this.toPage([e.clientX - b.left, e.clientY - b.top])
  }

  /** Length in page points -> CSS pixels. */
  len(points: number): number {
    return points * this.scale
  }
}
