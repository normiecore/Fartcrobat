// Agent tools: show_in_app.
import type annotOps from '@engine/ops/annots'
import type { AnnotInfo } from '@engine/ops/annots'
import type { Rect } from '@shared/geometry'
import type { AgentToolName } from '@shared/agent/tools'
import { invoke, type DocumentModel } from '@renderer/sdk'
import { activateDocument } from '@renderer/app/actions'
import { flashRect } from '../ui/store'
import { auditName, pageIndex, rectArg, resolveDoc, round, ToolError, type ToolContext, type ToolHandler } from './common'

/**
 * The viewer of a document that was just brought to the front (it mounts on the next render).
 * Null when it does not appear, e.g. while Organize Pages replaces the page view.
 */
async function waitForView(doc: DocumentModel, ctx: ToolContext, timeoutMs = 3000): Promise<DocumentModel['view']> {
  const until = Date.now() + timeoutMs
  // Timers rather than animation frames: frames stop while the window is minimised.
  while (!doc.view && Date.now() < until && !ctx.signal.aborted && !doc.isClosed) await new Promise((r) => setTimeout(r, 30))
  return doc.view
}

async function findAnnotations(doc: DocumentModel, ids: number[], hintPage: number | undefined): Promise<AnnotInfo[]> {
  const ops = doc.ops<typeof annotOps>('annots')
  const found: AnnotInfo[] = []
  for (const id of ids) {
    try {
      found.push(await ops.get(id, hintPage))
    } catch {
      throw new ToolError('invalid_args', `There is no comment with id ${id}. Call list_annotations for current ids.`)
    }
  }
  return found
}

async function showInApp(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = resolveDoc(ctx, args.handle)
  ctx.audit({ document: auditName(doc) })
  let page = args.page === undefined || args.page === null ? null : pageIndex(args.page, doc.pageCount)
  let rect: Rect | null = args.rect === undefined || args.rect === null ? null : rectArg(args.rect)
  if (rect && page === null) throw new ToolError('invalid_args', 'rect needs page: the page the region is on.')
  const rawIds = args.annotation_ids
  if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'number' || !Number.isInteger(id))))
    throw new ToolError('invalid_args', 'annotation_ids must be a list of comment ids (from list_annotations)')
  const ids = (rawIds as number[] | undefined) ?? []
  const comments = ids.length ? await findAnnotations(doc, ids, page ?? undefined) : []

  // A selection holds comments of one page: those of the first comment's page (or the given page).
  const selectPage = comments.length ? (page !== null && comments.some((a) => a.page === page) ? page : comments[0].page) : null
  const selected = comments.filter((a) => a.page === selectPage)
  const skipped = comments.filter((a) => a.page !== selectPage).map((a) => a.id)
  if (page === null) page = selectPage ?? doc.state.currentPage
  if (!rect && selected.length === 1 && selectPage === page) rect = selected[0].rect

  activateDocument(doc.id)
  void invoke('feature:agent-access:attention').catch(() => {})
  const view = await waitForView(doc, ctx)
  if (selected.length) doc.setSelection({ kind: 'annotations', page: selectPage!, ids: selected.map((a) => a.id) })
  if (view) {
    if (rect) {
      view.scrollToRect(page, rect, { center: true })
      flashRect(doc.id, page, rect)
    } else view.goToPage(page)
  } else doc.set({ currentPage: page })
  const notes: string[] = []
  if (skipped.length) notes.push('Only comments on one page can be selected at a time.')
  if (!view) notes.push('The document is in front, but its pages are not shown right now (another view is open).')
  return {
    data: {
      page: page + 1,
      ...(rect ? { rect: round(rect) } : {}),
      ...(selected.length ? { selected: selected.map((a) => a.id) } : {}),
      ...(skipped.length ? { notSelected: skipped } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {})
    }
  }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  show_in_app: showInApp
}
