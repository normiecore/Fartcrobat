import { useEffect, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { confirm, FloatingAt, getActiveDoc, toast, useApp } from '@renderer/sdk'
import type { SignatureKind } from './shared'
import { loadSaved, saveSignature, useFillSign, type SignatureImage } from './state'
import { cancelPlacing, PLACE_TOOL, startPlacing } from './actions'
import { openSignatureDialog } from './SignatureDialog'
import { InitialsIcon } from './icons'

/** Opens the "Sign yourself" menu next to the control that asked for it. */
export function openSignMenu(anchor?: { x: number; y: number }) {
  void loadSaved()
  let pos = anchor
  if (!pos) {
    const el = document.activeElement
    if (el instanceof HTMLElement && el.tagName === 'BUTTON' && el.closest('.shell-quicktools')) {
      const r = el.getBoundingClientRect()
      pos = { x: r.right + 8, y: r.top }
    } else if (el instanceof HTMLElement && el.tagName === 'BUTTON' && el.closest('.shell, .ui-panel')) {
      const r = el.getBoundingClientRect()
      pos = { x: r.left, y: r.bottom + 4 }
    }
  }
  if (!pos) {
    const wrap = document.querySelector('.shell-viewer-wrap')?.getBoundingClientRect()
    pos = wrap ? { x: wrap.left + 64, y: wrap.top + 12 } : { x: 120, y: 120 }
  }
  useFillSign.setState({ menu: pos })
}

export function closeSignMenu() {
  useFillSign.setState({ menu: null })
}

/** Creates a new signature/initials with the dialog, saves it if asked, then lets the user place it. */
export async function addSignatureFlow(kind: SignatureKind) {
  closeSignMenu()
  if (!getActiveDoc()) {
    toast('Open a PDF first to sign it.')
    return
  }
  const result = await openSignatureDialog(kind)
  if (!result) return
  if (result.save) await saveSignature(kind, result.image)
  startPlacing(kind, result.image)
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

function SavedRow({ kind, image }: { kind: SignatureKind; image: SignatureImage }) {
  const noun = kind === 'signature' ? 'signature' : 'initials'
  return (
    <div className="fc-fill-sign-saved">
      <button
        type="button"
        role="menuitem"
        className="fc-fill-sign-saved-use"
        title={`Place your ${noun}`}
        aria-label={`Place your saved ${noun}`}
        onClick={() => startPlacing(kind, image)}
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
        <div className="fc-fill-sign-menu-title">Signature</div>
        {signature && <SavedRow kind="signature" image={signature} />}
        <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void addSignatureFlow('signature')}>
          <span className="ui-menu-icon">
            <Plus size={16} />
          </span>
          <span className="ui-menu-label">{signature ? 'Add new signature' : 'Add signature'}</span>
        </button>
        <div className="ui-menu-sep" role="separator" />
        <div className="fc-fill-sign-menu-title">Initials</div>
        {initials && <SavedRow kind="initials" image={initials} />}
        <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void addSignatureFlow('initials')}>
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
