import type { MenuItemModel, MenuModel } from '@shared/types'
import { invoke, isMac } from '../platform'
import { registry, type CommandContext, type CommandDefinition, type MenuId } from './registry'
import { getActiveDoc, useApp } from './store'
import { showError } from './ui-services'

export function commandContext(): CommandContext {
  return { doc: getActiveDoc() }
}

export function commandLabel(cmd: CommandDefinition, ctx = commandContext()): string {
  return typeof cmd.label === 'function' ? cmd.label(ctx) : cmd.label
}

export function isCommandEnabled(cmd: CommandDefinition, ctx = commandContext()): boolean {
  if (cmd.requiresDocument !== false && !ctx.doc) return false
  try {
    return cmd.enabled ? cmd.enabled(ctx) : true
  } catch {
    return false
  }
}

export async function runCommand(id: string): Promise<boolean> {
  const cmd = registry.commands.get(id)
  if (!cmd) {
    console.warn(`Unknown command ${id}`)
    return false
  }
  const ctx = commandContext()
  if (!isCommandEnabled(cmd, ctx)) return false
  try {
    await cmd.run(ctx)
  } catch (err) {
    showError(err)
  }
  return true
}

// ---- shortcuts ------------------------------------------------------------------------------

/** "Mod+Shift+S" -> normalized form with Ctrl/Meta resolved for this platform. */
export function normalizeShortcut(s: string): string {
  let parts: string[]
  let key: string
  if (s.endsWith('++')) {
    parts = s.slice(0, -2).split('+')
    key = '+'
  } else {
    parts = s.split('+').map((p) => p.trim())
    key = parts.pop()!
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  const out: string[] = []
  if (mods.has('mod')) out.push(isMac ? 'Meta' : 'Ctrl')
  if (mods.has('ctrl')) out.push('Ctrl')
  if (mods.has('meta') || mods.has('cmd')) out.push('Meta')
  if (mods.has('alt') || mods.has('option')) out.push('Alt')
  if (mods.has('shift')) out.push('Shift')
  const order = ['Ctrl', 'Meta', 'Alt', 'Shift']
  out.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [...new Set(out), key.length === 1 ? key.toUpperCase() : key].join('+')
}

export function eventToShortcut(e: KeyboardEvent): string {
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  // Shift changes symbols ("+" vs "="); use the physical key for digits and symbols.
  if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (e.code === 'Equal') key = '='
  else if (e.code === 'Minus') key = '-'
  else if (e.code === 'NumpadAdd') key = '+'
  else if (e.code === 'NumpadSubtract') key = '-'
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.metaKey) mods.push('Meta')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, key].join('+')
}

/** Human-readable shortcut for menus and tooltips. */
export function displayShortcut(s: string): string {
  const n = normalizeShortcut(s)
  if (!isMac) return n
  return n
    .replace('Meta+', '⌘')
    .replace('Ctrl+', '⌃')
    .replace('Alt+', '⌥')
    .replace('Shift+', '⇧')
}

/** Electron accelerator syntax. */
function toAccelerator(s: string): string {
  return s
    .split('+')
    .map((p) => (p === 'Mod' ? 'CmdOrCtrl' : p))
    .join('+')
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'range', 'color'].includes(type)
  }
  return false
}

let shortcutIndex: Map<string, CommandDefinition[]> | null = null

function buildShortcutIndex() {
  shortcutIndex = new Map()
  for (const cmd of registry.commands.values()) {
    const list = cmd.shortcut ? (Array.isArray(cmd.shortcut) ? cmd.shortcut : [cmd.shortcut]) : []
    for (const s of list) {
      const key = normalizeShortcut(s)
      const arr = shortcutIndex.get(key) ?? []
      arr.push(cmd)
      shortcutIndex.set(key, arr)
    }
  }
}

/** Global keydown handler. Returns true when a command handled the event. */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!shortcutIndex) buildShortcutIndex()
  if (e.defaultPrevented) return false
  const combo = eventToShortcut(e)
  const cmds = shortcutIndex!.get(combo)
  if (!cmds) return false
  const key = combo.split('+').pop()!
  const hasMod = /(^|\+)(Ctrl|Meta|Alt)\+/.test(combo) || /^(Ctrl|Meta|Alt)\+/.test(combo)
  const functionKey = /^F\d+$/.test(key) || key === 'Escape'
  const typing = isTypingTarget(e.target)
  // While typing, plain keys and text-editing shortcuts belong to the input.
  if (typing && !hasMod && !functionKey) return false
  if (typing && /^(Ctrl|Meta)\+(Shift\+)?[ACVXZY]$/.test(combo)) return false
  const letterKey = !hasMod && /^[A-Z0-9]$/.test(key)
  if (letterKey && !useApp.getState().prefs.singleKeyShortcuts) return false
  if (useApp.getState().dialogs.length || useApp.getState().paletteOpen) return false
  const ctx = commandContext()
  for (const cmd of cmds) {
    if (!isCommandEnabled(cmd, ctx)) continue
    e.preventDefault()
    e.stopPropagation()
    void Promise.resolve(cmd.run(ctx)).catch((err) => showError(err))
    return true
  }
  return false
}

// ---- native menu ----------------------------------------------------------------------------

const MENU_LABELS: Record<MenuId, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  document: 'Document',
  comment: 'Comment',
  forms: 'Forms',
  tools: 'Tools',
  sign: 'Sign',
  window: 'Window',
  help: 'Help'
}

export interface ResolvedMenuItem {
  command: CommandDefinition
  submenu?: string
}

/** Groups menu contributions by menu, in display order, with separators between groups. */
export function resolveMenus(): { id: MenuId; label: string; groups: ResolvedMenuItem[][] }[] {
  const out: { id: MenuId; label: string; groups: ResolvedMenuItem[][] }[] = []
  for (const id of Object.keys(MENU_LABELS) as MenuId[]) {
    const items = registry.menus.filter((m) => m.menu === id && registry.commands.has(m.command))
    if (!items.length) continue
    const groupOrder: string[] = []
    const groups = new Map<string, typeof items>()
    for (const it of items.sort((a, b) => (a.order ?? 500) - (b.order ?? 500))) {
      const g = it.group ?? 'default'
      if (!groups.has(g)) {
        groups.set(g, [])
        groupOrder.push(g)
      }
      groups.get(g)!.push(it)
    }
    out.push({
      id,
      label: MENU_LABELS[id],
      groups: groupOrder.map((g) =>
        groups.get(g)!.map((m) => ({ command: registry.commands.get(m.command)!, submenu: m.submenu }))
      )
    })
  }
  return out
}

export function buildMenuModel(): MenuModel {
  const ctx = commandContext()
  const toItem = (cmd: CommandDefinition): MenuItemModel => {
    const shortcut = Array.isArray(cmd.shortcut) ? cmd.shortcut[0] : cmd.shortcut
    return {
      id: cmd.id,
      label: commandLabel(cmd, ctx),
      accelerator: shortcut && shortcut.includes('+') ? toAccelerator(shortcut) : undefined,
      enabled: isCommandEnabled(cmd, ctx),
      type: cmd.checked ? 'checkbox' : 'normal',
      checked: cmd.checked ? cmd.checked(ctx) : undefined
    }
  }
  return {
    menus: resolveMenus().map((menu) => {
      const items: MenuItemModel[] = []
      menu.groups.forEach((group, gi) => {
        if (gi > 0) items.push({ type: 'separator' })
        const subs = new Map<string, MenuItemModel>()
        for (const it of group) {
          if (it.submenu) {
            let sub = subs.get(it.submenu)
            if (!sub) {
              sub = { label: it.submenu, type: 'submenu', submenu: [] }
              subs.set(it.submenu, sub)
              items.push(sub)
            }
            sub.submenu!.push(toItem(it.command))
          } else items.push(toItem(it.command))
        }
      })
      return { id: menu.id, label: menu.label, items }
    })
  }
}

let menuTimer: number | null = null

/** Rebuilds the native menu soon (coalesces bursts of state changes). */
export function scheduleMenuUpdate() {
  if (menuTimer !== null) return
  menuTimer = window.setTimeout(() => {
    menuTimer = null
    void invoke('menu:set', buildMenuModel()).catch(() => {})
  }, 150)
}
