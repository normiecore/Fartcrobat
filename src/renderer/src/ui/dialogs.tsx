import { useState, type ReactNode } from 'react'
import { openDialog } from '../app/ui-services'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { TextInput } from './Field'

export interface ConfirmButton<T extends string> {
  id: T
  label: string
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet'
}

/** Asks a question with custom buttons. Resolves with the clicked button id, or null if dismissed. */
export async function ask<T extends string>(opts: {
  title: string
  message: ReactNode
  buttons: ConfirmButton<T>[]
  width?: number
}): Promise<T | null> {
  const r = await openDialog<T>((close) => (
    <Dialog
      title={opts.title}
      onClose={() => close()}
      width={opts.width ?? 440}
      footer={opts.buttons.map((b) => (
        <Button key={b.id} variant={b.variant ?? 'secondary'} onClick={() => close(b.id)}>
          {b.label}
        </Button>
      ))}
    >
      <div className="ui-dialog-message">{opts.message}</div>
    </Dialog>
  ))
  return r ?? null
}

export async function confirm(opts: {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  const r = await ask({
    title: opts.title,
    message: opts.message,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: opts.confirmLabel ?? 'OK', variant: opts.danger ? 'danger' : 'primary' }
    ]
  })
  return r === 'ok'
}

export async function alertDialog(title: string, message: ReactNode): Promise<void> {
  await ask({ title, message, buttons: [{ id: 'ok', label: 'OK', variant: 'primary' }] })
}

function PromptBody({
  label,
  initial,
  password,
  placeholder,
  validate,
  onDone,
  okLabel,
  title,
  message
}: {
  label?: string
  initial: string
  password?: boolean
  placeholder?: string
  validate?: (v: string) => string | null
  onDone: (v?: string) => void
  okLabel: string
  title: string
  message?: ReactNode
}) {
  const [value, setValue] = useState(initial)
  const error = validate ? validate(value) : null
  const submit = () => {
    if (!error) onDone(value)
  }
  return (
    <Dialog
      title={title}
      onClose={() => onDone()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="primary" disabled={!!error} onClick={submit}>
            {okLabel}
          </Button>
        </>
      }
    >
      {message && <div className="ui-dialog-message">{message}</div>}
      <label className="ui-field">
        {label && <span className="ui-field-label">{label}</span>}
        <TextInput
          data-autofocus
          type={password ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && value && <span className="ui-field-error">{error}</span>}
      </label>
    </Dialog>
  )
}

/** Text input dialog. Resolves with the text, or null if cancelled. */
export async function prompt(opts: {
  title: string
  label?: string
  message?: ReactNode
  initial?: string
  password?: boolean
  placeholder?: string
  okLabel?: string
  validate?: (v: string) => string | null
}): Promise<string | null> {
  const r = await openDialog<string>((close) => (
    <PromptBody
      title={opts.title}
      label={opts.label}
      message={opts.message}
      initial={opts.initial ?? ''}
      password={opts.password}
      placeholder={opts.placeholder}
      validate={opts.validate}
      okLabel={opts.okLabel ?? 'OK'}
      onDone={(v) => close(v)}
    />
  ))
  return r ?? null
}
