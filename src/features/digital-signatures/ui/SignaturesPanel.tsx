import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleX, Eraser, FileSearch, FileSignature, Info, MoreHorizontal, RefreshCw, ScrollText } from 'lucide-react'
import { Button, EmptyState, IconButton, openToolGroup, showContextMenu, useDocState, type ContextMenuItem, type DocumentModel } from '@renderer/sdk'
import { overallStatus, permissionText, signatureStatus } from '../status'
import type { SignatureFieldInfo, SignatureReport } from '../types'
import { clearSignature, goToSignature, validateAll, viewSignedVersion } from './actions'
import { startSigning } from './flow'
import { openCertificateViewer, openSignatureProperties } from './Properties'
import { StatusIcon } from './StatusIcon'
import { useDocSignatures, useTrustedSet } from './store'
import { formatDateTime } from './format'

export function signatureMenuItems(doc: DocumentModel, r: SignatureReport, locked: boolean): ContextMenuItem[] {
  return [
    { id: 'validate', label: 'Validate Signature', icon: RefreshCw, run: () => void validateAll(doc, { announce: true }) },
    { id: 'props', label: 'Show Signature Properties…', icon: Info, run: () => openSignatureProperties(doc, r.fieldName) },
    { id: 'cert', label: "Show Signer's Certificate…", icon: ScrollText, disabled: !r.certificates.length, run: () => openCertificateViewer(r.certificates) },
    { id: 'version', label: 'View Signed Version', icon: FileSearch, disabled: !r.revisionEnd, run: () => void viewSignedVersion(doc, r) },
    { id: 'goto', label: 'Go to Signature Field', disabled: r.invisible, run: () => goToSignature(doc, r) },
    { id: 'sep', label: '', separator: true },
    { id: 'clear', label: 'Clear Signature', icon: Eraser, danger: true, disabled: locked, run: () => void clearSignature(doc, r.fieldName) }
  ]
}

function SignatureEntry({ doc, r, locked }: { doc: DocumentModel; r: SignatureReport; locked: boolean }) {
  const trusted = useTrustedSet()
  const [open, setOpen] = useState(false)
  const st = signatureStatus(r, trusted)
  const verb = r.kind === 'timestamp' ? 'Timestamped by' : r.kind === 'certification' ? 'Certified by' : 'Signed by'
  const menu = (e: React.MouseEvent) => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, signatureMenuItems(doc, r, locked))
  }
  return (
    <li className={`fc-digital-signatures-entry is-${st.level}`} onContextMenu={menu}>
      <div className="fc-digital-signatures-entry-head">
        <button
          className="fc-digital-signatures-entry-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${r.fieldName}`}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button className="fc-digital-signatures-entry-main" onClick={() => goToSignature(doc, r)} onDoubleClick={() => openSignatureProperties(doc, r.fieldName)}>
          <StatusIcon level={st.level} />
          <span className="fc-digital-signatures-entry-text">
            <span className="fc-digital-signatures-entry-title">
              {r.revision ? `Rev. ${r.revision}: ` : ''}
              {verb} {r.signerName}
            </span>
            <span className="fc-digital-signatures-entry-status">{st.title}</span>
          </span>
        </button>
        <IconButton
          icon={MoreHorizontal}
          label="Signature options"
          size={16}
          onClick={(e) => {
            const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
            showContextMenu(b.right - 220, b.bottom + 2, signatureMenuItems(doc, r, locked))
          }}
        />
      </div>
      {open && (
        <div className="fc-digital-signatures-entry-body">
          <ul className="fc-digital-signatures-bullets">
            {st.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
          {r.changes.length > 0 && (
            <ul className="fc-digital-signatures-changes">
              {r.changes.map((c, i) => (
                <li key={i} className={c.allowed ? 'is-allowed' : 'is-disallowed'}>
                  {c.allowed ? <CircleCheck size={13} /> : <CircleX size={13} />}
                  <span>{c.description}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="fc-digital-signatures-dl">
            {r.reason && (
              <>
                <dt>Reason</dt>
                <dd>{r.reason}</dd>
              </>
            )}
            {r.location && (
              <>
                <dt>Location</dt>
                <dd>{r.location}</dd>
              </>
            )}
            <dt>Signing time</dt>
            <dd>{formatDateTime(r.timestamp?.valid ? r.timestamp.time : r.signingTime)}</dd>
            <dt>Field</dt>
            <dd>
              {r.fieldName}
              {r.invisible ? ' (invisible)' : ` on page ${r.page + 1}`}
            </dd>
            {r.kind === 'certification' && (
              <>
                <dt>Allowed</dt>
                <dd>{permissionText(r.permission)}</dd>
              </>
            )}
          </dl>
          <div className="fc-digital-signatures-row">
            <Button size="sm" onClick={() => openSignatureProperties(doc, r.fieldName)}>
              Signature Properties
            </Button>
            <Button size="sm" variant="quiet" disabled={!r.revisionEnd} onClick={() => void viewSignedVersion(doc, r)}>
              View Signed Version
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

function UnsignedEntry({ doc, f, canSign }: { doc: DocumentModel; f: SignatureFieldInfo; canSign: boolean }) {
  return (
    <li className="fc-digital-signatures-entry is-unsigned">
      <div className="fc-digital-signatures-entry-head">
        <span className="fc-digital-signatures-entry-toggle" />
        <button
          className="fc-digital-signatures-entry-main"
          onClick={() => !f.invisible && doc.view?.scrollToRect(f.page, f.rect, { center: true })}
        >
          <StatusIcon level="unsigned" />
          <span className="fc-digital-signatures-entry-text">
            <span className="fc-digital-signatures-entry-title">{f.name}</span>
            <span className="fc-digital-signatures-entry-status">Unsigned signature field{f.invisible ? '' : ` on page ${f.page + 1}`}</span>
          </span>
        </button>
        <Button size="sm" variant="accent" disabled={!canSign} onClick={() => void startSigning(doc, { mode: 'sign', target: { kind: 'field', name: f.name } })}>
          Sign
        </Button>
      </div>
    </li>
  )
}

/** Right panel "Signatures" (Acrobat's Signature Panel). */
export function SignaturesPanel({ doc }: { doc: DocumentModel }) {
  const { report, running, error } = useDocSignatures(doc)
  const trusted = useTrustedSet()
  const dirty = useDocState(doc, (s) => s.dirty)
  const overall = overallStatus(report, trusted)
  const hasAny = !!report && (report.signatures.length > 0 || report.unsigned.length > 0)
  return (
    <div className="fc-digital-signatures-panel">
      <div className="fc-digital-signatures-panel-actions">
        <Button size="sm" icon={RefreshCw} disabled={running} onClick={() => void validateAll(doc, { announce: true })}>
          {running ? 'Validating…' : 'Validate All'}
        </Button>
        <Button size="sm" variant="quiet" icon={FileSignature} onClick={() => openToolGroup('certificate')}>
          Sign…
        </Button>
      </div>
      {error && <div className="fc-digital-signatures-error">Validation failed: {error}</div>}
      {overall && (
        <div className={`fc-digital-signatures-summary is-${overall.level}`}>
          <StatusIcon level={overall.level} />
          <span>{overall.message}</span>
        </div>
      )}
      {report && !report.checkedFile && report.signatures.length > 0 && (
        <p className="shell-muted fc-digital-signatures-small">Save the document to check its signatures.</p>
      )}
      {dirty && report && report.signatures.length > 0 && (
        <p className="shell-muted fc-digital-signatures-small">
          This document has unsaved changes. Signatures are checked against the saved file; save to see how your changes affect them.
        </p>
      )}
      {!report && running && <p className="shell-muted">Checking signatures…</p>}
      {report && !hasAny && (
        <EmptyState icon={FileSignature} title="No signatures">
          This document has not been signed. Use a certificate to sign it so anyone can check who signed and whether it changed.
          <div className="fc-digital-signatures-row fc-digital-signatures-center">
            <Button variant="accent" size="sm" onClick={() => openToolGroup('certificate')}>
              Sign with a certificate
            </Button>
          </div>
        </EmptyState>
      )}
      {report && hasAny && (
        <ul className="fc-digital-signatures-list" aria-label="Signatures">
          {report.signatures.map((r) => (
            <SignatureEntry key={r.fieldName} doc={doc} r={r} locked={report.locked} />
          ))}
          {report.unsigned.map((f) => (
            <UnsignedEntry key={f.name} doc={doc} f={f} canSign={!report.locked && report.certified !== 1} />
          ))}
        </ul>
      )}
      {report && report.validatedAt > 0 && hasAny && (
        <p className="shell-muted fc-digital-signatures-small">Last checked {formatDateTime(report.validatedAt)}</p>
      )}
    </div>
  )
}
