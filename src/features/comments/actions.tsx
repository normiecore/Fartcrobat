/**
 * Comment actions used by the page layer, pop-ups, the Comments panel and the commands.
 */
import {
  BringToFront,
  Check,
  Copy,
  Flag,
  Lock,
  LockOpen,
  MessageSquare,
  Reply,
  SendToBack,
  Settings2,
  SquareCheck,
  Star,
  Trash,
  Type
} from 'lucide-react'
import type { AnnotInfo, AnnotSpec } from '@engine/ops/annots'
import type { Rect } from '@shared/geometry'
import { invertMatrix, rotateMatrix, transformPoint } from '@shared/geometry'
import {
  authorName,
  basename,
  confirm,
  displayShortcut,
  invoke,
  openDialog,
  openNewDocument,
  openRightPanel,
  readFile,
  showError,
  stripExtension,
  toast,
  useApp,
  withProgress,
  writeFile,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import { saveAsDefault } from './appearance'
import type { ImportSummary } from './engine'
import { FlattenDialog, SummarizeDialog, type SummarizeChoice } from './dialogs'
import { canMove, groupIds, isPageComment, markedText, typeLabel } from './model'
import { openProperties } from './PropertiesDialog'
import { buildThreads, importMessage, plural, REVIEW_STATES } from './shared'
import {
  annotsOf,
  cachedComments,
  closePopupsFor,
  commentsOf,
  openPopup,
  refreshComments,
  startInlineEdit,
  useCommentPrefs,
  useCommentsUi,
  type CommentThread
} from './state'
import { buildXfdf, parseXfdfText } from './xfdf'

export function selectComments(doc: DocumentModel, page: number, ids: number[]) {
  doc.setSelection({ kind: 'annotations', page, ids })
}

/** Selects a comment and scrolls it into view. */
export function revealComment(doc: DocumentModel, a: AnnotInfo, list: AnnotInfo[] = cachedComments(doc)) {
  selectComments(doc, a.page, groupIds(list, a))
  doc.view?.scrollToRect(a.page, a.rect, { center: true })
}

export async function updateComment(doc: DocumentModel, a: Pick<AnnotInfo, 'id' | 'page'>, spec: AnnotSpec) {
  try {
    await annotsOf(doc).update(a.id, spec, a.page)
  } catch (err) {
    showError(err, 'Could not change the comment')
  }
}

export async function deleteComments(doc: DocumentModel, page: number, ids: number[]) {
  const list = cachedComments(doc)
  const locked = list.filter((a) => ids.includes(a.id) && a.locked)
  const targets = ids.filter((id) => !locked.some((a) => a.id === id))
  if (locked.length) toast(locked.length === 1 ? 'That comment is locked. Unlock it to delete it.' : 'Locked comments were not deleted.', { kind: 'warning' })
  if (!targets.length) return
  try {
    await annotsOf(doc).delete(targets, page)
    closePopupsFor(doc.id, targets)
    const sel = doc.state.selection
    if (sel.kind === 'annotations') {
      const rest = sel.ids.filter((id) => !targets.includes(id))
      if (rest.length) doc.setSelection({ ...sel, ids: rest })
      else doc.clearSelection()
    }
    const ed = useCommentsUi.getState().editing
    if (ed && ed.docId === doc.id && targets.includes(ed.id)) useCommentsUi.setState({ editing: null })
  } catch (err) {
    showError(err, 'Could not delete the comment')
  }
}

export async function deleteSelected(doc: DocumentModel) {
  const sel = doc.state.selection
  if (sel.kind !== 'annotations' || !sel.ids.length) return
  await deleteComments(doc, sel.page, sel.ids)
}

export async function setStatus(doc: DocumentModel, a: Pick<AnnotInfo, 'id' | 'page'>, state: string) {
  try {
    await annotsOf(doc).setState(a.id, state, authorName())
  } catch (err) {
    showError(err, 'Could not set the status')
  }
}

export async function setMarked(doc: DocumentModel, a: Pick<AnnotInfo, 'id' | 'page'>, marked: boolean) {
  await setStatus(doc, a, marked ? 'Marked' : 'Unmarked')
}

export async function addReply(doc: DocumentModel, a: Pick<AnnotInfo, 'id'>, text: string): Promise<boolean> {
  const t = text.trim()
  if (!t) return false
  try {
    await annotsOf(doc).reply(a.id, t, authorName())
    return true
  } catch (err) {
    showError(err, 'Could not add the reply')
    return false
  }
}

export async function copyCommentText(doc: DocumentModel, a: AnnotInfo) {
  try {
    const text = a.contents.trim() || (await markedText(doc, a))
    if (!text) {
      toast('This comment has no text to copy.')
      return
    }
    await invoke('clipboard:writeText', text)
    toast('Comment text copied', { kind: 'success', timeout: 1500 })
  } catch (err) {
    showError(err, 'Could not copy the text')
  }
}

export async function arrangeComments(doc: DocumentModel, ids: number[], where: 'front' | 'back', page: number) {
  try {
    await commentsOf(doc).arrange(ids, where, page)
  } catch (err) {
    showError(err, 'Could not change the stacking order')
  }
}

export function threadOf(list: AnnotInfo[], a: AnnotInfo): CommentThread | undefined {
  return buildThreads(list).find((t) => t.root.id === a.id || t.group.some((g) => g.id === a.id))
}

/** Right-click menu of a comment (on the page and in the Comments panel). */
export function commentMenu(doc: DocumentModel, a: AnnotInfo, list: AnnotInfo[]): ContextMenuItem[] {
  const thread = threadOf(list, a)
  const root = thread?.root ?? a
  const ids = groupIds(list, root)
  const status = thread?.status ?? 'None'
  return [
    { id: 'open', label: 'Open Pop-up Note', icon: MessageSquare, run: () => openPopup(doc, root) },
    { id: 'reply', label: 'Reply', icon: Reply, run: () => openPopup(doc, root, 'reply') },
    ...(root.type === 'FreeText' && !root.locked
      ? [{ id: 'edit', label: 'Edit Text', icon: Type, run: () => startInlineEdit(doc, root) } as ContextMenuItem]
      : []),
    {
      id: 'status',
      label: 'Set Status',
      icon: Flag,
      submenu: REVIEW_STATES.map((s) => ({ id: `status-${s}`, label: s, icon: s === status ? Check : undefined, run: () => void setStatus(doc, root, s) }))
    },
    {
      id: 'mark',
      label: thread?.marked ? 'Remove Checkmark' : 'Mark with Checkmark',
      icon: SquareCheck,
      run: () => void setMarked(doc, root, !thread?.marked)
    },
    { id: 'sep1', label: '', separator: true },
    { id: 'copy', label: 'Copy Text', icon: Copy, run: () => void copyCommentText(doc, root) },
    { id: 'front', label: 'Bring to Front', icon: BringToFront, run: () => void arrangeComments(doc, ids, 'front', root.page) },
    { id: 'back', label: 'Send to Back', icon: SendToBack, run: () => void arrangeComments(doc, ids, 'back', root.page) },
    {
      id: 'lock',
      label: root.locked ? 'Unlock' : 'Lock',
      icon: root.locked ? LockOpen : Lock,
      run: () => void updateComment(doc, root, { locked: !root.locked })
    },
    { id: 'sep2', label: '', separator: true },
    {
      id: 'delete',
      label: 'Delete',
      icon: Trash,
      danger: true,
      disabled: root.locked,
      shortcut: 'Del',
      run: () => void deleteComments(doc, root.page, ids)
    },
    { id: 'sep3', label: '', separator: true },
    {
      id: 'defaults',
      label: 'Make Current Properties Default',
      icon: Star,
      run: () => void makeDefault(root)
    },
    { id: 'props', label: 'Properties…', icon: Settings2, shortcut: displayShortcut('Mod+E'), run: () => openProperties(doc, root) }
  ]
}

/** Uses a comment's look (colour, line width, font...) for new comments of the same type. */
export async function makeDefault(a: AnnotInfo) {
  if (await saveAsDefault(a)) {
    toast(`New ${typeLabel(a).toLowerCase()} comments will look like this one.`, { kind: 'success', timeout: 2500 })
  }
}

// ---- File operations ---------------------------------------------------------------------------

const XFDF_FILTER = { name: 'Acrobat XFDF comment file', extensions: ['xfdf'] }
const FDF_FILTER = { name: 'Acrobat FDF comment file', extensions: ['fdf'] }

export async function exportComments(doc: DocumentModel) {
  try {
    if (!(await commentsOf(doc).count())) {
      toast('This document has no comments to export.')
      return
    }
    const path = await invoke('file:saveDialog', {
      title: 'Export Comments to Data File',
      defaultPath: stripExtension(doc.state.title) + '.xfdf',
      filters: [XFDF_FILTER, FDF_FILTER]
    })
    if (!path) return
    const isFdf = /\.fdf$/i.test(path)
    const target = isFdf || /\.xfdf$/i.test(path) ? path : path + '.xfdf'
    await doc.busyWhile('Exporting comments…', async () => {
      let bytes: Uint8Array
      let count: number
      if (isFdf) {
        const res = await commentsOf(doc).exportFdf(doc.state.title)
        bytes = res.bytes
        count = res.count
      } else {
        const records = await commentsOf(doc).exportRecords()
        bytes = new TextEncoder().encode(buildXfdf(records, doc.state.title))
        count = records.filter((r) => !r.inReplyTo).length
      }
      await writeFile(target, bytes)
      toast(`Exported ${plural(count, 'comment')} to ${basename(target)}`, { kind: 'success' })
    })
  } catch (err) {
    showError(err, 'Could not export the comments')
  }
}

/** Imports comments from XFDF or FDF files (paths given, or chosen in a dialog). */
export async function importComments(doc: DocumentModel, paths?: string[]) {
  const files =
    paths ??
    (await invoke('file:openDialog', {
      title: 'Import Comments',
      multiple: true,
      filters: [{ name: 'Comment files (XFDF, FDF)', extensions: ['xfdf', 'fdf', 'xml'] }, XFDF_FILTER, FDF_FILTER, { name: 'All files', extensions: ['*'] }]
    }))
  if (!files.length) return
  const total: ImportSummary = { imported: 0, duplicates: 0, skipped: 0, ids: [], comments: 0, replies: 0, duplicateComments: 0 }
  for (const path of files) {
    try {
      const bytes = await readFile(path)
      const head = new TextDecoder().decode(bytes.slice(0, 16))
      let res: ImportSummary
      if (head.startsWith('%FDF') || head.startsWith('%PDF')) res = await commentsOf(doc).importFdf(bytes)
      else {
        const records = parseXfdfText(new TextDecoder().decode(bytes))
        if (!records.length) throw new Error('The file does not contain any comments')
        res = await commentsOf(doc).importRecords(records)
      }
      total.imported += res.imported
      total.duplicates += res.duplicates
      total.skipped += res.skipped
      total.comments += res.comments
      total.replies += res.replies
      total.duplicateComments += res.duplicateComments
      total.ids.push(...res.ids)
    } catch (err) {
      showError(err, `Could not import ${basename(path)}`)
    }
  }
  if (!total.imported && !total.duplicates) return
  const from = files.length === 1 ? basename(files[0]) : `${files.length} files`
  toast(importMessage(total, from), { kind: total.imported ? 'success' : 'info', timeout: 6000 })
  if (total.imported) {
    if (!doc.state.showAnnotations) doc.set({ showAnnotations: true })
    openRightPanel('comments')
  }
}

export async function summarizeComments(doc: DocumentModel) {
  await refreshComments(doc)
  const list = cachedComments(doc)
  const threads = buildThreads(list)
  if (!threads.length) {
    toast('This document has no comments to summarize.')
    return
  }
  const filter = useCommentsUi.getState().filters[doc.id]
  const choice = await openDialog<SummarizeChoice>((close) => <SummarizeDialog close={close} hasFilter={!!filter && isFiltering(filter)} />)
  if (!choice) return
  try {
    const ids = choice.onlyShowing ? visibleThreadIds(doc) : null
    const bytes = await withProgress('Summarizing comments…', (report) =>
      doc.ops<typeof import('./engine').default>('comments', { onProgress: (f, m) => report(f, m) }).summary({ ...choice.options, ids, title: doc.state.title })
    )
    await openNewDocument(bytes, `${stripExtension(doc.state.title)} - Comment Summary.pdf`)
  } catch (err) {
    showError(err, 'Could not summarize the comments')
  }
}

/** Set by the Comments panel: ids of the threads the current filter shows. */
let visibleIds: { docId: string; ids: number[] } | null = null

export function setVisibleThreadIds(docId: string, ids: number[]) {
  visibleIds = { docId, ids }
}

function visibleThreadIds(doc: DocumentModel): number[] | null {
  return visibleIds?.docId === doc.id ? visibleIds.ids : null
}

export function isFiltering(f: { query: string; types: string[]; authors: string[]; statuses: string[]; colors: string[]; checkmark: string }) {
  return !!(f.query.trim() || f.types.length || f.authors.length || f.statuses.length || f.colors.length || f.checkmark !== 'any')
}

export async function deleteAllComments(doc: DocumentModel) {
  await refreshComments(doc)
  const n = buildThreads(cachedComments(doc)).length
  if (!n) {
    toast('This document has no comments to delete.')
    return
  }
  const ok = await confirm({
    title: 'Delete All Comments',
    message: `Delete ${n === 1 ? 'the only comment' : `all ${n} comments`} in “${doc.state.title}”, including replies? You can undo this with Edit > Undo.`,
    confirmLabel: 'Delete All',
    danger: true
  })
  if (!ok) return
  try {
    await commentsOf(doc).deleteAll()
    doc.clearSelection()
    useCommentsUi.setState((s) => ({ popups: s.popups.filter((p) => p.docId !== doc.id), editing: null }))
    toast(`Deleted ${plural(n, 'comment')}`, { action: { label: 'Undo', run: () => void doc.undo() } })
  } catch (err) {
    showError(err, 'Could not delete the comments')
  }
}

export async function flattenComments(doc: DocumentModel) {
  await refreshComments(doc)
  // count what people see as comments (not each reply and status change)
  const n = buildThreads(cachedComments(doc)).length
  const hasForm = doc.info.hasForm
  if (!n && !hasForm) {
    toast('There are no comments to flatten.')
    return
  }
  const choice = await openDialog<{ widgets: boolean }>((close) => <FlattenDialog close={close} count={n} hasForm={hasForm} />)
  if (!choice) return
  try {
    await doc.busyWhile('Flattening…', () => annotsOf(doc).flatten({ annots: true, widgets: choice.widgets }))
    doc.clearSelection()
    useCommentsUi.setState((s) => ({ popups: s.popups.filter((p) => p.docId !== doc.id), editing: null }))
    toast('Comments are now part of the page content.', { kind: 'success', action: { label: 'Undo', run: () => void doc.undo() } })
  } catch (err) {
    showError(err, 'Could not flatten the comments')
  }
}

/** Comment > Next Comment / Previous Comment (in page order). */
export async function navigateComments(doc: DocumentModel, dir: 1 | -1) {
  await refreshComments(doc)
  const list = cachedComments(doc)
  const threads = buildThreads(list)
    .filter((t) => isPageComment(t.root))
    .sort((a, b) => a.root.page - b.root.page || a.root.rect[1] - b.root.rect[1] || a.root.rect[0] - b.root.rect[0])
  if (!threads.length) {
    toast('This document has no comments.')
    return
  }
  const sel = doc.state.selection
  let idx = sel.kind === 'annotations' ? threads.findIndex((t) => sel.ids.includes(t.root.id)) : -1
  if (idx >= 0) idx = (idx + dir + threads.length) % threads.length
  else {
    const cur = doc.state.currentPage
    if (dir > 0) {
      idx = threads.findIndex((t) => t.root.page >= cur)
      if (idx < 0) idx = 0
    } else {
      idx = -1
      threads.forEach((t, i) => {
        if (t.root.page <= cur) idx = i
      })
      if (idx < 0) idx = threads.length - 1
    }
  }
  revealComment(doc, threads[idx].root, list)
}

export function toggleCommentVisibility(doc: DocumentModel) {
  const show = !doc.state.showAnnotations
  doc.set({ showAnnotations: show })
  if (!show) {
    if (doc.state.selection.kind === 'annotations') doc.clearSelection()
    useCommentsUi.setState({ editing: null, hover: null })
    toast('Comments are hidden.', { action: { label: 'Show', run: () => doc.set({ showAnnotations: true }) }, timeout: 4000 })
  }
}

/** Handles 'fartcrobat:edit-annotation' from the comment tools: open the pop-up or the text editor. */
export async function editNewAnnotation(doc: DocumentModel, id: number, page: number) {
  try {
    const a = await annotsOf(doc).get(id, page)
    if (!doc.state.showAnnotations) doc.set({ showAnnotations: true })
    if (a.type === 'FreeText') {
      selectComments(doc, a.page, [a.id])
      startInlineEdit(doc, a, !a.contents)
    } else if (useCommentPrefs.getState().openPopupOnCreate) {
      openPopup(doc, a, 'contents')
    }
  } catch (err) {
    showError(err, 'Could not open the new comment')
  }
}

/** Arrow keys move the selected comments by 1 pt (10 pt with Shift), in screen directions. */
export function nudgeSelection(doc: DocumentModel, key: string, step: number): boolean {
  const sel = doc.state.selection
  if (sel.kind !== 'annotations' || !sel.ids.length) return false
  const list = cachedComments(doc)
  const items = list.filter((a) => sel.ids.includes(a.id) && canMove(a))
  if (!items.length) return false
  const v: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const dir = v[key]
  if (!dir) return false
  let [dx, dy] = transformPoint(dir, invertMatrix(rotateMatrix(doc.state.viewRotation)))
  dx *= step
  dy *= step
  // keep the comments on the page
  const page = doc.info.pages[sel.page]
  const u: Rect = [
    Math.min(...items.map((a) => a.rect[0])),
    Math.min(...items.map((a) => a.rect[1])),
    Math.max(...items.map((a) => a.rect[2])),
    Math.max(...items.map((a) => a.rect[3]))
  ]
  if (page) {
    dx = Math.max(-u[0], Math.min(page.width - u[2], dx))
    dy = Math.max(-u[1], Math.min(page.height - u[3], dy))
  }
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return true
  annotsOf(doc)
    .move(
      items.map((a) => a.id),
      dx,
      dy,
      sel.page
    )
    .catch((err) => showError(err, 'Could not move the comment'))
  return true
}

export function activeDocOf(docId: string): DocumentModel | null {
  return useApp.getState().docs.find((d) => d.id === docId) ?? null
}
