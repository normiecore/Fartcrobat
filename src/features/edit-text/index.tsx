import { FilePenLine, TextCursorInput, Trash, Type } from 'lucide-react'
import { defineFeature, getActiveDoc, openToolGroup, setTool, useApp, type CommandContext } from '@renderer/sdk'
import { EditLayer } from './EditLayer'
import { EditPanel, EditToolbar } from './EditPanel'
import { EditTextGlobal } from './Global'
import { activeSession, commitSession, deleteBox } from './store'
import './edit-text.css'

function openEdit(tool: 'edit.content' | 'edit.addText') {
  if (useApp.getState().toolGroupId !== 'edit') openToolGroup('edit')
  if (getActiveDoc()) setTool(tool)
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
      keywords: ['edit text', 'change text', 'fix typo', 'replace text', 'font', 'add text', 'text box', 'type on pdf', 'edit pdf']
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
    { menu: 'tools', group: 'edit', command: 'editText.open', order: 20 },
    { menu: 'tools', group: 'edit', command: 'editText.editContent', order: 21 },
    { menu: 'tools', group: 'edit', command: 'editText.addText', order: 22 }
  ],
  globals: [EditTextGlobal]
})
