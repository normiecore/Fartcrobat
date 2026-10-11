import { useEffect } from 'react'
import { ChevronDown, ChevronUp, Minimize2 } from 'lucide-react'
import { registry } from '../app/registry'
import { useActiveDoc, useApp } from '../app/store'
import { openPaths } from '../app/actions'
import { pathForFile } from '../platform'
import { useDocState, type DocumentModel } from '../document/DocumentModel'
import { Viewer } from '../viewer/Viewer'
import { TopBar } from './TopBar'
import { LeftPane } from './LeftPane'
import { DocToolbar } from './DocToolbar'
import { QuickToolbar } from './QuickToolbar'
import { RightRail } from './RightRail'
import { FindBar } from './FindBar'
import { Home } from './Home'
import { CommandPalette } from './CommandPalette'
import { ContextMenuHost, DialogHost, ProgressHost, ToastHost } from './Hosts'

function ReadModeBar({ doc }: { doc: DocumentModel }) {
  const current = useDocState(doc, (s) => s.currentPage)
  const count = useDocState(doc, (s) => s.info.pageCount)
  return (
    <div className="shell-readbar">
      <button className="ui-icon-btn" aria-label="Previous page" onClick={() => doc.view?.goToPage(current - 1)}>
        <ChevronUp size={16} />
      </button>
      <span>
        {current + 1} / {count}
      </span>
      <button className="ui-icon-btn" aria-label="Next page" onClick={() => doc.view?.goToPage(current + 1)}>
        <ChevronDown size={16} />
      </button>
      <button className="ui-icon-btn" aria-label="Exit read mode" title="Exit read mode (Esc)" onClick={() => useApp.setState({ readMode: false })}>
        <Minimize2 size={16} />
      </button>
    </div>
  )
}

export function AppShell() {
  const doc = useActiveDoc()
  const readMode = useApp((s) => s.readMode)
  const findBarOpen = useApp((s) => s.findBarOpen)
  const leftOpen = useApp((s) => s.leftPaneOpen)

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (e: DragEvent) => {
      // Features (e.g. Organize Pages) may handle drops themselves.
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return
      e.preventDefault()
      const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean)
      if (paths.length) void openPaths(paths)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className={`shell ${readMode ? 'is-read-mode' : ''}`}>
      {!readMode && <TopBar />}
      <div className="shell-main">
        {doc ? (
          <>
            {!readMode && <LeftPane />}
            <div className={`shell-docarea ${leftOpen ? '' : 'is-left-collapsed'}`}>
              {!readMode && <DocToolbar doc={doc} />}
              <div className="shell-viewer-wrap">
                {!readMode && <QuickToolbar />}
                {findBarOpen && <FindBar key={doc.id} doc={doc} />}
                <Viewer key={doc.id} doc={doc} />
                {readMode && <ReadModeBar doc={doc} />}
              </div>
            </div>
            {!readMode && <RightRail />}
          </>
        ) : (
          <Home />
        )}
      </div>
      {registry.globals.map((G, i) => (
        <G key={i} />
      ))}
      <CommandPalette />
      <ContextMenuHost />
      <DialogHost />
      <ProgressHost />
      <ToastHost />
    </div>
  )
}
