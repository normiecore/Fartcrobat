/**
 * "This document appears to be scanned" message bar, shown under the document toolbar when a
 * document that looks like a scan (pages covered by images, no text) is opened.
 */
import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { ScanText, X } from 'lucide-react'
import { Button, IconButton, openToolGroup, registry, useActiveDoc, useApp, type DocumentModel } from '@renderer/sdk'
import type ocrOps from './engine'
import { loadOcrSettings, useOcrSettings } from './settings'

const P = 'fc-ocr'

interface ScanBarState {
  /** Documents (by id) detected as scanned whose bar has not been dismissed. */
  scanned: Record<string, true>
}

export const useScanBar = create<ScanBarState>(() => ({ scanned: {} }))

function hide(docId: string) {
  useScanBar.setState((s) => {
    if (!s.scanned[docId]) return s
    const scanned = { ...s.scanned }
    delete scanned[docId]
    return { scanned }
  })
}

/** The document was recognized: its bar is no longer needed. */
export function markRecognized(doc: DocumentModel) {
  hide(doc.id)
}

/** onDocumentOpen: samples a few pages and shows the bar when the document looks scanned. */
export async function detectScannedDocument(doc: DocumentModel) {
  await loadOcrSettings()
  if (!useOcrSettings.getState().detectScanned || doc.isClosed) return
  try {
    const res = await doc.ops<typeof ocrOps>('ocr').detectScanned()
    if (res.scanned && !doc.isClosed) useScanBar.setState((s) => ({ scanned: { ...s.scanned, [doc.id]: true } }))
  } catch (err) {
    // Detection is a convenience: a damaged page must not get in the way of opening the file.
    if (!doc.isClosed) console.warn('Scanned-document detection failed', err)
  }
}

/** Global: renders the bar of the active document into the document area. */
export function ScanBar({ onRecognize }: { onRecognize: (doc: DocumentModel) => void }) {
  const doc = useActiveDoc()
  const show = useScanBar((s) => (doc ? !!s.scanned[doc.id] : false))
  const enabled = useOcrSettings((s) => s.detectScanned)
  const readMode = useApp((s) => s.readMode)
  const groupId = useApp((s) => s.toolGroupId)
  const docView = !!registry.toolGroups.find((g) => g.id === groupId)?.documentView
  const [host, setHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setHost(document.querySelector<HTMLElement>('.shell-docarea'))
  }, [doc, readMode, docView])

  if (!doc || !show || !enabled || readMode || docView || !host?.isConnected) return null
  return createPortal(
    <div className={`${P}-msgbar`} role="region" aria-label="Scanned document message bar">
      <div className={`${P}-msgbar-main`}>
        <ScanText size={16} className={`${P}-msgbar-icon`} />
        <span className={`${P}-msgbar-text`}>This document appears to be scanned. Recognize text to make it searchable?</span>
      </div>
      <div className={`${P}-msgbar-actions`}>
        <Button size="sm" variant="primary" onClick={() => onRecognize(doc)} data-testid="ocr-msgbar-recognize">
          Recognize text
        </Button>
        <Button size="sm" variant="secondary" onClick={() => openToolGroup('ocr')}>
          Options…
        </Button>
        <IconButton icon={X} size={16} label="Close the message bar" onClick={() => hide(doc.id)} />
      </div>
    </div>,
    host
  )
}
