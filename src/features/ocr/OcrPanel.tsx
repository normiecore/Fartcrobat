/** Left pane of the "Scan & OCR" tool. */
import { useEffect, useState } from 'react'
import { Eraser, ScanText } from 'lucide-react'
import { Button, EmptyState, Section, ToolPanelFrame, useDocState, type DocumentModel } from '@renderer/sdk'
import { RecognizeFields, useRecognizeForm } from './RecognizeForm'
import { ocrOpsOf, recognizeText, removeRecognizedText, useRun } from './run'
import { pageHasText } from './pipeline'
import type { PageOcrStatus } from './types'

const P = 'fc-ocr'

/** Page statuses, refreshed whenever the document changes. */
function usePageStatuses(doc: DocumentModel): PageOcrStatus[] | null {
  const [tick, setTick] = useState(0)
  const [statuses, setStatuses] = useState<PageOcrStatus[] | null>(null)
  const pageCount = useDocState(doc, (s) => s.info.pageCount)
  // Every engine reply carries a change set; only real page changes need a new status.
  useEffect(
    () =>
      doc.onChange((cs) => {
        if (cs.all || cs.structure || cs.pages.length) setTick((t) => t + 1)
      }),
    [doc]
  )
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      ocrOpsOf(doc)
        .status()
        .then((s) => alive && setStatuses(s))
        .catch((err) => {
          if (alive && !doc.isClosed) console.warn('Could not read the page status', err)
        })
    }, 150)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [doc, tick, pageCount])
  return statuses
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

function DocumentStatus({ doc }: { doc: DocumentModel }) {
  const statuses = usePageStatuses(doc)
  if (!statuses) return null
  const recognized = statuses.filter((s) => s.hasOcrLayer).length
  const ownText = statuses.filter((s) => !s.hasOcrLayer && pageHasText(s)).length
  const without = statuses.length - recognized - ownText
  return (
    <Section title="This document">
      <ul className={`${P}-status`} data-testid="ocr-status">
        {recognized > 0 && (
          <li>
            <span className={`${P}-dot is-recognized`} />
            {plural(recognized, 'page has', 'pages have')} recognized text
          </li>
        )}
        {ownText > 0 && (
          <li>
            <span className={`${P}-dot is-text`} />
            {plural(ownText, 'page has', 'pages have')} text of {ownText === 1 ? 'its' : 'their'} own
          </li>
        )}
        {without > 0 && (
          <li>
            <span className={`${P}-dot is-none`} />
            {plural(without, 'page has', 'pages have')} no searchable text
          </li>
        )}
      </ul>
      {recognized > 0 && (
        <Button
          size="sm"
          variant="quiet"
          icon={Eraser}
          onClick={() => void removeRecognizedText(doc)}
          title="Remove the invisible text added by Recognize Text (the pages keep their images)"
        >
          Remove recognized text
        </Button>
      )}
    </Section>
  )
}

function PanelBody({ doc }: { doc: DocumentModel }) {
  const form = useRecognizeForm(doc)
  const running = useRun((s) => s.active)
  const req = form.request
  return (
    <div className={`${P}-panel`}>
      <p className={`${P}-intro`}>
        Make scanned pages searchable and selectable. Recognition runs on this computer; nothing is uploaded.
      </p>
      <Section title="Recognize text">
        <RecognizeFields doc={doc} form={form} />
        <Button
          variant="primary"
          icon={ScanText}
          className={`${P}-wide`}
          disabled={running || typeof req === 'string'}
          onClick={() => typeof req !== 'string' && void recognizeText(doc, req)}
          data-testid="ocr-recognize"
        >
          {running ? 'Recognizing…' : 'Recognize text'}
        </Button>
      </Section>
      <DocumentStatus doc={doc} />
    </div>
  )
}

export function OcrPanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame title="Scan & OCR">
      {doc ? <PanelBody key={doc.id} doc={doc} /> : <EmptyState icon={ScanText} title="Open a scanned PDF to recognize its text" />}
    </ToolPanelFrame>
  )
}
