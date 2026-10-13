import { FileSignature } from 'lucide-react'
import { registry, showContextMenu, type PageLayerProps } from '@renderer/sdk'
import { signatureStatus } from '../status'
import { startSigning } from './flow'
import { openSignatureProperties } from './Properties'
import { signatureMenuItems } from './SignaturesPanel'
import { useDocSignatures, useTrustedSet } from './store'

/** forms-fill handles clicks on unsigned signature fields (it dispatches 'fartcrobat:sign-field'). */
function formsFillHandlesFields(): boolean {
  return registry.features.some((f) => f.id === 'forms-fill')
}

/**
 * Page layer over signature fields: clicking a signed field opens its properties (Acrobat shows
 * the validation status); unsigned fields start signing when no form-filling feature does.
 */
export function SignatureFieldLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const { report } = useDocSignatures(doc)
  const trusted = useTrustedSet()
  if (!report) return null
  const signed = report.signatures.filter((s) => s.page === pageIndex && !s.invisible)
  const unsigned = formsFillHandlesFields() ? [] : report.unsigned.filter((f) => f.page === pageIndex && !f.invisible)
  if (!signed.length && !unsigned.length) return null
  return (
    <div className="viewer-layer fc-digital-signatures-fieldlayer">
      {signed.map((s) => {
        const c = geometry.rectToCss(s.rect)
        const st = signatureStatus(s, trusted)
        return (
          <button
            key={s.fieldName}
            className={`fc-digital-signatures-field is-signed is-${st.level}`}
            style={{ left: c.left, top: c.top, width: c.width, height: c.height }}
            title={`${s.kind === 'certification' ? 'Certified' : 'Signed'} by ${s.signerName}. ${st.title} Click for details.`}
            aria-label={`Signature ${s.fieldName}: ${st.title}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => openSignatureProperties(doc, s.fieldName)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              showContextMenu(e.clientX, e.clientY, signatureMenuItems(doc, s, report.locked))
            }}
          />
        )
      })}
      {unsigned.map((f) => {
        const c = geometry.rectToCss(f.rect)
        return (
          <button
            key={f.name}
            className="fc-digital-signatures-field is-unsigned"
            style={{ left: c.left, top: c.top, width: c.width, height: c.height }}
            title={`Signature field “${f.name}”. Click to sign.`}
            aria-label={`Sign ${f.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void startSigning(doc, { mode: 'sign', target: { kind: 'field', name: f.name } })}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              showContextMenu(e.clientX, e.clientY, [
                {
                  id: 'sign',
                  label: 'Sign Document…',
                  icon: FileSignature,
                  disabled: report.locked,
                  run: () => void startSigning(doc, { mode: 'sign', target: { kind: 'field', name: f.name } })
                }
              ])
            }}
          >
            <span>Click to sign</span>
          </button>
        )
      })}
    </div>
  )
}
