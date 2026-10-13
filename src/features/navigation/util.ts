/** Small pure helpers shared by the navigation panels and dialogs (unit-tested). */

export function formatBytes(n: number | null | undefined, withExact = false): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—'
  const exact = `${n.toLocaleString('en-US')} Bytes`
  if (n < 1024) return n === 1 ? '1 Byte' : exact
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const short = `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[u]}`
  return withExact ? `${short} (${exact})` : short
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const UNIT_FACTORS: Record<string, { per: number; digits: number; label: string }> = {
  in: { per: 72, digits: 2, label: 'in' },
  mm: { per: 72 / 25.4, digits: 1, label: 'mm' },
  cm: { per: 72 / 2.54, digits: 2, label: 'cm' },
  pt: { per: 1, digits: 0, label: 'pt' }
}

/** "8.50 × 11.00 in" for a page size in points. */
export function formatPageSize(width: number, height: number, units: string): string {
  const u = UNIT_FACTORS[units] ?? UNIT_FACTORS.in
  const f = (v: number) => (v / u.per).toFixed(u.digits)
  return `${f(width)} × ${f(height)} ${u.label}`
}

/** "page 3", "pages 2–4", "pages 1, 3 and 5" (1-based in the output). */
export function describePages(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  if (!sorted.length) return 'no pages'
  if (sorted.length === 1) return `page ${sorted[0] + 1}`
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1)
  if (contiguous) return `pages ${sorted[0] + 1}–${sorted[sorted.length - 1] + 1}`
  const nums = sorted.map((v) => String(v + 1))
  if (nums.length <= 4) return `pages ${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`
  return `${nums.length} pages`
}

/** File-name friendly page part: "page 3", "pages 2-4". */
export function pagesFileSuffix(indices: number[]): string {
  return describePages(indices)
    .replace('–', '-')
    .replace(/,? and /, ', ')
}

export interface ThumbLayout {
  /** Top of each item in CSS px. */
  tops: number[]
  heights: number[]
  /** Height of each thumbnail image. */
  imageHeights: number[]
  total: number
}

export const THUMB_LABEL_HEIGHT = 22
export const THUMB_PADDING = 8
export const THUMB_GAP = 6

/** Vertical layout of a single-column thumbnail list for page sizes (points) at a thumbnail width. */
export function thumbLayout(pages: { width: number; height: number }[], width: number): ThumbLayout {
  const tops: number[] = []
  const heights: number[] = []
  const imageHeights: number[] = []
  let y = THUMB_GAP
  for (const p of pages) {
    const ratio = Math.min(2.5, Math.max(0.2, p.height / Math.max(1, p.width)))
    const ih = Math.round(width * ratio)
    const h = ih + THUMB_LABEL_HEIGHT + THUMB_PADDING * 2
    tops.push(y)
    heights.push(h)
    imageHeights.push(ih)
    y += h + THUMB_GAP
  }
  return { tops, heights, imageHeights, total: y }
}

/** Index of the item at y (clamped), by binary search. */
export function itemAt(layout: ThumbLayout, y: number): number {
  const { tops } = layout
  if (!tops.length) return -1
  let lo = 0
  let hi = tops.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Insertion point (0..n) for a drop at y: before the item when above its middle, else after it. */
export function dropIndexAt(layout: ThumbLayout, y: number): number {
  const n = layout.tops.length
  if (!n) return 0
  const i = itemAt(layout, y)
  if (y < layout.tops[0]) return 0
  return y < layout.tops[i] + layout.heights[i] / 2 ? i : i + 1
}

/** Visible item range [first, last] for a scroll window, with overscan in px. */
export function visibleRange(
  layout: ThumbLayout,
  top: number,
  height: number,
  overscan = 300
): [number, number] {
  const n = layout.tops.length
  if (!n) return [0, -1]
  const first = itemAt(layout, Math.max(0, top - overscan))
  const last = itemAt(layout, top + height + overscan)
  return [first, Math.min(n - 1, last)]
}

/** Splits text into chunks of whole sentences no longer than `max` characters (for speech). */
export function speechChunks(text: string, max = 220): string[] {
  const clean = text
    .replace(/-\n(?=\p{Ll})/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?;:]+[.!?;:]+["'”’)\]]*\s*|[^.!?;:]+$/gu) ?? [clean]
  const out: string[] = []
  let cur = ''
  const push = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (const s of sentences) {
    if ((cur + s).length <= max) {
      cur += s
      continue
    }
    push()
    if (s.length <= max) {
      cur = s
      continue
    }
    // very long sentence: split on spaces
    let rest = s
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max)
      if (cut < max / 2) cut = max
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut)
    }
    cur = rest
  }
  push()
  return out
}

/** "1–3, 5, 8–9" for 0-based page indices. */
export function formatPageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]
    let end = start
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i]
    parts.push(end > start ? `${start + 1}–${end + 1}` : String(start + 1))
  }
  return parts.join(', ')
}

/** Acrobat-style compatibility note for a PDF version. */
export function pdfVersionLabel(version: string): string {
  const notes: Record<string, string> = {
    '1.0': 'Acrobat 1.x',
    '1.1': 'Acrobat 2.x',
    '1.2': 'Acrobat 3.x',
    '1.3': 'Acrobat 4.x',
    '1.4': 'Acrobat 5.x',
    '1.5': 'Acrobat 6.x',
    '1.6': 'Acrobat 7.x',
    '1.7': 'Acrobat 8.x and later',
    '2.0': 'PDF 2.0'
  }
  return notes[version] ? `${version} (${notes[version]})` : version
}

export const STANDARD_INFO_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped'
]

/** Why a custom document property name is not allowed, or null when it is fine. */
export function customKeyError(key: string): string | null {
  const k = key.trim()
  if (!k) return 'Enter a name.'
  if (!/^[A-Za-z0-9_.\-+:]{1,127}$/.test(k)) return 'Use letters, digits and . _ - + : only (no spaces).'
  if (STANDARD_INFO_KEYS.includes(k))
    return `“${k}” is a standard property. Change it on the Description tab.`
  return null
}

/** Guesses a MIME type from a file name (for embedded files). */
export function mimeTypeFor(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    htm: 'text/html',
    html: 'text/html',
    xml: 'application/xml',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4'
  }
  return map[ext] ?? 'application/octet-stream'
}

/** Trims search-result context to whole words: "pter 1 Hello" -> "1 Hello". */
export function tidyContext(
  c: { before: string; match: string; after: string },
  cutBefore: boolean,
  cutAfter: boolean
) {
  let before = c.before
  let after = c.after
  if (cutBefore) {
    const i = before.indexOf(' ')
    if (i >= 0 && i < before.length - 1) before = before.slice(i + 1)
  }
  if (cutAfter) {
    const i = after.lastIndexOf(' ')
    if (i > 0) after = after.slice(0, i)
  }
  return { before, match: c.match, after }
}
