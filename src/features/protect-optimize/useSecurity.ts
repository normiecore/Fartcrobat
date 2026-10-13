import { useEffect, useState } from 'react'
import type { Permission } from '@shared/types'
import { useDocState, type DocumentModel } from '@renderer/sdk'
import { securityOf } from './flows'
import type { SecurityStatus } from './shared'

export type FullSecurityStatus = SecurityStatus & { filePermissions: Record<Permission, boolean> }

/** The document's security, refreshed whenever the document or its info changes. */
export function useSecurity(doc: DocumentModel): FullSecurityStatus | null {
  const info = useDocState(doc, (s) => s.info)
  const version = useDocState(doc, (s) => s.docVersion)
  const [status, setStatus] = useState<FullSecurityStatus | null>(null)
  useEffect(() => {
    let alive = true
    securityOf(doc)
      .then((st) => {
        if (alive) setStatus(st)
      })
      .catch((err) => !doc.isClosed && console.warn('[protect-optimize] could not read security', err))
    return () => {
      alive = false
    }
  }, [doc, info, version])
  return status
}
