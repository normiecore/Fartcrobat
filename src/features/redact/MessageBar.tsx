import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert, X } from 'lucide-react'
import { Button, IconButton, registry, useActiveDoc, useApp, type DocumentModel } from '@renderer/sdk'
import { openRedactPanel, pagesPhrase, plural } from './actions'
import { applyRedactions } from './dialogs'
import { forgetDoc, useMarks, useRedactUi } from './store'

/** Document message bar under the document toolbar: "n redaction marks are not applied yet — Apply". */
function Bar({ doc }: { doc: DocumentModel }) {
  const marks = useMarks(doc)
  const dismissedAt = useRedactUi((s) => s.barDismissed[doc.id])
  const readMode = useApp((s) => s.readMode)
  const docView = useApp((s) => !!registry.toolGroups.find((g) => g.id === s.toolGroupId)?.documentView)
  const [host, setHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setHost(document.querySelector<HTMLElement>('.shell-docarea'))
  }, [readMode, docView])

  const n = marks.length
  if (!n || dismissedAt === n || readMode || docView || !host?.isConnected) return null
  const pages = pagesPhrase(
    marks.map((m) => m.page),
    doc.pageCount
  )
  return createPortal(
    <div className="fc-redact-bar" role="region" aria-label="Redaction marks">
      <div className="fc-redact-bar-main">
        <ShieldAlert size={16} className="fc-redact-bar-icon" />
        <span className="fc-redact-bar-text">
          <b>{plural(n, 'redaction mark')}</b> on {pages}. Nothing is removed until you apply {n === 1 ? 'it' : 'them'}.
        </span>
      </div>
      <div className="fc-redact-bar-actions">
        <Button size="sm" variant="secondary" onClick={() => openRedactPanel('main')}>
          Review
        </Button>
        <Button size="sm" variant="danger" onClick={() => void applyRedactions(doc)}>
          Apply
        </Button>
        <IconButton
          icon={X}
          size={16}
          label="Close the message bar"
          onClick={() => useRedactUi.setState((s) => ({ barDismissed: { ...s.barDismissed, [doc.id]: n } }))}
        />
      </div>
    </div>,
    host
  )
}

/** Mounted once: shows the message bar of the active document and forgets closed documents. */
export function RedactMessageBar() {
  const doc = useActiveDoc()
  const docIds = useApp((s) => s.docs.map((d) => d.id).join(','))
  useEffect(() => {
    // drop the state of closed documents
    const open = new Set(docIds.split(',').filter(Boolean))
    const known = new Set([...Object.keys(useRedactUi.getState().marks), ...Object.keys(useRedactUi.getState().find)])
    for (const id of known) if (!open.has(id)) forgetDoc(id)
  }, [docIds])
  return doc ? <Bar key={doc.id} doc={doc} /> : null
}
