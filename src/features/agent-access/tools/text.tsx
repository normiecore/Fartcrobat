/** Native PDF text editing, with a review in the same app the person is using. */
import type { AgentToolName } from '@shared/agent/tools'
import { hasActiveEditors } from '@renderer/app/commands'
import { activateDocument } from '@renderer/app/actions'
import type textOps from '../engine'
import type { FlowSpec } from '../flow'
import type { ReflowSpec } from '../reflow'
import type { TextPreview } from '../engine'
import { validateTextChanges, type TextChange } from '../textEdits'
import { reviewInDocument } from '../ui/InlineReview'
import { flashRect } from '../ui/store'
import {
  auditName,
  pageIndex,
  parsePages,
  resolveDoc,
  throwIfAborted,
  ToolError,
  type ToolHandler
} from './common'
import { copyRestriction } from './context'
import { toBase64 } from './contextShape'
import { engineTask, undoLabel } from './act-runtime'
import { runAsAgent } from './common'

async function reviewProposal(ctx: Parameters<ToolHandler>[1], options: Parameters<typeof reviewInDocument>[0]) {
  try { return await reviewInDocument(options) }
  catch (error) {
    throwIfAborted(ctx)
    throw new ToolError('failed', (error as Error).message)
  }
}

const inspect: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const page = pageIndex(args.page, doc.pageCount)
  const result = await engineTask('Could not inspect editable text', () =>
    doc.ops<typeof textOps>('agent-text').inspect(page)
  )
  ctx.audit({ document: auditName(doc), summary: 'inspected editable text on page ' + (page + 1) })
  return {
    data: {
      page: page + 1,
      revision: result.revision,
      ...copyRestriction(doc),
      blocks: result.blocks.map((b) => ({
        block_id: b.id,
        text: b.text,
        rect: b.bbox,
        frame: b.frame,
        runs: b.runs,
        editable: !b.mark && !b.unreadable,
        ...(b.mark
          ? { reason: 'Page mark: ' + b.mark }
          : b.unreadable
            ? { reason: 'Unreadable characters' }
            : {})
      }))
    }
  }
}

const edit: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  ctx.audit({ document: auditName(doc) })
  if (!Number.isInteger(args.revision) || (args.revision as number) < 0)
    throw new ToolError('invalid_args', 'revision must come from get_editable_text.')
  if (args.preview_only !== undefined && typeof args.preview_only !== 'boolean')
    throw new ToolError('invalid_args', 'preview_only must be true or false.')
  if (!Array.isArray(args.edits)) throw new ToolError('invalid_args', 'edits must be a list of text changes.')
  const changes = args.edits.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c))
      throw new ToolError('invalid_args', 'Each edit must be an object.')
    return { ...c, page: pageIndex(c.page, doc.pageCount) } as TextChange
  })
  try {
    validateTextChanges(changes, doc.pageCount)
  } catch (err) {
    throw new ToolError('invalid_args', (err as Error).message)
  }
  if (doc.state.info.permissions.edit === false)
    throw new ToolError('failed', 'The security settings do not allow editing this document.')
  const ops = doc.ops<typeof textOps>('agent-text')
  throwIfAborted(ctx)
  const report = await engineTask('Could not preview text edits', () =>
    ops.preview(args.revision as number, changes)
  )
  throwIfAborted(ctx)
  const { previews, ...summary } = report
  if (args.preview_only) {
    ctx.audit({ summary: 'previewed ' + changes.length + ' text changes' })
    return {
      data: {
        ...summary,
        applied: false,
        previewPages: previews.map((p) => p.page),
        ...copyRestriction(doc)
      },
      images: previews.map((p) => ({ mimeType: 'image/png' as const, data: toBase64(p.after) }))
    }
  }
  if (!report.canApply)
    return {
      data: {
        ...summary,
        applied: false,
        note: 'Nothing changed. Resolve the blocking layout issues and preview again.'
      }
    }
  activateDocument(doc.id)
  const first = report.changes[0]
  doc.view?.goToPage(first.page - 1)
  const accepted = await reviewProposal(ctx, {
    doc, title: 'Review text changes', report, signal: ctx.signal,
    preview: indices => ops.preview(args.revision as number, indices.map(i => changes[i]))
  })
  if (!accepted.length) {
    throwIfAborted(ctx)
    throw new ToolError('declined', 'The person declined the text changes. Nothing changed. Do not retry unless asked.')
  }
  throwIfAborted(ctx)
  if (hasActiveEditors())
    throw new ToolError('busy', 'The person is typing. Finish editing and inspect the text again.')
  // The worker rechecks its revision and layout atomically, including changes during the review.
  const result = await engineTask('Could not apply text edits', () =>
    runAsAgent(doc, () => ops.apply(args.revision as number, accepted.map(i => changes[i])))
  )
  if (first.bbox) {
    doc.view?.scrollToRect(first.page - 1, first.bbox, { center: true })
    flashRect(doc.id, first.page - 1, first.bbox)
  }
  ctx.audit({ summary: 'edited ' + result.changed + ' text blocks' })
  return {
    data: {
      ...result,
      acceptedEdits: accepted.map(i => i + 1),
      rejectedEdits: changes.map((_, i) => i).filter(i => !accepted.includes(i)).map(i => i + 1),
      applied: true,
      saved: false,
      undoLabel: await undoLabel(doc),
      note: 'Changes are visible in Fartcrobat. Inspect with render_page; save_document writes a local PDF.'
    }
  }
}

const layout: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const pages = parsePages(args.pages, doc.pageCount, 'current', doc.state.currentPage)
  if (pages.length > 10) throw new ToolError('invalid_args', 'Inspect at most 10 pages at a time.')
  const result = await engineTask('Could not inspect the document layout', () =>
    doc.ops<typeof textOps>('agent-text').layout(pages)
  )
  ctx.audit({ document: auditName(doc), summary: 'inspected layout of ' + pages.length + ' pages' })
  return {
    data: {
      ...result,
      ...copyRestriction(doc),
      note: 'Grouping, heading roles and margins are estimates. Use block geometry and render_page to verify columns, artwork and reading order before planning reflow.'
    }
  }
}

function validateReviewArgs(args: Record<string, unknown>) {
  if (!Number.isInteger(args.revision) || (args.revision as number) < 0)
    throw new ToolError('invalid_args', 'revision must come from get_document_layout or get_editable_text.')
  if (args.preview_only !== undefined && typeof args.preview_only !== 'boolean')
    throw new ToolError('invalid_args', 'preview_only must be true or false.')
}

const flow: ToolHandler = async (args, ctx) => {
  validateReviewArgs(args)
  const doc = resolveDoc(ctx, args.handle)
  ctx.audit({ document: auditName(doc) })
  if (!Array.isArray(args.regions) || !Array.isArray(args.paragraphs))
    throw new ToolError('invalid_args', 'Give regions and paragraphs in reading order.')
  const spec: FlowSpec = {
    regions: args.regions.map((r) => ({ ...r, page: pageIndex(r?.page, doc.pageCount) })),
    paragraphs: args.paragraphs.map((p) => ({ ...p, page: pageIndex(p?.page, doc.pageCount) })),
    ...(args.continuation
      ? {
          continuation: {
            ...(args.continuation as NonNullable<FlowSpec['continuation']>),
            template_page: pageIndex((args.continuation as any).template_page, doc.pageCount)
          }
        }
      : {})
  }
  const ops = doc.ops<typeof textOps>('agent-text')
  const report = await engineTask('Could not lay out text in the original design', () =>
    ops.previewFlow(args.revision as number, spec)
  )
  return reviewAndApply(args, ctx, doc, report, () => ops.flow(args.revision as number, spec))
}

const rebuild: ToolHandler = async (args, ctx) => {
  validateReviewArgs(args)
  const doc = resolveDoc(ctx, args.handle)
  ctx.audit({ document: auditName(doc) })
  const spec = {
    title: args.title,
    subtitle: args.subtitle,
    sections: args.sections,
    page_size: args.page_size,
    font_size: args.font_size,
    font: args.font
  } as ReflowSpec
  const ops = doc.ops<typeof textOps>('agent-text')
  const report = await engineTask('Could not build the new document design', () =>
    ops.previewReflow(args.revision as number, spec)
  )
  return reviewAndApply(args, ctx, doc, report, () => ops.reflow(args.revision as number, spec))
}

async function reviewAndApply(
  args: Record<string, unknown>,
  ctx: Parameters<ToolHandler>[1],
  doc: ReturnType<typeof resolveDoc>,
  report: TextPreview,
  apply: () => Promise<unknown>
) {
  throwIfAborted(ctx)
  const { previews, ...summary } = report
  if (args.preview_only) {
    ctx.audit({
      summary: report.rebuilt ? 'previewed a new document design' : 'previewed a design-preserving text flow'
    })
    return {
      data: {
        ...summary,
        applied: false,
        previewPages: previews.map((p) => p.page),
        ...copyRestriction(doc)
      },
      images: previews.map((p) => ({ mimeType: 'image/png' as const, data: toBase64(p.after) }))
    }
  }
  activateDocument(doc.id)
  doc.view?.goToPage((previews[0]?.page ?? 1) - 1)
  const accepted = await reviewProposal(ctx, {
    doc, title: report.rebuilt ? 'Review new document design' : 'Review text flow', report, signal: ctx.signal
  })
  if (!accepted.length) {
    throwIfAborted(ctx)
    throw new ToolError('declined', 'The person declined the proposed layout. Nothing changed. Do not retry unless asked.')
  }
  throwIfAborted(ctx)
  if (hasActiveEditors())
    throw new ToolError('busy', 'The person is typing. Finish editing and inspect the document again.')
  const result = await engineTask('Could not apply the reviewed layout', () => runAsAgent(doc, apply))
  doc.view?.goToPage(0)
  ctx.audit({
    summary: report.rebuilt ? 'rebuilt the document layout' : 'reflowed text through columns and pages'
  })
  return {
    data: {
      result,
      applied: true,
      saved: false,
      undoLabel: await undoLabel(doc),
      note: 'The updated PDF is visible in Fartcrobat. Render the affected pages to inspect the result. Save as a new local PDF with save_document.'
    }
  }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  get_editable_text: inspect,
  edit_text: edit,
  get_document_layout: layout,
  reflow_text: flow,
  rebuild_document: rebuild
}
