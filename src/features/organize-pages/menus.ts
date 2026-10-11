import {
  Clipboard,
  Copy,
  Eye,
  File,
  FileInput,
  FileOutput,
  FilePlus2,
  Files,
  Hash,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareDashedMousePointer,
  Trash2
} from 'lucide-react'
import { displayShortcut, openToolGroup, type ContextMenuItem, type DocumentModel } from '@renderer/sdk'
import { deletePages, duplicatePages, insertFromClipboard, rotatePages } from './actions'
import { openExtractDialog } from './dialogs/ExtractDialog'
import { openInsertDialog } from './dialogs/InsertDialog'
import { openLabelsDialog } from './dialogs/LabelsDialog'
import { openReplaceFlow } from './dialogs/ReplaceDialog'
import { openSplitDialog } from './dialogs/SplitDialog'
import { filterPages, type SelectFilter } from './order'
import { parsePageRange } from './ranges'
import { selectIndices } from './store'
import { prompt } from '@renderer/sdk'

/** Items of the Insert menu for a given insertion gap. */
export function insertItems(doc: DocumentModel, gap: number): ContextMenuItem[] {
  return [
    {
      id: 'insert-file',
      label: 'From file…',
      icon: File,
      shortcut: displayShortcut('Mod+Shift+I'),
      run: () => void openInsertDialog(doc, 'file', gap)
    },
    {
      id: 'insert-blank',
      label: 'Blank page…',
      icon: FilePlus2,
      run: () => void openInsertDialog(doc, 'blank', gap)
    },
    {
      id: 'insert-clipboard',
      label: 'From clipboard',
      icon: Clipboard,
      run: () => void insertFromClipboard(doc, gap)
    },
    { id: 'insert-sep', label: '', separator: true },
    {
      id: 'insert-pages',
      label: 'Insert pages…',
      icon: FileInput,
      run: () => void openInsertDialog(doc, 'open', gap)
    }
  ]
}

export function selectBy(doc: DocumentModel, filter: SelectFilter) {
  const pages = filterPages(doc.state.info.pages, filter)
  selectIndices(doc, pages, { focus: pages[0] ?? 0, anchor: pages[0] ?? 0 })
}

export async function selectRange(doc: DocumentModel) {
  const labels = doc.state.info.pages.map((p) => p.label)
  const v = await prompt({
    title: 'Select pages',
    label: `Pages (1–${doc.pageCount})`,
    placeholder: 'e.g. 1-3, 5, 8-',
    okLabel: 'Select',
    validate: (s) => {
      const r = parsePageRange(s, doc.pageCount, labels)
      return r.ok ? null : r.error
    }
  })
  if (v === null) return
  const r = parsePageRange(v, doc.pageCount, labels)
  if (r.ok) selectIndices(doc, r.pages, { focus: r.pages[0], anchor: r.pages[0] })
}

export function selectItems(doc: DocumentModel): ContextMenuItem[] {
  return [
    {
      id: 'sel-all',
      label: 'All pages',
      shortcut: displayShortcut('Mod+A'),
      run: () => selectBy(doc, 'all')
    },
    { id: 'sel-even', label: 'Even pages', run: () => selectBy(doc, 'even') },
    { id: 'sel-odd', label: 'Odd pages', run: () => selectBy(doc, 'odd') },
    { id: 'sel-portrait', label: 'Portrait pages', run: () => selectBy(doc, 'portrait') },
    { id: 'sel-landscape', label: 'Landscape pages', run: () => selectBy(doc, 'landscape') },
    { id: 'sel-sep', label: '', separator: true },
    {
      id: 'sel-range',
      label: 'Page range…',
      icon: SquareDashedMousePointer,
      run: () => void selectRange(doc)
    },
    { id: 'sel-none', label: 'Clear selection', run: () => selectIndices(doc, []) }
  ]
}

/** Right-click menu of a thumbnail (acts on the selection, which includes the clicked page). */
export function pageMenu(
  doc: DocumentModel,
  selected: number[],
  index: number,
  openPage: (i: number) => void
): ContextMenuItem[] {
  const n = selected.length
  const what = n > 1 ? `${n} Pages` : 'Page'
  const last = selected[selected.length - 1] ?? index
  const first = selected[0] ?? index
  return [
    { id: 'open', label: 'Open Page', icon: Eye, shortcut: 'Enter', run: () => openPage(index) },
    { id: 'sep0', label: '', separator: true },
    {
      id: 'rotate-left',
      label: `Rotate ${what} Counterclockwise`,
      icon: RotateCcw,
      run: () => void rotatePages(doc, selected, -90)
    },
    {
      id: 'rotate-right',
      label: `Rotate ${what} Clockwise`,
      icon: RotateCw,
      shortcut: displayShortcut('Mod+Shift+R'),
      run: () => void rotatePages(doc, selected, 90)
    },
    {
      id: 'duplicate',
      label: `Duplicate ${what}`,
      icon: Copy,
      run: () => void duplicatePages(doc, selected)
    },
    {
      id: 'delete',
      label: `Delete ${what}`,
      icon: Trash2,
      danger: true,
      shortcut: 'Delete',
      disabled: n >= doc.pageCount,
      run: () => void deletePages(doc, selected)
    },
    { id: 'sep1', label: '', separator: true },
    { id: 'insert-before', label: 'Insert Before', icon: FileInput, submenu: insertItems(doc, first) },
    { id: 'insert-after', label: 'Insert After', icon: FilePlus2, submenu: insertItems(doc, last + 1) },
    {
      id: 'extract',
      label: `Extract ${what}…`,
      icon: FileOutput,
      run: () => void openExtractDialog(doc, selected)
    },
    {
      id: 'replace',
      label: `Replace ${what}…`,
      icon: Replace,
      run: () => void openReplaceFlow(doc, selected)
    },
    { id: 'split', label: 'Split Document…', icon: Scissors, run: () => void openSplitDialog(doc) },
    { id: 'labels', label: 'Page Labels…', icon: Hash, run: () => void openLabelsDialog(doc, selected) }
  ]
}

/** Right-click menu on empty space in the grid. */
export function backgroundMenu(doc: DocumentModel, gap: number): ContextMenuItem[] {
  return [
    {
      id: 'select-all',
      label: 'Select All Pages',
      icon: Files,
      shortcut: displayShortcut('Mod+A'),
      run: () => selectBy(doc, 'all')
    },
    { id: 'insert', label: 'Insert Pages Here', icon: FilePlus2, submenu: insertItems(doc, gap) },
    { id: 'labels', label: 'Page Labels…', icon: Hash, run: () => void openLabelsDialog(doc, []) },
    { id: 'sep', label: '', separator: true },
    { id: 'close', label: 'Close Organize Pages', run: () => openToolGroup(null) }
  ]
}
