import { ChevronDown, ChevronUp, FileOutput, GitCompareArrows, Layers } from 'lucide-react'
import { defineFeature, openToolGroup } from '@renderer/sdk'
import { exportReport, hasResults, stepChange } from './actions'
import { CompareHost } from './CompareHost'
import { ComparePanel } from './ComparePanel'
import { CompareView } from './CompareView'
import { getCompare, setCompare } from './store'
import './compare.css'

export default defineFeature({
  id: 'compare',
  toolGroups: [
    {
      id: 'compare',
      label: 'Compare files',
      icon: GitCompareArrows,
      color: '#c9356c',
      description: 'See the differences between two versions of a PDF',
      order: 160,
      category: 'review',
      homeTile: true,
      requiresDocument: false,
      panel: ComparePanel,
      documentView: CompareView,
      keywords: ['compare', 'diff', 'difference', 'versions', 'changes', 'redline']
    }
  ],
  commands: [
    {
      id: 'compare.open',
      label: 'Compare Files',
      icon: GitCompareArrows,
      requiresDocument: false,
      keywords: ['diff', 'difference', 'versions', 'redline'],
      run: () => openToolGroup('compare')
    },
    {
      id: 'compare.nextChange',
      label: 'Next Change',
      icon: ChevronDown,
      shortcut: 'F7',
      requiresDocument: false,
      enabled: () => hasResults() && !!getCompare().session?.result.changes.length,
      run: () => stepChange(1)
    },
    {
      id: 'compare.prevChange',
      label: 'Previous Change',
      icon: ChevronUp,
      shortcut: 'Shift+F7',
      requiresDocument: false,
      enabled: () => hasResults() && !!getCompare().session?.result.changes.length,
      run: () => stepChange(-1)
    },
    {
      id: 'compare.toggleOverlay',
      label: 'Single Page Overlay',
      icon: Layers,
      requiresDocument: false,
      enabled: hasResults,
      checked: () => getCompare().overlay,
      run: () => setCompare((s) => ({ overlay: !s.overlay }))
    },
    {
      id: 'compare.exportReport',
      label: 'Export Compare Report',
      icon: FileOutput,
      requiresDocument: false,
      enabled: () => !!getCompare().session,
      run: () => exportReport()
    }
  ],
  menus: [
    { menu: 'tools', group: 'compare', command: 'compare.open', order: 160 },
    { menu: 'tools', group: 'compare', command: 'compare.nextChange', order: 161, submenu: 'Compare Results' },
    { menu: 'tools', group: 'compare', command: 'compare.prevChange', order: 162, submenu: 'Compare Results' },
    { menu: 'tools', group: 'compare', command: 'compare.toggleOverlay', order: 163, submenu: 'Compare Results' },
    { menu: 'tools', group: 'compare', command: 'compare.exportReport', order: 164, submenu: 'Compare Results' }
  ],
  globals: [CompareHost]
})
