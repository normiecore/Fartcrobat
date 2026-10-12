import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import {
  authorName,
  Button,
  Dialog,
  Field,
  invoke,
  openDialog,
  Segmented,
  Select,
  TextInput
} from '@renderer/sdk'
import { validateNewId } from '../lib/digitalId'
import { WrongPasswordError } from '../lib/pkcs12'
import type { DigitalIdRecord } from '../types'
import { COUNTRIES, defaultCountry } from './countries'
import { createDigitalId, importDigitalId } from './ids'

export interface IdResult {
  record: DigitalIdRecord
  /** The password just typed, so the sign dialog does not ask again (kept in memory only). */
  password: string
}

function passwordStrength(pw: string): { label: string; level: 0 | 1 | 2 | 3 } {
  if (!pw) return { label: '', level: 0 }
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (pw.length < 6) return { label: 'Too short', level: 1 }
  if (score <= 2) return { label: 'Weak', level: 1 }
  if (score <= 3) return { label: 'Good', level: 2 }
  return { label: 'Strong', level: 3 }
}

function CreateIdDialog({ onDone }: { onDone: (r?: IdResult) => void }) {
  const [name, setName] = useState(authorName() === 'Author' ? '' : authorName())
  const [organization, setOrganization] = useState('')
  const [unit, setUnit] = useState('')
  const [email, setEmail] = useState('')
  const [country, setCountry] = useState(defaultCountry())
  const [keyType, setKeyType] = useState<'RSA' | 'EC'>('RSA')
  const [years, setYears] = useState('5')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const opts = { name, organization, unit, email, country, keyType, years: parseInt(years, 10), password, confirm }
  const invalid = validateNewId(opts)
  const strength = passwordStrength(password)

  const submit = async () => {
    setTouched(true)
    if (invalid || busy) return
    setBusy(true)
    setError(null)
    try {
      const record = await createDigitalId(opts)
      onDone({ record, password })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Create a Digital ID"
      onClose={() => onDone()}
      onSubmit={() => void submit()}
      width={560}
      className="fc-digital-signatures-dialog"
      footer={
        <>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <p className="fc-digital-signatures-intro">
        A Digital ID is your personal certificate and private key. It is saved on this computer, protected by the password you
        choose, and lets you sign documents so anyone can check they have not been changed.
      </p>
      <div className="fc-digital-signatures-grid2">
        <Field label="Name">
          <TextInput data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Doe" aria-label="Name" />
        </Field>
        <Field label="Email address (optional)">
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" aria-label="Email address" />
        </Field>
        <Field label="Organisation (optional)">
          <TextInput value={organization} onChange={(e) => setOrganization(e.target.value)} aria-label="Organisation" />
        </Field>
        <Field label="Organisational unit (optional)">
          <TextInput value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Organisational unit" />
        </Field>
        <Field label="Country/Region">
          <Select value={country} onChange={setCountry} options={COUNTRIES} aria-label="Country/Region" />
        </Field>
        <Field label="Valid for">
          <Select
            value={years}
            onChange={setYears}
            aria-label="Valid for"
            options={[
              { value: '1', label: '1 year' },
              { value: '2', label: '2 years' },
              { value: '3', label: '3 years' },
              { value: '5', label: '5 years' },
              { value: '10', label: '10 years' }
            ]}
          />
        </Field>
      </div>
      <Field label="Key algorithm" hint={keyType === 'RSA' ? 'Works with every PDF reader.' : 'Smaller and faster; needs a recent PDF reader.'}>
        <Segmented<'RSA' | 'EC'>
          value={keyType}
          onChange={setKeyType}
          options={[
            { value: 'RSA', label: 'RSA 2048-bit' },
            { value: 'EC', label: 'ECDSA P-256' }
          ]}
        />
      </Field>
      <div className="fc-digital-signatures-grid2">
        <Field label="Password">
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="new-password" />
          {strength.label && (
            <span className={`fc-digital-signatures-strength is-${strength.level}`}>
              <i />
              <i />
              <i />
              {strength.label}
            </span>
          )}
        </Field>
        <Field label="Confirm password">
          <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm password" autoComplete="new-password" />
        </Field>
      </div>
      <p className="shell-muted fc-digital-signatures-small">
        You will need this password every time you sign. It cannot be recovered if you forget it.
      </p>
      {(error || (touched && invalid)) && (
        <div className="fc-digital-signatures-error" role="alert">
          {error ?? invalid}
        </div>
      )}
    </Dialog>
  )
}

export function openCreateIdDialog(): Promise<IdResult | undefined> {
  return openDialog<IdResult>((close) => <CreateIdDialog onDone={close} />)
}

function ImportPasswordDialog({ path, onDone }: { path: string; onDone: (r?: IdResult) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const record = await importDigitalId(path, password)
      onDone({ record, password })
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'The password is incorrect. Try again.' : err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Import a Digital ID"
      onClose={() => onDone()}
      onSubmit={() => void submit()}
      width={460}
      footer={
        <>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" disabled={busy || !password} onClick={() => void submit()}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="fc-digital-signatures-importfile">
        <KeyRound size={18} />
        <span>{path.split(/[\\/]/).pop()}</span>
      </div>
      <Field label="Password of the Digital ID file">
        <TextInput data-autofocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Digital ID password" />
      </Field>
      <p className="shell-muted fc-digital-signatures-small">
        Fartcrobat keeps a copy of the file in its settings folder. The password is not stored; you will enter it when you sign.
      </p>
      {error && (
        <div className="fc-digital-signatures-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  )
}

/** Asks for a .pfx/.p12 file and its password, then adds it to the Digital IDs. */
export async function importDigitalIdFlow(): Promise<IdResult | undefined> {
  const paths = await invoke('file:openDialog', {
    title: 'Import a Digital ID',
    filters: [
      { name: 'Digital ID files', extensions: ['pfx', 'p12'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (!paths.length) return undefined
  return openDialog<IdResult>((close) => <ImportPasswordDialog path={paths[0]} onDone={close} />)
}
