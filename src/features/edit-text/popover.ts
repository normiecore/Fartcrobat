/** Closes a colour palette opened from the formatting controls. Returns false when none was open. */
export function closeFormattingPopover(): boolean {
  const scrim = document.querySelector('[data-fc-edit-text-keep] .ui-popover-scrim')
  if (!scrim) return false
  // the UI kit closes its popovers on a mouse press outside them (on the scrim)
  scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return true
}
