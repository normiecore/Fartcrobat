import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button, openRightPanel, useActiveDoc, useApp, useDocState, type DocumentModel } from '@renderer/sdk'
import { overallStatus } from '../status'
import { StatusIcon } from './StatusIcon'
import { useDocSignatures, useSigStore, useTrustedSet, validateDocument } from './store'

/**
 * Keeps the validation of a document fresh: on open, after reloads and (debounced) after
 * document-level changes such as saving or clearing a signature.
 */
function useAutoValidate(doc: DocumentModel) {
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const info = useDocState(doc, (s) => s.info)
  const first = useRef(true)
  useEffect(() => {
    const delay = first.current ? 0 : 400
    first.current = false
    const t = setTimeout(() => void validateDocument(doc), delay)
    return () => clearTimeout(t)
  }, [doc, docVersion, info])
}

function DocValidator({ doc }: { doc: DocumentModel }) {
  useAutoValidate(doc)
  return null
}

/** Always mounted: validates the active document (also in Read mode, where no toolbar shows). */
export function ActiveDocValidator() {
  const doc = useActiveDoc()
  return doc ? <DocValidator key={doc.id} doc={doc} /> : null
}

/**
 * Acrobat's document message bar ("Signed and all signatures are valid."), shown as a full-width
 * row under the document toolbar. Rendered from a document-toolbar slot into the toolbar row.
 */
export function SignatureMessageBar({ doc }: { doc: DocumentModel }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const { report } = useDocSignatures(doc)
  const trusted = useTrustedSet()
  const hidden = useSigStore((s) => !!s.barHidden[doc.id])
  const panelOpen = useApp((s) => s.rightPanelId === 'signatures')
  useLayoutEffect(() => {
    setHost((anchor.current?.closest('.shell-doctoolbar') as HTMLElement | null) ?? null)
  }, [])
  const overall = overallStatus(report, trusted)
  const bar =
    overall && !hidden ? (
      <div className={`fc-digital-signatures-bar is-${overall.level}`} role="status" aria-live="polite">
        <StatusIcon level={overall.level} size={18} />
        <span className="fc-digital-signatures-bar-text">{overall.message}</span>
        <Button size="sm" variant={panelOpen ? 'quiet' : 'secondary'} onClick={() => openRightPanel('signatures')}>
          Signature Panel
        </Button>
        <button
          className="ui-icon-btn"
          aria-label="Hide message"
          title="Hide message"
          onClick={() => useSigStore.setState((s) => ({ barHidden: { ...s.barHidden, [doc.id]: true } }))}
        >
          <X size={14} />
        </button>
      </div>
    ) : null
  return (
    <>
      <span ref={anchor} className="fc-digital-signatures-anchor" aria-hidden />
      {bar && host ? createPortal(bar, host) : null}
    </>
  )
}
