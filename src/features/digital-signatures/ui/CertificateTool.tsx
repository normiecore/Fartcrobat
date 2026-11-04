import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, FileKey2, FileSignature, KeyRound, PenTool, ShieldCheck, Stamp } from 'lucide-react'
import {
  Button,
  getActiveDoc,
  openPreferences,
  setTool,
  ToolPanelFrame,
  ToolRow,
  Section,
  useApp,
  type DocumentModel,
  type PageLayerProps
} from '@renderer/sdk'
import { rectFromPoints, type Point, type Rect } from '@shared/geometry'
import type { MdpPermission } from '../types'
import { validateAll } from './actions'
import { CERTIFICATE_ENCRYPTED_SIGNING, refuseCertificateEncrypted, useCertificateEncrypted } from './encrypted'
import { startSigning } from './flow'
import { StatusIcon } from './StatusIcon'
import { loadIds, useDocSignatures, useSigStore } from './store'

export const BOX_TOOL = 'sign.certificateBox'
const DEFAULT_BOX = { w: 180, h: 54 }

/** Activates the "drag a signature box" tool for signing or certifying (refused for certificate-encrypted documents). */
export function beginBox(mode: 'sign' | 'certify', permission: MdpPermission = 2) {
  void (async () => {
    if (await refuseCertificateEncrypted(getActiveDoc())) return
    useSigStore.setState({ boxMode: { mode, permission } })
    setTool(BOX_TOOL)
  })()
}

/** Tool layer: drag a rectangle (or click for a default-size box) where the signature goes. */
export function CertificateBoxLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point; id: number } | null>(null)
  const local = (e: React.PointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect()
    return [Math.max(0, Math.min(r.width, e.clientX - r.left)), Math.max(0, Math.min(r.height, e.clientY - r.top))]
  }
  const finish = (a: Point, b: Point) => {
    let rect: Rect = rectFromPoints(geometry.toPage(a), geometry.toPage(b))
    const w = rect[2] - rect[0]
    const h = rect[3] - rect[1]
    if (w < 12 || h < 8) {
      // A click: a default-size box with its top-left corner at the click, kept on the page.
      const p = geometry.toPage(a)
      const x = Math.min(Math.max(0, p[0]), Math.max(0, geometry.width - DEFAULT_BOX.w))
      const y = Math.min(Math.max(0, p[1]), Math.max(0, geometry.height - DEFAULT_BOX.h))
      rect = [x, y, x + DEFAULT_BOX.w, y + DEFAULT_BOX.h]
    }
    const { mode, permission } = useSigStore.getState().boxMode
    setTool('select')
    void startSigning(doc, { mode, permission, target: { kind: 'new', page: pageIndex, rect } })
  }
  return (
    <div
      ref={ref}
      className="viewer-layer fc-digital-signatures-boxlayer"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const p = local(e)
        setDrag({ a: p, b: p, id: e.pointerId })
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => drag && drag.id === e.pointerId && setDrag({ ...drag, b: local(e) })}
      onPointerUp={(e) => {
        if (!drag || drag.id !== e.pointerId) return
        const d = drag
        setDrag(null)
        finish(d.a, local(e))
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {drag && (
        <div
          className="fc-digital-signatures-boxdraft"
          style={{
            left: Math.min(drag.a[0], drag.b[0]),
            top: Math.min(drag.a[1], drag.b[1]),
            width: Math.abs(drag.b[0] - drag.a[0]),
            height: Math.abs(drag.b[1] - drag.a[1])
          }}
        >
          <span>{useSigStore.getState().boxMode.mode === 'certify' ? 'Certify here' : 'Sign here'}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Keyboard alternative to dragging: a standard-size box in the bottom-right corner of the current
 * page (where Acrobat users usually sign).
 */
export function placeStandardBox(doc: DocumentModel) {
  const pageIndex = Math.max(0, Math.min(doc.pageCount - 1, doc.state.currentPage))
  const p = doc.info.pages[pageIndex]
  const margin = Math.min(36, p.width * 0.06, p.height * 0.06)
  const w = Math.min(DEFAULT_BOX.w, p.width - 2 * margin)
  const h = Math.min(DEFAULT_BOX.h, p.height - 2 * margin)
  // Keep clear of the page footer (page numbers usually sit in the bottom margin).
  const bottom = p.height - 2 * margin
  const right = p.width - margin
  const rect: Rect = [right - w, bottom - h, right, bottom]
  const { mode, permission } = useSigStore.getState().boxMode
  setTool('select')
  doc.view?.scrollToRect(pageIndex, rect, { center: true })
  void startSigning(doc, { mode, permission, target: { kind: 'new', page: pageIndex, rect } })
}

/** Contextual toolbar while the box tool is active. */
export function CertificateBoxToolbar({ doc }: { doc: DocumentModel }) {
  const mode = useSigStore((s) => s.boxMode.mode)
  return (
    <div className="fc-digital-signatures-toolbar">
      <PenTool size={16} />
      <span>
        {mode === 'certify' ? 'Drag a box where the certification signature goes, or click.' : 'Drag a box where your signature goes, or click.'}
      </span>
      <Button size="sm" variant="quiet" title="Put a standard-size signature box at the bottom right of the current page" onClick={() => placeStandardBox(doc)}>
        Place at bottom of page
      </Button>
      <Button size="sm" onClick={() => setTool('select')}>
        Cancel
      </Button>
    </div>
  )
}

/** Left pane of "Use a certificate". */
export function CertificatePanel({ doc }: { doc: DocumentModel | null }) {
  const toolId = useApp((s) => s.toolId)
  const boxMode = useSigStore((s) => s.boxMode.mode)
  const ids = useSigStore((s) => s.ids)
  const idsLoaded = useSigStore((s) => s.idsLoaded)
  const { report } = useDocSignatures(doc)
  const encrypted = useCertificateEncrypted(doc)
  useEffect(() => {
    if (!idsLoaded) void loadIds()
  }, [idsLoaded])
  const locked = !!report?.locked || encrypted
  const certified = report?.certified ?? null
  const signed = (report?.signatures.length ?? 0) > 0
  return (
    <ToolPanelFrame title="Use a certificate">
      <Section>
        <ToolRow
          icon={FileSignature}
          label="Digitally sign"
          description="Drag a box where your signature should appear"
          active={toolId === BOX_TOOL && boxMode === 'sign'}
          disabled={!doc || locked || certified === 1}
          onClick={() => beginBox('sign')}
        />
        <ToolRow
          icon={Stamp}
          label="Certify (visible signature)"
          description="Sign as the author and choose which changes stay allowed"
          active={toolId === BOX_TOOL && boxMode === 'certify'}
          disabled={!doc || signed || !!certified || encrypted}
          onClick={() => beginBox('certify')}
        />
        <ToolRow
          icon={ShieldCheck}
          label="Certify (invisible signature)"
          description="Certify without anything drawn on the page"
          disabled={!doc || signed || !!certified || encrypted}
          onClick={() => doc && void startSigning(doc, { mode: 'certify', target: { kind: 'invisible' } })}
        />
        <ToolRow
          icon={BadgeCheck}
          label="Validate all signatures"
          description="Check every signature and show the results"
          disabled={!doc}
          onClick={() => doc && void validateAll(doc, { openPanel: true, announce: true })}
        />
        <ToolRow icon={KeyRound} label="Manage Digital IDs" description="Create, import or export your IDs" onClick={() => openPreferences('digital-ids')} />
      </Section>
      {doc && report && report.unsigned.length > 0 && (
        <Section title="Signature fields to sign">
          <ul className="fc-digital-signatures-fieldlist">
            {report.unsigned.map((f) => (
              <li key={f.name}>
                <StatusIcon level="unsigned" size={16} />
                <span>
                  {f.name}
                  <span className="shell-muted">{f.invisible ? ' (invisible)' : ` · page ${f.page + 1}`}</span>
                </span>
                <Button size="sm" variant="accent" disabled={locked} onClick={() => void startSigning(doc, { mode: 'sign', target: { kind: 'field', name: f.name } })}>
                  Sign
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Your Digital IDs">
        {ids.length ? (
          <ul className="fc-digital-signatures-fieldlist">
            {ids.map((r) => (
              <li key={r.id}>
                <FileKey2 size={16} />
                <span>
                  {r.name}
                  <span className="shell-muted"> · {r.selfSigned ? 'self-signed' : r.issuer}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="shell-muted fc-digital-signatures-small">
            You don't have a Digital ID yet. You can create one in a few seconds when you sign.
          </p>
        )}
      </Section>
      {encrypted ? (
        <p className="fc-digital-signatures-note">{CERTIFICATE_ENCRYPTED_SIGNING}</p>
      ) : certified === 1 ? (
        <p className="fc-digital-signatures-note">This document is certified and the certifier allowed no changes, so it cannot be signed again.</p>
      ) : locked ? (
        <p className="fc-digital-signatures-note">This document is locked by a signature and cannot be signed again.</p>
      ) : certified ? (
        <p className="fc-digital-signatures-note">This document is certified. Only the changes the certifier allowed keep the certification valid.</p>
      ) : null}
    </ToolPanelFrame>
  )
}
