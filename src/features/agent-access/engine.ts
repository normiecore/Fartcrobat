/** MCP editing uses the same native Edit Text operations as the interactive editor. */
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import { Session } from '@engine/session'
import { certificatePermissions, openPlainSessionCopy } from '@engine/crypt'
import { renderToPixmap, toResult, type RenderOptions } from '@engine/ops/render'
import { walkStructuredText } from '@engine/util/stext'
import { quadToRect, rectUnion, type Rect } from '@shared/geometry'
import { extractPageContent } from '@features/export-create/extract'
import { analyzeDocument } from '@features/export-create/layout'
import { flowText, reviseFlowSpec, type FlowSpec, type FlowResult, type FlowTrace } from './flow'
import { buildReflow, installReflow, requireReflow } from './reflowEngine'
import { reviseReflowSpec, sectionText, type ReflowSpec } from './reflow'
import editText from '@features/edit-text/engine'
import { runsText, type CommitResult, type TextBlockInfo } from '@features/edit-text/model'
import {
  marginNote,
  planTextChange,
  styleNotes,
  styleOf,
  validateTextChanges,
  REVIEW_LIMITS,
  type PlannedTextChange,
  type ReviewStyle,
  type TextChange
} from './textEdits'

export type { ReviewStyle } from './textEdits'
export interface TextIssue {
  page: number
  code: string
  message: string
  blocking: boolean
  /** Index of the change it is about (edit_text), when it is about one. */
  change?: number
}
export type ReviewKind = 'edit' | 'paragraph' | 'section' | 'title' | 'design'
/** One item the person accepts or rejects (or reads, when it is not rejectable). */
export interface ReviewChange {
  /** The call's edit, the flow paragraph, or the rebuild item (0 title, 1..n sections, n+1 design). */
  index: number
  kind: ReviewKind
  label: string
  /** 1-based page of the first placement of the new text. */
  page: number
  /** 1-based live page of the original text (beforeBox, beforeLines). */
  beforePage: number
  before: string
  after: string
  /** The new text's box (or the old one when the new text is empty). */
  bbox: Rect | null
  fallbackFonts: string[]
  beforeBox: Rect | null
  /** One rect per original line, on the live page (for the strike-through). */
  beforeLines: Rect[]
  /** Every placement of the new text on the proposal pages. */
  fragments: { page: number; rect: Rect }[]
  styleBefore?: ReviewStyle
  styleAfter?: ReviewStyle
  notes: string[]
  rejectable: boolean
}
export interface ProposalPage {
  page: number
  width: number
  height: number
  /** The proposal page replaces a live page of the same size. */
  live: boolean
}
export interface TextPreview {
  revision: number
  flow?: FlowResult
  rebuilt?: boolean
  canApply: boolean
  issues: TextIssue[]
  changes: ReviewChange[]
  /** Proposal pages that differ from the live document. */
  pages: ProposalPage[]
  /** Text areas (union of the text blocks) before and after, per changed page. */
  margins: { page: number; before: Rect | null; after: Rect | null }[]
  /** The copy held in the worker for the review, rendered with renderProposal. */
  proposal?: { id: string; version: number }
  /** PNG images of the proposed pages, for preview_only only. */
  previews: { page: number; after: Uint8Array }[]
}
export interface ProposalCheck {
  canApply: boolean
  issues: TextIssue[]
}

function requireEdit(s: Session) {
  const allowed = s.pubsec
    ? certificatePermissions(s.pubsec.permissions).permissions.edit
    : s.pdf.hasPermission('edit')
  if (!allowed)
    throw new EngineError('The document security settings do not allow editing its text.', 'PERMISSION')
}
function requireRevision(s: Session, revision: number) {
  if (!Number.isInteger(revision) || revision !== s.editVersion())
    throw new EngineError(
      'The document changed. Call get_editable_text again and review a fresh proposal.',
      'STALE_BLOCK'
    )
}
/**
 * Plans the changes; the analysed pages are returned too, so nothing is analysed twice. A review
 * holds the edits of several calls, so the engine takes up to the review limits; each call is held
 * to the call limits by the handler.
 */
function plans(s: Session, changes: TextChange[]) {
  validateTextChanges(changes, s.pageCount(), REVIEW_LIMITS)
  const blocks = new Map<number, TextBlockInfo[]>()
  const plan = changes.map((c) => {
    if (!blocks.has(c.page)) blocks.set(c.page, editText.ops.analyze(s, c.page))
    return planTextChange(c, blocks.get(c.page)!)
  })
  return { plan, blocks }
}
/** Replace later original blocks first, so earlier source ranges remain stable. New text is last. */
function apply(s: Session, plan: PlannedTextChange[]): CommitResult[] {
  const results: CommitResult[] = []
  const order = plan
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.page - b.p.page || (b.p.block?.start ?? -1) - (a.p.block?.start ?? -1))
  for (const { p, i } of order) results[i] = editText.ops.commit(s, p.page, p.edit)
  return results
}
function overlap(a: Rect, b: Rect) {
  return (
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  )
}
function union(rects: (Rect | null | undefined)[]): Rect | null {
  return rects.reduce<Rect | null>((u, r) => (r ? (u ? rectUnion(u, r) : r) : u), null)
}
function image(s: Session, page: number): Uint8Array {
  // Bound even pathological page sizes; images never leave this operation as PDF bytes.
  const b = s.pageBounds(page)
  const scale = Math.min(1, 1200 / Math.max(b[2] - b[0], b[3] - b[1]))
  const pix = s.page(page).toPixmap([scale, 0, 0, scale, 0, 0], s.mupdf.ColorSpace.DeviceRGB, false, true)
  try {
    return pix.asPNG().slice()
  } finally {
    pix.destroy()
  }
}
/** PNGs of the proposed pages (preview_only), transferred rather than copied to the window. */
function withImages(copy: Session, report: TextPreview, pages: number[]) {
  const previews = pages.map((page) => ({ page, after: image(copy, page - 1) }))
  return withTransfer({ ...report, previews }, previews.map((p) => p.after.buffer as ArrayBuffer))
}
/** A private, in-memory copy that includes unsaved work and handles password/certificate security. */
function plainCopy(s: Session) {
  const copy = new Session(s.mupdf)
  copy.setDocument(openPlainSessionCopy(s, 'garbage=yes'))
  return copy
}
function pageInfo(s: Session, copy: Session, page: number) {
  const b = copy.pageBounds(page - 1)
  const width = b[2] - b[0]
  const height = b[3] - b[1]
  let live = false
  if (page <= s.pageCount()) {
    const l = s.pageBounds(page - 1)
    live = Math.abs(l[2] - l[0] - width) < 0.5 && Math.abs(l[3] - l[1] - height) < 0.5
  }
  return { page, width, height, live }
}
const textOf = (blocks: TextBlockInfo[]) => blocks.filter((b) => !b.mark && b.text.trim())

/** Builds the edit_text proposal on a copy. Never mutate, save or undo the live document for it. */
function buildEdit(s: Session, revision: number, changes: TextChange[]) {
  requireEdit(s)
  requireRevision(s, revision)
  const { plan, blocks } = plans(s, changes)
  const pages = [...new Set(plan.map((p) => p.page))].sort((a, b) => a - b)
  const copy = plainCopy(s)
  try {
    const results = copy.runMutation('Preview Text Changes', () => apply(copy, plan))
    const issues: TextIssue[] = []
    const issue = (page: number, change: number, code: string, message: string, blocking = true) =>
      issues.push({ page: page + 1, code, message, blocking, change })
    plan.forEach((p, i) => {
      const r = results[i]
      if (r.unsupported.length)
        issue(p.page, i, 'unsupported_characters', 'Some characters cannot be drawn: ' + r.unsupported.join(' '))
      if (r.fallbackFonts.length)
        issue(
          p.page,
          i,
          'font_substitution',
          'An original font needs a substitute: ' + r.fallbackFonts.join(', '),
          false
        )
      const box = r.bbox
      if (!box) return
      const bounds = s.pageBounds(p.page)
      if (
        box[0] < bounds[0] - 1 ||
        box[1] < bounds[1] - 1 ||
        box[2] > bounds[2] + 1 ||
        box[3] > bounds[3] + 1
      )
        issue(
          p.page,
          i,
          'outside_page',
          'Replacement text extends outside the page. Shorten it, move it or use a larger text area.'
        )
      const limit = changes[i].rect
      if (
        limit &&
        (box[0] < limit[0] - 1 || box[1] < limit[1] - 1 || box[2] > limit[2] + 1 || box[3] > limit[3] + 1)
      )
        issue(
          p.page,
          i,
          'outside_text_area',
          'The text does not fit the requested rect. Nothing is automatically shrunk.'
        )
      const old = p.block?.bbox
      if (old && box[3] > old[3] + 2)
        issue(
          p.page,
          i,
          'text_grew',
          'Text grows beyond its old box; surrounding content does not reflow.',
          false
        )
      for (const other of blocks.get(p.page)!) {
        if (plan.some((q) => q.page === p.page && q.block?.id === other.id)) continue
        if (overlap(box, other.bbox) > (old ? overlap(old, other.bbox) : 0) + 4) {
          issue(
            p.page,
            i,
            'text_overlap',
            'Replacement text would overlap another text block. Shorten it or move the blocks apart.'
          )
          break
        }
      }
      for (let j = 0; j < i; j++)
        if (plan[j].page === p.page && results[j].bbox) {
          const before = old && plan[j].block ? overlap(old, plan[j].block!.bbox) : 0
          if (overlap(box, results[j].bbox!) > before + 4)
            issue(p.page, i, 'text_overlap', 'Two proposed text blocks would overlap.')
        }
    })
    const margins = pages.map((page) => {
      const all = textOf(blocks.get(page)!)
      const replaced = new Set(plan.flatMap((p) => (p.page === page && p.block ? [p.block.id] : [])))
      return {
        page: page + 1,
        before: union(all.map((b) => b.bbox)),
        after: union([
          ...all.filter((b) => !replaced.has(b.id)).map((b) => b.bbox),
          ...results.filter((_, i) => plan[i].page === page).map((r) => r.bbox)
        ])
      }
    })
    const report: TextPreview = {
      revision,
      canApply: !issues.some((i) => i.blocking),
      issues,
      changes: plan.map((p, i) => {
        const r = results[i]
        const after = runsText(p.edit.runs)
        const styleBefore = p.block ? styleOf(p.block.runs, p.block.fonts) : undefined
        const styleAfter = after.trim() ? styleOf(p.edit.runs, p.block?.fonts) : undefined
        const notes = !p.block ? ['New text'] : !after.trim() ? ['Deletes the text'] : styleNotes(styleBefore, styleAfter)
        if (p.block && changes[i].rect) notes.push('Moves the text to a new box')
        if (p.block && after.trim() && p.edit.align !== p.block.align)
          notes.push('Alignment ' + p.block.align + ' → ' + p.edit.align)
        if (p.block && Math.abs(p.edit.lineSpacing - p.block.lineSpacing) > 0.01)
          notes.push('Line spacing ' + p.block.lineSpacing.toFixed(2) + ' → ' + p.edit.lineSpacing.toFixed(2))
        if (r.fallbackFonts.length) notes.push('Substitute font for ' + r.fallbackFonts.join(', '))
        const m = margins.find((m) => m.page === p.page + 1)!
        const area = marginNote(m.before, m.after)
        if (area) notes.push(area)
        return {
          index: i,
          kind: 'edit' as const,
          label: 'Change ' + (i + 1),
          page: p.page + 1,
          beforePage: p.page + 1,
          before: p.block?.text ?? '',
          after,
          bbox: r.bbox ?? p.block?.bbox ?? null,
          fallbackFonts: r.fallbackFonts,
          beforeBox: p.block?.bbox ?? null,
          beforeLines: p.block?.quads.map(quadToRect) ?? [],
          fragments: r.bbox ? [{ page: p.page + 1, rect: r.bbox }] : [],
          styleBefore,
          styleAfter,
          notes,
          rejectable: true
        }
      }),
      pages: pages.map((p) => pageInfo(s, copy, p + 1)),
      margins,
      previews: []
    }
    return { copy, report }
  } catch (err) {
    copy.closeDocument()
    throw err
  }
}

/** Builds a design-preserving flow on a copy. */
function buildFlow(s: Session, revision: number, spec: FlowSpec) {
  requireEdit(s)
  requireRevision(s, revision)
  const copy = plainCopy(s)
  try {
    const trace: FlowTrace = { blocks: new Map(), sources: [] }
    const result = copy.runMutation('Preview Text Flow', () => flowText(copy, spec, trace))
    const managed = new Set(spec.paragraphs.map((p) => p.page + ':' + p.block_id))
    const margins = result.pages
      .filter((page) => page <= s.pageCount())
      .map((page) => {
        const all = textOf(trace.blocks.get(page - 1) ?? [])
        return {
          page,
          before: union(all.map((b) => b.bbox)),
          after: union([
            ...all.filter((b) => !managed.has(page - 1 + ':' + b.id)).map((b) => b.bbox),
            ...result.placements.filter((x) => x.page === page).map((x) => x.rect)
          ])
        }
      })
    const report: TextPreview = {
      revision,
      canApply: true,
      flow: result,
      issues: result.warnings.map((message) => ({
        page: 1,
        code: 'layout_warning',
        message,
        blocking: false
      })),
      changes: spec.paragraphs.map((p, i) => {
        // Where the text was placed, which can be the next column's page or a continuation page.
        const fragments = result.placements
          .filter((x) => x.paragraph === i)
          .map((x) => ({ page: x.page, rect: x.rect }))
        const source = trace.sources[i]
        const styleBefore = styleOf(source.block.runs, source.block.fonts)
        const styleAfter = styleOf(source.runs, source.block.fonts)
        const notes = styleNotes(styleBefore, styleAfter)
        if (fragments.length > 1) notes.push('Continues in ' + fragments.length + ' places')
        const area = marginNote(
          margins.find((m) => m.page === p.page + 1)?.before ?? null,
          margins.find((m) => m.page === p.page + 1)?.after ?? null
        )
        if (area) notes.push(area)
        return {
          index: i,
          kind: 'paragraph' as const,
          label: 'Paragraph ' + (i + 1),
          page: fragments[0]?.page ?? p.page + 1,
          beforePage: p.page + 1,
          before: p.original_text ?? '',
          after: p.text,
          bbox: fragments[0]?.rect ?? null,
          fallbackFonts: [],
          beforeBox: source.block.bbox,
          beforeLines: source.block.quads.map(quadToRect),
          fragments,
          styleBefore,
          styleAfter,
          notes,
          rejectable: true
        }
      }),
      pages: result.pages.map((page) => pageInfo(s, copy, page)),
      margins,
      previews: []
    }
    return { copy, report }
  } catch (err) {
    copy.closeDocument()
    throw err
  }
}

/** Text lines of every page of a document, in reading order. */
function textLines(copy: Session) {
  const lines: { page: number; rect: Rect; text: string }[] = []
  for (let p = 0; p < copy.pageCount(); p++) {
    const stext = copy.page(p).toStructuredText('preserve-whitespace')
    try {
      let line: { page: number; rect: Rect; text: string } | null = null
      walkStructuredText(stext, {
        beginLine(bbox) {
          line = { page: p + 1, rect: [...bbox] as Rect, text: '' }
        },
        onChar(c) {
          if (line) line.text += c
        },
        endLine() {
          if (line?.text.trim()) lines.push(line)
          line = null
        }
      })
    } finally {
      stext.destroy()
    }
  }
  return lines
}
const normal = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Builds the new design without the rejected sections (0-based) and finds where its title and
 * kept sections landed, by walking the text in order and matching the headings.
 */
function buildRebuild(s: Session, revision: number, spec: ReflowSpec, rejected: number[] = []) {
  requireEdit(s)
  requireRevision(s, revision)
  requireReflow(s)
  const kept = rejected.length ? reviseReflowSpec(spec, rejected) : spec
  const copy = new Session(s.mupdf)
  copy.setDocument(buildReflow(s, kept))
  try {
    const lines = textLines(copy)
    const targets = [spec.title, ...kept.sections.map((x) => x.heading)].map(normal)
    const starts: number[] = []
    let at = 0
    for (const target of targets) {
      let found = -1
      for (let i = at; i < lines.length && found < 0; i++) {
        const l = normal(lines[i].text)
        if (l === target || (l.length >= 4 && target.startsWith(l))) found = i
      }
      starts.push(found)
      if (found >= 0) at = found + 1
    }
    const fragmentsOf = (k: number) => {
      if (starts[k] < 0) return []
      const end = starts.slice(k + 1).find((x) => x >= 0) ?? lines.length
      const byPage = new Map<number, Rect>()
      for (const l of lines.slice(starts[k], end)) {
        const r = byPage.get(l.page)
        byPage.set(l.page, r ? rectUnion(r, l.rect) : l.rect)
      }
      return [...byPage].map(([page, rect]) => ({ page, rect }))
    }
    const item = (
      index: number,
      kind: ReviewKind,
      label: string,
      after: string,
      fragments: { page: number; rect: Rect }[],
      notes: string[],
      rejectable: boolean
    ): ReviewChange => ({
      index,
      kind,
      label,
      page: fragments[0]?.page ?? 1,
      beforePage: 1,
      before: '',
      after,
      bbox: fragments[0]?.rect ?? null,
      fallbackFonts: [],
      beforeBox: null,
      beforeLines: [],
      fragments,
      notes,
      rejectable
    })
    let k = 0
    const sections = spec.sections.map((section, i) => {
      const left = rejected.includes(i)
      const fragments = left ? [] : fragmentsOf(++k)
      return item(i + 1, 'section', section.heading, sectionText(section), fragments, left ? ['Left out of the new design'] : [], true)
    })
    const size = spec.font_size ?? 11
    const count = copy.pageCount()
    const report: TextPreview = {
      revision,
      canApply: true,
      rebuilt: true,
      issues: [
        {
          page: 1,
          code: 'new_design',
          message:
            'This replaces the original layout, images, comments, form fields and bookmarks with a new text layout. Attachments and document security are retained. The source file is unchanged until Save. Undo restores the entire original document.',
          blocking: false
        }
      ],
      changes: [
        item(0, 'title', 'Title', [spec.title, spec.subtitle].filter(Boolean).join('\n'), fragmentsOf(0), [], false),
        ...sections,
        item(
          spec.sections.length + 1,
          'design',
          'Page design',
          '',
          [],
          [
            (spec.page_size ?? 'A4') + ' pages, ' + (spec.font === 'serif' ? 'serif' : 'sans serif') + ' text ' + size + ' pt',
            count + (count === 1 ? ' page' : ' pages') + ', was ' + s.pageCount(),
            'Margins 40 pt top and bottom, 44 pt left and right'
          ],
          false
        )
      ],
      pages: Array.from({ length: count }, (_, p) => pageInfo(s, copy, p + 1)),
      margins: [],
      previews: []
    }
    return { copy, report }
  } catch (err) {
    copy.closeDocument()
    throw err
  }
}

/**
 * The proposal of the review that is open for this document: one per worker, held for the whole
 * review so the viewer can render it at any zoom. A new proposal, an edit of the document or
 * closeProposal disposes it.
 */
interface Held {
  id: string
  version: number
  revision: number
  copy: Session
  report: TextPreview
  kind: 'edit' | 'flow' | 'rebuild'
  spec: TextChange[] | FlowSpec | ReflowSpec
  rejected: number[]
}
const held = new WeakMap<Session, Held>()
let proposals = 0

function dispose(s: Session) {
  const h = held.get(s)
  if (!h) return
  held.delete(s)
  h.copy.closeDocument()
}
function heldProposal(s: Session, id: string, version?: number) {
  const h = held.get(s)
  // Any edit, undo or reload of the document makes the proposal stale.
  if (h && h.revision !== s.editVersion()) dispose(s)
  const current = held.get(s)
  if (!current || current.id !== id || (version !== undefined && current.version !== version))
    throw new EngineError('This proposal is no longer shown.', 'STALE_PROPOSAL')
  return current
}
function hold(
  s: Session,
  built: { copy: Session; report: TextPreview },
  kind: Held['kind'],
  spec: Held['spec'],
  prev?: Held
): TextPreview {
  const h: Held = {
    id: prev?.id ?? 'p' + ++proposals,
    version: (prev?.version ?? 0) + 1,
    revision: s.editVersion(),
    copy: built.copy,
    report: built.report,
    kind,
    spec,
    rejected: prev?.rejected ?? []
  }
  held.set(s, h)
  return { ...built.report, proposal: { id: h.id, version: h.version } }
}
function build(s: Session, h: Pick<Held, 'kind' | 'spec' | 'revision'>, rejected: number[]) {
  if (h.kind === 'flow') return buildFlow(s, h.revision, reviseFlowSpec(h.spec as FlowSpec, rejected))
  // Rebuild items are 0 title, 1..n sections.
  return buildRebuild(s, h.revision, h.spec as ReflowSpec, rejected.map((i) => i - 1))
}

export default defineOps('agent-text', {
  layout(s, pages: number[]) {
    if (!Array.isArray(pages) || pages.length > 10)
      throw new EngineError('Inspect at most 10 pages at a time.', 'BAD_PAGE')
    const content = pages.map((p) => extractPageContent(s, p, { images: true }))
    const layout = analyzeDocument(content)
    return {
      revision: s.editVersion(),
      bodyFontSize: layout.bodySize,
      pages: layout.pages.map((p, i) => ({
        page: pages[i] + 1,
        width: p.width,
        height: p.height,
        margins: p.margins,
        elements: p.elements.map((e) =>
          e.kind === 'image' ? { kind: e.kind, rect: [e.x0, e.y0, e.x1, e.y1] } : e
        ),
        images: content[i].images.map(({ x0, y0, x1, y1, width, height }) => ({
          rect: [x0, y0, x1, y1],
          width,
          height
        })),
        links: content[i].links,
        comments: content[i].comments,
        rules: content[i].rules,
        fills: content[i].fills,
        drawings: content[i].drawings,
        blocks: editText.ops.analyze(s, pages[i]).map(b => ({ ...b, block_id: b.id, editable: !b.mark && !b.unreadable }))
      }))
    }
  },
  inspect(s, page: number) {
    s.page(page)
    return { revision: s.editVersion(), blocks: editText.ops.analyze(s, page) }
  },

  /** preview_only: the report and PNGs of the proposed pages; nothing is held. */
  preview(s, revision: number, changes: TextChange[]) {
    const { copy, report } = buildEdit(s, revision, changes)
    try {
      return withImages(copy, report, report.pages.map((p) => p.page))
    } finally {
      copy.closeDocument()
    }
  },
  previewFlow(s, revision: number, spec: FlowSpec) {
    const { copy, report } = buildFlow(s, revision, spec)
    try {
      return withImages(copy, report, report.pages.map((p) => p.page))
    } finally {
      copy.closeDocument()
    }
  },
  previewReflow(s, revision: number, spec: ReflowSpec) {
    const { copy, report } = buildRebuild(s, revision, spec)
    try {
      return withImages(copy, report, report.pages.map((p) => p.page))
    } finally {
      copy.closeDocument()
    }
  },

  /**
   * Proposals for a review: the copy is kept until closeProposal (a blocked edit keeps nothing).
   * With `replace` (the id of the held edit proposal) the changes are the review's combined set
   * after another call joined it: the new copy replaces the held one under the same id with a new
   * version, and a blocked set leaves the held one shown as it was.
   */
  propose(s, revision: number, changes: TextChange[], replace?: string) {
    if (replace !== undefined) {
      const h = heldProposal(s, replace)
      if (h.kind !== 'edit') throw new EngineError('Only text edits are added to a review.', 'BAD_EDIT')
      const built = buildEdit(s, revision, changes)
      if (!built.report.canApply) {
        built.copy.closeDocument()
        return built.report
      }
      dispose(s)
      return hold(s, built, 'edit', changes, h)
    }
    // Release the previous copy first: at most one is held, and building one needs memory too.
    dispose(s)
    const built = buildEdit(s, revision, changes)
    if (!built.report.canApply) {
      built.copy.closeDocument()
      return built.report
    }
    return hold(s, built, 'edit', changes)
  },
  proposeFlow(s, revision: number, spec: FlowSpec) {
    dispose(s)
    return hold(s, buildFlow(s, revision, spec), 'flow', spec)
  },
  proposeReflow(s, revision: number, spec: ReflowSpec) {
    dispose(s)
    return hold(s, buildRebuild(s, revision, spec), 'rebuild', spec)
  },
  /** A page of the held proposal, exactly like render.page. Throws STALE_PROPOSAL once replaced. */
  async renderProposal(s, id: string, version: number, page: number, opts: RenderOptions) {
    const h = heldProposal(s, id, version)
    const { pix, region } = renderToPixmap(h.copy, page, { ...opts, hide: undefined })
    try {
      return await toResult(new Uint8ClampedArray(pix.getPixels()), region)
    } finally {
      pix.destroy()
    }
  },
  /**
   * Checks the edits that are kept (indices into the proposal's edits) for overlaps and overflow,
   * as apply will, without images. Issues refer to the proposal's indices.
   */
  checkProposal(s, id: string, indices: number[]): ProposalCheck {
    const h = heldProposal(s, id)
    if (h.kind !== 'edit') throw new EngineError('Only text edits are checked in parts.', 'BAD_EDIT')
    const changes = h.spec as TextChange[]
    const subset = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < changes.length).sort((a, b) => a - b)
    if (subset.length === changes.length) return { canApply: h.report.canApply, issues: h.report.issues }
    if (!subset.length) return { canApply: true, issues: [] }
    const { copy, report } = buildEdit(s, h.revision, subset.map((i) => changes[i]))
    copy.closeDocument()
    return {
      canApply: report.canApply,
      issues: report.issues.map((i) => ({ ...i, change: i.change === undefined ? undefined : subset[i.change] }))
    }
  },
  /**
   * Flow and rebuild: rebuilds the held proposal with the rejected items (change indices) kept as
   * they were (flow) or left out (rebuild), with a new version. Every item stays in the report.
   */
  reviseProposal(s, id: string, rejected: number[]) {
    const h = heldProposal(s, id)
    if (h.kind === 'edit') throw new EngineError('Rejected text edits are only left out when applied.', 'BAD_EDIT')
    const list = [...new Set(rejected)].sort((a, b) => a - b)
    // Built before the held copy goes: a revision that fails leaves the shown proposal, and the
    // version the review renders, as they were.
    const built = build(s, h, list)
    dispose(s)
    const next = hold(s, built, h.kind, h.spec, h)
    held.get(s)!.rejected = list
    return next
  },
  closeProposal(s, id: string) {
    if (held.get(s)?.id === id) dispose(s)
  },

  flow: mutation('Reflow Text', (s, revision: number, spec: FlowSpec) => {
    // A dry run on a copy first: a flow that does not fit must not leave a partial change.
    buildFlow(s, revision, spec).copy.closeDocument()
    return flowText(s, spec)
  }),
  reflow: mutation('Rebuild Document Layout', (s, revision: number, spec: ReflowSpec) => {
    requireEdit(s)
    requireRevision(s, revision)
    requireReflow(s)
    const replacement = buildReflow(s, spec)
    try {
      const pages = replacement.countPages()
      installReflow(s, replacement, spec.title)
      return { pageCount: pages }
    } finally {
      replacement.destroy()
    }
  }),
  apply: mutation('Edit Text Batch', (s, revision: number, changes: TextChange[]) => {
    const { copy, report } = buildEdit(s, revision, changes)
    copy.closeDocument()
    if (!report.canApply)
      throw new EngineError(
        report.issues
          .filter((i) => i.blocking)
          .map((i) => i.message)
          .join(' '),
        'LAYOUT_CONFLICT'
      )
    const results = apply(s, plans(s, changes).plan)
    return {
      changed: results.length,
      pages: [...new Set(changes.map((c) => c.page + 1))],
      issues: report.issues
    }
  })
})
