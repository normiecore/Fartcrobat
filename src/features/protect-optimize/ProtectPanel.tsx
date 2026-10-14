import { useEffect, useState } from 'react'
import { KeyRound, Lock, LockOpen, PenOff } from 'lucide-react'
import type { SavedPasswordInfo } from '@shared/passwords'
import type { Permission } from '@shared/types'
import {
  Button,
  EmptyState,
  Section,
  ToolPanelFrame,
  ToolRow,
  openToolGroup,
  registry,
  savedPasswordFor,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { enterPermissionsPassword, forgetDocumentPassword, openProtectDialog, removeSecurity } from './flows'
import { isRestricted } from './shared'
import { useSecurity } from './useSecurity'

const P = 'fc-protect-optimize'

const allowed = (v: boolean) => (v ? 'Allowed' : 'Not allowed')

type Level = 'allowed' | 'partial' | 'denied'
const level = (v: boolean): Level => (v ? 'allowed' : 'denied')

function permissionRows(p: Record<Permission, boolean>): [string, string, Level][] {
  const printing: [string, Level] = !p.print ? ['Not allowed', 'denied'] : p['print-hq'] ? ['Allowed', 'allowed'] : ['Low resolution only', 'partial']
  return [
    ['Printing', printing[0], printing[1]],
    ['Changing the document', allowed(p.edit), level(p.edit)],
    ['Document assembly', allowed(p.assemble), level(p.assemble)],
    ['Content copying', allowed(p.copy), level(p.copy)],
    ['Content copying for accessibility', allowed(p.accessibility), level(p.accessibility)],
    ['Commenting', allowed(p.annotate), level(p.annotate)],
    ['Filling of form fields', allowed(p.form), level(p.form)],
    ['Signing', allowed(p.form), level(p.form)]
  ]
}

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

function ProtectPanelBody({ doc }: { doc: DocumentModel }) {
  const st = useSecurity(doc)
  const [saved, refreshSaved] = useSavedPassword(doc, !!st?.encrypted)
  if (!st) return <div className="shell-muted">Checking security…</div>
  const fileRestricted = st.encrypted && isRestricted(st.filePermissions)
  const redact = registry.toolGroups.find((g) => g.id === 'redact')
  return (
    <div className={`${P}-panel`}>
      <div className={`${P}-status ${st.encrypted ? 'is-protected' : ''}`} data-testid="security-status">
        <span className={`${P}-status-icon`}>{st.encrypted ? <Lock size={18} /> : <LockOpen size={18} />}</span>
        <div className={`${P}-status-text`}>
          <div className={`${P}-status-title`}>{st.encrypted ? 'Protected' : 'Not protected'}</div>
          <div className={`${P}-status-sub`}>
            {st.encrypted ? `${st.method ?? 'Encrypted'} encryption` : 'Anyone with the file can open, print, copy and change it.'}
          </div>
        </div>
      </div>
      {st.encrypted && (
        <dl className={`${P}-facts`}>
          <dt>Password to open</dt>
          <dd>{st.needsOpenPassword ? 'Required' : 'Not required'}</dd>
          <dt>Editing and printing</dt>
          <dd>{fileRestricted ? 'Restricted' : 'Not restricted'}</dd>
        </dl>
      )}
      {st.ownerAccess && fileRestricted && (
        <p className={`${P}-hint`}>You have full access for now (permissions password entered). Others still get the restrictions below.</p>
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
        <ToolRow icon={KeyRound} label="Protect using password" description="Require a password to open this PDF" onClick={() => void openProtectDialog(doc, 'password')} />
        <ToolRow icon={PenOff} label="Restrict editing" description="Control printing, changes and copying" onClick={() => void openProtectDialog(doc, 'restrict')} />
        {st.encrypted && !st.ownerAccess && (
          <ToolRow icon={KeyRound} label="Enter permissions password" description="Lift the restrictions while you work" onClick={() => void enterPermissionsPassword(doc)} />
        )}
        <ToolRow
          icon={LockOpen}
          label="Remove security"
          description={st.encrypted ? 'Remove the password and restrictions' : 'This PDF has no security'}
          disabled={!st.encrypted}
          onClick={() => void removeSecurity(doc)}
        />
        {redact && <ToolRow icon={redact.icon} label={redact.label} description="Permanently remove sensitive content" onClick={() => openToolGroup('redact')} />}
      </Section>

      <Section title="Document restrictions">
        {st.encrypted ? (
          <table className={`${P}-perms`} data-testid="security-permissions">
            <tbody>
              {permissionRows(st.filePermissions).map(([label, value, lvl]) => (
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
