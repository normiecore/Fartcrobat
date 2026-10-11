import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronFirst,
  ChevronLast,
  Columns2,
  Copy,
  FileText,
  FolderOpen,
  Info,
  Keyboard,
  Maximize,
  MousePointer2,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings,
  StretchHorizontal,
  Undo2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { PageLayoutMode } from '@shared/types'
import { defineFeature, type CommandContext, type CommandDefinition, type MenuContribution } from '../app/registry'
import { getActiveDoc, useApp } from '../app/store'
import {
  activateDocument,
  closeAllDocuments,
  closeDocument,
  openFileDialog,
  openPaths,
  quitApp,
  saveDocument,
  setTool
} from '../app/actions'
import { invoke, isMac } from '../platform'
import { nextZoomStep, spreadIndexOf, spreads } from '../viewer/layout'
import { copySelection } from '../viewer/layers/TextSelectionLayer'
import { getLoadedText, loadText } from '../viewer/layers/textSync'
import { confirm, prompt } from '../ui/dialogs'
import { coreTools } from './tools'
import { openAbout, openPreferences, openShortcuts } from './dialogs'

const doc = (ctx: CommandContext) => ctx.doc!

function setLayout(ctx: CommandContext, layout: PageLayoutMode) {
  doc(ctx).set({ layout })
}

function step(ctx: CommandContext, dir: 1 | -1) {
  const d = doc(ctx)
  const s = d.state
  const rows = spreads(d.pageCount, s.layout, s.coverPage)
  const ri = spreadIndexOf(rows, s.currentPage)
  const next = rows[Math.max(0, Math.min(rows.length - 1, ri + dir))]
  if (next) d.view?.goToPage(next[0])
}

async function selectAll(ctx: CommandContext) {
  const d = doc(ctx)
  const ranges = []
  for (let p = 0; p < d.pageCount; p++) {
    const t = getLoadedText(d, p) ?? (await loadText(d, p))
    if (t.text.length) ranges.push({ page: p, start: 0, end: t.text.length })
  }
  d.setSelection({ kind: 'text', ranges })
}

const commands: CommandDefinition[] = [
  // ---- File
  { id: 'file.open', label: 'Open…', icon: FolderOpen, shortcut: 'Mod+O', requiresDocument: false, run: () => openFileDialog() },
  {
    id: 'file.save',
    label: 'Save',
    icon: Save,
    shortcut: 'Mod+S',
    run: async (ctx) => {
      await saveDocument(doc(ctx))
    }
  },
  {
    id: 'file.saveAs',
    label: 'Save As…',
    shortcut: 'Mod+Shift+S',
    run: async (ctx) => {
      await saveDocument(doc(ctx), { saveAs: true })
    }
  },
  {
    id: 'file.revert',
    label: 'Revert',
    enabled: (ctx) => !!ctx.doc?.state.filePath && ctx.doc.state.dirty,
    run: async (ctx) => {
      const d = doc(ctx)
      const path = d.state.filePath!
      if (!(await confirm({ title: 'Revert', message: `Discard all changes to “${d.state.title}” since it was last saved?`, confirmLabel: 'Revert', danger: true }))) return
      d.set({ dirty: false })
      d.engine.terminate()
      useApp.setState((s) => ({ docs: s.docs.filter((x) => x.id !== d.id) }))
      await openPaths([path])
    }
  },
  { id: 'file.close', label: 'Close', icon: X, shortcut: 'Mod+W', run: (ctx) => void closeDocument(doc(ctx)) },
  { id: 'file.closeAll', label: 'Close All', shortcut: 'Mod+Shift+W', run: () => void closeAllDocuments() },
  {
    id: 'file.showInFolder',
    label: isMac ? 'Reveal in Finder' : 'Show in Folder',
    enabled: (ctx) => !!ctx.doc?.state.filePath,
    run: (ctx) => void invoke('shell:showItemInFolder', doc(ctx).state.filePath!)
  },
  { id: 'file.newWindow', label: 'New Window', shortcut: 'Mod+Shift+N', requiresDocument: false, run: () => void invoke('window:new') },
  { id: 'app.quit', label: isMac ? 'Quit Fartcrobat' : 'Exit', shortcut: 'Mod+Q', requiresDocument: false, run: () => quitApp() },
  { id: 'app.preferences', label: 'Preferences…', icon: Settings, shortcut: 'Mod+K', requiresDocument: false, run: () => openPreferences(), keywords: ['settings', 'options'] },

  // ---- Edit
  {
    id: 'edit.undo',
    label: (ctx) => (ctx.doc?.state.journal.undoLabel ? `Undo ${ctx.doc.state.journal.undoLabel}` : 'Undo'),
    icon: Undo2,
    shortcut: 'Mod+Z',
    enabled: (ctx) => !!ctx.doc?.state.journal.canUndo,
    run: (ctx) => doc(ctx).undo()
  },
  {
    id: 'edit.redo',
    label: (ctx) => (ctx.doc?.state.journal.redoLabel ? `Redo ${ctx.doc.state.journal.redoLabel}` : 'Redo'),
    icon: Redo2,
    shortcut: 'Mod+Shift+Z',
    enabled: (ctx) => !!ctx.doc?.state.journal.canRedo,
    run: (ctx) => doc(ctx).redo()
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    icon: Copy,
    shortcut: 'Mod+C',
    enabled: (ctx) => ctx.doc?.state.selection.kind === 'text',
    run: (ctx) => copySelection(doc(ctx))
  },
  { id: 'edit.selectAll', label: 'Select All', shortcut: 'Mod+A', run: (ctx) => selectAll(ctx) },
  { id: 'edit.deselect', label: 'Deselect All', shortcut: 'Mod+Shift+A', run: (ctx) => doc(ctx).clearSelection() },
  {
    id: 'edit.find',
    label: 'Find…',
    icon: Search,
    shortcut: 'Mod+F',
    run: async (ctx) => {
      useApp.setState({ findBarOpen: true, readMode: false })
      const text = await doc(ctx).selectedText()
      if (text && text.length < 80 && !text.includes('\n')) void doc(ctx).search(text)
      window.dispatchEvent(new Event('fartcrobat:focus-find'))
    }
  },
  { id: 'edit.findNext', label: 'Find Next', shortcut: ['F3', 'Mod+G'], enabled: (ctx) => !!ctx.doc?.state.search.hits.length, run: (ctx) => doc(ctx).nextHit(1) },
  { id: 'edit.findPrev', label: 'Find Previous', shortcut: ['Shift+F3', 'Mod+Shift+G'], enabled: (ctx) => !!ctx.doc?.state.search.hits.length, run: (ctx) => doc(ctx).nextHit(-1) },

  // ---- View: zoom
  { id: 'view.zoomIn', label: 'Zoom In', icon: ZoomIn, shortcut: ['Mod+=', 'Mod++'], run: (ctx) => doc(ctx).view?.setZoom(nextZoomStep(doc(ctx).state.zoom, 1)) },
  { id: 'view.zoomOut', label: 'Zoom Out', icon: ZoomOut, shortcut: 'Mod+-', run: (ctx) => doc(ctx).view?.setZoom(nextZoomStep(doc(ctx).state.zoom, -1)) },
  { id: 'view.zoomTo', label: 'Zoom To…', shortcut: 'Mod+Y', hidden: true, run: async (ctx) => {
      const v = await prompt({ title: 'Zoom to', label: 'Magnification (%)', initial: String(Math.round(doc(ctx).state.zoom * 100)), validate: (s) => (/^\d+(\.\d+)?$/.test(s.trim()) ? null : 'Enter a number') })
      if (v) doc(ctx).view?.setZoom(parseFloat(v) / 100)
    } },
  { id: 'view.actualSize', label: 'Actual Size', shortcut: 'Mod+1', checked: (ctx) => ctx.doc?.state.zoomMode === 'actual-size', run: (ctx) => doc(ctx).view?.setZoom('actual-size') },
  { id: 'view.fitPage', label: 'Zoom to Page Level', icon: Maximize, shortcut: 'Mod+0', checked: (ctx) => ctx.doc?.state.zoomMode === 'fit-page', run: (ctx) => doc(ctx).view?.setZoom('fit-page') },
  { id: 'view.fitWidth', label: 'Fit Width', icon: StretchHorizontal, shortcut: 'Mod+2', checked: (ctx) => ctx.doc?.state.zoomMode === 'fit-width', run: (ctx) => doc(ctx).view?.setZoom('fit-width') },
  { id: 'view.fitVisible', label: 'Fit Visible', shortcut: 'Mod+3', checked: (ctx) => ctx.doc?.state.zoomMode === 'fit-visible', run: (ctx) => doc(ctx).view?.setZoom('fit-visible') },

  // ---- View: rotation & layout
  { id: 'view.rotateCW', label: 'Rotate View Clockwise', icon: RotateCw, shortcut: 'Mod+Shift+=', run: (ctx) => doc(ctx).set((s) => ({ viewRotation: (((s.viewRotation + 90) % 360) as 0 | 90 | 180 | 270) })) },
  { id: 'view.rotateCCW', label: 'Rotate View Counterclockwise', icon: RotateCcw, shortcut: 'Mod+Shift+-', run: (ctx) => doc(ctx).set((s) => ({ viewRotation: (((s.viewRotation + 270) % 360) as 0 | 90 | 180 | 270) })) },
  { id: 'view.layout.single', label: 'Single Page View', checked: (ctx) => ctx.doc?.state.layout === 'single', run: (ctx) => setLayout(ctx, 'single') },
  { id: 'view.layout.continuous', label: 'Enable Scrolling', checked: (ctx) => ctx.doc?.state.layout === 'continuous', run: (ctx) => setLayout(ctx, 'continuous') },
  { id: 'view.layout.twoPage', label: 'Two Page View', icon: Columns2, checked: (ctx) => ctx.doc?.state.layout === 'two-page', run: (ctx) => setLayout(ctx, 'two-page') },
  { id: 'view.layout.twoPageContinuous', label: 'Two Page Scrolling', checked: (ctx) => ctx.doc?.state.layout === 'two-page-continuous', run: (ctx) => setLayout(ctx, 'two-page-continuous') },
  { id: 'view.coverPage', label: 'Show Cover Page in Two Page View', checked: (ctx) => !!ctx.doc?.state.coverPage, run: (ctx) => doc(ctx).set((s) => ({ coverPage: !s.coverPage })) },
  {
    id: 'view.readMode',
    label: 'Read Mode',
    icon: BookOpen,
    shortcut: 'Mod+H',
    checked: () => useApp.getState().readMode,
    run: () => useApp.setState((s) => ({ readMode: !s.readMode }))
  },
  {
    id: 'view.fullScreen',
    label: 'Full Screen Mode',
    icon: Maximize,
    shortcut: 'Mod+L',
    requiresDocument: false,
    run: async () => {
      const on = !(await invoke('window:isFullScreen'))
      await invoke('window:setFullScreen', on)
      useApp.setState({ fullScreen: on, readMode: on })
    }
  },
  {
    id: 'view.exitModes',
    label: 'Exit Read Mode / Full Screen',
    shortcut: 'Escape',
    hidden: true,
    requiresDocument: false,
    enabled: () => {
      const s = useApp.getState()
      return s.readMode || s.fullScreen || s.toolId !== 'select' || !!getActiveDoc()?.state.selection.kind.match(/text|annotations|custom/)
    },
    run: async (ctx) => {
      const s = useApp.getState()
      if (s.fullScreen) {
        await invoke('window:setFullScreen', false)
        useApp.setState({ fullScreen: false, readMode: false })
      } else if (s.readMode) useApp.setState({ readMode: false })
      else if (s.toolId !== 'select') setTool('select')
      else ctx.doc?.clearSelection()
    }
  },
  {
    id: 'view.toggleToolsPane',
    label: 'Show/Hide Tools Pane',
    shortcut: 'Shift+F4',
    requiresDocument: false,
    run: () => useApp.setState((s) => ({ leftPaneOpen: !s.leftPaneOpen }))
  },
  {
    id: 'view.toggleRightPane',
    label: 'Show/Hide Side Panel',
    shortcut: 'F4',
    run: () => useApp.setState((s) => ({ rightPanelId: s.rightPanelId ? null : 'thumbnails' }))
  },

  // ---- Navigation
  { id: 'nav.first', label: 'First Page', icon: ChevronFirst, shortcut: 'Home', run: (ctx) => doc(ctx).view?.goToPage(0) },
  { id: 'nav.last', label: 'Last Page', icon: ChevronLast, shortcut: 'End', run: (ctx) => doc(ctx).view?.goToPage(doc(ctx).pageCount - 1) },
  { id: 'nav.next', label: 'Next Page', shortcut: ['ArrowRight', 'Mod+PageDown'], enabled: (ctx) => !!ctx.doc && ctx.doc.state.currentPage < ctx.doc.pageCount - 1, run: (ctx) => step(ctx, 1) },
  { id: 'nav.prev', label: 'Previous Page', shortcut: ['ArrowLeft', 'Mod+PageUp'], enabled: (ctx) => !!ctx.doc && ctx.doc.state.currentPage > 0, run: (ctx) => step(ctx, -1) },
  {
    id: 'nav.goTo',
    label: 'Go to Page…',
    shortcut: 'Mod+Shift+P',
    run: async (ctx) => {
      const d = doc(ctx)
      const v = await prompt({
        title: 'Go to page',
        label: `Page number (1–${d.pageCount})`,
        initial: String(d.state.currentPage + 1),
        validate: (s) => {
          const n = parseInt(s, 10)
          return n >= 1 && n <= d.pageCount ? null : `Enter a number between 1 and ${d.pageCount}`
        }
      })
      if (v) d.view?.goToPage(parseInt(v, 10) - 1)
    }
  },
  {
    id: 'nav.back',
    label: 'Previous View',
    icon: ArrowLeft,
    shortcut: 'Alt+ArrowLeft',
    enabled: (ctx) => !!ctx.doc?.history.back.length,
    run: (ctx) => {
      const d = doc(ctx)
      const p = d.history.back.pop()
      if (p === undefined) return
      d.history.forward.push(d.state.currentPage)
      d.view?.goToPage(p, { fromHistory: true })
    }
  },
  {
    id: 'nav.forward',
    label: 'Next View',
    icon: ArrowRight,
    shortcut: 'Alt+ArrowRight',
    enabled: (ctx) => !!ctx.doc?.history.forward.length,
    run: (ctx) => {
      const d = doc(ctx)
      const p = d.history.forward.pop()
      if (p === undefined) return
      d.history.back.push(d.state.currentPage)
      d.view?.goToPage(p, { fromHistory: true })
    }
  },

  // ---- Tools
  { id: 'tools.select', label: 'Selection Tool', icon: MousePointer2, shortcut: 'V', hidden: true, run: () => setTool('select') },
  { id: 'tools.hand', label: 'Hand Tool', shortcut: 'H', hidden: true, run: () => setTool('hand') },
  { id: 'tools.zoom', label: 'Marquee Zoom', shortcut: 'Z', hidden: true, run: () => setTool('zoom') },

  // ---- Window
  {
    id: 'window.nextTab',
    label: 'Next Document',
    shortcut: 'Ctrl+Tab',
    requiresDocument: false,
    run: () => {
      const s = useApp.getState()
      if (!s.docs.length) return
      const i = s.docs.findIndex((d) => d.id === s.activeDocId)
      activateDocument(s.docs[(i + 1) % s.docs.length].id)
    }
  },
  {
    id: 'window.prevTab',
    label: 'Previous Document',
    shortcut: 'Ctrl+Shift+Tab',
    requiresDocument: false,
    run: () => {
      const s = useApp.getState()
      if (!s.docs.length) return
      const i = s.docs.findIndex((d) => d.id === s.activeDocId)
      activateDocument(s.docs[(i - 1 + s.docs.length) % s.docs.length].id)
    }
  },
  { id: 'window.home', label: 'Home', requiresDocument: false, run: () => activateDocument(null) },

  // ---- Help
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard, shortcut: 'Mod+/', requiresDocument: false, run: () => openShortcuts() },
  { id: 'help.defaultApp', label: 'Make Fartcrobat the Default PDF App…', requiresDocument: false, run: () => openPreferences('general') },
  { id: 'help.about', label: 'About Fartcrobat', icon: Info, requiresDocument: false, run: () => openAbout() },
  {
    id: 'help.website',
    label: 'Fartcrobat on GitHub',
    icon: FileText,
    requiresDocument: false,
    run: () => void invoke('shell:openExternal', 'https://github.com/normiecore/fartcrobat')
  },
  {
    id: 'app.commandPalette',
    label: 'Find Text or Tools',
    icon: Search,
    shortcut: 'Mod+Shift+K',
    requiresDocument: false,
    hidden: true,
    run: () => useApp.setState({ paletteOpen: true })
  }
]

const m = (menu: MenuContribution['menu'], group: string, ids: string[], order = 0, submenu?: string): MenuContribution[] =>
  ids.map((command, i) => ({ menu, group, command, order: order + i, submenu }))

const menus: MenuContribution[] = [
  ...m('file', 'open', ['file.open'], 0),
  ...m('file', 'save', ['file.save', 'file.saveAs', 'file.revert'], 100),
  ...m('file', 'close', ['file.close', 'file.closeAll', 'file.showInFolder'], 800),
  ...m('file', 'window', ['file.newWindow'], 900),
  ...(isMac ? [] : m('file', 'prefs', ['app.preferences'], 950)),
  ...(isMac ? [] : m('file', 'quit', ['app.quit'], 999)),
  ...m('edit', 'history', ['edit.undo', 'edit.redo'], 0),
  ...m('edit', 'clipboard', ['edit.copy', 'edit.selectAll', 'edit.deselect'], 100),
  ...m('edit', 'find', ['edit.find', 'edit.findNext', 'edit.findPrev'], 300),
  ...m('view', 'zoom', ['view.zoomIn', 'view.zoomOut', 'view.actualSize', 'view.fitPage', 'view.fitWidth', 'view.fitVisible'], 0, 'Zoom'),
  ...m('view', 'rotate', ['view.rotateCW', 'view.rotateCCW'], 100, 'Rotate View'),
  ...m('view', 'nav', ['nav.first', 'nav.prev', 'nav.next', 'nav.last', 'nav.goTo', 'nav.back', 'nav.forward'], 200, 'Page Navigation'),
  ...m('view', 'layout', ['view.layout.single', 'view.layout.continuous', 'view.layout.twoPage', 'view.layout.twoPageContinuous', 'view.coverPage'], 300, 'Page Display'),
  ...m('view', 'modes', ['view.readMode', 'view.fullScreen', 'view.toggleToolsPane', 'view.toggleRightPane'], 400),
  ...m('window', 'tabs', ['window.home', 'window.nextTab', 'window.prevTab'], 0),
  ...m('help', 'help', ['help.shortcuts', 'help.defaultApp', 'help.website', 'help.about'], 0)
]

/** Name used as the author of new comments: Preferences, else the OS account name. */
export function authorName(): string {
  const s = useApp.getState()
  return s.prefs.authorName.trim() || s.systemInfo?.userName || 'Author'
}

export const coreFeature = defineFeature({
  id: 'core',
  onDocumentOpen: (d) => {
    void d.ops<typeof import('@engine/ops/annots').default>('annots').setAuthor(authorName())
  },
  commands,
  menus,
  tools: coreTools,
  quickTools: [{ id: 'select', order: 0 }]
})
