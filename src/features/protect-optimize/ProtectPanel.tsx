import { useEffect, useState } from 'react'
import { FileKey2, KeyRound, Lock, LockOpen, PenOff } from 'lucide-react'
import { describeCertKey } from '@shared/certkeys'
import type { SavedPasswordInfo } from '@shared/passwords'
import {
  Button,
  EmptyState,
  Section,
  ToolPanelFrame,
  ToolRow,
  invoke,
  openToolGroup,
  registry,
  savedPasswordFor,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { certificateRecipientNames } from './certificates'
import { enterPermissionsPassword, forgetDocumentPassword, openCertificateEncryptDialog, openProtectDialog, removeSecurity } from './flows'
import { isRestricted, permissionRows, restrictionList } from './shared'
import { useSecurity } from './useSecurity'

const P = 'fc-protect-optimize'

/** The password saved on this device for the document, refreshed when its file or security changes. */
function useSavedPassword(doc: DocumentModel, encrypted: boolean): [SavedPasswordInfo | null, () => void] {
  const info = useDocState(doc, (s) => s.info)
  const filePath = useDocState(doc, (s) => s.filePath)
  const unlock = useDocState(doc, (s) => s.unlock)
  const [saved, setSaved] = useState<SavedPasswordInfo | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    if (!encrypted) setSaved(null)
    else
      savedPasswordFor(doc)
        .then((r) => alive && setSaved(r))
        .catch(() => alive && setSaved(null))
    return () => {
      alive = false
    }
  }, [doc, encrypted, info, filePath, unlock, tick])
  return [saved, () => setTick((t) => t + 1)]
}

/**
 * Who a certificate-encrypted document is encrypted for: the recipients' issuers and serial numbers
 * (an envelope names no one), or the person's own key when it is one of them. Null while unknown.
 */
function useCertificateRecipients(doc: DocumentModel, enabled: boolean): string[] | null {
  const unlock = useDocState(doc, (s) => s.unlock)
  const [names, setNames] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    setNames(null)
    if (enabled)
      void (async () => {
        try {
          const lock = await doc.core.doc.certificateLock()
          if (!lock) return
          const res = await invoke('certkeys:probe', { blobs: lock.recipients })
          if (alive) setNames(certificateRecipientNames(res))
        } catch (err) {
          if (!doc.isClosed) console.warn('[protect-optimize] could not read the recipients', err)
        }
      })()
    return () => {
      alive = false
    }
  }, [doc, enabled, unlock])
  return names
}

function ProtectPanelBody({ doc }: { doc: DocumentModel }) {
  const st = useSecurity(doc)
  const certificate = useDocState(doc, (s) => s.info.security === 'certificate')
  const via = useDocState(doc, (s) => s.unlock?.via)
  const [saved, refreshSaved] = useSavedPassword(doc, !!st?.encrypted && !certificate)
  const recipients = useCertificateRecipients(doc, certificate)
  if (!st) return <div className="shell-muted">Checking security…</div>
  const fileRestricted = st.encrypted && isRestricted(st.filePermissions)
  // A certificate that may not change the security cannot replace or remove it either.
  const locked = certificate && !st.ownerAccess
  // Every permission, but not the security settings (the default of a group added in Encrypt with Certificate).
  const allButSecurity = locked && restrictionList(st.filePermissions).length === 0
  const lockedNote = 'Your certificate does not allow changing the security'
  const redact = registry.toolGroups.find((g) => g.id === 'redact')
  return (
    <div className={`${P}-panel`}>
      <div className={`${P}-status ${st.encrypted ? 'is-protected' : ''}`} data-testid="security-status">
        <span className={`${P}-status-icon`}>{st.encrypted ? <Lock size={18} /> : <LockOpen size={18} />}</span>
        <div className={`${P}-status-text`}>
          <div className={`${P}-status-title`}>{certificate ? 'Certificate security' : st.encrypted ? 'Protected' : 'Not protected'}</div>
          <div className={`${P}-status-sub`}>
            {certificate
              ? `${st.method ?? 'Encrypted'} encryption. Only the people it is encrypted for can open it.`
              : st.encrypted
                ? `${st.method ?? 'Encrypted'} encryption`
                : 'Anyone with the file can open, print, copy and change it.'}
          </div>
        </div>
      </div>
      {st.encrypted && !certificate && (
        <dl className={`${P}-facts`}>
          <dt>Password to open</dt>
          <dd>{st.needsOpenPassword ? 'Required' : 'Not required'}</dd>
          <dt>Editing and printing</dt>
          <dd>{fileRestricted ? 'Restricted' : 'Not restricted'}</dd>
        </dl>
      )}
      {certificate && (
        <dl className={`${P}-facts is-certificate`} data-testid="certificate-facts">
          {via && (
            <>
              <dt>Opened with</dt>
              <dd>{describeCertKey(via)}</dd>
            </>
          )}
          <dt>Your access</dt>
          <dd>{st.ownerAccess ? 'Full access' : allButSecurity ? 'Everything except changing the security' : 'Restricted'}</dd>
        </dl>
      )}
      {certificate && recipients && recipients.length > 0 && (
        <div className={`${P}-recipients`} data-testid="certificate-recipients">
          <div className={`${P}-recipients-title`}>Encrypted for</div>
          <ul>
            {recipients.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
      {!certificate && st.ownerAccess && fileRestricted && (
        <p className={`${P}-hint`}>You have full access for now (permissions password entered). Others still get the restrictions below.</p>
      )}
      {locked && (
        <p className={`${P}-hint`}>
          {allButSecurity
            ? 'Your certificate does not allow changing the security, so you cannot protect it again or remove its security.'
            : 'Your certificate gives you restricted access.'}{' '}
          Others it is encrypted for may have different permissions.
        </p>
      )}
      {saved && (
        <div className={`${P}-saved`} data-testid="saved-password">
          <KeyRound size={14} aria-hidden />
          <span>Password saved on this device</span>
          <Button size="sm" variant="quiet" onClick={() => void forgetDocumentPassword(doc).then(refreshSaved)}>
            Forget
          </Button>
        </div>
      )}

      <Section>
        <ToolRow
          icon={KeyRound}
          label="Protect using password"
          description={locked ? lockedNote : 'Require a password to open this PDF'}
          disabled={locked}
          onClick={() => void openProtectDialog(doc, 'password')}
        />
        <ToolRow
          icon={FileKey2}
          label="Encrypt with certificate"
          description={locked ? lockedNote : 'Only the people you choose can open it, with their certificate'}
          disabled={locked}
          onClick={() => void openCertificateEncryptDialog(doc)}
        />
        <ToolRow
          icon={PenOff}
          label="Restrict editing"
          description={locked ? lockedNote : 'Control printing, changes and copying'}
          disabled={locked}
          onClick={() => void openProtectDialog(doc, 'restrict')}
        />
        {st.encrypted && !st.ownerAccess && !certificate && (
          <ToolRow icon={KeyRound} label="Enter permissions password" description="Lift the restrictions while you work" onClick={() => void enterPermissionsPassword(doc)} />
        )}
        <ToolRow
          icon={LockOpen}
          label="Remove security"
          description={
            !st.encrypted
              ? 'This PDF has no security'
              : locked
                ? 'Your certificate does not allow removing the security'
                : certificate
                  ? 'Remove the certificate security'
                  : 'Remove the password and restrictions'
          }
          disabled={!st.encrypted || locked}
          onClick={() => void removeSecurity(doc)}
        />
        {redact && <ToolRow icon={redact.icon} label={redact.label} description="Permanently remove sensitive content" onClick={() => openToolGroup('redact')} />}
      </Section>

      <Section title={certificate ? 'Your permissions' : 'Document restrictions'}>
        {st.encrypted ? (
          <table className={`${P}-perms`} data-testid="security-permissions">
            <tbody>
              {permissionRows(st.filePermissions, certificate ? { changeSecurity: st.ownerAccess } : {}).map(([label, value, lvl]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className={`is-${lvl}`}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={`${P}-hint`}>No restrictions: everything is allowed.</p>
        )}
      </Section>
    </div>
  )
}

export function ProtectPanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame title="Protect a PDF">
      {doc ? <ProtectPanelBody key={doc.id} doc={doc} /> : <EmptyState icon={Lock} title="Open a PDF to protect it" />}
    </ToolPanelFrame>
  )
}
