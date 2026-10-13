import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import type { MenuModel } from '@shared/types'
import { buildMenuTemplate, STANDARD_EDIT_ACTIONS } from '@main/util/menuTemplate'

const model: MenuModel = {
  menus: [
    { id: 'file', label: 'File', items: [{ id: 'file.open', label: 'Open…', accelerator: 'CmdOrCtrl+O', enabled: true }] },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: 'edit.undo', label: 'Undo Add Highlight', accelerator: 'CmdOrCtrl+Z', enabled: true },
        { id: 'edit.redo', label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', enabled: false },
        { type: 'separator' },
        { id: 'edit.cut', label: 'Cut', accelerator: 'CmdOrCtrl+X', enabled: false },
        { id: 'edit.copy', label: 'Copy', accelerator: 'CmdOrCtrl+C', enabled: false },
        { id: 'edit.paste', label: 'Paste', accelerator: 'CmdOrCtrl+V', enabled: false },
        { id: 'edit.delete', label: 'Delete', enabled: false },
        { id: 'edit.selectAll', label: 'Select All', accelerator: 'CmdOrCtrl+A', enabled: false },
        { id: 'edit.deselect', label: 'Deselect All', accelerator: 'CmdOrCtrl+Shift+A', enabled: false }
      ]
    },
    { id: 'window', label: 'Window', items: [{ id: 'window.home', label: 'Home', enabled: true }] },
    { id: 'help', label: 'Help', items: [{ id: 'help.about', label: 'About Fartcrobat', enabled: true }] }
  ]
}

function setup(platform: string, appWindowFocused = true) {
  const commands: string[] = []
  const actions: string[] = []
  const template = buildMenuTemplate(model, platform, {
    appName: 'Fartcrobat',
    command: (id) => commands.push(id),
    appWindowFocused: () => appWindowFocused,
    sendAction: (s) => actions.push(s)
  })
  const menu = (label: string) => template.find((m) => m.label === label)!
  const items = (label: string) => menu(label).submenu as MenuItemConstructorOptions[]
  const item = (label: string, itemLabel: string) => items(label).find((i) => i.label === itemLabel)!
  const click = (i: MenuItemConstructorOptions) => (i.click as unknown as () => void)()
  return { template, menu, items, item, click, commands, actions }
}

describe('native menu on macOS', () => {
  it('starts with the app menu, with Quit as the standard role', () => {
    const { template } = setup('darwin')
    expect(template[0].label).toBe('Fartcrobat')
    const roles = (template[0].submenu as MenuItemConstructorOptions[]).map((i) => i.role).filter(Boolean)
    expect(roles).toContain('quit')
    expect(roles).toContain('hide')
  })

  it('keeps Cut, Copy, Paste, Delete and Select All enabled with their shortcuts so text fields work', () => {
    const { item } = setup('darwin')
    for (const label of ['Cut', 'Copy', 'Paste', 'Delete', 'Select All']) {
      expect(item('Edit', label).enabled, label).toBe(true)
      expect(item('Edit', label).registerAccelerator, label).toBeUndefined()
    }
    expect(item('Edit', 'Paste').accelerator).toBe('CmdOrCtrl+V')
    // Undo/Redo follow the renderer (which enables them while a text field has focus).
    expect(item('Edit', 'Undo Add Highlight').enabled).toBe(true)
    expect(item('Edit', 'Redo').enabled).toBe(false)
    expect(item('Edit', 'Deselect All').enabled).toBe(false)
  })

  it('sends edit items to the document window, or to a native panel (Save dialog) when that is key', () => {
    const doc = setup('darwin', true)
    doc.click(doc.item('Edit', 'Paste'))
    doc.click(doc.item('Edit', 'Undo Add Highlight'))
    expect(doc.commands).toEqual(['edit.paste', 'edit.undo'])
    expect(doc.actions).toEqual([])

    const panel = setup('darwin', false)
    for (const label of ['Cut', 'Copy', 'Paste', 'Delete', 'Select All', 'Undo Add Highlight']) panel.click(panel.item('Edit', label))
    expect(panel.actions).toEqual(['cut:', 'copy:', 'paste:', 'delete:', 'selectAll:', 'undo:'])
    expect(panel.commands).toEqual([])
    // Other items always go to the document window.
    panel.click(panel.item('File', 'Open…'))
    expect(panel.commands).toEqual(['file.open'])
  })

  it('uses the standard Window and Help menus (Minimize, window list, Help search)', () => {
    const { menu, items } = setup('darwin')
    expect(menu('Window').role).toBe('windowMenu')
    const roles = items('Window').map((i) => i.role ?? i.label)
    expect(roles).toEqual(['minimize', 'zoom', undefined, 'Home', undefined, 'front'])
    expect(menu('Help').role).toBe('help')
  })

  it('maps every standard edit command to a Cocoa action', () => {
    expect(Object.keys(STANDARD_EDIT_ACTIONS).sort()).toEqual(
      ['edit.copy', 'edit.cut', 'edit.delete', 'edit.paste', 'edit.redo', 'edit.selectAll', 'edit.undo'].sort()
    )
  })
})

describe('native menu on Windows and Linux', () => {
  it('has no app menu and leaves shortcuts to the renderer', () => {
    for (const platform of ['win32', 'linux']) {
      const { template, item, click, commands } = setup(platform)
      expect(template.map((m) => m.label)).toEqual(['File', 'Edit', 'Window', 'Help'])
      expect(item('Edit', 'Copy').enabled).toBe(false)
      expect(item('Edit', 'Copy').registerAccelerator).toBe(false)
      expect(item('Edit', 'Copy').accelerator).toBe('CmdOrCtrl+C')
      click(item('Edit', 'Cut'))
      expect(commands).toEqual(['edit.cut'])
      expect(template.find((m) => m.label === 'Window')!.role).toBeUndefined()
    }
  })
})
