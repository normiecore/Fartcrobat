/** MCP editing uses the same native Edit Text operations as the interactive editor. */
import { defineOps, EngineError, mutation } from '@engine/define'
import { Session } from '@engine/session'
import { certificatePermissions, openPlainSessionCopy } from '@engine/crypt'
import type { Rect } from '@shared/geometry'
import { extractPageContent } from '@features/export-create/extract'
import { analyzeDocument } from '@features/export-create/layout'
import { flowText, type FlowSpec, type FlowResult } from './flow'
import { buildReflow, installReflow, requireReflow } from './reflowEngine'
import type { ReflowSpec } from './reflow'
import editText from '@features/edit-text/engine'
import type { CommitResult, TextBlockInfo } from '@features/edit-text/model'
import { planTextChange, validateTextChanges, type PlannedTextChange, type TextChange } from './textEdits'

export interface TextIssue {
  page: number
  code: string
  message: string
  blocking: boolean
}
export interface TextPreview {
  revision: number
  flow?: FlowResult
  rebuilt?: boolean
  canApply: boolean
  issues: TextIssue[]
  changes: { page: number; before: string; after: string; bbox: Rect | null; fallbackFonts: string[] }[]
  previews: { page: number; before: Uint8Array; after: Uint8Array }[]
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
function plans(s: Session, changes: TextChange[]): PlannedTextChange[] {
  validateTextChanges(changes, s.pageCount())
  const blocks = new Map<number, TextBlockInfo[]>()
  return changes.map((c) => {
    if (!blocks.has(c.page)) blocks.set(c.page, editText.ops.analyze(s, c.page))
    return planTextChange(c, blocks.get(c.page)!)
  })
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

function preview(s: Session, revision: number, changes: TextChange[], images: boolean): TextPreview {
  requireEdit(s)
  requireRevision(s, revision)
  const plan = plans(s, changes)
  const pages = [...new Set(plan.map((p) => p.page))]
  const originals = new Map(pages.map((p) => [p, editText.ops.analyze(s, p)]))
  // Private, in-memory copy includes unsaved work and handles password/certificate security.
  // Never mutate, save or undo the live document to produce a preview.
  const copy = new Session(s.mupdf)
  copy.setDocument(openPlainSessionCopy(s, 'garbage=yes'))
  try {
    const results = copy.runMutation('Preview Text Changes', () => apply(copy, plan))
    const issues: TextIssue[] = []
    const issue = (page: number, code: string, message: string, blocking = true) =>
      issues.push({ page: page + 1, code, message, blocking })
    plan.forEach((p, i) => {
      const r = results[i]
      if (r.unsupported.length)
        issue(p.page, 'unsupported_characters', 'Some characters cannot be drawn: ' + r.unsupported.join(' '))
      if (r.fallbackFonts.length)
        issue(
          p.page,
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
          'outside_text_area',
          'The text does not fit the requested rect. Nothing is automatically shrunk.'
        )
      const old = p.block?.bbox
      if (old && box[3] > old[3] + 2)
        issue(
          p.page,
          'text_grew',
          'Text grows beyond its old box; surrounding content does not reflow.',
          false
        )
      for (const other of originals.get(p.page)!) {
        if (plan.some((q) => q.page === p.page && q.block?.id === other.id)) continue
        if (overlap(box, other.bbox) > (old ? overlap(old, other.bbox) : 0) + 4) {
          issue(
            p.page,
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
            issue(p.page, 'text_overlap', 'Two proposed text blocks would overlap.')
        }
    })
    return {
      revision,
      canApply: !issues.some((i) => i.blocking),
      issues,
      changes: plan.map((p, i) => ({
        page: p.page + 1,
        before: p.block?.text ?? '',
        after: p.edit.runs.map((r) => r.text).join(''),
        bbox: results[i].bbox,
        fallbackFonts: results[i].fallbackFonts
      })),
      previews: images
        ? pages.map((page) => ({ page: page + 1, before: image(s, page), after: image(copy, page) }))
        : []
    }
  } finally {
    copy.closeDocument()
  }
}

function previewFlow(s: Session, revision: number, spec: FlowSpec, images = true): TextPreview {
  requireEdit(s)
  requireRevision(s, revision)
  const copy = new Session(s.mupdf)
  copy.setDocument(openPlainSessionCopy(s, 'garbage=yes'))
  try {
    const result = copy.runMutation('Preview Text Flow', () => flowText(copy, spec))
    return {
      revision,
      canApply: true,
      flow: result,
      issues: result.warnings.map((message) => ({
        page: 1,
        code: 'layout_warning',
        message,
        blocking: false
      })),
      changes: spec.paragraphs.map((p, i) => ({
        page: p.page + 1,
        before: p.original_text ?? '',
        after: p.text,
        bbox: result.placements.find((x) => x.paragraph === i)?.rect ?? null,
        fallbackFonts: []
      })),
      previews: images
        ? result.pages.map((page) => ({
            page,
            before: page <= s.pageCount() ? image(s, page - 1) : new Uint8Array(),
            after: image(copy, page - 1)
          }))
        : []
    }
  } finally {
    copy.closeDocument()
  }
}

function previewReflow(s: Session, revision: number, spec: ReflowSpec): TextPreview {
  requireEdit(s)
  requireRevision(s, revision)
  requireReflow(s)
  const doc = buildReflow(s, spec)
  const copy = new Session(s.mupdf)
  copy.setDocument(doc)
  try {
    return {
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
      changes: [],
      previews: Array.from({ length: copy.pageCount() }, (_, p) => ({
        page: p + 1,
        before: p < s.pageCount() ? image(s, p) : new Uint8Array(),
        after: image(copy, p)
      }))
    }
  } finally {
    copy.closeDocument()
  }
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
  previewFlow(s, revision: number, spec: FlowSpec) {
    return previewFlow(s, revision, spec)
  },
  flow: mutation('Reflow Text', (s, revision: number, spec: FlowSpec) => {
    previewFlow(s, revision, spec, false)
    return flowText(s, spec)
  }),
  previewReflow(s, revision: number, spec: ReflowSpec) {
    return previewReflow(s, revision, spec)
  },
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
  inspect(s, page: number) {
    s.page(page)
    return { revision: s.editVersion(), blocks: editText.ops.analyze(s, page) }
  },
  preview(s, revision: number, changes: TextChange[]) {
    return preview(s, revision, changes, true)
  },
  apply: mutation('Edit Text Batch', (s, revision: number, changes: TextChange[]) => {
    const report = preview(s, revision, changes, false)
    if (!report.canApply)
      throw new EngineError(
        report.issues
          .filter((i) => i.blocking)
          .map((i) => i.message)
          .join(' '),
        'LAYOUT_CONFLICT'
      )
    const results = apply(s, plans(s, changes))
    return {
      changed: results.length,
      pages: [...new Set(changes.map((c) => c.page + 1))],
      issues: report.issues
    }
  })
})
