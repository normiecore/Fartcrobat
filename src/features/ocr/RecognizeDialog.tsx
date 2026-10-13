/** Tools > Scan & OCR > Recognize Text… */
import { Button, Dialog, openDialog, type DocumentModel } from '@renderer/sdk'
import { RecognizeFields, useRecognizeForm, type PageScope } from './RecognizeForm'
import { recognizeText, type RecognizeRequest } from './run'

function RecognizeDialog({
  doc,
  scope,
  close
}: {
  doc: DocumentModel
  scope: PageScope
  close: (req?: RecognizeRequest) => void
}) {
  const form = useRecognizeForm(doc, scope)
  const req = form.request
  const submit = () => {
    if (typeof req !== 'string') close(req)
  }
  return (
    <Dialog
      title="Recognize Text"
      width={440}
      className="fc-ocr-dialog"
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={typeof req === 'string'} onClick={submit} data-testid="ocr-dialog-recognize">
            Recognize text
          </Button>
        </>
      }
    >
      <p className="fc-ocr-intro">Make scanned pages searchable and selectable. Recognition runs on this computer.</p>
      <RecognizeFields doc={doc} form={form} />
    </Dialog>
  )
}

export async function openRecognizeDialog(doc: DocumentModel, scope: PageScope = 'all') {
  const req = await openDialog<RecognizeRequest>((close) => <RecognizeDialog doc={doc} scope={scope} close={close} />)
  if (req) await recognizeText(doc, req)
}
