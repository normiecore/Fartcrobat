import { EyeOff, Files, ScanSearch, ShieldCheck, ShieldX, SlidersHorizontal, TextCursorInput, Trash2 } from 'lucide-react'
import { defineFeature, setTool, type CommandContext, type MenuContribution } from '@renderer/sdk'
import './redact.css'
import { deleteMarks, markRanges, openRedactPanel, watchForSave } from './actions'
import { applyRedactions, openPageRangeDialog, openSanitizeDialog } from './dialogs'
import { contextItemsAt, MarkLayer, MarkToolbar } from './MarkTool'
import { MarksLayer } from './MarksLayer'
import { RedactMessageBar } from './MessageBar'
import { RedactPanel } from './Panel'
import { openPropertiesDialog, RedactionSettings } from './PropertiesForm'
import { loadProps, marksOf, refreshMarks, selectedMarkIds, useRedactUi } from './store'

const doc = (ctx: CommandContext) => ctx.doc!

const menus: MenuContribution[] = [
  { menu: 'tools', submenu: 'Redact', group: 'redact', command: 'redact.markTool', order: 600 },
  { menu: 'tools', submenu: 'Redact', group: 'redact', command: 'redact.findText', order: 601 },
  { menu: 'tools', submenu: 'Redact', group: 'redact', command: 'redact.markPages', order: 602 },
  { menu: 'tools', submenu: 'Redact', group: 'redact', command: 'redact.apply', order: 603 },
  { menu: 'tools', submenu: 'Redact', group: 'redact', command: 'redact.sanitize', order: 604 },
  { menu: 'tools', submenu: 'Redact', group: 'redact', command: 'redact.properties', order: 605 }
]

export default defineFeature({
  id: 'redact',
  commands: [
    {
      id: 'redact.markTool',
      label: 'Redact Text & Images',
      icon: TextCursorInput,
      keywords: ['redact', 'redaction', 'black out', 'mark for redaction', 'censor', 'hide'],
      run: () => {
        openRedactPanel('main')
        setTool('redact.mark')
      }
    },
    {
      id: 'redact.findText',
      label: 'Find Text & Redact…',
      icon: ScanSearch,
      keywords: ['redact', 'search and remove', 'patterns', 'email', 'phone', 'social security', 'credit card'],
      run: () => openRedactPanel('find')
    },
    {
      id: 'redact.markPages',
      label: 'Mark Page Range for Redaction…',
      icon: Files,
      keywords: ['redact', 'whole page'],
      run: (ctx) => openPageRangeDialog(doc(ctx))
    },
    {
      id: 'redact.apply',
      label: 'Apply Redactions…',
      icon: ShieldCheck,
      keywords: ['redact', 'redaction'],
      enabled: (ctx) => !!ctx.doc && marksOf(ctx.doc).length > 0,
      run: (ctx) => applyRedactions(doc(ctx))
    },
    {
      id: 'redact.sanitize',
      label: 'Remove Hidden Information…',
      icon: EyeOff,
      keywords: ['sanitize', 'sanitise', 'metadata', 'redact', 'hidden text', 'privacy', 'clean'],
      run: (ctx) => openSanitizeDialog(doc(ctx))
    },
    {
      id: 'redact.properties',
      label: 'Redaction Properties…',
      icon: SlidersHorizontal,
      requiresDocument: false,
      keywords: ['redact', 'overlay text', 'redaction code', 'fill colour'],
      run: (ctx) => openPropertiesDialog(ctx.doc)
    },
    {
      id: 'redact.deleteSelected',
      label: 'Delete Redaction Mark',
      icon: Trash2,
      shortcut: ['Delete', 'Backspace'],
      hidden: true,
      enabled: (ctx) => selectedMarkIds(ctx.doc).length > 0,
      run: (ctx) => deleteMarks(doc(ctx), selectedMarkIds(ctx.doc))
    }
  ],
  menus,
  tools: [
    {
      id: 'redact.mark',
      label: 'Redact text & images',
      icon: TextCursorInput,
      cursor: 'crosshair',
      layer: MarkLayer,
      toolbar: MarkToolbar,
      onActivate: (ctx) => {
        if (ctx.doc) void refreshMarks(ctx.doc)
      },
      onDeactivate: () => useRedactUi.setState({ hover: null })
    }
  ],
  toolGroups: [
    {
      id: 'redact',
      label: 'Redact a PDF',
      icon: ShieldX,
      color: '#d7373f',
      description: 'Permanently remove sensitive text, images and hidden information',
      order: 120,
      category: 'protect',
      homeTile: true,
      panel: RedactPanel,
      defaultTool: 'redact.mark',
      keywords: ['redact', 'redaction', 'black out', 'sanitize', 'remove hidden information']
    }
  ],
  pageLayers: [{ id: 'redact-marks', order: 45, component: MarksLayer }],
  textSelectionActions: [
    {
      id: 'redact',
      label: 'Mark for redaction',
      icon: ShieldX,
      order: 80,
      run: async (d, sel) => {
        const marks = await markRanges(d, sel.ranges)
        if (marks.length) d.clearSelection()
      }
    }
  ],
  pageContextMenu: [
    {
      id: 'redact',
      order: 80,
      items: ({ doc: d, pageIndex, point }) => contextItemsAt(d, marksOf(d), pageIndex, point)
    }
  ],
  settings: [{ id: 'redaction', label: 'Redaction', order: 60, component: RedactionSettings }],
  globals: [RedactMessageBar],
  onDocumentOpen: (d) => {
    void loadProps()
    watchForSave(d)
  }
})
