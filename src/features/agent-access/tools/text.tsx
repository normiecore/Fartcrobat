/** Native PDF text editing, with a review in the same app the person is using. */
import type { AgentToolName } from '@shared/agent/tools'
import { hasActiveEditors } from '@renderer/app/commands'
import { activateDocument } from '@renderer/app/actions'
import type textOps from '../engine'
import { reviseFlowSpec, type FlowSpec } from '../flow'
import { reviseReflowSpec, type ReflowSpec } from '../reflow'
import type { TextPreview } from '../engine'
import { validateTextChanges, type TextChange } from '../textEdits'
import { reviewInDocument } from '../ui/InlineReview'
import { useInlineReview } from '../ui/reviewState'
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

/** A proposal for a review is being made or reviewed (its copy is held in the worker until then). */
let reviewing = false
/**
 * Another review holds the page: refuse before switching the person's tab away from it, and before
 * a new proposal replaces the one that review shows.
 */
function refuseWhileReviewing() {
  if (useInlineReview.getState().review || reviewing)
    throw new ToolError('busy', 'Another edit review is open in Fartcrobat. Wait until the person has finished it.')
}
/** Proposes and reviews while no other review can start. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  refuseWhileReviewing()
  reviewing = true
  try { return await fn() } finally { reviewing = false }
}

/** The report as the AI app sees it: the review's page geometry stays in Fartcrobat. */
function forAgent(report: TextPreview) {
  const { previews: _previews, proposal: _proposal, pages: _pages, margins: _margins, changes, ...rest } = report
  return {
    ...rest,
    changes: changes.map((c) => ({
      page: c.page,
      label: c.label,
      before: c.before,
      after: c.after,
      bbox: c.bbox,
      fallbackFonts: c.fallbackFonts,
      ...(c.notes.length ? { notes: c.notes } : {})
    }))
  }
}

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
  if (args.preview_only) {
    const report = await engineTask('Could not preview text edits', () =>
      ops.preview(args.revision as number, changes)
    )
    throwIfAborted(ctx)
    ctx.audit({ summary: 'previewed ' + changes.length + ' text changes' })
    return {
      data: {
        ...forAgent(report),
        applied: false,
        previewPages: report.previews.map((p) => p.page),
        ...copyRestriction(doc)
      },
      images: report.previews.map((p) => ({ mimeType: 'image/png' as const, data: toBase64(p.after) }))
    }
  }
  const { report, accepted } = await exclusive(async () => {
    const report = await engineTask('Could not preview text edits', () =>
      ops.propose(args.revision as number, changes)
    )
    const proposal = report.proposal
    const close = () => (proposal ? ops.closeProposal(proposal.id) : Promise.resolve())
    if (ctx.signal.aborted || !report.canApply) {
      void close().catch(() => {})
      throwIfAborted(ctx)
      return { report, accepted: null }
    }
    activateDocument(doc.id)
    doc.view?.goToPage(report.changes[0].page - 1)
    const accepted = await reviewProposal(ctx, {
      doc, title: 'Review text changes', report, signal: ctx.signal, close,
      check: kept => ops.checkProposal(proposal!.id, kept)
    })
    return { report, accepted }
  })
  if (!accepted)
    return {
      data: {
        ...forAgent(report),
        applied: false,
        note: 'Nothing changed. Resolve the blocking layout issues and preview again.'
      }
    }
  const first = report.changes[0]
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
  // The first edit that was applied, not a rejected one.
  const shown = report.changes[accepted[0]] ?? first
  if (shown.bbox) {
    doc.view?.scrollToRect(shown.page - 1, shown.bbox, { center: true })
    flashRect(doc.id, shown.page - 1, shown.bbox)
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
  return reviewAndApply(args, ctx, doc, {
    what: 'Could not lay out text in the original design',
    preview: () => ops.previewFlow(args.revision as number, spec),
    propose: () => ops.proposeFlow(args.revision as number, spec),
    revise: (id, rejected) => ops.reviseProposal(id, rejected),
    close: (id) => ops.closeProposal(id),
    // A rejected paragraph keeps its original wording and is still flowed.
    apply: (rejected) => ops.flow(args.revision as number, reviseFlowSpec(spec, rejected))
  })
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
  return reviewAndApply(args, ctx, doc, {
    what: 'Could not build the new document design',
    preview: () => ops.previewReflow(args.revision as number, spec),
    propose: () => ops.proposeReflow(args.revision as number, spec),
    revise: (id, rejected) => ops.reviseProposal(id, rejected),
    close: (id) => ops.closeProposal(id),
    // Rebuild items are 0 the title and 1..n the sections; a rejected section is left out.
    apply: (rejected) => ops.reflow(args.revision as number, reviseReflowSpec(spec, rejected.map((i) => i - 1)))
  })
}

async function reviewAndApply(
  args: Record<string, unknown>,
  ctx: Parameters<ToolHandler>[1],
  doc: ReturnType<typeof resolveDoc>,
  steps: {
    what: string
    preview: () => Promise<TextPreview>
    propose: () => Promise<TextPreview>
    revise: (id: string, rejected: number[]) => Promise<TextPreview>
    close: (id: string) => Promise<unknown>
    /** Applies the change with the rejected items (change indices). */
    apply: (rejected: number[]) => Promise<unknown>
  }
) {
  throwIfAborted(ctx)
  if (args.preview_only) {
    const report = await engineTask(steps.what, steps.preview)
    throwIfAborted(ctx)
    ctx.audit({
      summary: report.rebuilt ? 'previewed a new document design' : 'previewed a design-preserving text flow'
    })
    return {
      data: {
        ...forAgent(report),
        applied: false,
        previewPages: report.previews.map((p) => p.page),
        ...copyRestriction(doc)
      },
      images: report.previews.map((p) => ({ mimeType: 'image/png' as const, data: toBase64(p.after) }))
    }
  }
  const { report, accepted } = await exclusive(async () => {
    const report = await engineTask(steps.what, steps.propose)
    const id = report.proposal!.id
    const close = () => steps.close(id)
    if (ctx.signal.aborted) void close().catch(() => {})
    throwIfAborted(ctx)
    activateDocument(doc.id)
    doc.view?.goToPage((report.pages[0]?.page ?? 1) - 1)
    const accepted = await reviewProposal(ctx, {
      doc, title: report.rebuilt ? 'Review new document design' : 'Review text flow', report, signal: ctx.signal,
      close, revise: rejected => steps.revise(id, rejected)
    })
    return { report, accepted }
  })
  if (!accepted.length) {
    throwIfAborted(ctx)
    throw new ToolError('declined', 'The person declined the proposed layout. Nothing changed. Do not retry unless asked.')
  }
  throwIfAborted(ctx)
  if (hasActiveEditors())
    throw new ToolError('busy', 'The person is typing. Finish editing and inspect the document again.')
  // Paragraphs are numbered from 1 in the call's order; rebuild items are the call's sections.
  const items = report.changes.filter((c) => c.rejectable)
  const item = (c: (typeof items)[number]) => ({ item: report.rebuilt ? c.index : c.index + 1, label: c.label })
  const acceptedItems = items.filter((c) => accepted.includes(report.changes.indexOf(c)))
  const rejectedItems = items.filter((c) => !acceptedItems.includes(c))
  const result = await engineTask('Could not apply the reviewed layout', () =>
    runAsAgent(doc, () => steps.apply(rejectedItems.map((c) => c.index)))
  )
  doc.view?.goToPage(0)
  ctx.audit({
    summary: report.rebuilt ? 'rebuilt the document layout' : 'reflowed text through columns and pages'
  })
  return {
    data: {
      result,
      acceptedItems: acceptedItems.map(item),
      rejectedItems: rejectedItems.map(item),
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
