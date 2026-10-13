/** The signing flow: checks, the sign dialog, Save As, signing in the engine, reloading the tab. */
import {
  alertDialog,
  basename,
  confirm,
  dirname,
  invoke,
  joinPath,
  openDialog,
  openRightPanel,
  PDF_FILTER,
  replaceDocumentBytes,
  showError,
  stripExtension,
  toast,
  useApp,
  withProgress,
  type DocumentModel
} from '@renderer/sdk'
import type { SignRequest, SignTarget } from '../types'
import { SignDialog, type SignDialogResult } from './SignDialog'
import { loadIds, loadTrusted, sigOps, useSigStore, validateDocument } from './store'

export interface StartSigningOptions {
  mode: 'sign' | 'certify'
  target: SignTarget
  permission?: 1 | 2 | 3
}

function suggestedPath(doc: DocumentModel): string {
  const title = doc.state.title || 'Document.pdf'
  const name = `${stripExtension(title)}_signed.pdf`
  const fp = doc.state.filePath
  if (fp) return joinPath(dirname(fp), name)
  const docs = useApp.getState().systemInfo?.documentsPath
  return docs ? joinPath(docs, name) : name
}

/** Signs or certifies the document. Resolves true when a signed copy was written and opened. */
export async function startSigning(doc: DocumentModel, opts: StartSigningOptions): Promise<boolean> {
  let cap
  try {
    cap = await sigOps(doc).capability()
  } catch (err) {
    showError(err, 'Could not check the document')
    return false
  }
  if (opts.mode === 'certify' && !cap.canCertify) {
    await alertDialog('Cannot certify this document', cap.certifyReason ?? 'This document cannot be certified.')
    return false
  }
  if (!cap.canSign) {
    await alertDialog('Cannot sign this document', cap.reason ?? 'This document cannot be signed.')
    return false
  }
  if (opts.target.kind === 'field') {
    const name = opts.target.name
    const field = cap.fields.find((f) => f.name === name)
    if (!field) {
      await alertDialog('Signature field not found', `The signature field “${name}” no longer exists.`)
      return false
    }
    if (field.signed) {
      await alertDialog('Already signed', `The signature field “${name}” is already signed.`)
      return false
    }
  } else if (cap.newFieldBreaksCertification) {
    const ok = await confirm({
      title: 'Certified document',
      message:
        'This document is certified and the certifier only allows signing the existing signature fields. Adding a new signature field will make the certification invalid. Do you want to continue?',
      confirmLabel: 'Add signature anyway',
      danger: true
    })
    if (!ok) return false
  }
  if (!useSigStore.getState().idsLoaded) await loadIds()
  const size =
    opts.target.kind === 'new'
      ? { w: opts.target.rect[2] - opts.target.rect[0], h: opts.target.rect[3] - opts.target.rect[1] }
      : opts.target.kind === 'field'
        ? (() => {
            const name = (opts.target as { name: string }).name
            const f = cap.fields.find((x) => x.name === name)!
            return f.invisible ? null : { w: f.rect[2] - f.rect[0], h: f.rect[3] - f.rect[1] }
          })()
        : null
  const result = await openDialog<SignDialogResult>((close) => (
    <SignDialog doc={doc} mode={opts.mode} target={opts.target} size={size} initialPermission={opts.permission ?? 2} onDone={close} />
  ))
  if (!result) return false

  const path = await invoke('file:saveDialog', {
    title: opts.mode === 'certify' ? 'Save Certified Document As' : 'Save Signed Document As',
    defaultPath: suggestedPath(doc),
    filters: [PDF_FILTER]
  })
  if (!path) {
    toast('Signing cancelled. The document was not changed.')
    return false
  }
  const target = path.toLowerCase().endsWith('.pdf') ? path : `${path}.pdf`
  const req: SignRequest = { ...result.request, time: Date.now() }
  try {
    const signed = await withProgress(opts.mode === 'certify' ? 'Certifying…' : 'Signing…', async (report) => {
      report(null, 'Creating the signature')
      const res = await doc.busyWhile('Signing…', () => sigOps(doc).sign(req))
      report(0.8, 'Saving the signed copy')
      await replaceDocumentBytes(doc, res.bytes, target)
      return res
    })
    try {
      const recent = await invoke('recent:add', { path: target, name: basename(target), size: signed.bytes.length, pageCount: doc.pageCount })
      useApp.setState({ recent })
    } catch {}
    await loadTrusted()
    // Show the message bar again for the freshly signed file, even if it was hidden before.
    useSigStore.setState((s) => ({ barHidden: { ...s.barHidden, [doc.id]: false } }))
    await validateDocument(doc)
    openRightPanel('signatures')
    toast(`${opts.mode === 'certify' ? 'Certified' : 'Signed'} and saved as ${basename(target)}`, { kind: 'success' })
    return true
  } catch (err) {
    showError(err, opts.mode === 'certify' ? 'Could not certify the document' : 'Could not sign the document')
    return false
  }
}
