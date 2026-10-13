import { useEffect, useRef } from 'react'
import { PenLine, Plus, Trash2 } from 'lucide-react'
import type { Rect } from '@shared/geometry'
import { confirm, FloatingAt, getActiveDoc, registry, toast, useApp } from '@renderer/sdk'
import type { SignatureKind } from './shared'
import { loadSaved, saveSignature, useFillSign, type SignatureImage, type SignFieldTarget } from './state'
import { cancelPlacing, PLACE_TOOL, startPlacing } from './actions'
import { openSignatureDialog } from './SignatureDialog'
import { InitialsIcon } from './icons'

/** How long after a click on a signature field opening the Sign menu still targets that field. */
const FIELD_TARGET_MS = 60_000

let lastSignField: (SignFieldTarget & { at: number }) | null = null

/**
 * forms-fill dispatches 'fartcrobat:sign-field' when an unsigned signature field is clicked. When
 * certificate signing (digital-signatures) is not available, it offers "Fill & Sign instead",
 * which opens this menu: the signature chosen then goes into that field.
 */
function onSignField(e: Event) {
  if (registry.features.some((f) => f.id === 'digital-signatures')) return
  const d = (e as CustomEvent<{ docId?: string; page?: number; rect?: Rect; fieldName?: string }>).detail
  if (!d || typeof d.docId !== 'string' || typeof d.page !== 'number' || !Array.isArray(d.rect) || d.rect.length !== 4) return
  lastSignField = { docId: d.docId, page: d.page, rect: d.rect, fieldName: String(d.fieldName ?? ''), at: Date.now() }
}

/** The signature field clicked just before, if it belongs to the active document. Used once. */
function takeFieldTarget(): SignFieldTarget | null {
  const f = lastSignField
  lastSignField = null
  const doc = getActiveDoc()
  if (!f || !doc || f.docId !== doc.id || Date.now() - f.at > FIELD_TARGET_MS) return null
  return { docId: f.docId, page: f.page, rect: f.rect, fieldName: f.fieldName }
}

function visible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** Where to show the menu when no position was given: next to a Sign yourself button. */
function defaultAnchor(): { x: number; y: number } {
  const active = document.activeElement
  if (visible(active) && active.tagName === 'BUTTON' && active.closest('.shell-quicktools')) {
    const r = active.getBoundingClientRect()
    return { x: r.right + 8, y: r.top }
  }
  const below = document.querySelector('.fc-fill-sign-bigbtn') ?? document.querySelector('.fc-fill-sign-signbtn')
  if (visible(below)) {
    const r = below.getBoundingClientRect()
    return { x: r.left, y: r.bottom + 4 }
  }
  const quick = document.querySelector('.shell-quicktool[aria-label="Sign Yourself"]')
  if (visible(quick)) {
    const r = quick.getBoundingClientRect()
    return { x: r.right + 8, y: r.top }
  }
  const wrap = document.querySelector('.shell-viewer-wrap')?.getBoundingClientRect()
  return wrap ? { x: wrap.left + 64, y: wrap.top + 12 } : { x: 120, y: 120 }
}

/** Opens the "Sign yourself" menu next to the control that asked for it. */
export function openSignMenu(anchor?: { x: number; y: number }) {
  void loadSaved()
  const target = takeFieldTarget()
  const show = () => useFillSign.setState({ menu: { ...(anchor ?? defaultAnchor()), target } })
  // Opened together with the Fill & Sign pane (e.g. from a toast or a menu): place the menu once
  // the pane has been laid out.
  if (anchor) show()
  else requestAnimationFrame(show)
}

export function closeSignMenu() {
  useFillSign.setState({ menu: null })
}

/**
 * Creates a new signature/initials with the dialog, saves it if asked, then lets the user place it
 * (or puts it into the signature field the menu was opened for).
 */
export async function addSignatureFlow(kind: SignatureKind, target: SignFieldTarget | null = null) {
  closeSignMenu()
  if (!getActiveDoc()) {
    toast('Open a PDF first to sign it.')
    return
  }
  const result = await openSignatureDialog(kind)
  if (!result) return
  if (result.save) await saveSignature(kind, result.image)
  startPlacing(kind, result.image, target)
}

export async function clearSaved() {
  closeSignMenu()
  const ok = await confirm({
    title: 'Clear saved signatures',
    message: 'Remove your saved signature and initials from this computer? Signatures already placed in documents are not affected.',
    confirmLabel: 'Clear',
    danger: true
  })
  if (!ok) return
  await saveSignature('signature', null)
  await saveSignature('initials', null)
  toast('Saved signature and initials removed.', { kind: 'success', timeout: 2500 })
}

function SavedRow({ kind, image, target }: { kind: SignatureKind; image: SignatureImage; target: SignFieldTarget | null }) {
  const noun = kind === 'signature' ? 'signature' : 'initials'
  return (
    <div className="fc-fill-sign-saved">
      <button
        type="button"
        role="menuitem"
        className="fc-fill-sign-saved-use"
        title={target ? `Put your ${noun} in the signature field` : `Place your ${noun}`}
        aria-label={`Place your saved ${noun}`}
        onClick={() => startPlacing(kind, image, target)}
      >
        <img src={image.dataUrl} alt="" draggable={false} />
      </button>
      <button
        type="button"
        role="menuitem"
        className="ui-icon-btn fc-fill-sign-saved-remove"
        title={`Remove saved ${noun}`}
        aria-label={`Remove saved ${noun}`}
        onClick={() => void saveSignature(kind, null)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}

export function SignMenuHost() {
  const menu = useFillSign((s) => s.menu)
  const signature = useFillSign((s) => s.signature)
  const initials = useFillSign((s) => s.initials)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadSaved()
    window.addEventListener('fartcrobat:sign-field', onSignField)
    return () => window.removeEventListener('fartcrobat:sign-field', onSignField)
  }, [])

  // Esc closes the menu, or cancels placing a signature and goes back to the previous tool. Caught
  // before the app's own Esc handling, which would otherwise also switch to the Select tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const st = useFillSign.getState()
      if (st.menu) {
        e.preventDefault()
        closeSignMenu()
      } else if (st.placing && useApp.getState().toolId === PLACE_TOOL && !useApp.getState().dialogs.length) {
        e.preventDefault()
        cancelPlacing()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (menu) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
  }, [menu])

  if (!menu) return null
  const target = menu.target
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
      next?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSignMenu()
    }
  }
  return (
    <FloatingAt x={menu.x} y={menu.y} onClose={closeSignMenu}>
      <div ref={ref} className="ui-menu fc-fill-sign-menu" role="menu" aria-label="Sign yourself" onKeyDown={onKeyDown}>
        {target && (
          <div className="fc-fill-sign-menu-target" role="note">
            <PenLine size={14} />
            <span>Goes into the signature field you clicked</span>
          </div>
        )}
        <div className="fc-fill-sign-menu-title">Signature</div>
        {signature && <SavedRow kind="signature" image={signature} target={target} />}
        <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void addSignatureFlow('signature', target)}>
          <span className="ui-menu-icon">
            <Plus size={16} />
          </span>
          <span className="ui-menu-label">{signature ? 'Add new signature' : 'Add signature'}</span>
        </button>
        <div className="ui-menu-sep" role="separator" />
        <div className="fc-fill-sign-menu-title">Initials</div>
        {initials && <SavedRow kind="initials" image={initials} target={target} />}
        <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void addSignatureFlow('initials', target)}>
          <span className="ui-menu-icon">
            <InitialsIcon size={16} />
          </span>
          <span className="ui-menu-label">{initials ? 'Add new initials' : 'Add initials'}</span>
        </button>
        {(signature || initials) && (
          <>
            <div className="ui-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="ui-menu-item is-danger" onClick={() => void clearSaved()}>
              <span className="ui-menu-icon">
                <Trash2 size={16} />
              </span>
              <span className="ui-menu-label">Clear saved</span>
            </button>
          </>
        )}
      </div>
    </FloatingAt>
  )
}
