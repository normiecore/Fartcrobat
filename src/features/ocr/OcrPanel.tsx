/** Left pane of the "Scan & OCR" tool. */
import { useEffect, useState } from 'react'
import { Eraser, ScanText } from 'lucide-react'
import { Button, EmptyState, Section, ToolPanelFrame, useDocState, type DocumentModel } from '@renderer/sdk'
import { RecognizeFields, useRecognizeForm } from './RecognizeForm'
import { ocrOpsOf, recognizeText, removeRecognizedText, useRun } from './run'
import { pageHasText } from './pipeline'
import type { PageOcrStatus } from './types'

const P = 'fc-ocr'

/** Pages whose status is read per engine call, so page renders get a turn in between. */
const STATUS_CHUNK = 25

/**
 * Page statuses, kept up to date: all pages when the panel opens or the page structure changes,
 * only the changed pages after an edit.
 */
function usePageStatuses(doc: DocumentModel): PageOcrStatus[] | null {
  const [statuses, setStatuses] = useState<PageOcrStatus[] | null>(null)
  const pageCount = useDocState(doc, (s) => s.info.pageCount)
  useEffect(() => {
    let alive = true
    let current: PageOcrStatus[] = []
    const dirty = new Set<number>()
    let all = true
    let busy = false
    let timer = 0
    const refresh = async () => {
      if (busy || !alive) return
      busy = true
      try {
        while (alive && (all || dirty.size)) {
          const n = doc.pageCount
          let pages: number[]
          if (all) {
            all = false
            dirty.clear()
            pages = [...Array(n).keys()]
            current = []
          } else {
            pages = [...dirty].filter((p) => p < n)
            dirty.clear()
          }
          for (let i = 0; i < pages.length && alive && !all; i += STATUS_CHUNK) {
            const got = await ocrOpsOf(doc).status(pages.slice(i, i + STATUS_CHUNK))
            const byPage = new Map(current.map((st) => [st.page, st]))
            for (const st of got) byPage.set(st.page, st)
            current = [...byPage.values()].filter((st) => st.page < doc.pageCount).sort((a, b) => a.page - b.page)
          }
          if (alive && !all && current.length === doc.pageCount) setStatuses(current)
        }
      } catch (err) {
        if (alive && !doc.isClosed) console.warn('Could not read the page status', err)
      } finally {
        busy = false
      }
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), 150)
    }
    // Every engine reply carries a change set; only real page changes need a new status.
    const off = doc.onChange((cs) => {
      if (cs.all || cs.structure) all = true
      else if (cs.pages.length) for (const p of cs.pages) dirty.add(p)
      else return
      schedule()
    })
    schedule()
    return () => {
      alive = false
      window.clearTimeout(timer)
      off()
    }
  }, [doc, pageCount])
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
