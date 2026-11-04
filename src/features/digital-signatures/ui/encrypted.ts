/**
 * Signing certificate-encrypted documents is not supported yet: a correct signature needs an
 * incremental save that keeps the certificate security, and every save of these documents rewrites
 * them (docs/features/passwordless.md, D8). The signing tools are disabled for them and say why.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { alertDialog, type DocumentModel } from '@renderer/sdk'

/** Why signing is refused (the engine refuses with code CERTIFICATE_ENCRYPTED too). */
export const CERTIFICATE_ENCRYPTED_SIGNING =
  'Signing certificate-encrypted documents is not supported yet. Remove the certificate security (Protect > Remove security) to sign, then encrypt again.'

/** The document is encrypted with certificates (public-key security). */
export function isCertificateEncrypted(doc: DocumentModel | null | undefined): boolean {
  return doc?.state.info.security === 'certificate'
}

/** isCertificateEncrypted, re-rendering when the document changes (Remove Security, Revert...). */
export function useCertificateEncrypted(doc: DocumentModel | null): boolean {
  const subscribe = useCallback((onChange: () => void) => (doc ? doc.store.subscribe(onChange) : () => {}), [doc])
  return useSyncExternalStore(subscribe, () => isCertificateEncrypted(doc))
}

/** Tells the person why the document cannot be signed. True when it was refused. */
export async function refuseCertificateEncrypted(doc: DocumentModel | null | undefined): Promise<boolean> {
  if (!isCertificateEncrypted(doc)) return false
  await alertDialog('Cannot sign this document', CERTIFICATE_ENCRYPTED_SIGNING)
  return true
}
