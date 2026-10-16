/** Native PDF text editing, with a review in the same app the person is using. */
import type { AgentToolName } from '@shared/agent/tools'
import { hasActiveEditors } from '@renderer/app/commands'
import { activateDocument } from '@renderer/app/actions'
import type textOps from '../engine'
import type { FlowSpec } from '../flow'
import type { ReflowSpec } from '../reflow'
import type { TextPreview } from '../engine'
import { validateTextChanges, type TextChange } from '../textEdits'
import { flashRect } from '../ui/store'
import {
  auditName,
  confirmAgentAction,
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

function Preview({ report }: { report: TextPreview }) {
  return (
    <div className="fc-agent-access-text-review">
      <p>
        Review these changes to the PDF open in Fartcrobat. Apply changes makes one undoable edit; it does not
        save the file.
      </p>
      {report.issues.length > 0 && (
        <ul>
          {report.issues.map((issue, i) => (
            <li key={i}>
              Page {issue.page}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {report.changes.map((c, i) => (
        <section key={i} className="fc-agent-access-text-diff">
          <b>
            Page {c.page} · Change {i + 1}
          </b>
          <div className="fc-agent-access-text-columns">
            <div>
              <h3>Before</h3>
              <pre>{c.before || '(New text)'}</pre>
            </div>
            <div>
              <h3>After</h3>
              <pre>{c.after || '(Delete text)'}</pre>
            </div>
          </div>
        </section>
      ))}
      {report.previews.map((p) => (
        <section key={p.page}>
          <b>Page {p.page} preview</b>
          <div className="fc-agent-access-text-columns">
            <figure>
              <figcaption>Before</figcaption>
              {p.before.length ? (
                <img
                  alt={'Page ' + p.page + ' before edits'}
                  src={'data:image/png;base64,' + toBase64(p.before)}
                />
              ) : (
                <p>New continuation page</p>
              )}
            </figure>
            <figure>
              <figcaption>After</figcaption>
              <img
                alt={'Page ' + p.page + ' proposed edits'}
                src={'data:image/png;base64,' + toBase64(p.after)}
              />
            </figure>
          </div>
        </section>
      ))}
      <p>
        {report.flow
          ? 'Text flows through the proposed columns and pages. Check spacing, repeated labels and fonts before applying.'
          : report.rebuilt
            ? 'This is a new document design. Only apply it if you want the original layout replaced.'
            : 'PDF text blocks do not push surrounding content onto another page. Use design-preserving text flow for larger rewrites.'}
      </p>
    </div>
  )
}

export { Preview as TextReview }

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
  const accepted = await confirmAgentAction(ctx, {
    title: 'Review text changes',
    message: <Preview report={report} />,
    confirmLabel: 'Apply changes',
    width: 1000
  })
  if (!accepted) {
    throwIfAborted(ctx)
    throw new ToolError(
      'declined',
      'The person declined the text changes in Fartcrobat. Nothing changed. Do not retry unless they ask.'
    )
  }
  throwIfAborted(ctx)
  if (hasActiveEditors())
    throw new ToolError('busy', 'The person is typing. Finish editing and inspect the text again.')
  // The worker rechecks its revision and layout atomically, including changes during the review.
  const result = await engineTask('Could not apply text edits', () =>
    runAsAgent(doc, () => ops.apply(args.revision as number, changes))
  )
  if (first.bbox) {
    doc.view?.scrollToRect(first.page - 1, first.bbox, { center: true })
    flashRect(doc.id, first.page - 1, first.bbox)
  }
  ctx.audit({ summary: 'edited ' + result.changed + ' text blocks' })
  return {
    data: {
      ...result,
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
  const ok = await confirmAgentAction(ctx, {
    title: report.rebuilt ? 'Review new document design' : 'Review text flow',
    message: <Preview report={report} />,
    confirmLabel: 'Apply changes',
    width: 1000
  })
  if (!ok) {
    throwIfAborted(ctx)
    throw new ToolError(
      'declined',
      'The person declined the proposed layout. Nothing changed. Do not retry unless they ask.'
    )
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
