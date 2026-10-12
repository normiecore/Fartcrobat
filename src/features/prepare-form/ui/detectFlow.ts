import {
  ask,
  registry,
  runCommand,
  setTool,
  showError,
  toast,
  withProgress,
  type DocumentModel
} from '@renderer/sdk'
import type pfOps from '../engine'
import type { DetectedField } from '../model'
import { refreshInfo, selectFields } from './actions'
import { usePF } from './state'

function summary(found: DetectedField[]): string {
  const count = (pred: (f: DetectedField) => boolean) => found.filter(pred).length
  const parts: string[] = []
  const text = count((f) => f.type === 'text')
  const dates = count((f) => f.type === 'date')
  const checks = count((f) => f.type === 'checkbox')
  const sigs = count((f) => f.type === 'signature')
  if (text) parts.push(`${text} text field${text > 1 ? 's' : ''}`)
  if (dates) parts.push(`${dates} date field${dates > 1 ? 's' : ''}`)
  if (checks) parts.push(`${checks} check box${checks > 1 ? 'es' : ''}`)
  if (sigs) parts.push(`${sigs} signature field${sigs > 1 ? 's' : ''}`)
  return parts.join(', ')
}

/** Finds likely fields and adds them in one undoable step. */
export async function detectFieldsFlow(doc: DocumentModel, pages?: number[]): Promise<number> {
  try {
    const found = await withProgress('Looking for form fields…', (report) =>
      doc.ops<typeof pfOps>('prepare-form', { onProgress: (f, m) => report(f, m) }).detect(pages)
    )
    if (!found.length) {
      // a scan has no text to find labels in: offer text recognition when it is installed
      let scanned = false
      try {
        const list = pages ?? Array.from({ length: Math.min(doc.pageCount, 3) }, (_, i) => i)
        scanned = (await Promise.all(list.map((p) => doc.pageText(p)))).every((t) => !t.text.trim())
      } catch {}
      if (scanned && registry.commands.has('ocr.recognize')) {
        toast(
          'This looks like a scan, so there is no text to find fields by. Recognize the text first, then detect fields again.',
          {
            timeout: 8000,
            action: { label: 'Recognize text', run: () => void runCommand('ocr.recognize') }
          }
        )
      } else {
        toast('No form fields were found. Add fields with the tools in the toolbar.', { timeout: 5000 })
      }
      return 0
    }
    const created = await doc.ops<typeof pfOps>('prepare-form').createMany(
      found.map((f) => ({ type: f.type, page: f.page, rect: f.rect, name: f.name })),
      'Detect Form Fields'
    )
    void refreshInfo(doc)
    setTool('form.select')
    const first = created[0]
    if (first) {
      const onFirstPage = created.filter((f) => f.page === first.page)
      selectFields(
        doc,
        first.page,
        onFirstPage.map((f) => f.id)
      )
      doc.view?.goToPage(first.page)
    }
    toast(`Added ${summary(found)}. Check their names and positions — undo removes them all.`, {
      kind: 'success',
      timeout: 6000
    })
    return created.length
  } catch (err) {
    showError(err, 'Could not detect form fields')
    return 0
  }
}

/** Asked once per document when "Prepare a form" opens on a document without fields. */
export async function offerDetection(doc: DocumentModel) {
  const st = usePF.getState()
  if (st.askedDetect[doc.id]) return
  usePF.setState({ askedDetect: { ...st.askedDetect, [doc.id]: true } })
  const answer = await ask({
    title: 'Detect form fields automatically?',
    message:
      'This document has no form fields yet. Fartcrobat can look for blanks, lines, boxes and signature lines and turn them into fillable fields. You can review, rename, move or undo them afterwards.',
    buttons: [
      { id: 'no', label: 'Not now' },
      { id: 'yes', label: 'Detect fields', variant: 'primary' }
    ]
  })
  if (answer === 'yes') await detectFieldsFlow(doc)
}
