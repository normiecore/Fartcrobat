import { describe, expect, it } from 'vitest'
import type { Point } from '@shared/geometry'
import {
  calloutLine,
  capsuleInterval,
  cloudPath,
  constrainSquare,
  densify,
  distToSegment,
  eraseStrokes,
  fitRect,
  inkBounds,
  processStroke,
  simplifyRdp,
  smoothPoints,
  snapAngle
} from '@features/markup-tools/geometry'

const len = (s: Point[]) => s.slice(1).reduce((acc, p, i) => acc + Math.hypot(p[0] - s[i][0], p[1] - s[i][1]), 0)

describe('markup-tools geometry', () => {
  it('simplifies polylines with Ramer-Douglas-Peucker', () => {
    const line: Point[] = Array.from({ length: 50 }, (_, i) => [i, 0.01 * Math.sin(i)])
    expect(simplifyRdp(line, 0.1)).toEqual([line[0], line[49]])
    const corner: Point[] = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]]
    expect(simplifyRdp(corner, 0.5)).toEqual([[0, 0], [10, 0], [10, 10]])
    expect(simplifyRdp([[1, 1]], 1)).toEqual([[1, 1]])
  })

  it('smooths jitter and keeps end points', () => {
    const jitter: Point[] = Array.from({ length: 20 }, (_, i) => [i, i % 2 ? 1 : -1])
    const s = smoothPoints(jitter, 2)
    expect(s[0]).toEqual(jitter[0])
    expect(s[19]).toEqual(jitter[19])
    expect(Math.max(...s.slice(2, -2).map((p) => Math.abs(p[1])))).toBeLessThan(0.6)
  })

  it('densifies along a smooth curve through the original points', () => {
    const pts: Point[] = [[0, 0], [10, 10], [20, 0]]
    const d = densify(pts, 1)
    expect(d.length).toBeGreaterThan(20)
    expect(d[0]).toEqual([0, 0])
    expect(d[d.length - 1]).toEqual([20, 0])
    expect(d).toContainEqual([10, 10])
  })

  it('turns raw samples into a compact smooth stroke', () => {
    const raw: Point[] = []
    for (let i = 0; i <= 200; i++) raw.push([100 + i, 100 + 20 * Math.sin(i / 20) + (i % 3) * 0.05])
    const s = processStroke(raw, 1.33)
    expect(s.length).toBeLessThan(raw.length / 2)
    expect(s.length).toBeGreaterThan(10)
    expect(s[0][0]).toBeCloseTo(100, 1)
    expect(s[s.length - 1][0]).toBeCloseTo(300, 1)
    // a single click becomes a dot (two coincident points)
    expect(processStroke([[5, 5]], 1)).toHaveLength(2)
  })

  it('constrains rectangles to squares and lines to 45 degree steps', () => {
    expect(constrainSquare([0, 0], [10, 4])).toEqual([10, 10])
    expect(constrainSquare([0, 0], [-3, 8])).toEqual([-8, 8])
    const p = snapAngle([0, 0], [10, 1])
    expect(p[0]).toBeCloseTo(Math.hypot(10, 1))
    expect(p[1]).toBeCloseTo(0)
    const d = snapAngle([0, 0], [10, 9])
    expect(d[0]).toBeCloseTo(d[1])
    const v = snapAngle([0, 0], [1, -10])
    expect(v[0]).toBeCloseTo(0)
    expect(v[1]).toBeLessThan(0)
  })

  it('keeps rectangles on the page', () => {
    expect(fitRect([590, 10, 690, 50], 612, 792)).toEqual([512, 10, 612, 50])
    expect(fitRect([-10, -10, 20, 20], 612, 792)).toEqual([0, 0, 30, 30])
  })

  it('routes callout leader lines to the nearest side of the box', () => {
    expect(calloutLine([100, 200], [300, 100, 400, 150])).toEqual([[100, 200], [282, 125], [300, 125]])
    expect(calloutLine([500, 125], [300, 100, 400, 150])).toEqual([[500, 125], [418, 125], [400, 125]])
    // tip right under the box: straight to the bottom edge
    expect(calloutLine([350, 160], [300, 100, 400, 150])).toEqual([[350, 160], [350, 150]])
  })

  it('builds cloudy outlines', () => {
    const d = cloudPath([[0, 0], [100, 0], [100, 50], [0, 50]], 10)
    expect(d.startsWith('M0.00 0.00')).toBe(true)
    expect((d.match(/A/g) ?? []).length).toBeGreaterThan(10)
    expect(cloudPath([], 10)).toBe('')
  })

  it('finds where a segment passes through the eraser', () => {
    const iv = capsuleInterval([0, 0], [100, 0], [50, -10], [50, 10], 5)!
    expect(iv[0]).toBeCloseTo(0.45, 2)
    expect(iv[1]).toBeCloseTo(0.55, 2)
    expect(capsuleInterval([0, 0], [100, 0], [50, 10], [60, 10], 5)).toBeNull()
    const all = capsuleInterval([0, 0], [10, 0], [-20, 0], [30, 0], 1)!
    expect(all).toEqual([0, 1])
    expect(distToSegment([5, 5], [0, 0], [10, 0])).toBe(5)
  })

  it('splits a stroke where the eraser crosses it', () => {
    const stroke: Point[] = [[0, 0], [50, 0], [100, 0]]
    const { strokes, changed } = eraseStrokes([stroke], [[50, -20], [50, 20]], 5)
    expect(changed).toBe(true)
    expect(strokes).toHaveLength(2)
    expect(strokes[0][0]).toEqual([0, 0])
    expect(strokes[0][strokes[0].length - 1][0]).toBeCloseTo(45, 1)
    expect(strokes[1][0][0]).toBeCloseTo(55, 1)
    expect(strokes[1][strokes[1].length - 1]).toEqual([100, 0])
  })

  it('erases the end of a stroke and whole strokes', () => {
    const a: Point[] = [[0, 0], [100, 0]]
    const b: Point[] = [[0, 50], [10, 50]]
    // sweep over the right half of a, and over all of b
    const path: Point[] = [[60, 0], [110, 0], [110, 50], [-5, 50]]
    const { strokes } = eraseStrokes([a, b], path, 4)
    expect(strokes).toHaveLength(1)
    expect(strokes[0][0]).toEqual([0, 0])
    expect(strokes[0][1][0]).toBeCloseTo(56, 1)
    expect(len(strokes[0])).toBeCloseTo(56, 0)
  })

  it('leaves strokes alone when the eraser misses them', () => {
    const s: Point[][] = [[[0, 0], [10, 0], [20, 10]]]
    const res = eraseStrokes(s, [[0, 100], [50, 100]], 5)
    expect(res.changed).toBe(false)
    expect(res.strokes).toBe(s)
    // a dot is erased when touched
    expect(eraseStrokes([[[5, 5]]], [[5, 6]], 2).strokes).toEqual([])
  })

  it('keeps continuous pieces joined across untouched segments', () => {
    const zig: Point[] = [[0, 0], [10, 10], [20, 0], [30, 10], [40, 0]]
    const { strokes } = eraseStrokes([zig], [[35, -5], [35, 15]], 1)
    expect(strokes).toHaveLength(2)
    expect(strokes[0].slice(0, 4)).toEqual(zig.slice(0, 4))
    expect(inkBounds(strokes)![2]).toBeCloseTo(40, 3)
  })
})
