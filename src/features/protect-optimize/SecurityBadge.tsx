import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Lock, ShieldAlert, X } from 'lucide-react'
import { Button, openToolGroup, useDocState, type DocumentModel } from '@renderer/sdk'
import { enterPermissionsPassword } from './flows'
import { encryptionLabel, isRestricted, restrictionList, sentenceList } from './shared'
import { useProtectOptimize } from './state'

const P = 'fc-protect-optimize'

/** Acrobat's document message bar for restricted documents, shown under the document toolbar. */
function RestrictedBar({ doc, permsKey }: { doc: DocumentModel; permsKey: string }) {
  const permissions = useDocState(doc, (s) => s.info.permissions)
  // Certificate security has no permissions password: the certificate decides.
  const certificate = useDocState(doc, (s) => s.info.security === 'certificate')
  const denied = restrictionList(permissions)
  return (
    <div className={`${P}-msgbar`} role="status" data-testid="restricted-bar">
      <ShieldAlert size={16} className={`${P}-msgbar-icon`} />
      <span className={`${P}-msgbar-text`}>
        <b>This document has restricted permissions.</b> {denied.length > 0 && <>Not allowed: {sentenceList(denied)}.</>}
      </span>
      <Button size="sm" variant="quiet" onClick={() => openToolGroup('protect')}>
        Permission details
      </Button>
      {!certificate && (
        <Button size="sm" variant="quiet" onClick={() => void enterPermissionsPassword(doc)}>
          Enter password…
        </Button>
      )}
      <button
        type="button"
        className="ui-icon-btn"
        aria-label="Close message"
        title="Close message"
        onClick={() => useProtectOptimize.setState((s) => ({ dismissedBars: { ...s.dismissedBars, [doc.id]: permsKey } }))}
      >
        <X size={14} />
      </button>
    </div>
  )
}

/** Lock badge in the document toolbar for encrypted documents (opens Protect), plus the message bar. */
export function SecurityBadge({ doc }: { doc: DocumentModel }) {
  const encryption = useDocState(doc, (s) => s.info.encryption)
  const security = useDocState(doc, (s) => s.info.security)
  const permissions = useDocState(doc, (s) => s.info.permissions)
  const permsKey = JSON.stringify(permissions)
  const dismissed = useProtectOptimize((s) => s.dismissedBars[doc.id] === permsKey)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const anchor = useCallback((el: HTMLSpanElement | null) => {
    setHost((el?.closest('.shell-doctoolbar') as HTMLElement | null) ?? null)
  }, [])
  const encrypted = !!encryption || security === 'certificate'
  const restricted = encrypted && isRestricted(permissions)
  const label = encryptionLabel(encryption)
  const title =
    security === 'certificate'
      ? `This document is protected with certificate security${label ? ` (${label})` : ''}. Click for security settings.`
      : `This document is protected${label ? ` (${label})` : ''}. Click for security settings.`
  return (
    <span ref={anchor} className={`${P}-badge-anchor`}>
      {encrypted && (
        <button
          type="button"
          className={`${P}-badge ${restricted ? 'is-restricted' : ''}`}
          title={title}
          aria-label="Document security"
          data-testid="security-badge"
          onClick={() => openToolGroup('protect')}
        >
          <Lock size={14} />
          <span>Secured</span>
        </button>
      )}
      {host && restricted && !dismissed && createPortal(<RestrictedBar doc={doc} permsKey={permsKey} />, host)}
    </span>
  )
}
