import type { MenuItemConstructorOptions } from 'electron'
import type { MenuItemModel, MenuModel } from '@shared/types'

/** What menu items do when chosen. */
export interface MenuHandlers {
  appName: string
  /** Runs a renderer command in the focused document window. */
  command(id: string): void
  /** macOS: whether a document window is key (not a native panel such as a Save dialog). */
  appWindowFocused(): boolean
  /** macOS: sends a standard action (copy:, paste:...) to the first responder. */
  sendAction(selector: string): void
}

/**
 * Edit menu commands that are also standard text-editing actions. In a text field the renderer
 * turns them into the native action (webContents.copy() and so on); on macOS, when a native panel
 * such as the Save dialog is key, the action goes to that panel instead. These items are always
 * enabled on macOS because the menu is what makes Cmd+X/C/V/A work in every text field there.
 */
export const STANDARD_EDIT_ACTIONS: Readonly<Record<string, string>> = {
  'edit.undo': 'undo:',
  'edit.redo': 'redo:',
  'edit.cut': 'cut:',
  'edit.copy': 'copy:',
  'edit.paste': 'paste:',
  'edit.delete': 'delete:',
  'edit.selectAll': 'selectAll:'
}

const ALWAYS_ENABLED_ON_MAC = new Set(['edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'])

/** Converts the renderer's menu model into an Electron menu template for `platform`. */
export function buildMenuTemplate(model: MenuModel, platform: string, h: MenuHandlers): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'

  const toItem = (item: MenuItemModel): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.role) return { role: item.role as MenuItemConstructorOptions['role'], label: item.label }
    const opts: MenuItemConstructorOptions = {
      label: item.label,
      enabled: item.enabled !== false,
      type: item.type === 'checkbox' || item.type === 'radio' ? item.type : undefined,
      checked: item.checked
    }
    if (item.accelerator) {
      opts.accelerator = item.accelerator
      // The renderer handles shortcuts itself on Windows/Linux; avoid double triggering.
      if (!isMac) opts.registerAccelerator = false
    }
    if (item.submenu) {
      opts.submenu = item.submenu.map(toItem)
      return opts
    }
    const id = item.id
    if (!id) return opts
    const selector = STANDARD_EDIT_ACTIONS[id]
    if (isMac && selector) {
      if (ALWAYS_ENABLED_ON_MAC.has(id)) opts.enabled = true
      opts.click = () => (h.appWindowFocused() ? h.command(id) : h.sendAction(selector))
    } else {
      opts.click = () => h.command(id)
    }
    return opts
  }

  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: h.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: () => h.command('app.preferences') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }
  for (const menu of model.menus) {
    const items = menu.items.map(toItem)
    if (isMac && menu.id === 'window') {
      // The standard Window menu: Minimize (Cmd+M), Zoom, the window list and Bring All to Front.
      template.push({
        label: menu.label,
        role: 'windowMenu',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, ...items, { type: 'separator' }, { role: 'front' }]
      })
    } else if (isMac && menu.id === 'help') {
      template.push({ label: menu.label, role: 'help', submenu: items })
    } else {
      template.push({ label: menu.label, submenu: items })
    }
  }
  return template
}
