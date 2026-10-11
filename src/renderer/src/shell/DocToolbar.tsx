import { Hand, MousePointer2, Redo2, Save, Search, Undo2, ZoomIn } from 'lucide-react'
import { registry } from '../app/registry'
import { useApp } from '../app/store'
import { runCommand, displayShortcut } from '../app/commands'
import { setTool } from '../app/actions'
import { useDocState, type DocumentModel } from '../document/DocumentModel'
import { IconButton } from '../ui/Button'
import { ZOOM_STEPS } from '../viewer/layout'
import type { ZoomMode } from '@shared/types'

const ZOOM_OPTIONS: { value: string; label: string }[] = [
  { value: 'fit-page', label: 'Fit page' },
  { value: 'fit-width', label: 'Fit width' },
  { value: 'actual-size', label: 'Actual size' },
  ...ZOOM_STEPS.filter((z) => z >= 0.25 && z <= 8).map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` }))
]

function ZoomSelect({ doc }: { doc: DocumentModel }) {
  const zoom = useDocState(doc, (s) => s.zoom)
  const mode = useDocState(doc, (s) => s.zoomMode)
  const value = mode !== 'custom' ? mode : String(ZOOM_STEPS.find((z) => Math.abs(z - zoom) < 0.001) ?? 'custom')
  return (
    <select
      className="ui-input ui-select shell-zoom-select"
      aria-label="Zoom"
      value={value}
      onChange={(e) => {
        const v = e.target.value
        if (/^[a-z-]+$/.test(v)) doc.view?.setZoom(v as ZoomMode)
        else doc.view?.setZoom(parseFloat(v))
      }}
    >
      {value === 'custom' && <option value="custom">{Math.round(zoom * 100)}%</option>}
      {ZOOM_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {mode !== 'custom' && o.value === mode ? `${o.label} (${Math.round(zoom * 100)}%)` : o.label}
        </option>
      ))}
    </select>
  )
}

export function DocToolbar({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const journal = useDocState(doc, (s) => s.journal)
  const busy = useDocState(doc, (s) => s.busy)
  const tool = registry.tools.get(toolId)
  const ToolBar = tool?.toolbar
  return (
    <div className="shell-doctoolbar" role="toolbar" aria-label="Document toolbar">
      <div className="shell-doctoolbar-left">
        <IconButton icon={Save} label="Save" shortcut={displayShortcut('Mod+S')} onClick={() => void runCommand('file.save')} />
        <IconButton
          icon={Undo2}
          label={journal.undoLabel ? `Undo ${journal.undoLabel}` : 'Undo'}
          shortcut={displayShortcut('Mod+Z')}
          disabled={!journal.canUndo}
          onClick={() => void runCommand('edit.undo')}
        />
        <IconButton
          icon={Redo2}
          label={journal.redoLabel ? `Redo ${journal.redoLabel}` : 'Redo'}
          shortcut={displayShortcut('Mod+Shift+Z')}
          disabled={!journal.canRedo}
          onClick={() => void runCommand('edit.redo')}
        />
        <span className="shell-sep" />
        <IconButton icon={MousePointer2} label="Select" shortcut="V" active={toolId === 'select'} onClick={() => setTool('select')} />
        <IconButton icon={Hand} label="Hand" shortcut="H" active={toolId === 'hand'} onClick={() => setTool('hand')} />
        <IconButton icon={ZoomIn} label="Marquee zoom" shortcut="Z" active={toolId === 'zoom'} onClick={() => setTool('zoom')} />
        <ZoomSelect doc={doc} />
        {registry.docToolbar.map((item) => (
          <item.component key={item.id} doc={doc} />
        ))}
      </div>
      <div className="shell-doctoolbar-right">
        {busy && <span className="shell-busy">{busy}</span>}
        <IconButton icon={Search} label="Find" shortcut={displayShortcut('Mod+F')} onClick={() => void runCommand('edit.find')} />
      </div>
      {ToolBar && (
        <div className="shell-tooloptions">
          <ToolBar doc={doc} />
        </div>
      )}
    </div>
  )
}
