import type { EditCommand } from '@shared/ipc'
import { invoke } from '../platform'
import { commandsAllowed, isCommandEnabled, normalizeShortcut, runCommand, scheduleMenuUpdate } from './commands'
import { registry, type CommandContext, type CommandDefinition } from './registry'

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'])

/**
 * Whether keyboard focus is in a field where text is typed. The Edit menu's Undo, Cut, Copy,
 * Paste, Delete and Select All then act on that text instead of the document.
 */
export function textFieldFocused(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement) return !el.disabled
  if (el instanceof HTMLInputElement) return !el.disabled && TEXT_INPUT_TYPES.has(el.type)
  return false
}

/** Runs a native text-editing command (the same as the browser's own Edit menu) in the focused field. */
export function nativeEdit(action: EditCommand): Promise<void> {
  return invoke('window:editCommand', action)
}

/**
 * The enabled command, other than `self`, that pressing `shortcut` would run (features bind
 * Mod+C, Mod+V, Delete... to their own selections, e.g. form fields or comments).
 */
export function commandForShortcut(shortcut: string, self: string, ctx: CommandContext): CommandDefinition | null {
  const key = normalizeShortcut(shortcut)
  for (const cmd of registry.commands.values()) {
    if (cmd.id === self || !cmd.shortcut) continue
    const list = Array.isArray(cmd.shortcut) ? cmd.shortcut : [cmd.shortcut]
    if (!list.some((s) => normalizeShortcut(s) === key)) continue
    if (isCommandEnabled(cmd, ctx)) return cmd
  }
  return null
}

/** Edit commands that are text-editing actions when a text field has focus. */
const TEXT_ACTIONS: Readonly<Record<string, EditCommand>> = {
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'edit.cut': 'cut',
  'edit.copy': 'copy',
  'edit.paste': 'paste',
  'edit.delete': 'delete',
  'edit.selectAll': 'selectAll'
}

/**
 * Runs a command chosen in the native menu (or with a shortcut the native menu handles, as macOS
 * does for Cmd+Z/X/C/V/A in text fields). With a text field focused, the Edit menu's text
 * commands edit that field, as in every other app; everything else runs the command.
 */
export async function runMenuCommand(id: string): Promise<void> {
  const action = TEXT_ACTIONS[id]
  if (action && textFieldFocused()) {
    await nativeEdit(action)
    return
  }
  // Like keyboard shortcuts, menu commands wait until a dialog or a long operation is finished.
  if (!commandsAllowed()) return
  await runCommand(id)
}

let tracking = false

/** Keeps the native Edit menu in step with focus moving in and out of text fields. */
export function trackTextFieldFocus() {
  if (tracking) return
  tracking = true
  let last = textFieldFocused()
  const check = () => {
    // During focusout the next element is not focused yet; look once focus has settled.
    setTimeout(() => {
      const now = textFieldFocused()
      if (now !== last) {
        last = now
        scheduleMenuUpdate()
      }
    }, 0)
  }
  document.addEventListener('focusin', check)
  document.addEventListener('focusout', check)
}
