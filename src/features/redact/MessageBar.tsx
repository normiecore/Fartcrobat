import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert, X } from 'lucide-react'
import { Button, IconButton, registry, useActiveDoc, useApp, type DocumentModel } from '@renderer/sdk'
import { openRedactPanel, plural } from './actions'
import { applyRedactions } from './dialogs'
import { forgetDoc, useMarks, useRedactUi } from './store'

/** The element around the page viewer (positioned), once the viewer is mounted. */
function useViewerHost(doc: DocumentModel): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    let timer = 0
    const check = () => {
      const el = doc.view?.getViewportElement()?.parentElement ?? null
      setHost((cur) => (cur === el ? cur : el))
    }
    check()
    // the viewer can remount (tab switch, Organize Pages...): re-check now and then
    timer = window.setInterval(check, 500)
    return () => window.clearInterval(timer)
  }, [doc])
  return host
}

function Bar({ doc }: { doc: DocumentModel }) {
  const marks = useMarks(doc)
  const dismissedAt = useRedactUi((s) => s.barDismissed[doc.id])
  const host = useViewerHost(doc)
  const n = marks.length
  if (!n || dismissedAt === n || !host) return null
  const pages = new Set(marks.map((m) => m.page)).size
  return createPortal(
    <div className="fc-redact-bar" role="status" aria-label="Redaction marks">
      <ShieldAlert size={18} className="fc-redact-bar-icon" />
      <span className="fc-redact-bar-text" title="The marked content is still in the document until you apply the marks.">
        <b>{plural(n, 'redaction mark')}</b> {n === 1 ? 'is' : 'are'} not applied yet{pages > 1 ? ` (${pages} pages)` : ''}
      </span>
      <Button size="sm" variant="quiet" onClick={() => openRedactPanel('main')}>
        Review
      </Button>
      <Button size="sm" variant="danger" onClick={() => void applyRedactions(doc)}>
        Apply
      </Button>
      <IconButton
        icon={X}
        size={16}
        label="Hide this message"
        onClick={() => useRedactUi.setState((s) => ({ barDismissed: { ...s.barDismissed, [doc.id]: n } }))}
      />
    </div>,
    host
  )
}

/** Document message bar "n redaction marks — Apply" (mounted once, follows the active document). */
export function RedactMessageBar() {
  const doc = useActiveDoc()
  const docIds = useApp((s) => s.docs.map((d) => d.id).join(','))
  useEffect(() => {
    // drop the state of closed documents
    const open = new Set(docIds.split(',').filter(Boolean))
    const known = new Set([...Object.keys(useRedactUi.getState().marks), ...Object.keys(useRedactUi.getState().find)])
    for (const id of known) if (!open.has(id)) forgetDoc(id)
  }, [docIds])
  const readMode = useApp((s) => s.readMode)
  const documentView = useApp((s) => !!registry.toolGroups.find((g) => g.id === s.toolGroupId)?.documentView)
  if (!doc || readMode || documentView) return null
  return <Bar key={doc.id} doc={doc} />
}
