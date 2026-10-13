import { FilePenLine, Pencil, TextCursorInput, Trash, Type } from 'lucide-react'
import {
  defineFeature,
  getActiveDoc,
  getLoadedText,
  isOverText,
  openToolGroup,
  rangeRects,
  setTool,
  showError,
  useApp,
  type CommandContext,
  type DocumentModel,
  type Selection
} from '@renderer/sdk'
import { EditLayer } from './EditLayer'
import { EditPanel, EditToolbar } from './EditPanel'
import { EditTextGlobal } from './Global'
import { activeSession, commitSession, deleteBox, editTextAt } from './store'
import './edit-text.css'

function openEdit(tool: 'edit.content' | 'edit.addText') {
  if (useApp.getState().toolGroupId !== 'edit') openToolGroup('edit')
  if (getActiveDoc()) setTool(tool)
}

/** "Edit text" on the floating bar of selected text: opens the paragraph with that text selected. */
async function editSelection(doc: DocumentModel, sel: Extract<Selection, { kind: 'text' }>) {
  const range = sel.ranges[0]
  if (!range) return
  try {
    const t = await doc.pageText(range.page)
    const rects = rangeRects(t, range.start, Math.min(range.end, t.text.length))
    if (!rects.length) return
    const r = rects[0]
    const text = sel.ranges.length === 1 ? t.text.slice(range.start, range.end) : undefined
    await editTextAt(doc, range.page, [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], text)
  } catch (err) {
    showError(err, 'Could not edit this text')
  }
}

/** True when keyboard focus is not in a text field or the text editor. */
function focusIsFree(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return true
  if (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return false
  return !el.closest('[data-fc-edit-text-editor]')
}

export default defineFeature({
  id: 'edit-text',
  toolGroups: [
    {
      id: 'edit',
      label: 'Edit a PDF',
      icon: FilePenLine,
      color: '#d83790',
      description: 'Edit text and images, fix typos, add text',
      order: 20,
      category: 'edit',
      panel: EditPanel,
      defaultTool: 'edit.content',
      homeTile: true,
      keywords: [
        'edit text',
        'change text',
        'fix typo',
        'replace text',
        'font',
        'add text',
        'text box',
        'type on pdf',
        'edit pdf'
      ]
    }
  ],
  tools: [
    {
      id: 'edit.content',
      label: 'Edit text & images',
      icon: TextCursorInput,
      layer: EditLayer,
      toolbar: EditToolbar,
      onDeactivate: () => void commitSession()
    },
    {
      id: 'edit.addText',
      label: 'Add text',
      icon: Type,
      cursor: 'text',
      layer: EditLayer,
      toolbar: EditToolbar,
      onDeactivate: () => void commitSession()
    }
  ],
  commands: [
    {
      id: 'editText.open',
      label: 'Edit a PDF',
      icon: FilePenLine,
      keywords: ['edit pdf', 'edit text'],
      run: () => openEdit('edit.content')
    },
    {
      id: 'editText.editContent',
      label: 'Edit Text & Images',
      icon: TextCursorInput,
      keywords: ['edit text', 'change text', 'fix typo'],
      checked: () => useApp.getState().toolId === 'edit.content',
      run: () => openEdit('edit.content')
    },
    {
      id: 'editText.addText',
      label: 'Add Text',
      icon: Type,
      keywords: ['text box', 'type on pdf', 'add text'],
      checked: () => useApp.getState().toolId === 'edit.addText',
      run: () => openEdit('edit.addText')
    },
    {
      id: 'editText.deleteBox',
      label: 'Delete Text Box',
      icon: Trash,
      shortcut: ['Delete', 'Backspace'],
      hidden: true,
      keepEditing: true,
      enabled: (ctx: CommandContext) => {
        const s = activeSession()
        return !!ctx.doc && !!s && s.status === 'editing' && focusIsFree()
      },
      run: () => deleteBox()
    },
    {
      id: 'editText.finish',
      label: 'Finish Editing Text',
      hidden: true,
      enabled: () => !!activeSession(),
      run: () => commitSession()
    }
  ],
  menus: [
    { menu: 'edit', group: 'editpdf', command: 'editText.editContent', order: 400 },
    { menu: 'edit', group: 'editpdf', command: 'editText.addText', order: 401 },
    { menu: 'tools', group: 'edit', command: 'editText.open', order: 20 },
    { menu: 'tools', group: 'edit', command: 'editText.editContent', order: 21 },
    { menu: 'tools', group: 'edit', command: 'editText.addText', order: 22 }
  ],
  textSelectionActions: [
    {
      id: 'edit-text',
      label: 'Edit text',
      icon: Pencil,
      order: 60,
      run: (doc, sel) => editSelection(doc, sel)
    }
  ],
  pageContextMenu: [
    {
      id: 'edit-text',
      order: 20,
      items: ({ doc, pageIndex, point }) => {
        const t = getLoadedText(doc, pageIndex)
        if (!t || !isOverText(t, point)) return []
        return [
          {
            id: 'edit-text',
            label: 'Edit Text',
            icon: Pencil,
            run: () => void editTextAt(doc, pageIndex, point)
          }
        ]
      }
    }
  ],
  globals: [EditTextGlobal]
})
