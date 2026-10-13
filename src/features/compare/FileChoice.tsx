import { useEffect } from 'react'
import { ChevronDown, Clock, FileText, FolderOpen, Loader2 } from 'lucide-react'
import { Button, DropdownMenu, invoke, pathForFile, useApp, type ContextMenuItem } from '@renderer/sdk'
import { browse, chooseFile, chooseTab } from './sources'
import { useCompare, type Side } from './store'

export const SIDE_LABEL: Record<Side, string> = { old: 'Old file', new: 'New file' }

/** Menu of places to pick a file from: open documents, recent files, Browse…. */
export function fileMenuItems(side: Side): ContextMenuItem[] {
  const { docs, recent } = useApp.getState()
  const openPaths = new Set(docs.map((d) => d.state.filePath).filter(Boolean))
  const recentFiles = recent.filter((r) => !openPaths.has(r.path)).slice(0, 12)
  return [
    {
      id: 'open',
      label: 'Open documents',
      icon: FileText,
      disabled: !docs.length,
      submenu: docs.length
        ? docs.map((d) => ({ id: d.id, label: d.state.title, icon: FileText, run: () => chooseTab(side, d) }))
        : undefined
    },
    {
      id: 'recent',
      label: 'Recent files',
      icon: Clock,
      disabled: !recentFiles.length,
      submenu: recentFiles.length
        ? recentFiles.map((r) => ({ id: r.path, label: r.name, icon: FileText, run: () => void chooseFile(side, r.path) }))
        : undefined
    },
    { id: 'sep', label: '', separator: true },
    { id: 'browse', label: 'Browse…', icon: FolderOpen, run: () => void browse(side) }
  ]
}

/** "Choose file" button with the file menu. */
export function ChooseFileButton({ side, variant = 'secondary', size = 'sm' }: { side: Side; variant?: 'secondary' | 'primary' | 'quiet'; size?: 'sm' | 'md' }) {
  const slot = useCompare((s) => s.slots[side])
  useEffect(() => {
    invoke('recent:list')
      .then((recent) => useApp.setState({ recent }))
      .catch(() => {})
  }, [])
  return (
    <DropdownMenu
      items={() => fileMenuItems(side)}
      trigger={(p) => (
        <Button
          variant={variant}
          size={size}
          disabled={slot.loading}
          aria-label={`${slot.doc ? 'Change' : 'Choose'} ${SIDE_LABEL[side].toLowerCase()}`}
          aria-haspopup="menu"
          {...p}
        >
          {slot.doc ? 'Change…' : 'Choose file…'}
          <ChevronDown size={14} className="fc-compare-btn-caret" />
        </Button>
      )}
    />
  )
}

/** Props that make an element accept a dropped file for one side. */
export function dropProps(side: Side, onActive: (on: boolean) => void) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      onActive(true)
    },
    onDragLeave: () => onActive(false),
    onDrop: (e: React.DragEvent) => {
      onActive(false)
      const file = e.dataTransfer.files[0]
      if (!file) return
      // Stop the window from opening the file as a tab.
      e.preventDefault()
      const path = pathForFile(file)
      if (path) void chooseFile(side, path)
    }
  }
}

export function SlotStatus({ side }: { side: Side }) {
  const slot = useCompare((s) => s.slots[side])
  if (slot.loading)
    return (
      <span className="fc-compare-slot-meta">
        <Loader2 size={12} className="fc-compare-spin" /> Opening…
      </span>
    )
  if (!slot.doc) return <span className="fc-compare-slot-meta">No file chosen</span>
  const n = slot.doc.pageCount
  return (
    <span className="fc-compare-slot-meta" title={slot.path ?? slot.name}>
      {n} page{n === 1 ? '' : 's'}
      {slot.path ? '' : ' · not saved'}
    </span>
  )
}
