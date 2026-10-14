import { useEffect, useId, useMemo, useState } from 'react'
import { FileKey2, IdCard, Info, Plus, SlidersHorizontal, Trash2, TriangleAlert, UserPlus, X } from 'lucide-react'
import type { WindowsStoreState } from '@shared/certkeys'
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Segmented,
  Select,
  basename,
  invoke,
  openDialog,
  prompt,
  readFile,
  showError,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { loadIds } from '@features/digital-signatures/ui/store'
import { CERTIFICATE_FILE_EXTENSIONS, CertificateFileError, isExpired, readCertificateFile, type CertificateInfo } from './certificateFiles'
import {
  FULL_ACCESS,
  OWN_REMOVED_WARNING,
  addRecipients,
  chooseOwnCertificate,
  hasOwnRecipient,
  moveRecipient,
  permissionSummary,
  recipientCount,
  recipientFromDigitalId,
  recipientFromStore,
  recipientRefusal,
  recipientWarnings,
  recipientsFromFile,
  removeGroup,
  removeRecipient,
  removedGroupNotice,
  type GroupSettings,
  type Recipient,
  type RecipientGroup
} from './certificates'
import { PRINTING_OPTIONS, type PrintingAllowed } from './shared'

const P = 'fc-protect-optimize'

/** What the dialog resolves with. */
export interface CertificateEncryptChoice {
  groups: RecipientGroup[]
  /** The person's own certificate added by default (null when they have none). */
  own: Recipient | null
}

/** The certificates the person can pick recipients from. */
export interface RecipientSources {
  /** Preferences > Digital IDs. */
  ids: Recipient[]
  /** The Windows store: the person's own certificates, then Other People. */
  store: Recipient[]
  storeState: WindowsStoreState
}

/** Reads the Digital IDs and, on Windows, the certificate store. Never prompts. */
export async function loadRecipientSources(): Promise<RecipientSources> {
  const ids = (await loadIds()).map(recipientFromDigitalId).filter((r): r is Recipient => !!r)
  let storeState: WindowsStoreState = 'unavailable'
  let store: Recipient[] = []
  try {
    storeState = (await invoke('certkeys:status')).windowsStore
    if (storeState === 'available') {
      const list = await invoke('certkeys:listEncryptionCertificates', { includeOthers: true })
      store = list.map(recipientFromStore).filter((r): r is Recipient => !!r)
    }
  } catch (err) {
    console.warn('[protect-optimize] could not list the Windows certificates', err)
  }
  return { ids, store, storeState }
}

const dateText = (d: Date) => d.toISOString().slice(0, 10)

function sourceText(r: Recipient): string {
  if (r.source === 'digital-id') return 'Digital ID'
  if (r.source === 'windows-store') return 'Windows certificate store'
  if (r.source === 'other-people') return 'Other People'
  return r.sourceLabel
}

function certMeta(c: CertificateInfo, now: number): string {
  const validity = isExpired(c, now) ? `Expired ${dateText(c.notAfter)}` : `Expires ${dateText(c.notAfter)}`
  return [c.email, `Issued by ${c.issuerName}`, validity].filter(Boolean).join(' · ')
}

// ---- picking recipients -------------------------------------------------------------------------

type PickerTab = 'ids' | 'store' | 'files'

interface LoadedFile {
  name: string
  recipients: Recipient[]
  error?: string
}

/** Reads a certificate file, asking for the password of a .p12 or .pfx. Null when cancelled. */
async function readWithPassword(name: string, bytes: Uint8Array): Promise<CertificateInfo[] | null> {
  let password: string | undefined
  let message = `“${name}” is protected with a password. Enter it to read the certificate in it; only the public certificate is used.`
  for (;;) {
    try {
      return readCertificateFile(bytes, { password })
    } catch (err) {
      if (!(err instanceof CertificateFileError) || (err.code !== 'NEEDS_PASSWORD' && err.code !== 'WRONG_PASSWORD')) throw err
      if (err.code === 'WRONG_PASSWORD') message = 'That password is not correct. Try again.'
      const pw = await prompt({ title: 'Password required', message, label: 'Password', password: true, okLabel: 'Open' })
      if (pw === null) return null
      password = pw
    }
  }
}

function PickRow({
  r,
  checked,
  taken,
  now,
  onChange
}: {
  r: Recipient
  checked: boolean
  taken: boolean
  now: number
  onChange: (v: boolean) => void
}) {
  const refusal = recipientRefusal(r.cert)
  const warnings = refusal || taken ? [] : recipientWarnings(r.cert, now)
  return (
    <li className={`${P}-cert-row ${refusal || taken ? 'is-disabled' : ''}`} data-testid="cert-pick-row">
      <Checkbox
        checked={checked || taken}
        disabled={!!refusal || taken}
        onChange={onChange}
        label={
          <span className={`${P}-cert-text`}>
            <span className={`${P}-cert-name`}>
              {r.cert.name}
              {r.mine && <span className={`${P}-chip`}>You</span>}
              {taken && <span className={`${P}-chip`}>Added</span>}
              {r.cert.isCA && <span className={`${P}-chip`}>Certificate authority</span>}
            </span>
            <span className={`${P}-cert-meta`}>
              {certMeta(r.cert, now)} · {r.cert.keyDescription}
            </span>
            {refusal && <span className={`${P}-cert-reason`}>{refusal}</span>}
            {warnings.map((w) => (
              <span key={w} className={`${P}-cert-warn`}>
                <TriangleAlert size={12} aria-hidden /> {w}
              </span>
            ))}
          </span>
        }
      />
    </li>
  )
}

/** "Add recipients": certificates from the Digital IDs, the Windows store and files. */
function RecipientPicker({ sources, taken, onDone }: { sources: RecipientSources; taken: Set<string>; onDone: (r?: Recipient[]) => void }) {
  const storeOn = sources.storeState === 'available'
  const [tab, setTab] = useState<PickerTab>(() => (sources.ids.length ? 'ids' : storeOn && sources.store.length ? 'store' : 'files'))
  const [selected, setSelected] = useState<Map<string, Recipient>>(() => new Map())
  const [files, setFiles] = useState<LoadedFile[]>([])
  const [reading, setReading] = useState(false)
  const now = useMemo(() => Date.now(), [])
  const toggle = (r: Recipient, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (on) next.set(r.id, r)
      else next.delete(r.id)
      return next
    })
  const chooseFiles = async () => {
    const paths = await invoke('file:openDialog', {
      title: 'Choose Certificate Files',
      filters: [
        { name: 'Certificates', extensions: CERTIFICATE_FILE_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ],
      multiple: true
    })
    if (!paths.length) return
    setReading(true)
    try {
      for (const path of paths) {
        const name = basename(path)
        let loaded: LoadedFile
        try {
          const certs = await readWithPassword(name, await readFile(path))
          if (!certs) continue
          loaded = { name, recipients: recipientsFromFile(certs, name) }
        } catch (err) {
          loaded = { name, recipients: [], error: err instanceof Error ? err.message : String(err) }
        }
        setFiles((prev) => [...prev.filter((f) => f.name !== name), loaded])
        // Tick what can be added, except certificate authorities.
        for (const r of loaded.recipients) if (!recipientRefusal(r.cert) && !r.cert.isCA && !taken.has(r.id)) toggle(r, true)
      }
    } finally {
      setReading(false)
    }
  }
  const list = (items: Recipient[]) => (
    <ul className={`${P}-cert-list`}>
      {items.map((r) => (
        <PickRow key={r.id} r={r} now={now} checked={selected.has(r.id)} taken={taken.has(r.id)} onChange={(v) => toggle(r, v)} />
      ))}
    </ul>
  )
  const own = sources.store.filter((r) => r.source === 'windows-store')
  const others = sources.store.filter((r) => r.source === 'other-people')
  const tabs: { value: PickerTab; label: string }[] = [
    { value: 'ids', label: 'My Digital IDs' },
    ...(storeOn ? [{ value: 'store' as const, label: 'Windows certificate store' }] : []),
    { value: 'files', label: 'Certificate files' }
  ]
  const count = selected.size
  return (
    <Dialog
      title="Add recipients"
      onClose={() => onDone()}
      width={620}
      className={`${P}-dialog`}
      footer={
        <>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" disabled={!count} onClick={() => onDone([...selected.values()])} data-testid="cert-pick-add">
            {count > 1 ? `Add ${count} Recipients` : 'Add Recipient'}
          </Button>
        </>
      }
    >
      <div className={`${P}-cert-picker`}>
        <Segmented<PickerTab> value={tab} onChange={setTab} options={tabs} />
        <div className={`${P}-cert-pane`}>
          {tab === 'ids' &&
            (sources.ids.length ? (
              list(sources.ids)
            ) : (
              <p className={`${P}-hint`}>
                You have no Digital IDs yet. Create or import one in Preferences &gt; Digital IDs, or add a certificate file.
              </p>
            ))}
          {tab === 'store' && (
            <>
              <h4 className={`${P}-cert-subhead`}>My certificates</h4>
              {own.length ? list(own) : <p className={`${P}-hint`}>No personal certificates for encryption were found.</p>}
              <h4 className={`${P}-cert-subhead`}>Other People</h4>
              {others.length ? list(others) : <p className={`${P}-hint`}>No certificates in Other People.</p>}
            </>
          )}
          {tab === 'files' && (
            <>
              <p className={`${P}-hint`}>
                Add the certificates of the people who should open the file: .cer, .crt or .pem files, .p7b collections, or a .p12 or
                .pfx file (its password is needed; only the public certificate is used).
              </p>
              <Button icon={FileKey2} onClick={() => void chooseFiles().catch((err) => showError(err, 'Could not read the certificates'))} disabled={reading}>
                Choose Certificate Files…
              </Button>
              {files.map((f) => (
                <div key={f.name} className={`${P}-cert-file`}>
                  <h4 className={`${P}-cert-subhead`}>{f.name}</h4>
                  {f.error ? (
                    <div className={`${P}-note is-error`} role="alert">
                      <TriangleAlert size={16} />
                      <span>{f.error}</span>
                    </div>
                  ) : (
                    list(f.recipients)
                  )}
                </div>
              ))}
            </>
          )}
          {sources.storeState === 'constrained' && tab !== 'files' && (
            <p className={`${P}-hint`}>
              <Info size={14} aria-hidden /> The Windows certificate store cannot be used on this computer (PowerShell is restricted). Use
              Digital IDs or certificate files.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function pickRecipients(sources: RecipientSources, taken: Set<string>): Promise<Recipient[] | undefined> {
  return openDialog<Recipient[]>((close) => <RecipientPicker sources={sources} taken={taken} onDone={close} />)
}

// ---- permission groups --------------------------------------------------------------------------

function PermissionsEditor({ settings: s, onChange }: { settings: GroupSettings; onChange: (s: GroupSettings) => void }) {
  const id = useId()
  const all = s.changeSecurity
  const set = (patch: Partial<GroupSettings>) => onChange({ ...s, ...patch })
  return (
    <div className={`${P}-cert-perms`} data-testid="cert-group-permissions">
      <Checkbox checked={all} onChange={(v) => set({ changeSecurity: v })} label="Changing the security settings (allows everything below)" />
      <div className={`${P}-group-body ${all ? 'is-disabled' : ''}`}>
        <div className={`${P}-perm-grid`}>
          <label className="ui-field-label" htmlFor={`${id}-print`}>
            Printing allowed
          </label>
          <Select<PrintingAllowed>
            id={`${id}-print`}
            value={all ? 'high' : s.printing}
            disabled={all}
            onChange={(v) => set({ printing: v })}
            options={PRINTING_OPTIONS}
          />
        </div>
        <div className={`${P}-checks`}>
          <Checkbox checked={all || s.edit} disabled={all} onChange={(v) => set({ edit: v })} label="Changing the document" />
          <Checkbox checked={all || s.assemble} disabled={all} onChange={(v) => set({ assemble: v })} label="Inserting, deleting and rotating pages" />
          <Checkbox checked={all || s.annotate} disabled={all} onChange={(v) => set({ annotate: v })} label="Commenting" />
          {/* Commenting also allows filling in forms (the same permission bit), as screen readers follow copying. */}
          <Checkbox
            checked={all || s.annotate || s.form}
            disabled={all || s.annotate}
            onChange={(v) => set({ form: v })}
            label="Filling in form fields and signing"
          />
          <Checkbox checked={all || s.copy} disabled={all} onChange={(v) => set({ copy: v })} label="Copying text, images and other content" />
          <Checkbox
            checked={all || s.copy || s.accessibility}
            disabled={all || s.copy}
            onChange={(v) => set({ accessibility: v })}
            label="Text access for screen readers"
          />
        </div>
      </div>
    </div>
  )
}

function RecipientRow({
  r,
  groups,
  groupId,
  now,
  onMove,
  onRemove
}: {
  r: Recipient
  groups: RecipientGroup[]
  groupId: number
  now: number
  onMove: (groupId: number) => void
  onRemove: () => void
}) {
  const warnings = recipientWarnings(r.cert, now)
  return (
    <li className={`${P}-cert-row`} data-testid="cert-recipient">
      <IdCard size={18} className={`${P}-cert-icon`} aria-hidden />
      <span className={`${P}-cert-text`}>
        <span className={`${P}-cert-name`}>
          {r.cert.name}
          {r.mine && <span className={`${P}-chip`}>You</span>}
        </span>
        <span className={`${P}-cert-meta`}>
          {certMeta(r.cert, now)} · {sourceText(r)}
        </span>
        {warnings.map((w) => (
          <span key={w} className={`${P}-cert-warn`}>
            <TriangleAlert size={12} aria-hidden /> {w}
          </span>
        ))}
      </span>
      {groups.length > 1 && (
        <Select
          aria-label={`Group of ${r.cert.name}`}
          value={String(groupId)}
          onChange={(v) => onMove(Number(v))}
          options={groups.map((g, i) => ({ value: String(g.id), label: `Group ${i + 1}` }))}
        />
      )}
      <IconButton icon={X} size={16} label={`Remove ${r.cert.name}`} onClick={onRemove} />
    </li>
  )
}

/**
 * Acrobat's "Certificate Security Settings": recipients in permission groups (one envelope each),
 * from the person's Digital IDs, the Windows certificate store and certificate files. Their own
 * certificate is added by default. Resolves with the groups to encrypt for.
 */
export function CertificateEncryptDialog({ doc, onDone }: { doc: DocumentModel; onDone: (choice?: CertificateEncryptChoice) => void }) {
  const signatures = useDocState(doc, (s) => s.info.signatureCount)
  const security = useDocState(doc, (s) => s.info.security)
  const [sources, setSources] = useState<RecipientSources | null>(null)
  const [own, setOwn] = useState<Recipient | null>(null)
  const [groups, setGroups] = useState<RecipientGroup[]>([{ id: 1, settings: FULL_ACCESS, recipients: [] }])
  const [nextId, setNextId] = useState(2)
  const [editing, setEditing] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const now = useMemo(() => Date.now(), [])

  useEffect(() => {
    let alive = true
    loadRecipientSources()
      .then((s) => {
        if (!alive) return
        const mine = chooseOwnCertificate({ via: doc.state.unlock?.via, ids: s.ids, store: s.store })
        setSources(s)
        setOwn(mine)
        if (mine) setGroups((prev) => addRecipients(prev, prev[0].id, [mine]).groups)
      })
      .catch((err) => {
        if (!alive) return
        showError(err, 'Could not read your certificates')
        setSources({ ids: [], store: [], storeState: 'unavailable' })
      })
    return () => {
      alive = false
    }
  }, [doc])

  const taken = useMemo(() => new Set(groups.flatMap((g) => g.recipients.map((r) => r.id))), [groups])
  const count = recipientCount(groups)
  const ownKept = hasOwnRecipient(groups)

  const add = async (groupId: number) => {
    if (!sources) return
    const picked = await pickRecipients(sources, taken)
    if (!picked?.length) return
    // A certificate file can hold one of the person's own certificates: keep it as theirs.
    const theirs = [...sources.ids, ...sources.store].filter((r) => r.mine)
    const resolved = picked.map((r) => (r.mine ? r : (theirs.find((o) => o.id === r.id) ?? r)))
    // The picker is modal, so the groups have not changed while it was open.
    const res = addRecipients(groups, groupId, resolved)
    setGroups(res.groups)
    setNotice(res.duplicates ? 'Certificates that were already in the list were not added again.' : null)
  }
  const addGroup = () => {
    // A new group starts with everything allowed except changing the security.
    setGroups((prev) => [...prev, { id: nextId, settings: { ...FULL_ACCESS, changeSecurity: false }, recipients: [] }])
    setEditing(nextId)
    setNextId((n) => n + 1)
  }
  const submit = () => {
    if (count) onDone({ groups, own })
  }

  return (
    <Dialog
      title="Encrypt with certificate"
      onClose={() => onDone()}
      width={680}
      className={`${P}-dialog`}
      footer={
        <>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!count} data-testid="cert-encrypt-apply">
            Apply and Save…
          </Button>
        </>
      }
    >
      <div className={`${P}-protect`} data-testid="cert-encrypt-dialog">
        <p className={`${P}-hint`}>
          Only the people you add can open the PDF, each with their own Digital ID, certificate or smart card. No password is needed.
        </p>
        {!sources ? (
          <div className="shell-muted">Loading your certificates…</div>
        ) : (
          groups.map((g, i) => (
            <section key={g.id} className={`${P}-group ${P}-cert-group`} data-testid="cert-group">
              <div className={`${P}-cert-group-head`}>
                <div className={`${P}-cert-text`}>
                  <b>{groups.length > 1 ? `Group ${i + 1}` : 'Recipients'}</b>
                  <span className={`${P}-cert-meta`}>{permissionSummary(g.settings)}</span>
                </div>
                <Button
                  size="sm"
                  variant="quiet"
                  icon={SlidersHorizontal}
                  aria-expanded={editing === g.id}
                  onClick={() => setEditing((e) => (e === g.id ? null : g.id))}
                >
                  Permissions
                </Button>
                {groups.length > 1 && (
                  <IconButton
                    icon={Trash2}
                    size={16}
                    label={`Remove group ${i + 1}`}
                    onClick={() => {
                      // Its recipients stay, in the first remaining group: say so, with what it allows.
                      setNotice(removedGroupNotice(groups, g.id))
                      setGroups((prev) => removeGroup(prev, g.id))
                    }}
                  />
                )}
              </div>
              {editing === g.id && (
                <PermissionsEditor
                  settings={g.settings}
                  onChange={(settings) => setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, settings } : x)))}
                />
              )}
              {g.recipients.length ? (
                <ul className={`${P}-cert-list`}>
                  {g.recipients.map((r) => (
                    <RecipientRow
                      key={r.id}
                      r={r}
                      groups={groups}
                      groupId={g.id}
                      now={now}
                      onMove={(to) => setGroups((prev) => moveRecipient(prev, r.id, to))}
                      onRemove={() => setGroups((prev) => removeRecipient(prev, r.id))}
                    />
                  ))}
                </ul>
              ) : (
                <p className={`${P}-hint`}>No recipients in this group yet.</p>
              )}
              <Button size="sm" icon={UserPlus} onClick={() => void add(g.id)} data-testid="cert-add-recipients">
                Add Recipients…
              </Button>
            </section>
          ))
        )}
        {sources && (
          <div>
            <Button size="sm" variant="quiet" icon={Plus} onClick={addGroup}>
              Add a Group with Other Permissions
            </Button>
          </div>
        )}
        {notice && (
          <div className={`${P}-note`}>
            <Info size={16} />
            <span>{notice}</span>
          </div>
        )}
        {sources && !ownKept && (
          <div className={`${P}-note is-warning`} data-testid="cert-own-warning">
            <TriangleAlert size={16} />
            <span>
              {own
                ? OWN_REMOVED_WARNING
                : 'None of your Digital IDs or certificates is in the list, so you will not be able to open this file yourself. You can create or import a Digital ID in Preferences > Digital IDs.'}
            </span>
          </div>
        )}
        {signatures > 0 && (
          <div className={`${P}-note is-warning`}>
            <TriangleAlert size={16} />
            <span>This document is signed. Encrypting rewrites the file, so its existing signatures will no longer be valid.</span>
          </div>
        )}
        <div className={`${P}-note`}>
          <Info size={16} />
          <span>
            {security ? 'This replaces the current security of the document. ' : ''}
            Next, choose where to save the encrypted PDF. To encrypt this file itself, save over it.
          </span>
        </div>
      </div>
    </Dialog>
  )
}
