import { useEffect, useState } from 'react'
import { Download, FileKey2, FolderInput, Plus, ScrollText, ShieldCheck, Trash2 } from 'lucide-react'
import { Button, confirm, IconButton, showError, toast } from '@renderer/sdk'
import { parseCertificate } from '../lib/x509'
import { describeCertificate } from '../lib/x509'
import { exportCertificate, idStatus, recordCertificate, removeDigitalId, untrustCertificate } from './ids'
import { importDigitalIdFlow, openCreateIdDialog } from './IdDialogs'
import { openCertificateViewer } from './Properties'
import { loadIds, loadTrusted, useSigStore } from './store'
import { formatDate } from './format'

/** Preferences > Digital IDs: your signing IDs and the certificates you trust. */
export function DigitalIdsSettings() {
  const ids = useSigStore((s) => s.ids)
  const trusted = useSigStore((s) => s.trusted)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    void loadIds()
    void loadTrusted()
  }, [])
  const rec = ids.find((r) => r.id === selected) ?? null

  const add = async (how: 'create' | 'import') => {
    try {
      const r = how === 'create' ? await openCreateIdDialog() : await importDigitalIdFlow()
      if (r) {
        setSelected(r.record.id)
        toast(how === 'create' ? `Digital ID “${r.record.name}” created.` : `Digital ID “${r.record.name}” imported.`, { kind: 'success' })
      }
    } catch (err) {
      showError(err)
    }
  }

  const remove = async () => {
    if (!rec) return
    const ok = await confirm({
      title: 'Remove Digital ID?',
      message: (
        <>
          <b>{rec.name}</b> will be removed{rec.createdByApp ? ' and its file deleted' : ''}. You will no longer be able to sign with it.
          Documents you already signed stay valid.
        </>
      ),
      confirmLabel: 'Remove ID',
      danger: true
    })
    if (!ok) return
    try {
      await removeDigitalId(rec)
      setSelected(null)
      toast(`Digital ID “${rec.name}” removed.`)
    } catch (err) {
      showError(err, 'Could not remove the Digital ID')
    }
  }

  const exportCert = async () => {
    if (!rec) return
    try {
      const path = await exportCertificate(recordCertificate(rec), rec.name)
      if (path) toast('Certificate exported. Share it so others can trust your signatures.', { kind: 'success' })
    } catch (err) {
      showError(err, 'Could not export the certificate')
    }
  }

  const showCert = async () => {
    if (!rec) return
    try {
      openCertificateViewer([await describeCertificate(parseCertificate(recordCertificate(rec)))])
    } catch (err) {
      showError(err, 'Could not read the certificate')
    }
  }

  return (
    <div className="fc-digital-signatures-settings">
      <p className="shell-muted">
        Digital IDs let you sign and certify documents with a certificate. The private key stays in the ID file on this computer and is
        protected by its password, which Fartcrobat never stores.
      </p>
      <div className="fc-digital-signatures-row">
        <Button icon={Plus} variant="accent" onClick={() => void add('create')}>
          Create Digital ID…
        </Button>
        <Button icon={FolderInput} onClick={() => void add('import')}>
          Import ID File…
        </Button>
        <span className="fc-digital-signatures-spacer" />
        <Button icon={ScrollText} disabled={!rec} onClick={() => void showCert()}>
          Certificate Details
        </Button>
        <Button icon={Download} disabled={!rec} onClick={() => void exportCert()}>
          Export Certificate…
        </Button>
        <Button icon={Trash2} variant="quiet" disabled={!rec} onClick={() => void remove()}>
          Remove ID
        </Button>
      </div>
      {ids.length === 0 ? (
        <div className="fc-digital-signatures-emptyids">
          <FileKey2 size={28} />
          <div>No Digital IDs yet. Create one to start signing with a certificate, or import a .pfx/.p12 file you already have.</div>
        </div>
      ) : (
        <div className="fc-digital-signatures-tablewrap">
          <table className="fc-digital-signatures-table" aria-label="Digital IDs">
            <thead>
              <tr>
                <th>Name</th>
                <th>Issuer</th>
                <th>Key</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {ids.map((r) => {
                const status = idStatus(r)
                return (
                  <tr
                    key={r.id}
                    className={r.id === selected ? 'is-selected' : ''}
                    tabIndex={0}
                    aria-selected={r.id === selected}
                    onClick={() => setSelected(r.id)}
                    onDoubleClick={() => void showCert()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelected(r.id)
                      }
                    }}
                  >
                    <td>
                      <b>{r.name}</b>
                      {r.email && <div className="shell-muted">{r.email}</div>}
                    </td>
                    <td>{r.selfSigned ? 'Self-signed' : r.issuer}</td>
                    <td>{r.keyType}</td>
                    <td className={status !== 'valid' ? 'fc-digital-signatures-bad' : ''}>
                      {status === 'expired' ? `Expired ${formatDate(r.notAfter)}` : formatDate(r.notAfter)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <h4 className="fc-digital-signatures-h4">Trusted certificates</h4>
      <p className="shell-muted fc-digital-signatures-small">
        Signatures made with these certificates (or certificates they issued) show the signer's identity as valid. Add one from a
        signature's properties with “Trust This Signer”.
      </p>
      {trusted.length === 0 ? (
        <p className="shell-muted fc-digital-signatures-small">You have not trusted any certificates yet.</p>
      ) : (
        <ul className="fc-digital-signatures-trustlist" aria-label="Trusted certificates">
          {trusted.map((t) => (
            <li key={t.fingerprint}>
              <ShieldCheck size={16} className="fc-digital-signatures-ok" />
              <span>
                <b>{t.name}</b>
                <span className="shell-muted"> · issued by {t.issuer} · SHA-256 {t.fingerprint.slice(0, 16)}…</span>
              </span>
              <IconButton
                icon={Trash2}
                size={15}
                label={`Stop trusting ${t.name}`}
                onClick={() => void untrustCertificate(t.fingerprint).catch((e) => showError(e, 'Could not update trusted certificates'))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
