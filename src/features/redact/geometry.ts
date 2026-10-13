/** Geometry helpers for marks in the UI (no engine imports). */
import type { Rect } from '@shared/geometry'
import { quadToRect } from '@shared/geometry'
import { charRect, type PageText } from '@renderer/sdk'
import type { MarkInfo } from './shared'

/** The rectangles (page space) a mark covers: one per text line, or its area. */
export function markAreas(m: Pick<MarkInfo, 'quads' | 'rect'>): Rect[] {
  return m.quads.length ? m.quads.map(quadToRect) : [m.rect]
}

/** The page text lying under a mark (characters whose centre is inside it). */
export function textUnderMark(t: PageText, m: Pick<MarkInfo, 'quads' | 'rect'>): string {
  const areas = markAreas(m)
  let out = ''
  let lastWasGap = false
  for (let i = 0; i < t.text.length; i++) {
    const ch = t.text[i]
    if (ch === '\n') {
      if (out && !lastWasGap) out += ' '
      lastWasGap = true
      continue
    }
    const r = charRect(t, i)
    const cx = (r[0] + r[2]) / 2
    const cy = (r[1] + r[3]) / 2
    if (areas.some((a) => cx >= a[0] && cx <= a[2] && cy >= a[1] && cy <= a[3])) {
      out += ch
      lastWasGap = false
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

const UNIT_POINTS: Record<string, number> = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54 }

/** Size of an area in the user's measurement units, e.g. "2.5 × 0.4 in". */
export function formatSize(r: Rect, units: 'pt' | 'in' | 'mm' | 'cm' = 'in'): string {
  const k = UNIT_POINTS[units] ?? 72
  const digits = units === 'in' || units === 'cm' ? 100 : 1
  const fmt = (v: number) => String(Math.round((v / k) * digits) / digits)
  return `${fmt(r[2] - r[0])} × ${fmt(r[3] - r[1])} ${units}`
}
