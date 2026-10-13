import { useEffect } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button, Field, Select } from '@renderer/sdk'
import { SIZE_STEPS, type SignatureKind } from './shared'
import { loadSaved, saveSignature, setDefaultTextSize, useFillSign, type SignatureImage } from './state'
import { openSignatureDialog } from './SignatureDialog'

function SavedCard({ kind, image }: { kind: SignatureKind; image: SignatureImage | null }) {
  const noun = kind === 'signature' ? 'signature' : 'initials'
  const title = kind === 'signature' ? 'Signature' : 'Initials'
  const edit = async () => {
    const r = await openSignatureDialog(kind, { forceSave: true })
    if (r) await saveSignature(kind, r.image)
  }
  return (
    <div className="fc-fill-sign-card" aria-label={`Saved ${noun}`} role="group">
      <div className="fc-fill-sign-card-title">{title}</div>
      <div className={`fc-fill-sign-card-preview ${image ? '' : 'is-empty'}`}>
        {image ? <img src={image.dataUrl} alt={`Your saved ${noun}`} /> : <span className="shell-muted">No {noun} saved</span>}
      </div>
      <div className="fc-fill-sign-card-actions">
        <Button size="sm" icon={image ? Pencil : Plus} onClick={() => void edit()}>
          {image ? 'Replace…' : `Add ${noun}…`}
        </Button>
        {image && (
          <Button size="sm" variant="quiet" icon={Trash2} onClick={() => void saveSignature(kind, null)}>
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}

/** Preferences > Signatures: saved signature and initials, default text size. */
export function SignatureSettings() {
  const signature = useFillSign((s) => s.signature)
  const initials = useFillSign((s) => s.initials)
  const size = useFillSign((s) => s.textSize)
  useEffect(() => {
    void loadSaved(true)
  }, [])
  const sizes = SIZE_STEPS.filter((v) => v <= 48)
  return (
    <div className="fc-fill-sign-settings">
      <p className="shell-muted fc-fill-sign-settings-intro">
        Your signature and initials are kept only on this computer and are used by Fill &amp; Sign (and as the picture
        in certificate signatures).
      </p>
      <div className="fc-fill-sign-cards">
        <SavedCard kind="signature" image={signature} />
        <SavedCard kind="initials" image={initials} />
      </div>
      <Field label="Default text size for Fill & Sign">
        <Select<string>
          value={String(size)}
          onChange={(v) => void setDefaultTextSize(parseFloat(v))}
          options={[
            ...(sizes.includes(size) ? [] : [{ value: String(size), label: `${size} pt` }]),
            ...sizes.map((v) => ({ value: String(v), label: `${v} pt` }))
          ]}
        />
      </Field>
    </div>
  )
}
