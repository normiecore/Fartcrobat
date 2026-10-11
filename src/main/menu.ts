import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuItemModel, MenuModel } from '@shared/types'
import { send } from './ipc'
import { currentWindow } from './windows'

const isMac = process.platform === 'darwin'

function toItem(item: MenuItemModel): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }
  if (item.role) return { role: item.role as any, label: item.label }
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
  if (item.submenu) opts.submenu = item.submenu.map(toItem)
  else if (item.id) {
    const id = item.id
    opts.click = () => send(currentWindow(), 'menu:command', id)
  }
  return opts
}

export function applyMenu(model: MenuModel) {
  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: () => send(currentWindow(), 'menu:command', 'app.preferences') },
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
    template.push({ label: menu.label, submenu: menu.items.map(toItem) })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Minimal menu shown before the renderer sends its full model. */
export function applyDefaultMenu() {
  applyMenu({
    menus: [
      { id: 'edit', label: 'Edit', items: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'copy' }, { role: 'paste' }] },
      { id: 'view', label: 'View', items: [{ role: 'toggleDevTools' }] }
    ]
  })
}
