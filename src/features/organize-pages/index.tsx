import {
  Clipboard,
  Combine,
  Copy,
  File,
  FileInput,
  FileOutput,
  FilePlus2,
  Hash,
  LayoutGrid,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  X
} from 'lucide-react'
import {
  defineFeature,
  openToolGroup,
  type CommandContext,
  type CommandDefinition,
  type ContextMenuItem,
  type DocumentModel,
  type MenuContribution
} from '@renderer/sdk'
import { deletePages, duplicatePages, insertFromClipboard, rotatePages } from './actions'
import { openCombineDialog } from './CombineDialog'
import { openDeleteDialog } from './dialogs/DeleteDialog'
import { openExtractDialog } from './dialogs/ExtractDialog'
import { openInsertDialog } from './dialogs/InsertDialog'
import { openLabelsDialog } from './dialogs/LabelsDialog'
import { openReplaceFlow } from './dialogs/ReplaceDialog'
import { openRotateDialog } from './dialogs/RotateDialog'
import { openSplitDialog } from './dialogs/SplitDialog'
import { insertItems } from './menus'
import { OrganizePanel } from './OrganizePanel'
import { OrganizeView } from './OrganizeView'
import { defaultInsertionGap, isOrganizeOpen, ORGANIZE_GROUP, selectedIndices, targetPages } from './store'
import './organize.css'

const d = (ctx: CommandContext) => ctx.doc!

/** Selection to prefill dialogs with: the grid selection when the grid is open. */
function dialogSelection(doc: DocumentModel): number[] {
  return isOrganizeOpen(doc) ? selectedIndices(doc) : []
}

function gridSelection(ctx: CommandContext): number[] {
  return ctx.doc && isOrganizeOpen(ctx.doc) ? selectedIndices(ctx.doc) : []
}

/** Rotates the grid selection directly; elsewhere opens Rotate Pages… with the direction chosen. */
function rotateCommand(ctx: CommandContext, degrees: 90 | -90) {
  const doc = d(ctx)
  const sel = gridSelection(ctx)
  if (sel.length) return rotatePages(doc, sel, degrees)
  return openRotateDialog(doc, [], degrees)
}

const commands: CommandDefinition[] = [
  {
    id: 'organize.open',
    label: 'Organize Pages',
    icon: LayoutGrid,
    keywords: ['pages', 'reorder', 'move pages', 'page thumbnails', 'arrange'],
    checked: (ctx) => isOrganizeOpen(ctx.doc),
    run: () => openToolGroup(ORGANIZE_GROUP)
  },
  {
    id: 'organize.close',
    label: 'Close Organize Pages',
    icon: X,
    hidden: true,
    enabled: (ctx) => isOrganizeOpen(ctx.doc),
    run: () => openToolGroup(null)
  },
  // Registered before organize.rotatePages so Mod+Shift+R rotates the grid selection directly.
  {
    id: 'organize.rotateRight',
    label: 'Rotate Pages Clockwise',
    icon: RotateCw,
    shortcut: 'Mod+Shift+R',
    keywords: ['rotate right', 'turn'],
    run: (ctx) => rotateCommand(ctx, 90)
  },
  {
    id: 'organize.rotateLeft',
    label: 'Rotate Pages Counterclockwise',
    icon: RotateCcw,
    keywords: ['rotate left', 'turn', 'anticlockwise'],
    run: (ctx) => rotateCommand(ctx, -90)
  },
  {
    id: 'organize.rotatePages',
    label: 'Rotate Pages…',
    icon: RotateCw,
    shortcut: 'Mod+Shift+R',
    keywords: ['rotate', 'turn', 'landscape', 'portrait'],
    run: (ctx) => openRotateDialog(d(ctx), dialogSelection(d(ctx)), 90)
  },
  {
    id: 'organize.delete',
    label: 'Delete Selected Pages',
    icon: Trash2,
    shortcut: ['Delete', 'Backspace'],
    hidden: true,
    enabled: (ctx) => gridSelection(ctx).length > 0,
    run: (ctx) => void deletePages(d(ctx), gridSelection(ctx))
  },
  {
    id: 'organize.deletePages',
    label: 'Delete Pages…',
    icon: Trash2,
    shortcut: 'Mod+Shift+D',
    keywords: ['remove pages'],
    enabled: (ctx) => !!ctx.doc && ctx.doc.pageCount > 1,
    run: (ctx) => openDeleteDialog(d(ctx), dialogSelection(d(ctx)))
  },
  {
    id: 'organize.insertFromFile',
    label: 'Insert Pages from File…',
    icon: File,
    shortcut: 'Mod+Shift+I',
    keywords: ['add pages', 'merge', 'append'],
    run: (ctx) => openInsertDialog(d(ctx), 'file', defaultInsertionGap(d(ctx)))
  },
  {
    id: 'organize.insertBlank',
    label: 'Insert Blank Page…',
    icon: FilePlus2,
    keywords: ['add page', 'new page', 'empty page'],
    run: (ctx) => openInsertDialog(d(ctx), 'blank', defaultInsertionGap(d(ctx)))
  },
  {
    id: 'organize.insertClipboard',
    label: 'Insert Pages from Clipboard',
    icon: Clipboard,
    keywords: ['paste', 'screenshot', 'image'],
    run: (ctx) => insertFromClipboard(d(ctx), defaultInsertionGap(d(ctx)))
  },
  {
    id: 'organize.insertPages',
    label: 'Insert Pages…',
    icon: FileInput,
    keywords: ['add pages', 'from open document'],
    run: (ctx) => openInsertDialog(d(ctx), 'open', defaultInsertionGap(d(ctx)))
  },
  {
    id: 'organize.extract',
    label: 'Extract Pages…',
    icon: FileOutput,
    keywords: ['save pages', 'export pages', 'pull out'],
    run: (ctx) => openExtractDialog(d(ctx), dialogSelection(d(ctx)))
  },
  {
    id: 'organize.split',
    label: 'Split Document…',
    icon: Scissors,
    keywords: ['split pdf', 'separate', 'divide', 'break up'],
    enabled: (ctx) => !!ctx.doc && ctx.doc.pageCount > 1,
    run: (ctx) => openSplitDialog(d(ctx))
  },
  {
    id: 'organize.replace',
    label: 'Replace Pages…',
    icon: Replace,
    keywords: ['swap pages', 'substitute'],
    run: (ctx) => openReplaceFlow(d(ctx), dialogSelection(d(ctx)))
  },
  {
    id: 'organize.duplicate',
    label: 'Duplicate Pages',
    icon: Copy,
    keywords: ['copy pages', 'clone page'],
    run: (ctx) => duplicatePages(d(ctx), targetPages(d(ctx)))
  },
  {
    id: 'organize.pageLabels',
    label: 'Page Labels…',
    icon: Hash,
    keywords: ['number pages', 'page numbering', 'roman numerals', 'bates'],
    run: (ctx) => openLabelsDialog(d(ctx), dialogSelection(d(ctx)))
  },
  {
    id: 'combine.open',
    label: 'Combine Files…',
    icon: Combine,
    requiresDocument: false,
    keywords: ['merge', 'join', 'binder', 'combine pdf'],
    run: () => openCombineDialog()
  }
]

const menuItems = (
  menu: MenuContribution['menu'],
  group: string,
  ids: string[],
  order: number,
  submenu?: string
): MenuContribution[] => ids.map((command, i) => ({ menu, group, command, order: order + i, submenu }))

const menus: MenuContribution[] = [
  ...menuItems('file', 'create', ['combine.open'], 60),
  ...menuItems('document', 'organize-pages', ['organize.open'], 100),
  ...menuItems(
    'document',
    'organize-pages-edit',
    ['organize.insertFromFile', 'organize.insertBlank', 'organize.insertClipboard', 'organize.insertPages'],
    200,
    'Insert Pages'
  ),
  ...menuItems(
    'document',
    'organize-pages-edit',
    [
      'organize.deletePages',
      'organize.extract',
      'organize.replace',
      'organize.split',
      'organize.rotatePages',
      'organize.duplicate',
      'organize.pageLabels'
    ],
    210
  ),
  ...menuItems('tools', 'organize-pages', ['organize.open', 'combine.open'], 100)
]

function pageMenuItems({ doc, pageIndex }: { doc: DocumentModel; pageIndex: number }): ContextMenuItem[] {
  return [
    {
      id: 'organize-rotate',
      label: 'Rotate Page',
      icon: RotateCw,
      submenu: [
        { id: 'cw', label: 'Clockwise', icon: RotateCw, run: () => void rotatePages(doc, [pageIndex], 90) },
        {
          id: 'ccw',
          label: 'Counterclockwise',
          icon: RotateCcw,
          run: () => void rotatePages(doc, [pageIndex], -90)
        },
        { id: '180', label: '180°', run: () => void rotatePages(doc, [pageIndex], 180) }
      ]
    },
    {
      id: 'organize-insert',
      label: 'Insert Pages',
      icon: FilePlus2,
      submenu: insertItems(doc, pageIndex + 1)
    },
    {
      id: 'organize-extract',
      label: 'Extract Page…',
      icon: FileOutput,
      run: () => void openExtractDialog(doc, [pageIndex])
    },
    {
      id: 'organize-delete',
      label: 'Delete Page',
      icon: Trash2,
      danger: true,
      disabled: doc.pageCount <= 1,
      run: () => void deletePages(doc, [pageIndex])
    },
    {
      id: 'organize-open',
      label: 'Organize Pages',
      icon: LayoutGrid,
      run: () => {
        doc.set({ currentPage: pageIndex })
        openToolGroup(ORGANIZE_GROUP)
      }
    }
  ]
}

export default defineFeature({
  id: 'organize-pages',
  commands,
  menus,
  toolGroups: [
    {
      id: 'combine',
      label: 'Combine files',
      icon: Combine,
      color: '#7e57c2',
      description: 'Merge PDFs, images and Office files into one PDF',
      order: 40,
      category: 'create',
      homeTile: true,
      requiresDocument: false,
      keywords: ['merge', 'join', 'binder'],
      run: () => openCombineDialog()
    },
    {
      id: ORGANIZE_GROUP,
      label: 'Organize pages',
      icon: LayoutGrid,
      color: '#2d9d78',
      description: 'Reorder, rotate, insert, delete, extract and split pages',
      order: 50,
      category: 'edit',
      homeTile: true,
      keywords: ['pages', 'rotate', 'delete', 'insert', 'extract', 'split', 'reorder'],
      panel: OrganizePanel,
      documentView: OrganizeView
    }
  ],
  pageContextMenu: [{ id: 'organize-pages', order: 70, items: pageMenuItems }]
})
