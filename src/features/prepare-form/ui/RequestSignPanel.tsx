import { useEffect, useMemo, useState } from 'react'
import { Calendar, Copy, FolderOpen, Info, Mail, Send, Signature, UserPlus, X } from 'lucide-react'
import {
  Button,
  invoke,
  isMac,
  saveDocument,
  Section,
  showError,
  toast,
  ToolPanelFrame,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { enterFormEditing, selectFields, updateFields } from './actions'
import { useAllFields } from './hooks'
import { usePF, type Signer } from './state'

const SIGNER_RE = /^Signature of (.+)$/

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The email Fartcrobat opens in the user's mail app. */
export function mailtoLink(title: string, signers: Signer[], path: string | null): string {
  const to = signers
    .map((s) => s.email.trim())
    .filter((e) => EMAIL_RE.test(e))
    .join(',')
  const names = signers.map((s) => s.name).join(', ')
  const subject = `Please sign: ${title}`
  const body = [
    'Hello,',
    '',
    `Please review and sign the attached document “${title}”.${names ? ` Signature fields are marked for: ${names}.` : ''}`,
    '',
    'You can sign it with Fartcrobat, Adobe Acrobat Reader or any PDF app that supports signature fields, then send the signed file back to me.',
    ...(path ? ['', `(File: ${path})`] : []),
    '',
    'Thank you!'
  ].join('\n')
  return `mailto:${encodeURIComponent(to).replace(/%2C/g, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/** "Request e-signatures": the offline version of Acrobat's send-for-signature workflow. */
export function RequestSignPanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame title="Request e-signatures">
      {doc ? <RequestSignBody doc={doc} /> : <p className="shell-muted">Open a PDF to request signatures.</p>}
    </ToolPanelFrame>
  )
}

function RequestSignBody({ doc }: { doc: DocumentModel }) {
  const { fields } = useAllFields(doc)
  const stored = usePF((s) => s.signers[doc.id])
  const pending = usePF((s) => s.pendingSigner)
  const filePath = useDocState(doc, (s) => s.filePath)
  const dirty = useDocState(doc, (s) => s.dirty)
  const title = useDocState(doc, (s) => s.title)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<string | null>(null)

  const sigFields = fields.filter((f) => f.type === 'signature')
  // signers come from what was entered here, plus names already on signature fields
  const signers = useMemo(() => {
    const list = [...(stored ?? [])]
    for (const f of sigFields) {
      const m = SIGNER_RE.exec(f.tooltip)
      if (m && !list.some((s) => s.name === m[1])) list.push({ name: m[1], email: '' })
    }
    return list
  }, [stored, sigFields])

  useEffect(() => {
    if (!stored && signers.length) usePF.setState((s) => ({ signers: { ...s.signers, [doc.id]: signers } }))
  }, [stored, signers, doc.id])

  const setSigners = (list: Signer[]) =>
    usePF.setState((s) => ({ signers: { ...s.signers, [doc.id]: list } }))

  const addSigner = () => {
    const n = name.trim()
    if (!n) return
    if (signers.some((s) => s.name.toLowerCase() === n.toLowerCase())) {
      toast(`${n} is already in the list.`)
      return
    }
    setSigners([...signers, { name: n, email: email.trim() }])
    setName('')
    setEmail('')
  }

  const place = (signer: Signer, kind: 'signature' | 'date') => {
    // the form toolbar tells the user to click or drag on the page
    enterFormEditing(kind === 'signature' ? 'form.signature' : 'form.date')
    usePF.setState({ pendingSigner: signer })
  }

  const saveAndShare = async () => {
    if (!sigFields.length) {
      toast('Add at least one signature field first.', { kind: 'warning' })
      return
    }
    if (dirty || !filePath) {
      const ok = await saveDocument(doc)
      if (!ok) return
    }
    const path = doc.state.filePath
    try {
      await invoke('shell:openExternal', mailtoLink(doc.state.title, signers, path))
      setSent(path)
    } catch (err) {
      showError(err, 'Could not open your email app')
      setSent(path)
    }
  }

  const fieldsOf = (s: Signer) => sigFields.filter((f) => f.tooltip === `Signature of ${s.name}`)

  /** Assigns a signature field to a signer (stored as the field's tooltip, like Acrobat's signer roles). */
  const assign = async (id: number, signer: string) => {
    await updateFields(
      doc,
      [id],
      signer ? { tooltip: `Signature of ${signer}`, required: true } : { tooltip: '' }
    )
  }
  const unassigned = sigFields.filter((f) => !SIGNER_RE.test(f.tooltip))

  return (
    <div className="fc-prepare-form-left fc-prepare-form-request">
      <div className="fc-prepare-form-note">
        <Info size={16} aria-hidden />
        <span>
          Fartcrobat works offline, so it doesn’t send documents through a signing service. Add a signature
          field for each signer, then save the PDF and email it to them — they can sign it in any PDF app.
        </span>
      </div>

      <Section title="1. Who needs to sign?">
        <div className="fc-prepare-form-signer-form">
          <input
            className="ui-input"
            placeholder="Name"
            aria-label="Signer name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSigner()}
          />
          <input
            className="ui-input"
            placeholder="Email (optional)"
            aria-label="Signer email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSigner()}
          />
          <Button icon={UserPlus} onClick={addSigner} disabled={!name.trim()}>
            Add signer
          </Button>
        </div>
        {signers.length === 0 && (
          <p className="fc-prepare-form-hint">Add the people who need to sign, in signing order.</p>
        )}
        <ol className="fc-prepare-form-signers">
          {signers.map((s, i) => {
            const count = fieldsOf(s).length
            return (
              <li key={s.name} className={pending?.name === s.name ? 'is-pending' : ''}>
                <div className="fc-prepare-form-signer-head">
                  <span className="fc-prepare-form-signer-num">{i + 1}</span>
                  <span className="fc-prepare-form-signer-name">
                    <b>{s.name}</b>
                    <span className="shell-muted">{s.email || 'no email'}</span>
                  </span>
                  <button
                    className="ui-icon-btn"
                    aria-label={`Remove ${s.name}`}
                    title="Remove signer"
                    onClick={() => setSigners(signers.filter((x) => x !== s))}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="fc-prepare-form-signer-actions">
                  <Button size="sm" icon={Signature} onClick={() => place(s, 'signature')}>
                    Signature field
                  </Button>
                  <Button size="sm" icon={Calendar} onClick={() => place(s, 'date')}>
                    Date field
                  </Button>
                  <span className="shell-muted">
                    {count} field{count === 1 ? '' : 's'}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      </Section>

      <Section title="2. Signature fields">
        {sigFields.length === 0 ? (
          <p className="fc-prepare-form-hint">
            No signature fields yet. Use “Signature field” next to a signer, then click on the page where they
            should sign.
          </p>
        ) : (
          <ul className="fc-prepare-form-sigfields">
            {sigFields.map((f) => {
              const assigned = SIGNER_RE.exec(f.tooltip)?.[1] ?? ''
              return (
                <li key={f.id}>
                  <div>
                    <button
                      className="fc-prepare-form-link"
                      onClick={() => {
                        enterFormEditing()
                        selectFields(doc, f.page, [f.id])
                        doc.view?.scrollToRect(f.page, f.rect, { center: true })
                      }}
                    >
                      {f.name}
                    </button>
                    <span className="shell-muted"> · page {f.page + 1}</span>
                  </div>
                  <select
                    className="ui-input ui-select fc-prepare-form-assign"
                    aria-label={`Signer of ${f.name}`}
                    value={assigned}
                    onChange={(e) => void assign(f.id, e.target.value)}
                  >
                    <option value="">No signer</option>
                    {[
                      ...signers.map((s) => s.name),
                      ...(assigned && !signers.some((s) => s.name === assigned) ? [assigned] : [])
                    ].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>
        )}
        {unassigned.length > 0 && signers.length > 0 && (
          <p className="fc-prepare-form-hint">
            Choose who signs each field. The signer’s name becomes the field’s tooltip.
          </p>
        )}
      </Section>

      <Section title="3. Send">
        <Button
          variant="primary"
          icon={Send}
          onClick={() => void saveAndShare()}
          disabled={!sigFields.length}
        >
          Save and share
        </Button>
        <p className="fc-prepare-form-hint">
          Saves the PDF and opens your email app with a message to{' '}
          {signers.some((s) => s.email) ? 'the signers' : 'your signers'}. Attach the saved file to the email.
        </p>
        {sent && (
          <div
            className="fc-prepare-form-sent"
            role="status"
            ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
          >
            <div>
              <Mail size={16} aria-hidden /> <b>Your email app should open now.</b>
            </div>
            <div className="shell-muted">Attach this file to the message:</div>
            <code className="fc-prepare-form-path">{sent}</code>
            <div className="fc-prepare-form-sent-actions">
              <Button size="sm" icon={FolderOpen} onClick={() => void invoke('shell:showItemInFolder', sent)}>
                {isMac ? 'Reveal in Finder' : 'Show in folder'}
              </Button>
              <Button
                size="sm"
                icon={Copy}
                onClick={async () => {
                  await invoke('clipboard:writeText', sent)
                  toast('File path copied', { timeout: 1500 })
                }}
              >
                Copy path
              </Button>
              <Button
                size="sm"
                icon={Mail}
                onClick={() => void invoke('shell:openExternal', mailtoLink(title, signers, sent))}
              >
                Open email again
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}
