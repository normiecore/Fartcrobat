import { useEffect } from 'react'
import { BadgeCheck, FileSignature, KeyRound, PenTool, ShieldCheck, Stamp } from 'lucide-react'
import {
  defineFeature,
  openPreferences,
  openRightPanel,
  openToolGroup,
  registry,
  showError,
  useApp,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import { validateAll } from './ui/actions'
import { beginBox, BOX_TOOL, CertificateBoxLayer, CertificateBoxToolbar, CertificatePanel } from './ui/CertificateTool'
import { DigitalIdsSettings } from './ui/DigitalIdsSettings'
import { SignatureFieldLayer } from './ui/FieldLayer'
import { startSigning } from './ui/flow'
import { ActiveDocValidator, SignatureMessageBar } from './ui/MessageBar'
import { SignaturesPanel, signatureMenuItems } from './ui/SignaturesPanel'
import { forgetDocument, loadIds, loadTrusted, sigOps, useSigStore } from './ui/store'
import './styles.css'

interface SignFieldEvent {
  docId?: string
  fieldId?: number
  fieldName?: string
  page?: number
  rect?: [number, number, number, number]
}

/** Always mounted: loads IDs and trust, answers forms-fill's 'fartcrobat:sign-field', tidies up. */
function SignatureGlobals() {
  useEffect(() => {
    void loadIds()
    void loadTrusted()
    const onSignField = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as SignFieldEvent
      const app = useApp.getState()
      const doc = app.docs.find((x) => x.id === d.docId) ?? app.docs.find((x) => x.id === app.activeDocId)
      if (!doc || (!d.fieldName && d.fieldId === undefined)) return
      if (app.activeDocId !== doc.id) useApp.setState({ activeDocId: doc.id })
      void (async () => {
        let name = d.fieldName
        if (!name) {
          // Only the widget id was given: look the field up.
          const fields = await sigOps(doc).fields()
          name = fields.find((f) => f.widgetId === d.fieldId)?.name
          if (!name) throw new Error('That signature field no longer exists.')
        }
        await startSigning(doc, { mode: 'sign', target: { kind: 'field', name } })
      })().catch((err) => showError(err, 'Could not start signing'))
    }
    window.addEventListener('fartcrobat:sign-field', onSignField)
    const unsub = useApp.subscribe((s, prev) => {
      if (s.docs === prev.docs) return
      const open = new Set(s.docs.map((d) => d.id))
      for (const id of Object.keys(useSigStore.getState().byDoc)) if (!open.has(id)) forgetDocument(id)
    })
    return () => {
      window.removeEventListener('fartcrobat:sign-field', onSignField)
      unsub()
    }
  }, [])
  return null
}

function contextItems(doc: DocumentModel, pageIndex: number, point: [number, number]): ContextMenuItem[] {
  const report = useSigStore.getState().byDoc[doc.id]?.report
  if (!report) return []
  const inside = (r: [number, number, number, number]) => point[0] >= r[0] && point[0] <= r[2] && point[1] >= r[1] && point[1] <= r[3]
  const signed = report.signatures.find((s) => s.page === pageIndex && !s.invisible && inside(s.rect))
  if (signed) return signatureMenuItems(doc, signed, report.locked)
  const unsigned = report.unsigned.find((f) => f.page === pageIndex && !f.invisible && inside(f.rect))
  if (unsigned) {
    return [
      {
        id: 'dsig-sign-field',
        label: 'Sign Document…',
        icon: FileSignature,
        disabled: report.locked,
        run: () => void startSigning(doc, { mode: 'sign', target: { kind: 'field', name: unsigned.name } })
      }
    ]
  }
  return []
}

export default defineFeature({
  id: 'digital-signatures',
  commands: [
    {
      id: 'sign.useCertificate',
      label: 'Use a Certificate',
      icon: ShieldCheck,
      keywords: ['digital signature', 'certificate', 'digital id', 'certify', 'pki'],
      run: () => openToolGroup('certificate')
    },
    {
      id: 'sign.digitallySign',
      label: 'Digitally Sign…',
      icon: FileSignature,
      keywords: ['digital signature', 'certificate', 'sign'],
      run: () => beginBox('sign')
    },
    {
      id: 'sign.certifyVisible',
      label: 'Certify (Visible Signature)…',
      icon: Stamp,
      keywords: ['certify', 'certification', 'docmdp'],
      run: () => beginBox('certify')
    },
    {
      id: 'sign.certifyInvisible',
      label: 'Certify (Invisible Signature)…',
      icon: ShieldCheck,
      keywords: ['certify', 'certification', 'docmdp'],
      run: ({ doc }) => startSigning(doc!, { mode: 'certify', target: { kind: 'invisible' } }).then(() => undefined)
    },
    {
      id: 'sign.validateAll',
      label: 'Validate All Signatures',
      icon: BadgeCheck,
      keywords: ['verify', 'signatures', 'check'],
      run: ({ doc }) => validateAll(doc!, { openPanel: true, announce: true })
    },
    {
      id: 'sign.showSignaturesPanel',
      label: 'Signatures Panel',
      icon: PenTool,
      run: () => openRightPanel('signatures')
    },
    {
      id: 'sign.manageDigitalIds',
      label: 'Manage Digital IDs…',
      icon: KeyRound,
      requiresDocument: false,
      keywords: ['digital id', 'certificate', 'pfx', 'p12', 'trusted certificates'],
      run: () => openPreferences('digital-ids')
    }
  ],
  menus: [
    { menu: 'sign', group: 'certificate', command: 'sign.useCertificate', order: 300 },
    { menu: 'sign', group: 'certificate', command: 'sign.digitallySign', order: 301 },
    { menu: 'sign', group: 'certificate', command: 'sign.certifyVisible', order: 302 },
    { menu: 'sign', group: 'certificate', command: 'sign.certifyInvisible', order: 303 },
    { menu: 'sign', group: 'certificate-validate', command: 'sign.validateAll', order: 310 },
    { menu: 'sign', group: 'certificate-validate', command: 'sign.showSignaturesPanel', order: 311 },
    { menu: 'sign', group: 'certificate-validate', command: 'sign.manageDigitalIds', order: 312 }
  ],
  tools: [
    {
      id: BOX_TOOL,
      label: 'Draw signature field',
      icon: FileSignature,
      cursor: 'crosshair',
      layer: CertificateBoxLayer,
      toolbar: CertificateBoxToolbar
    }
  ],
  toolGroups: [
    {
      id: 'certificate',
      label: 'Use a certificate',
      icon: ShieldCheck,
      color: '#7b4fd6',
      description: 'Sign, certify and validate with a digital ID',
      order: 90,
      category: 'sign',
      panel: CertificatePanel,
      keywords: ['digital signature', 'certificate', 'certify', 'validate', 'digital id']
    }
  ],
  rightPanels: [{ id: 'signatures', label: 'Signatures', icon: PenTool, order: 40, component: SignaturesPanel }],
  pageLayers: [
    {
      id: 'digital-signatures-fields',
      order: 55,
      component: SignatureFieldLayer,
      when: ({ toolId }) => {
        const tool = registry.tools.get(toolId)
        return !tool?.layer || !!tool.allowDefaultInteractions
      }
    }
  ],
  pageContextMenu: [{ id: 'digital-signatures', order: 40, items: ({ doc, pageIndex, point }) => contextItems(doc, pageIndex, point) }],
  settings: [{ id: 'digital-ids', label: 'Digital IDs', order: 60, component: DigitalIdsSettings }],
  docToolbar: [{ id: 'digital-signatures-bar', order: 90, component: SignatureMessageBar }],
  globals: [SignatureGlobals, ActiveDocValidator]
})
