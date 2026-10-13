import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, Info, TriangleAlert } from 'lucide-react'
import { Button, Checkbox, Dialog, Select, useDocState, type DocumentModel } from '@renderer/sdk'
import {
  CHANGES_OPTIONS,
  DEFAULT_PROTECT_SETTINGS,
  ENCRYPTION_METHODS,
  PRINTING_OPTIONS,
  passwordStrength,
  validateProtect,
  type ChangesAllowed,
  type EncryptionMethod,
  type PrintingAllowed,
  type ProtectSettings
} from './shared'

const P = 'fc-protect-optimize'

function PasswordField({
  label,
  value,
  onChange,
  error,
  autoFocus,
  disabled,
  testId
}: {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  autoFocus?: boolean
  disabled?: boolean
  testId?: string
}) {
  const [show, setShow] = useState(false)
  const id = useId()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    // After the dialog has focused its first control.
    const t = setTimeout(() => ref.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [autoFocus])
  return (
    <div className={`${P}-pw-field`}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <div className={`${P}-pw-input`}>
        <input
          id={id}
          ref={ref}
          className="ui-input"
          type={show ? 'text' : 'password'}
          value={value}
          disabled={disabled}
          autoComplete="new-password"
          spellCheck={false}
          data-testid={testId}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="ui-icon-btn"
          disabled={disabled}
          aria-label={show ? 'Hide password' : 'Show password'}
          title={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow((v) => !v)}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {error && <span className="ui-field-error">{error}</span>}
    </div>
  )
}

function StrengthMeter({ password }: { password: string }) {
  const { score, label } = passwordStrength(password)
  return (
    <div className={`${P}-strength`} aria-live="polite">
      <div className={`${P}-strength-bars is-${score}`} aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={i <= score ? 'is-on' : ''} />
        ))}
      </div>
      <span className={`${P}-strength-label`}>{label ? `Password strength: ${label}` : 'Password strength'}</span>
    </div>
  )
}

/**
 * Acrobat's "Password Security - Settings": an open password, a permissions password with printing,
 * changes and copying choices, and the encryption level. Resolves with the settings to apply.
 */
export function ProtectDialog({
  doc,
  mode,
  initial,
  onDone
}: {
  doc: DocumentModel
  mode: 'password' | 'restrict'
  /** Choices ticked when the dialog opens (agent access); by default the mode decides. */
  initial?: Partial<Pick<ProtectSettings, 'requireOpenPassword' | 'restrictEditing'>>
  onDone: (settings?: ProtectSettings) => void
}) {
  const signatures = useDocState(doc, (s) => s.info.signatureCount)
  const [s, setS] = useState<ProtectSettings>(() => ({
    ...DEFAULT_PROTECT_SETTINGS,
    requireOpenPassword: mode === 'password',
    restrictEditing: mode === 'restrict',
    ...initial
  }))
  const [confirmOpen, setConfirmOpen] = useState('')
  const [confirmPerms, setConfirmPerms] = useState('')
  const [attempted, setAttempted] = useState(false)
  const set = (patch: Partial<ProtectSettings>) => setS((prev) => ({ ...prev, ...patch }))
  const errors = validateProtect(s, confirmOpen, confirmPerms)
  const shown = attempted ? errors : {}
  // Live feedback that is useful while typing.
  const commaOpen = s.openPassword.includes(',') ? errors.open : undefined
  const commaPerms = s.permissionsPassword.includes(',') ? errors.perms : undefined
  const valid = Object.keys(errors).length === 0
  const submit = () => {
    setAttempted(true)
    if (valid) onDone(s)
  }
  return (
    <Dialog
      title={mode === 'restrict' ? 'Restrict editing' : 'Protect using password'}
      onClose={() => onDone()}
      onSubmit={submit}
      width={600}
      className={`${P}-dialog`}
      footer={
        <>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" onClick={submit} data-testid="protect-apply">
            Apply and Save…
          </Button>
        </>
      }
    >
      <div className={`${P}-protect`}>
        <section className={`${P}-group`}>
          <Checkbox
            checked={s.requireOpenPassword}
            onChange={(v) => set({ requireOpenPassword: v })}
            label={<b>Require a password to open the document</b>}
          />
          <div className={`${P}-group-body ${s.requireOpenPassword ? '' : 'is-disabled'}`}>
            <div className={`${P}-pw-row`}>
              <PasswordField
                label="Document open password"
                value={s.openPassword}
                onChange={(v) => set({ openPassword: v })}
                error={shown.open ?? commaOpen}
                disabled={!s.requireOpenPassword}
                autoFocus={mode === 'password'}
                testId="protect-open-password"
              />
              <PasswordField
                label="Confirm password"
                value={confirmOpen}
                onChange={setConfirmOpen}
                error={shown.openConfirm}
                disabled={!s.requireOpenPassword}
                testId="protect-open-confirm"
              />
            </div>
            {s.requireOpenPassword && <StrengthMeter password={s.openPassword} />}
          </div>
        </section>

        <section className={`${P}-group`}>
          <Checkbox
            checked={s.restrictEditing}
            onChange={(v) => set({ restrictEditing: v })}
            label={<b>Restrict editing and printing of the document</b>}
          />
          <div className={`${P}-group-body ${s.restrictEditing ? '' : 'is-disabled'}`}>
            <p className={`${P}-hint`}>A permissions password is needed to change these settings.</p>
            <div className={`${P}-pw-row`}>
              <PasswordField
                label="Change permissions password"
                value={s.permissionsPassword}
                onChange={(v) => set({ permissionsPassword: v })}
                error={shown.perms ?? commaPerms}
                disabled={!s.restrictEditing}
                autoFocus={mode === 'restrict'}
                testId="protect-perms-password"
              />
              <PasswordField
                label="Confirm password"
                value={confirmPerms}
                onChange={setConfirmPerms}
                error={shown.permsConfirm}
                disabled={!s.restrictEditing}
                testId="protect-perms-confirm"
              />
            </div>
            <div className={`${P}-perm-grid`}>
              <label className="ui-field-label" htmlFor={`${P}-printing`}>
                Printing allowed
              </label>
              <Select<PrintingAllowed>
                id={`${P}-printing`}
                value={s.printing}
                disabled={!s.restrictEditing}
                onChange={(v) => set({ printing: v })}
                options={PRINTING_OPTIONS}
              />
              <label className="ui-field-label" htmlFor={`${P}-changes`}>
                Changes allowed
              </label>
              <Select<ChangesAllowed>
                id={`${P}-changes`}
                value={s.changes}
                disabled={!s.restrictEditing}
                onChange={(v) => set({ changes: v })}
                options={CHANGES_OPTIONS}
              />
            </div>
            <div className={`${P}-checks`}>
              <Checkbox
                checked={s.allowCopy}
                disabled={!s.restrictEditing}
                onChange={(v) => set({ allowCopy: v })}
                label="Enable copying of text, images, and other content"
              />
              <Checkbox
                checked={s.allowCopy || s.allowScreenReaders}
                disabled={!s.restrictEditing || s.allowCopy}
                onChange={(v) => set({ allowScreenReaders: v })}
                label="Enable text access for screen reader devices for the visually impaired"
              />
            </div>
          </div>
        </section>

        <section className={`${P}-group ${P}-group-plain`}>
          <div className={`${P}-perm-grid`}>
            <label className="ui-field-label" htmlFor={`${P}-method`}>
              Encryption level
            </label>
            <Select<EncryptionMethod>
              id={`${P}-method`}
              value={s.method}
              onChange={(v) => set({ method: v })}
              options={ENCRYPTION_METHODS.map((m) => ({ value: m.value, label: m.label }))}
            />
          </div>
          <p className={`${P}-hint`}>{ENCRYPTION_METHODS.find((m) => m.value === s.method)?.hint} Passwords can’t contain commas.</p>
        </section>

        {shown.general && (
          <div className={`${P}-note is-error`} role="alert">
            <TriangleAlert size={16} />
            <span>{shown.general}</span>
          </div>
        )}
        {signatures > 0 && (
          <div className={`${P}-note is-warning`}>
            <TriangleAlert size={16} />
            <span>This document is signed. Adding security rewrites the file, so its existing signatures will no longer be valid.</span>
          </div>
        )}
        <div className={`${P}-note`}>
          <Info size={16} />
          <span>
            Next, choose where to save the protected PDF. To protect this file itself, save over it. Passwords can’t be recovered, so keep
            them safe.
          </span>
        </div>
      </div>
    </Dialog>
  )
}
