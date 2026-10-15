/** Actions on existing signatures (panel, context menu, commands). */
import { confirm, openBytes, openRightPanel, showError, stripExtension, toast, type DocumentModel } from '@renderer/sdk'
import { signatureStatus } from '../status'
import type { SignatureReport } from '../types'
import { sigOps, trustedSet, validateDocument } from './store'

/** Opens the document exactly as it was when the signature was applied (in a new tab). */
export async function viewSignedVersion(doc: DocumentModel, r: SignatureReport) {
  try {
    const bytes = await sigOps(doc).revisionBytes(r.revisionEnd)
    // A read-only view of an earlier revision: nothing to save unless the user edits it.
    const name = `${stripExtension(doc.state.title)} (signed version${r.signedVersion ? `, rev. ${r.signedVersion}` : ''}).pdf`
    // An earlier revision of a certificate-encrypted file opens with the tab's key.
    const opened = await openBytes(bytes, name, { filePath: null, dirty: false, derivedFrom: doc.state.unlock })
    if (opened) {
      openRightPanel('signatures')
      toast(`Showing the document as it was when ${r.signerName} signed it.`)
    }
  } catch (err) {
    showError(err, 'Could not open the signed version')
  }
}

export function goToSignature(doc: DocumentModel, r: { page: number; rect: [number, number, number, number]; invisible: boolean }) {
  if (r.invisible || r.page < 0) return
  doc.view?.scrollToRect(r.page, r.rect, { center: true })
}

export async function validateAll(doc: DocumentModel, opts: { openPanel?: boolean; announce?: boolean } = {}) {
  if (opts.openPanel) openRightPanel('signatures')
  const report = await validateDocument(doc)
  if (!report) {
    if (!doc.isClosed) toast('The signatures could not be validated.', { kind: 'error' })
    return
  }
  if (!opts.announce) return
  if (!report.signatures.length) {
    toast(report.unsigned.length ? 'This document has signature fields, but none are signed yet.' : 'This document has no signatures.')
    return
  }
  const levels = report.signatures.map((s) => signatureStatus(s, trustedSet()).level)
  const bad = levels.filter((l) => l === 'invalid').length
  const n = report.signatures.length
  if (bad) toast(`${bad} of ${n} signature${n === 1 ? ' is' : 's are'} invalid.`, { kind: 'error' })
  else if (levels.some((l) => l === 'warning' || l === 'unknown')) toast('At least one signature has problems.', { kind: 'warning' })
  else toast(`${n === 1 ? 'The signature is' : `All ${n} signatures are`} valid.`, { kind: 'success' })
}

/** Acrobat's "Clear Signature": removes the signature (undoable until saved). */
export async function clearSignature(doc: DocumentModel, fieldName: string) {
  const ok = await confirm({
    title: 'Clear signature?',
    message: `The signature in “${fieldName}” will be removed from the document. You can undo this until you save.`,
    confirmLabel: 'Clear Signature',
    danger: true
  })
  if (!ok) return
  try {
    await sigOps(doc).clearSignature(fieldName)
    await validateDocument(doc)
    toast('Signature cleared.', { action: { label: 'Undo', run: () => void doc.undo() } })
  } catch (err) {
    showError(err, 'Could not clear the signature')
  }
}
