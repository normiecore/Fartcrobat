/**
 * Pure helpers behind the read-only agent tools (tools/context.ts): they turn the app's own data
 * into the compact JSON an agent receives. No DOM, no engine and no app state, so they are unit
 * tested in Node. Every page number they output is 1-based and every rect is rounded to 0.01 pt.
 */
import type { AnnotInfo } from '@engine/ops/annots'
import type { FieldInfo } from '@engine/ops/forms'
import type { OutlineNode } from '@engine/ops/nav'
import type { Rect } from '@shared/geometry'
import type { PageInfo } from '@shared/types'
import { hitContext, rangeRects, type PageText, type SearchHit } from '@renderer/document/textModel'
import { buildThreads, cleanDate, threadLabel } from '@features/comments/shared'
import { signatureStatus } from '@features/digital-signatures/status'
import type { ValidationReport } from '@features/digital-signatures/types'

// common.tsx has the same rounding, but importing it would pull in the whole renderer.
const r2 = (v: number) => Math.round(v * 100) / 100
export const rect2 = (r: readonly number[]): number[] => r.map(r2)

// ---- get_page_text ------------------------------------------------------------------------------

export interface LineOut {
  text: string
  rect: number[]
}

export interface PageTextOut {
  page: number
  text?: string
  lines?: LineOut[]
  /** The page did not fit in max_chars: only its beginning is here. */
  truncated?: true
}

/** One page of get_page_text: its text, or (include_lines) its lines with their rects. */
export function pageTextOut(t: PageText, withLines: boolean): PageTextOut {
  const page = t.pageIndex + 1
  if (!withLines) return { page, text: t.text.replace(/\s+$/, '') }
  const lines: LineOut[] = []
  for (const l of t.lines) {
    const text = t.text.slice(l.start, l.end)
    if (text.trim()) lines.push({ text, rect: rect2(l.bbox) })
  }
  return { page, lines }
}

function sizeOf(p: PageTextOut): number {
  return p.lines ? p.lines.reduce((n, l) => n + l.text.length, 0) : (p.text?.length ?? 0)
}

/** True when the page has no text at all (a scan without recognised text, a blank page). */
export function isEmptyPage(p: PageTextOut): boolean {
  return p.lines ? p.lines.length === 0 : !p.text?.trim()
}

/** The first `n` characters of a page, ending at a line break when one is reasonably close. */
function cutPage(p: PageTextOut, n: number): PageTextOut | null {
  if (p.lines) {
    const lines: LineOut[] = []
    let used = 0
    for (const l of p.lines) {
      if (used + l.text.length > n) break
      lines.push(l)
      used += l.text.length
    }
    if (!lines.length && p.lines.length) lines.push({ ...p.lines[0], text: cutString(p.lines[0].text, n) })
    return lines.length ? { page: p.page, lines, truncated: true } : null
  }
  let text = cutString(p.text ?? '', n)
  const nl = text.lastIndexOf('\n')
  if (nl > n / 2) text = text.slice(0, nl)
  return text ? { page: p.page, text, truncated: true } : null
}

/** s cut to n UTF-16 units without splitting a character outside the BMP. */
function cutString(s: string, n: number): string {
  if (s.length <= n) return s
  const code = s.charCodeAt(n - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n)
}

/**
 * Collects pages for get_page_text until max_chars characters. The page that does not fit is cut
 * and becomes `nextPage`, where the agent continues.
 */
export class TextBudget {
  readonly pages: PageTextOut[] = []
  /** First page not returned in full, once the budget ran out. */
  nextPage: number | null = null
  private left: number

  constructor(maxChars: number) {
    this.left = maxChars
  }

  get full(): boolean {
    return this.nextPage !== null
  }

  /** Adds a page; returns false once the budget is used up (that page may have been cut). */
  add(p: PageTextOut): boolean {
    if (this.nextPage !== null) return false
    const size = sizeOf(p)
    if (size <= this.left) {
      this.pages.push(p)
      this.left -= size
      return true
    }
    this.nextPage = p.page
    if (this.left > 0) {
      const cut = cutPage(p, this.left)
      if (cut) this.pages.push(cut)
    }
    this.left = 0
    return false
  }
}

/** 0-based page indices as a 1-based range string ("3-5,8"). */
export function rangeText(pages: number[]): string {
  const parts: string[] = []
  for (let i = 0; i < pages.length; ) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++
    parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}-${pages[j] + 1}`)
    i = j + 1
  }
  return parts.join(',')
}

// ---- find_text ----------------------------------------------------------------------------------

export interface HitOut {
  page: number
  text: string
  /** The match with about 40 characters on each side, white space collapsed. */
  context: string
  rects: number[][]
}

export function hitOut(t: PageText, hit: SearchHit): HitOut {
  const c = hitContext(t, hit, 40)
  return {
    page: hit.page + 1,
    text: c.match,
    context: c.before + c.match + c.after,
    rects: rangeRects(t, hit.start, hit.end).map(rect2)
  }
}

// ---- render_page --------------------------------------------------------------------------------

/** Longest side of a rendered picture, in pixels: larger requests get a lower resolution. */
export const MAX_RENDER_SIDE = 2000

export interface RenderPlan {
  /** Device pixels per point. */
  scale: number
  /** Effective resolution (lower than asked when the picture would be too large). */
  dpi: number
  /** Part of the page shown, in points (the whole page when no region was asked for). */
  region: Rect
  /** The region in device pixels from the top-left of the page, or null for the whole page. */
  clip: Rect | null
  width: number
  height: number
  scaledDown: boolean
}

/** What render_page draws. Null when the region lies outside the page. */
export function renderPlan(pageSize: readonly [number, number], dpi: number, region: Rect | null, maxSide = MAX_RENDER_SIDE): RenderPlan | null {
  const [w, h] = pageSize
  let area: Rect = [0, 0, w, h]
  if (region) {
    const r: Rect = [Math.max(0, region[0]), Math.max(0, region[1]), Math.min(w, region[2]), Math.min(h, region[3])]
    if (r[2] - r[0] < 0.5 || r[3] - r[1] < 0.5) return null
    area = r
  }
  const aw = area[2] - area[0]
  const ah = area[3] - area[1]
  const wanted = dpi / 72
  const scale = Math.min(wanted, maxSide / aw, maxSide / ah)
  return {
    scale,
    dpi: r2(scale * 72),
    region: area,
    clip: region ? [area[0] * scale, area[1] * scale, area[2] * scale, area[3] * scale] : null,
    width: Math.max(1, Math.round(aw * scale)),
    height: Math.max(1, Math.round(ah * scale)),
    scaledDown: scale < wanted - 1e-9
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// ---- get_document_info --------------------------------------------------------------------------

export interface PageOut {
  page: number
  width: number
  height: number
  rotation?: number
  /** Only when it differs from the page number. */
  label?: string
}

export function pagesOut(pages: PageInfo[]): PageOut[] {
  return pages.map((p, i) => {
    const out: PageOut = { page: i + 1, width: r2(p.width), height: r2(p.height) }
    if (p.rotation) out.rotation = p.rotation
    if (p.label && p.label !== String(i + 1)) out.label = p.label
    return out
  })
}

/** Distinct page sizes with how many pages have each (instead of a list of thousands of pages). */
export function pageSizes(pages: PageInfo[]): { width: number; height: number; count: number; firstPage: number }[] {
  const sizes = new Map<string, { width: number; height: number; count: number; firstPage: number }>()
  pages.forEach((p, i) => {
    const width = r2(p.width)
    const height = r2(p.height)
    const key = `${width}x${height}`
    const s = sizes.get(key)
    if (s) s.count++
    else sizes.set(key, { width, height, count: 1, firstPage: i + 1 })
  })
  return [...sizes.values()]
}

export interface OutlineOut {
  title: string
  page?: number
  uri?: string
  children?: OutlineOut[]
}

/** Bookmarks, at most `max` of them (depth first). */
export function outlineOut(nodes: OutlineNode[], max = 1000): { outline: OutlineOut[]; truncated: boolean } {
  let left = max
  let truncated = false
  const walk = (list: OutlineNode[]): OutlineOut[] => {
    const out: OutlineOut[] = []
    for (const n of list) {
      if (left <= 0) {
        truncated = true
        break
      }
      left--
      const o: OutlineOut = { title: n.title }
      if (n.dest) o.page = n.dest.page + 1
      else if (n.uri) o.uri = n.uri
      if (n.children.length) {
        const children = walk(n.children)
        if (children.length) o.children = children
      }
      out.push(o)
    }
    return out
  }
  const outline = walk(nodes)
  return { outline, truncated }
}

// ---- list_annotations ---------------------------------------------------------------------------

/** Annotation types that are not comments: form fields, links and the pop-up windows of notes. */
const NOT_COMMENTS = new Set(['Widget', 'Link', 'Popup'])

export interface ReplyOut {
  id: number
  text: string
  author?: string
  created?: string
}

export interface AnnotOut {
  id: number
  page: number
  type: string
  /** Acrobat's name for it ("Sticky Note", "Text Box", "Replace Text"...). */
  label: string
  rect: number[]
  text?: string
  /** Text under a highlight, underline or strikethrough. */
  markedText?: string
  author?: string
  color?: string
  subject?: string
  created?: string
  modified?: string
  /** Latest review status ("Accepted", "Rejected", "Cancelled", "Completed"). */
  status?: string
  statusBy?: string
  replies?: ReplyOut[]
  /** Annotations that belong to this one (the caret of a "Replace Text"). */
  grouped?: { id: number; type: string }[]
  hidden?: true
  locked?: true
}

/**
 * Comments as threads: replies and status changes are folded into the comment they answer.
 * `types` (PDF annotation types such as "Highlight", or Acrobat labels such as "Sticky Note") keeps
 * only threads whose comment has one of them; `marked` gives the text under text markup by id.
 */
export function annotationsOut(list: AnnotInfo[], opts: { types?: string[] | null; marked?: Map<number, string> } = {}): AnnotOut[] {
  const wanted = opts.types?.length ? new Set(opts.types.map((t) => t.toLowerCase())) : null
  const threads = buildThreads(list.filter((a) => !NOT_COMMENTS.has(a.type)))
  const out: AnnotOut[] = []
  for (const t of threads) {
    const a = t.root
    const label = threadLabel(t)
    if (wanted && !wanted.has(a.type.toLowerCase()) && !wanted.has(label.toLowerCase())) continue
    const o: AnnotOut = { id: a.id, page: a.page + 1, type: a.type, label, rect: rect2(a.rect) }
    if (a.contents) o.text = a.contents
    const marked = opts.marked?.get(a.id)
    if (marked) o.markedText = marked
    if (a.author) o.author = a.author
    const color = a.type === 'FreeText' ? (a.textColor ?? a.color) : (a.color ?? a.interiorColor)
    if (color) o.color = color
    if (a.subject) o.subject = a.subject
    const created = cleanDate(a.created)
    const modified = cleanDate(a.modified)
    if (created) o.created = created
    if (modified && modified !== created) o.modified = modified
    if (t.status) {
      o.status = t.status
      if (t.statusBy) o.statusBy = t.statusBy
    }
    if (t.replies.length) {
      o.replies = t.replies.map((r) => {
        const reply: ReplyOut = { id: r.id, text: r.contents }
        if (r.author) reply.author = r.author
        const when = cleanDate(r.created) || cleanDate(r.modified)
        if (when) reply.created = when
        return reply
      })
    }
    if (t.group.length) o.grouped = t.group.map((g) => ({ id: g.id, type: g.type }))
    if (a.hidden) o.hidden = true
    if (a.locked) o.locked = true
    out.push(o)
  }
  return out
}

// ---- list_form_fields ---------------------------------------------------------------------------

export interface FieldOut {
  name: string
  type: string
  /** Missing for password fields, whose content stays private. */
  value?: string
  checked?: boolean
  /** The value a checkbox has when ticked. */
  onValue?: string
  options?: { value: string; label?: string }[]
  page: number
  rect: number[]
  /** Every widget, when the field has several (radio buttons, repeated fields). */
  widgets?: { page: number; rect: number[]; onValue?: string }[]
  tooltip?: string
  readOnly?: true
  required?: true
  multiline?: true
  maxLength?: number
  multiSelect?: true
  editable?: true
  password?: true
  signed?: boolean
  hidden?: true
}

/** Form fields, one entry per field (its widgets merged), keeping fields with a widget in `pages`. */
export function fieldsOut(fields: FieldInfo[], pages: Set<number> | null = null): FieldOut[] {
  const groups = new Map<string, FieldInfo[]>()
  for (const f of fields) {
    const g = groups.get(f.name)
    if (g) g.push(f)
    else groups.set(f.name, [f])
  }
  const out: FieldOut[] = []
  for (const [name, widgets] of groups) {
    if (pages && !widgets.some((w) => pages.has(w.page))) continue
    const f = widgets[0]
    const o: FieldOut = { name, type: f.type, page: f.page + 1, rect: rect2(f.rect) }
    if (f.password) o.password = true
    else if (f.type !== 'button' && f.type !== 'signature') o.value = f.value
    if (f.type === 'checkbox') {
      o.checked = widgets.some((w) => w.checked)
      if (f.onState) o.onValue = f.onState
    } else if (f.type === 'radio') {
      const values = [...new Set(widgets.map((w) => w.onState).filter((v): v is string => !!v && v !== 'Off'))]
      o.options = values.map((value) => ({ value }))
    } else if (f.type === 'combo' || f.type === 'list') {
      o.options = f.options.map((opt) => (opt.label && opt.label !== opt.value ? { value: opt.value, label: opt.label } : { value: opt.value }))
    }
    if (widgets.length > 1) {
      o.widgets = widgets.map((w) => {
        const wo: { page: number; rect: number[]; onValue?: string } = { page: w.page + 1, rect: rect2(w.rect) }
        if (f.type === 'radio' && w.onState) wo.onValue = w.onState
        return wo
      })
    }
    if (f.tooltip) o.tooltip = f.tooltip
    if (f.readOnly) o.readOnly = true
    if (f.required) o.required = true
    if (f.type === 'text') {
      if (f.multiline) o.multiline = true
      if (f.maxLen > 0) o.maxLength = f.maxLen
    }
    if ((f.type === 'combo' || f.type === 'list') && f.multiSelect) o.multiSelect = true
    if (f.type === 'combo' && f.editable) o.editable = true
    if (f.type === 'signature') o.signed = widgets.some((w) => w.signed)
    if (widgets.every((w) => w.hidden)) o.hidden = true
    out.push(o)
  }
  return out
}

// ---- list_signatures ----------------------------------------------------------------------------

/** Signatures with their validation, as the Signatures panel shows them. */
export function signaturesOut(report: ValidationReport, trusted: Set<string>) {
  const signatures = report.signatures.map((r) => {
    const st = signatureStatus(r, trusted)
    const cert = r.certificates[0]
    return {
      field: r.fieldName,
      ...(r.invisible ? { invisible: true } : { page: r.page + 1, rect: rect2(r.rect) }),
      kind: r.kind,
      signer: r.signerName,
      signingTime: r.timestamp?.valid ? r.timestamp.time : r.signingTime,
      ...(r.timestamp ? { timestamp: { time: r.timestamp.time, authority: r.timestamp.authority, valid: r.timestamp.valid } } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.location ? { location: r.location } : {}),
      status: st.level,
      summary: st.title,
      details: st.details,
      changedAfterSigning: !r.coversWholeFile,
      ...(r.changes.length ? { changes: r.changes.map((c) => ({ description: c.description, allowed: c.allowed })) } : {}),
      identityTrusted: st.identityKnown,
      ...(cert
        ? {
            certificate: {
              subject: cert.subject,
              issuer: cert.issuer,
              ...(cert.organization ? { organization: cert.organization } : {}),
              ...(cert.email ? { email: cert.email } : {}),
              validFrom: cert.notBefore,
              validTo: cert.notAfter,
              serial: cert.serial,
              sha256: cert.sha256,
              selfSigned: cert.selfSigned
            }
          }
        : {}),
      revision: r.signedVersion
    }
  })
  return {
    signatures,
    unsignedFields: report.unsigned.map((f) => ({
      name: f.name,
      ...(f.invisible ? { invisible: true } : { page: f.page + 1, rect: rect2(f.rect) })
    })),
    ...(report.certified ? { certified: true, certifiedBy: report.certifiedBy } : {}),
    ...(report.locked ? { locked: true } : {}),
    // Signatures are checked against the saved file; unsaved changes are not part of the check.
    checkedSavedFile: report.checkedFile
  }
}
