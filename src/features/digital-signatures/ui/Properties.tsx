import { useState } from 'react'
import { CircleCheck, CircleX, Download, FileStack, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react'
import { Button, Dialog, openDialog, showError, toast, type DocumentModel } from '@renderer/sdk'
import type { CertDetails } from '../lib/x509'
import { permissionText, signatureStatus } from '../status'
import type { SignatureReport } from '../types'
import { exportCertificate, trustCertificate, untrustCertificate } from './ids'
import { StatusIcon } from './StatusIcon'
import { useDocSignatures, useTrustedSet, validateDocument } from './store'
import { formatDateTime } from './format'
import { viewSignedVersion } from './actions'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <div className="fc-digital-signatures-kv">
      <span className="fc-digital-signatures-k">{label}</span>
      <span className="fc-digital-signatures-v">{children}</span>
    </div>
  )
}

function CertificateDetails({ cert }: { cert: CertDetails }) {
  return (
    <div className="fc-digital-signatures-certdetails">
      <Row label="Issued to">{cert.subject}</Row>
      <Row label="Issued by">{cert.issuer}</Row>
      <Row label="Valid from">{formatDateTime(cert.notBefore)}</Row>
      <Row label="Valid to">{formatDateTime(cert.notAfter)}</Row>
      <Row label="Intended usage">{[...cert.keyUsage, ...cert.extKeyUsage].join(', ') || 'Not restricted'}</Row>
      <Row label="Serial number">
        <code>{cert.serial}</code>
      </Row>
      <Row label="Public key">{cert.publicKey}</Row>
      <Row label="Signature algorithm">{cert.signatureAlgorithm}</Row>
      <Row label="SHA-256 fingerprint">
        <code className="fc-digital-signatures-fp">{cert.sha256.match(/.{2}/g)?.join(':')}</code>
      </Row>
      <Row label="SHA-1 fingerprint">
        <code className="fc-digital-signatures-fp">{cert.sha1.match(/.{2}/g)?.join(':')}</code>
      </Row>
      <Row label="Type">{cert.selfSigned ? 'Self-signed (not issued by a certificate authority)' : cert.isCA ? 'Certificate authority' : 'Issued by a certificate authority'}</Row>
    </div>
  )
}

/** Acrobat's Certificate Viewer: the chain on the left, details and trust on the right. */
export function CertificateViewer({ chain, initial = 0, onClose }: { chain: CertDetails[]; initial?: number; onClose: () => void }) {
  const [index, setIndex] = useState(initial)
  const trusted = useTrustedSet()
  const cert = chain[index]
  const isTrusted = trusted.has(cert.sha256)
  const toggleTrust = async () => {
    try {
      if (isTrusted) {
        await untrustCertificate(cert.sha256)
        toast(`“${cert.subjectName}” was removed from your trusted certificates.`)
      } else {
        await trustCertificate({ fingerprint: cert.sha256, name: cert.subjectName, issuer: cert.issuerName })
        toast(`“${cert.subjectName}” is now a trusted certificate.`, { kind: 'success' })
      }
    } catch (err) {
      showError(err, 'Could not change the trust setting')
    }
  }
  const ordered = [...chain.keys()].reverse()
  return (
    <Dialog
      title="Certificate Viewer"
      onClose={onClose}
      width={760}
      className="fc-digital-signatures-dialog"
      footer={
        <>
          <Button icon={Download} onClick={() => void exportCertificate(cert.der, cert.subjectName).catch((e) => showError(e, 'Could not export'))}>
            Export…
          </Button>
          <Button icon={isTrusted ? ShieldOff : ShieldCheck} onClick={() => void toggleTrust()}>
            {isTrusted ? 'Remove from Trusted Certificates' : 'Trust This Certificate'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="fc-digital-signatures-certviewer">
        <ul className="fc-digital-signatures-chain" aria-label="Certificate chain">
          {ordered.map((i, depth) => (
            <li key={chain[i].sha256}>
              <button
                className={i === index ? 'is-active' : ''}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => setIndex(i)}
                aria-current={i === index}
              >
                {trusted.has(chain[i].sha256) ? <ShieldCheck size={15} /> : <FileStack size={15} />}
                <span>{chain[i].subjectName}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="fc-digital-signatures-certmain">
          <div className="fc-digital-signatures-trustline">
            {isTrusted ? (
              <>
                <CircleCheck size={16} className="fc-digital-signatures-ok" /> You trust this certificate. Signatures made with it (or with
                certificates it issued) show a known identity.
              </>
            ) : (
              <>
                <ShieldQuestion size={16} /> This certificate is not in your trusted certificates. Trust it only if you have checked with
                its owner that the SHA-256 fingerprint below is theirs.
              </>
            )}
          </div>
          <CertificateDetails cert={cert} />
        </div>
      </div>
    </Dialog>
  )
}

export function openCertificateViewer(chain: CertDetails[], initial = 0) {
  if (!chain.length) return
  void openDialog((close) => <CertificateViewer chain={chain} initial={initial} onClose={() => close()} />)
}

function SignatureProperties({ doc, fieldName, onClose }: { doc: DocumentModel; fieldName: string; onClose: () => void }) {
  const { report } = useDocSignatures(doc)
  const trusted = useTrustedSet()
  const r: SignatureReport | undefined = report?.signatures.find((s) => s.fieldName === fieldName)
  const [validating, setValidating] = useState(false)
  if (!r) {
    return (
      <Dialog title="Signature Properties" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <p>This signature is no longer in the document.</p>
      </Dialog>
    )
  }
  const st = signatureStatus(r, trusted)
  const signer = r.certificates[0]
  const signerTrusted = st.identityKnown
  return (
    <Dialog
      title="Signature Properties"
      onClose={onClose}
      width={680}
      className="fc-digital-signatures-dialog"
      footer={
        <>
          <Button
            disabled={validating}
            onClick={async () => {
              setValidating(true)
              await validateDocument(doc)
              setValidating(false)
            }}
          >
            {validating ? 'Validating…' : 'Validate Signature'}
          </Button>
          <Button disabled={!r.revisionEnd} onClick={() => void viewSignedVersion(doc, r)}>
            View Signed Version
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className={`fc-digital-signatures-verdict is-${st.level}`}>
        <StatusIcon level={st.level} size={28} />
        <div>
          <div className="fc-digital-signatures-verdict-title">{st.title}</div>
          <div className="shell-muted">
            {r.kind === 'timestamp' ? 'Document timestamp' : r.kind === 'certification' ? 'Certified by' : 'Signed by'} <b>{r.signerName}</b>
            {r.signingTime ? <> on {formatDateTime(r.timestamp?.valid ? r.timestamp.time : r.signingTime)}</> : null}
          </div>
        </div>
      </div>
      <div className="fc-digital-signatures-sectiontitle">Validity summary</div>
      <ul className="fc-digital-signatures-bullets">
        {st.details.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
      {r.changes.length > 0 && (
        <>
          <div className="fc-digital-signatures-sectiontitle">Changes made after this signature</div>
          <ul className="fc-digital-signatures-changes">
            {r.changes.map((c, i) => (
              <li key={i} className={c.allowed ? 'is-allowed' : 'is-disallowed'}>
                {c.allowed ? <CircleCheck size={14} /> : <CircleX size={14} />}
                <span>{c.description}</span>
                {!c.allowed && <span className="fc-digital-signatures-tag">Not allowed</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.changesUnknown && <p className="shell-muted">The document was changed after signing, but the changes could not be listed.</p>}
      <div className="fc-digital-signatures-sectiontitle">Signer</div>
      <div className="fc-digital-signatures-signer">
        <div>
          <Row label="Name">{r.signerName}</Row>
          <Row label="Email">{signer?.email}</Row>
          <Row label="Organisation">{signer?.organization}</Row>
          <Row label="Certificate issued by">{signer ? (signer.selfSigned ? 'Self-signed' : signer.issuerName) : null}</Row>
        </div>
        <div className="fc-digital-signatures-signer-actions">
          <Button size="sm" disabled={!signer} onClick={() => openCertificateViewer(r.certificates)}>
            Show Signer's Certificate…
          </Button>
          {signer && !signerTrusted && (
            <Button
              size="sm"
              icon={ShieldCheck}
              onClick={() =>
                void trustCertificate({ fingerprint: signer.sha256, name: signer.subjectName, issuer: signer.issuerName })
                  .then(() => toast(`Signatures by “${signer.subjectName}” will now show a known identity.`, { kind: 'success' }))
                  .catch((e) => showError(e, 'Could not trust the certificate'))
              }
            >
              Trust This Signer
            </Button>
          )}
        </div>
      </div>
      <div className="fc-digital-signatures-sectiontitle">Details</div>
      <Row label="Reason">{r.reason}</Row>
      <Row label="Location">{r.location}</Row>
      <Row label="Contact info">{r.contactInfo}</Row>
      <Row label="Signing time">{r.signingTime ? `${formatDateTime(r.signingTime)}${r.timestamp ? '' : ' (from the signer’s computer)'}` : 'Not given'}</Row>
      {r.timestamp && (
        <Row label="Timestamp">
          {formatDateTime(r.timestamp.time)} by {r.timestamp.authority} {r.timestamp.valid ? '' : '(could not be verified)'}
        </Row>
      )}
      <Row label="Field">
        {r.fieldName}
        {r.invisible ? ' (invisible)' : ` on page ${r.page + 1}`}
      </Row>
      <Row label="Signed version">
        {r.signedVersion ? `Rev. ${r.signedVersion}${r.revision ? ` (file revision ${r.revision} of ${r.revisionCount})` : ''}` : null}
      </Row>
      {r.kind === 'certification' && <Row label="Allowed changes">{permissionText(r.permission)}</Row>}
      {r.lock && <Row label="Lock">{r.lock.permission === 1 ? 'Document locked after signing' : `Locks ${r.lock.action === 'All' ? 'all fields' : r.lock.fields.join(', ')}`}</Row>}
      <Row label="Signature format">{r.subFilter}</Row>
      <Row label="Hash algorithm">{r.digestAlgorithm}</Row>
      <Row label="Signature algorithm">{r.signatureAlgorithm}</Row>
    </Dialog>
  )
}

export function openSignatureProperties(doc: DocumentModel, fieldName: string) {
  void openDialog((close) => <SignatureProperties doc={doc} fieldName={fieldName} onClose={() => close()} />)
}
