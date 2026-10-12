/**
 * Comments: makes every comment selectable, movable and editable on the page, pop-up notes with
 * replies and review status, the Comments panel, comment properties, XFDF/FDF import and export,
 * comment summaries, and Delete All / Flatten.
 */
import {
  ChevronDown,
  ChevronUp,
  Eye,
  FileDown,
  FileUp,
  Layers,
  MessageSquare,
  MessagesSquare,
  ScrollText,
  Settings2,
  Trash
} from 'lucide-react'
import { defineFeature, openRightPanel, registry, type CommandContext, type MenuContribution } from '@renderer/sdk'
import {
  deleteAllComments,
  deleteSelected,
  exportComments,
  flattenComments,
  importComments,
  navigateComments,
  summarizeComments,
  toggleCommentVisibility
} from './actions'
import { AnnotationLayer } from './AnnotationLayer'
import { CommentsPanel } from './CommentsPanel'
import { CommentsGlobal } from './Globals'
import { openProperties } from './PropertiesDialog'
import { CommentingSettings } from './Settings'
import { buildThreads } from './shared'
import { cachedComments, openPopup } from './state'
import './comments.css'

const doc = (ctx: CommandContext) => ctx.doc!

/** The single selected comment (a group counts as one), if any. */
function selectedComment(ctx: CommandContext) {
  const d = ctx.doc
  const sel = d?.state.selection
  if (!d || sel?.kind !== 'annotations' || !sel.ids.length) return null
  const t = buildThreads(cachedComments(d)).find((x) => sel.ids.includes(x.root.id) || x.group.some((g) => sel.ids.includes(g.id)))
  if (!t) return null
  const ids = [t.root.id, ...t.group.map((g) => g.id)]
  return sel.ids.every((id) => ids.includes(id)) ? t.root : null
}

const m = (menu: MenuContribution['menu'], group: string, ids: string[], order: number, submenu?: string): MenuContribution[] =>
  ids.map((command, i) => ({ menu, group, command, order: order + i, submenu }))

export default defineFeature({
  id: 'comments',
  commands: [
    {
      id: 'comments.toggleVisibility',
      label: 'Show/Hide Comments',
      icon: Eye,
      checked: (ctx) => !!ctx.doc?.state.showAnnotations,
      run: (ctx) => toggleCommentVisibility(doc(ctx)),
      keywords: ['hide comments', 'show comments', 'annotations', 'markup']
    },
    {
      id: 'comments.showList',
      label: 'Comments List',
      icon: MessagesSquare,
      run: () => openRightPanel('comments'),
      keywords: ['comments panel', 'review', 'replies']
    },
    {
      id: 'comments.next',
      label: 'Next Comment',
      icon: ChevronDown,
      run: (ctx) => navigateComments(doc(ctx), 1),
      keywords: ['go to comment']
    },
    {
      id: 'comments.previous',
      label: 'Previous Comment',
      icon: ChevronUp,
      run: (ctx) => navigateComments(doc(ctx), -1),
      keywords: ['go to comment']
    },
    {
      id: 'comments.openPopup',
      label: 'Open Pop-up Note',
      icon: MessageSquare,
      enabled: (ctx) => !!selectedComment(ctx),
      run: (ctx) => {
        const a = selectedComment(ctx)
        if (a) openPopup(doc(ctx), a)
      }
    },
    {
      id: 'comments.properties',
      label: 'Comment Properties…',
      icon: Settings2,
      shortcut: 'Mod+E',
      enabled: (ctx) => !!selectedComment(ctx),
      run: (ctx) => {
        const a = selectedComment(ctx)
        if (a) openProperties(doc(ctx), a)
      }
    },
    {
      id: 'comments.delete',
      label: 'Delete Comment',
      icon: Trash,
      shortcut: ['Delete', 'Backspace'],
      enabled: (ctx) => ctx.doc?.state.selection.kind === 'annotations' && ctx.doc.state.selection.ids.length > 0,
      run: (ctx) => deleteSelected(doc(ctx))
    },
    {
      id: 'comments.import',
      label: 'Import Comments…',
      icon: FileUp,
      run: (ctx) => importComments(doc(ctx)),
      keywords: ['xfdf', 'fdf', 'import data file', 'merge comments']
    },
    {
      id: 'comments.export',
      label: 'Export Comments to Data File…',
      icon: FileDown,
      run: (ctx) => exportComments(doc(ctx)),
      keywords: ['xfdf', 'fdf', 'export comments', 'save comments']
    },
    {
      id: 'comments.summarize',
      label: 'Summarize Comments…',
      icon: ScrollText,
      run: (ctx) => summarizeComments(doc(ctx)),
      keywords: ['comment summary', 'print comments', 'report']
    },
    {
      id: 'comments.deleteAll',
      label: 'Delete All Comments…',
      icon: Trash,
      run: (ctx) => deleteAllComments(doc(ctx)),
      keywords: ['remove comments', 'clear annotations']
    },
    {
      id: 'comments.flatten',
      label: 'Flatten Comments…',
      icon: Layers,
      run: (ctx) => flattenComments(doc(ctx)),
      keywords: ['print production', 'flatten annotations', 'burn in']
    }
  ],
  menus: [
    ...m('comment', 'comments-list', ['comments.showList', 'comments.next', 'comments.previous'], 600),
    ...m('comment', 'comments-selection', ['comments.openPopup', 'comments.properties', 'comments.delete'], 650),
    ...m('comment', 'comments-files', ['comments.import', 'comments.export', 'comments.summarize'], 700),
    ...m('comment', 'comments-view', ['comments.toggleVisibility'], 750),
    ...m('comment', 'comments-cleanup', ['comments.deleteAll', 'comments.flatten'], 800),
    ...m('view', 'comments-showhide', ['comments.toggleVisibility'], 450, 'Show/Hide'),
    ...m('document', 'comments-production', ['comments.flatten'], 800, 'Print Production')
  ],
  rightPanels: [{ id: 'comments', label: 'Comments', icon: MessagesSquare, order: 30, component: CommentsPanel }],
  pageLayers: [
    {
      id: 'annotations',
      order: 40,
      component: AnnotationLayer,
      when: ({ toolId }) => toolId === 'select' || !!registry.tools.get(toolId)?.allowDefaultInteractions
    }
  ],
  settings: [{ id: 'comments', label: 'Commenting', order: 20, component: CommentingSettings }],
  globals: [CommentsGlobal]
})
