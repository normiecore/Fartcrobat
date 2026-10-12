import { useEffect, useMemo, useRef, useState } from 'react'
import { FileKey2, FolderInput, Plus, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button, Checkbox, Dialog, Field, Segmented, Select, TextInput, useDocState, type DocumentModel } from '@renderer/sdk'
import { WrongPasswordError } from '../lib/pkcs12'
import { parseCertificate } from '../lib/x509'
import type { AppearanceContent, AppearanceOptions, DigitalIdRecord, MdpPermission, SignRequest, SignTarget } from '../types'
import { idStatus, recordCertificate, unlockDigitalId } from './ids'
import { importDigitalIdFlow, openCreateIdDialog } from './IdDialogs'
import { DEFAULT_PREFS, loadSavedSignatureImage, loadSignPrefs, REASONS, saveSignPrefs, type SignPrefs } from './prefs'
import { sigOps, useSigStore } from './store'
import { FieldGroup } from './FieldGroup'
import { formatDate } from './format'

export interface SignDialogResult {
  request: Omit<SignRequest, 'time'>
}

const PREVIEW_MAX_W = 380
const PREVIEW_MAX_H = 170

function AppearancePreview({ doc, content, size }: { doc: DocumentModel; content: AppearanceContent; size: { w: number; h: number } }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scale = Math.min(PREVIEW_MAX_W / size.w, PREVIEW_MAX_H / size.h, 3)
  const cssW = Math.round(size.w * scale)
  const cssH = Math.round(size.h * scale)
  const key = JSON.stringify({ ...content, options: { ...content.options, image: content.options.image?.length ?? 0 }, time: Math.floor(content.time / 60000) })
  useEffect(() => {
    let alive = true
    let made: string | null = null
    const t = setTimeout(() => {
      sigOps(doc)
        .previewAppearance(content, size.w, size.h, scale * (window.devicePixelRatio || 1))
        .then((png) => {
          if (!alive) return
          made = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
          setUrl(made)
          setError(null)
        })
        .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
      if (made) URL.revokeObjectURL(made)
    }
    // content is captured through key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key, size.w, size.h, scale])
  return (
    <div className="fc-digital-signatures-preview" style={{ width: cssW, height: cssH }} aria-label="Signature appearance preview" role="img">
      {url && <img src={url} alt="" draggable={false} style={{ width: cssW, height: cssH }} />}
      {error && <span className="fc-digital-signatures-error">{error}</span>}
    </div>
  )
}

function IdCard({ rec, selected, onSelect }: { rec: DigitalIdRecord; selected: boolean; onSelect: () => void }) {
  const status = idStatus(rec)
  return (
    <label className={`fc-digital-signatures-idcard ${selected ? 'is-selected' : ''} ${status !== 'valid' ? 'is-disabled' : ''}`}>
      <input type="radio" name="fc-digital-id" checked={selected} onChange={onSelect} disabled={status !== 'valid'} aria-label={rec.name} />
      <FileKey2 size={22} className="fc-digital-signatures-idicon" />
      <span className="fc-digital-signatures-idtext">
        <span className="fc-digital-signatures-idname">
          {rec.name}
          {rec.email && <span className="shell-muted"> &lt;{rec.email}&gt;</span>}
        </span>
        <span className="fc-digital-signatures-idmeta">
          {rec.selfSigned ? 'Self-signed' : `Issued by ${rec.issuer}`} · {rec.keyType} ·{' '}
          {status === 'expired' ? (
            <b className="fc-digital-signatures-bad">Expired {formatDate(rec.notAfter)}</b>
          ) : status === 'not-yet-valid' ? (
            <b className="fc-digital-signatures-bad">Valid from {formatDate(rec.notBefore)}</b>
          ) : (
            <>Expires {formatDate(rec.notAfter)}</>
          )}
        </span>
      </span>
    </label>
  )
}

export function SignDialog({
  doc,
  mode,
  target,
  size,
  initialPermission,
  onDone
}: {
  doc: DocumentModel
  mode: 'sign' | 'certify'
  target: SignTarget
  /** Visible signature size in points, or null for an invisible signature. */
  size: { w: number; h: number } | null
  initialPermission: MdpPermission
  onDone: (r?: SignDialogResult) => void
}) {
  const ids = useSigStore((s) => s.ids)
  const dirty = useDocState(doc, (s) => s.dirty)
  const [prefs, setPrefs] = useState<SignPrefs | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState('')
  const [location, setLocation] = useState('')
  const [contactInfo, setContactInfo] = useState('')
  const [appearance, setAppearance] = useState<Omit<AppearanceOptions, 'image'>>(DEFAULT_PREFS.appearance)
  const [subFilter, setSubFilter] = useState<SignPrefs['subFilter']>('ETSI.CAdES.detached')
  const [permission, setPermission] = useState<MdpPermission>(initialPermission)
  const [lock, setLock] = useState(false)
  const [savedImage, setSavedImage] = useState<Uint8Array | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now] = useState(() => Date.now())
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([loadSignPrefs(), loadSavedSignatureImage()]).then(([p, img]) => {
      if (!alive) return
      setPrefs(p)
      setReason(p.reason)
      setLocation(p.location)
      setContactInfo(p.contactInfo)
      setSubFilter(p.subFilter)
      setSavedImage(img)
      setAppearance({ ...p.appearance, graphic: p.appearance.graphic === 'image' && !img ? 'name' : p.appearance.graphic })
      const usable = useSigStore.getState().ids.filter((r) => idStatus(r) === 'valid')
      setSelectedId((cur) => cur ?? (usable.find((r) => r.id === p.lastIdId) ?? usable[0])?.id ?? null)
    })
    return () => {
      alive = false
    }
  }, [])

  const rec = ids.find((r) => r.id === selectedId) ?? null
  // Once the remembered ID is picked, the password is the only thing left to type.
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (!prefs || !rec || focusedOnce.current) return
    focusedOnce.current = true
    passwordRef.current?.focus()
  }, [prefs, rec])
  const dn = useMemo(() => {
    if (!rec) return ''
    try {
      return parseCertificate(recordCertificate(rec)).subject.text
    } catch {
      return ''
    }
  }, [rec])
  const content: AppearanceContent = {
    name: rec?.name ?? 'Your Name',
    distinguishedName: dn,
    reason,
    location,
    time: now,
    certify: mode === 'certify',
    options: { ...appearance, image: appearance.graphic === 'image' ? savedImage : null }
  }

  const addId = async (how: 'create' | 'import') => {
    const r = how === 'create' ? await openCreateIdDialog() : await importDigitalIdFlow()
    if (!r) return
    setSelectedId(r.record.id)
    setPassword(r.password)
    setError(null)
  }

  const submit = async () => {
    if (busy) return
    if (!rec) {
      setError('Choose a Digital ID, or create one.')
      return
    }
    if (idStatus(rec) !== 'valid') {
      setError(`The Digital ID “${rec.name}” is not valid now (it expired or is not valid yet). Choose another ID or create a new one.`)
      return
    }
    if (!password) {
      setError('Enter the password of your Digital ID.')
      passwordRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const id = await unlockDigitalId(rec, password)
      const p: SignPrefs = { ...(prefs ?? DEFAULT_PREFS), lastIdId: rec.id, reason, location, contactInfo, appearance, subFilter }
      void saveSignPrefs(p)
      onDone({
        request: {
          mode,
          target,
          key: { pkcs8: id.pkcs8, alg: id.keyAlg },
          chain: id.chain,
          appearance: { ...content, name: rec.name },
          reason,
          location,
          contactInfo,
          permission: mode === 'certify' ? permission : undefined,
          lock: mode === 'sign' ? lock : undefined,
          subFilter
        }
      })
    } catch (err) {
      setBusy(false)
      if (err instanceof WrongPasswordError) {
        setError('The password is incorrect. Try again.')
        passwordRef.current?.select()
      } else setError(err instanceof Error ? err.message : String(err))
    }
  }

  const opt = (k: keyof Omit<AppearanceOptions, 'image' | 'graphic'>) => (v: boolean) => setAppearance((a) => ({ ...a, [k]: v }))
  const title = mode === 'certify' ? (size ? 'Certify with a Digital ID' : 'Certify with a Digital ID (invisible)') : 'Sign with a Digital ID'

  return (
    <Dialog
      title={title}
      onClose={() => onDone()}
      onSubmit={() => void submit()}
      width={880}
      className="fc-digital-signatures-dialog fc-digital-signatures-signdialog"
      footer={
        <>
          <span className="fc-digital-signatures-footnote shell-muted">
            {dirty ? 'Your unsaved changes are included in the signed copy. ' : ''}You will choose where to save the signed copy next.
          </span>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" icon={ShieldCheck} disabled={busy || !rec} onClick={() => void submit()}>
            {busy ? 'Checking…' : mode === 'certify' ? 'Certify' : 'Sign'}
          </Button>
        </>
      }
    >
      <div className="fc-digital-signatures-signgrid">
        <div className="fc-digital-signatures-col">
          <div className="fc-digital-signatures-sectiontitle">Digital ID</div>
          {ids.length === 0 ? (
            <div className="fc-digital-signatures-noid">
              <p>
                You don't have a Digital ID yet. A Digital ID proves who signed and shows if the document changes later. Creating one
                takes a few seconds.
              </p>
              <div className="fc-digital-signatures-row">
                <Button variant="accent" icon={Plus} data-autofocus onClick={() => void addId('create')}>
                  Create a Digital ID
                </Button>
                <Button icon={FolderInput} onClick={() => void addId('import')}>
                  Import from file
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="fc-digital-signatures-idlist" role="radiogroup" aria-label="Digital IDs">
                {ids.map((r) => (
                  <IdCard
                    key={r.id}
                    rec={r}
                    selected={r.id === selectedId}
                    onSelect={() => {
                      setSelectedId(r.id)
                      setPassword('')
                      setError(null)
                    }}
                  />
                ))}
              </div>
              <div className="fc-digital-signatures-row">
                <Button size="sm" variant="quiet" icon={Plus} onClick={() => void addId('create')}>
                  Create new ID
                </Button>
                <Button size="sm" variant="quiet" icon={FolderInput} onClick={() => void addId('import')}>
                  Import ID file
                </Button>
              </div>
            </>
          )}
          <Field label={rec ? `Password for “${rec.name}”` : 'Password'}>
            <input
              ref={passwordRef}
              className="ui-input"
              data-autofocus
              type="password"
              value={password}
              disabled={!rec}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="Digital ID password"
              autoComplete="off"
            />
          </Field>
          <Field label="Reason">
            <TextInput list="fc-digital-signatures-reasons" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" aria-label="Reason" />
            <datalist id="fc-digital-signatures-reasons">
              {REASONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <div className="fc-digital-signatures-grid2">
            <Field label="Location">
              <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Optional, e.g. a city" aria-label="Location" />
            </Field>
            <Field label="Contact info">
              <TextInput value={contactInfo} onChange={(e) => setContactInfo(e.target.value)} placeholder="Optional, e.g. phone or email" aria-label="Contact info" />
            </Field>
          </div>
          {mode === 'certify' ? (
            <Field label="Allowed after certifying">
              <Select<string>
                value={String(permission)}
                onChange={(v) => setPermission(Number(v) as MdpPermission)}
                aria-label="Allowed after certifying"
                options={[
                  { value: '1', label: 'No changes allowed' },
                  { value: '2', label: 'Filling in forms and signing' },
                  { value: '3', label: 'Filling in forms, signing and commenting' }
                ]}
              />
            </Field>
          ) : (
            <Checkbox checked={lock} onChange={setLock} label="Lock document after signing (no further changes or signatures)" />
          )}
        </div>
        <div className="fc-digital-signatures-col">
          <div className="fc-digital-signatures-sectiontitle">Appearance</div>
          {size ? (
            <>
              <div className="fc-digital-signatures-previewwrap">
                <AppearancePreview doc={doc} content={content} size={size} />
              </div>
              <FieldGroup label="Show on the left">
                <Segmented<AppearanceOptions['graphic']>
                  value={appearance.graphic}
                  onChange={(g) => setAppearance((a) => ({ ...a, graphic: g }))}
                  options={[
                    { value: 'name', label: 'Name' },
                    ...(savedImage ? [{ value: 'image' as const, label: 'My signature', title: 'Your saved signature from Fill & Sign' }] : []),
                    { value: 'none', label: 'Nothing' }
                  ]}
                />
              </FieldGroup>
              {!savedImage && (
                <p className="shell-muted fc-digital-signatures-small">
                  Tip: save a handwritten signature in Fill &amp; Sign to show it here.
                </p>
              )}
              <div className="fc-digital-signatures-checks">
                <Checkbox checked={appearance.showName} onChange={opt('showName')} label="Name" />
                <Checkbox checked={appearance.showDate} onChange={opt('showDate')} label="Date" />
                <Checkbox checked={appearance.showReason} onChange={opt('showReason')} label="Reason" />
                <Checkbox checked={appearance.showLocation} onChange={opt('showLocation')} label="Location" />
                <Checkbox checked={appearance.showDistinguishedName} onChange={opt('showDistinguishedName')} label="Distinguished name" />
                <Checkbox checked={appearance.showLabels} onChange={opt('showLabels')} label="Labels" />
              </div>
            </>
          ) : (
            <div className="fc-digital-signatures-invisible">
              <ShieldCheck size={28} />
              <p>
                {mode === 'certify'
                  ? 'An invisible certification does not appear on any page. It shows in the Signatures panel and in the blue bar at the top of the document.'
                  : 'This signature field is invisible: nothing is drawn on the page. The signature shows in the Signatures panel.'}
              </p>
            </div>
          )}
          <Field label="Signature format" hint={subFilter === 'ETSI.CAdES.detached' ? 'PAdES (CAdES-based), like current Acrobat.' : 'Compatible with older PDF readers.'}>
            <Select<SignPrefs['subFilter']>
              value={subFilter}
              onChange={setSubFilter}
              aria-label="Signature format"
              options={[
                { value: 'ETSI.CAdES.detached', label: 'CAdES-Equivalent (recommended)' },
                { value: 'adbe.pkcs7.detached', label: 'PKCS#7 – Detached' }
              ]}
            />
          </Field>
        </div>
      </div>
      {error && (
        <div className="fc-digital-signatures-error" role="alert">
          <TriangleAlert size={16} /> {error}
        </div>
      )}
    </Dialog>
  )
}
