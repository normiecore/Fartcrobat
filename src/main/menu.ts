import { app, BrowserWindow, Menu } from 'electron'
import type { MenuModel } from '@shared/types'
import { send } from './ipc'
import { buildMenuTemplate } from './util/menuTemplate'
import { currentWindow, isAppWindow } from './windows'

export function applyMenu(model: MenuModel) {
  const template = buildMenuTemplate(model, process.platform, {
    appName: app.name,
    command: (id) => send(currentWindow(), 'menu:command', id),
    appWindowFocused: () => {
      const focused = BrowserWindow.getFocusedWindow()
      return !!focused && isAppWindow(focused)
    },
    sendAction: (selector) => Menu.sendActionToFirstResponder(selector)
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Minimal menu shown before the renderer sends its full model. */
export function applyDefaultMenu() {
  applyMenu({
    menus: [
      {
        id: 'edit',
        label: 'Edit',
        items: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      { id: 'view', label: 'View', items: [{ role: 'toggleDevTools' }] }
    ]
  })
}
