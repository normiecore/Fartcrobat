// Tabs between windows (docs/features/windows-tabs.md): Move to New Window with unsaved changes,
// moving into another window (menu and a drop on its tab strip), reordering by drag, a window left
// without tabs by a drag closing, the second-launch preference, and agent handles that follow a move.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'
import { dataOf, startSession } from './agent-helpers'

function tempCopy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'inkmoor-tabs-'))
  const path = join(dir, name.split('/').pop()!)
  copyFileSync(fixturePath(name), path)
  return path
}

async function titles(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__inkmoor?.useApp.getState().docs.map((d: any) => d.state.title) ?? [])
}

async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)
}

/** Waits for a window opened by `action`, booted. */
async function nextWindow(app: ElectronApplication, action: () => Promise<unknown>): Promise<Page> {
  const next = app.waitForEvent('window')
  await action()
  const page = await next
  await page.waitForSelector('.shell')
  await page.waitForFunction(() => !!(window as any).__inkmoor)
  return page
}

async function addNote(page: Page, text: string) {
  await page.evaluate(
    (t) => (window as any).__inkmoor.getActiveDoc().ops('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: t }),
    text
  )
  await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
}

async function activePath(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__inkmoor.getActiveDoc()?.state.filePath ?? null)
}

test('Move to New Window keeps unsaved changes, the path, the page and zoom; Save writes the same file', async () => {
  const path = tempCopy('text.pdf')
  const before = readFileSync(path).length
  const { app, page } = await launch()
  try {
    await openFile(page, path)
    await openFile(page, fixturePath('form.pdf'))
    await page.getByRole('tab', { name: /text\.pdf/ }).click()
    await addNote(page, 'Moved along')
    await page.evaluate(() => {
      const d = (window as any).__inkmoor.getActiveDoc()
      d.view.setZoom(1.5)
      d.view.goToPage(2)
    })
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(2)

    const win2 = await nextWindow(app, () => runCommand(page, 'window.moveToNewWindow'))
    await expect.poll(() => titles(win2)).toEqual(['text.pdf'])
    await waitForRender(win2, 2)
    const s = await activeDocState(win2)
    expect(s).toMatchObject({ title: 'text.pdf', dirty: true, currentPage: 2, zoom: 1.5 })
    // The undo history stayed behind, and the person is told.
    expect(s!.journal.canUndo).toBe(false)
    await expect(win2.locator('.toast', { hasText: 'Its undo history stayed behind' })).toBeVisible()
    expect(await activePath(win2)).toBe(path)
    const notes = await win2.evaluate(() => (window as any).__inkmoor.getActiveDoc().ops('annots').list(0))
    expect(notes.map((n: any) => n.contents)).toContain('Moved along')
    await win2.screenshot({ path: 'test-results/windows-tabs-moved.png' })

    // The first window keeps its other tab (a move from the menu does not close it).
    await expect.poll(() => titles(page)).toEqual(['form.pdf'])
    expect(await windowCount(app)).toBe(2)

    // Save in the new window writes the file it came from.
    await runCommand(win2, 'file.save')
    await expect.poll(async () => (await activeDocState(win2))?.dirty).toBe(false)
    expect(readFileSync(path).length).toBeGreaterThan(before)
    expect(readFileSync(path).includes(Buffer.from('Moved along'))).toBe(true)
  } finally {
    await app.close()
  }
})

test('a tab moves into another window from its menu and by a drop on that window’s tab strip; a dragged-out last tab closes its window', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await openFile(page, fixturePath('form.pdf'))
    await openFile(page, fixturePath('compare-a.pdf'))
    const win2 = await nextWindow(app, () => runCommand(page, 'file.newWindow'))
    await openFile(win2, fixturePath('mixed-sizes.pdf'))

    // Reorder in the strip by dragging a tab onto another.
    await page.getByRole('tab', { name: /compare-a\.pdf/ }).dragTo(page.getByRole('tab', { name: /text\.pdf/ }), { targetPosition: { x: 5, y: 10 } })
    await expect.poll(() => titles(page)).toEqual(['compare-a.pdf', 'text.pdf', 'form.pdf'])

    // Right-click > Move to the other window (its title names its document).
    await page.getByRole('tab', { name: /form\.pdf/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to “mixed-sizes.pdf” window' }).click()
    await expect.poll(() => titles(win2)).toEqual(['mixed-sizes.pdf', 'form.pdf'])
    await expect.poll(() => titles(page)).toEqual(['compare-a.pdf', 'text.pdf'])

    // A tab of the first window dropped at the start of the second window's strip.
    const from = await (await app.browserWindow(page)).evaluate((w) => w.id)
    const docId = await page.evaluate(() => (window as any).__inkmoor.useApp.getState().docs.find((d: any) => d.state.title === 'text.pdf').id)
    const boot = 'another-window'
    await win2.evaluate(
      ({ data }) => {
        const strip = document.querySelector('.shell-tabs')!
        const first = strip.querySelector('.shell-tab')!.getBoundingClientRect()
        const dt = new DataTransfer()
        dt.setData('application/x-inkmoor-tab', JSON.stringify(data))
        const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: first.left + 2, clientY: first.top + 5 }
        strip.dispatchEvent(new DragEvent('dragover', at))
        strip.dispatchEvent(new DragEvent('drop', at))
      },
      { data: { windowId: from, boot, docId } }
    )
    await expect.poll(() => titles(win2)).toEqual(['text.pdf', 'mixed-sizes.pdf', 'form.pdf'])
    await expect.poll(() => titles(page)).toEqual(['compare-a.pdf'])

    // The last tab dragged out of the first window (let go over the desktop): a new window takes it
    // and the first window, left without tabs, closes.
    const win3 = await nextWindow(app, () =>
      page.evaluate(() => {
        const w = (window as any).__inkmoor
        return w.moveDocument(w.getActiveDoc(), { kind: 'new', point: { x: 300, y: 200 } }, { closeEmpty: true })
      })
    )
    await expect.poll(() => titles(win3)).toEqual(['compare-a.pdf'])
    await expect.poll(() => windowCount(app)).toBe(2)
    expect(page.isClosed()).toBe(true)
  } finally {
    await app.close()
  }
})

test('a document already open in the other window does not move there twice', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    const win2 = await nextWindow(app, () => runCommand(page, 'file.newWindow'))
    await openFile(win2, fixturePath('text.pdf'))
    await page.getByRole('tab', { name: /text\.pdf/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Move to “text\.pdf” window/ }).click()
    await expect(page.locator('.ui-dialog, .toast', { hasText: 'already open in that window' })).toBeVisible()
    expect(await titles(page)).toEqual(['text.pdf'])
    expect(await titles(win2)).toEqual(['text.pdf'])
  } finally {
    await app.close()
  }
})

/** A Digital ID from the fixture PKI as Preferences > Digital IDs stores it (see certificate-encryption.spec.ts). */
function digitalId(name: string, label: string) {
  const pki = fixturePath('passwordless/pki')
  const der = readFileSync(join(pki, `${name}.cer`))
  const path = join(mkdtempSync(join(tmpdir(), 'inkmoor-ids-')), `${name}.p12`)
  copyFileSync(join(pki, `${name}.p12`), path)
  return {
    id: createHash('sha256').update(der).digest('hex').toUpperCase(),
    path,
    name: label,
    email: '',
    organization: 'Fartcrobat Test Keys',
    issuer: 'Fartcrobat Test CA',
    notBefore: '2025-01-01T00:00:00.000Z',
    notAfter: '2045-01-01T00:00:00.000Z',
    keyType: 'RSA 2048',
    certificate: der.toString('base64'),
    selfSigned: false,
    createdByApp: false,
    addedAt: 0
  }
}

function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

test('password-protected and certificate-encrypted documents move without asking again', async () => {
  test.skip(!!process.env.INKMOOR_EXECUTABLE, 'packaged builds have no test cipher')
  const { app, page } = await launch([], { INKMOOR_TEST_SECRET_CIPHER: '1' }, {
    prefs: { useWindowsCertificateStore: false },
    kv: { 'digital-signatures:ids': [digitalId('alice', 'Alice Test')] }
  })
  try {
    await page.evaluate((p) => void (window as any).__inkmoor.openPaths([p]), fixturePath('encrypted.pdf'))
    const pw = dialogTitled(page, 'Password required')
    await pw.getByLabel('Password', { exact: true }).fill('secret')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('encrypted.pdf')

    const cert = tempCopy('passwordless/text-v5.pdf')
    await page.evaluate((p) => void (window as any).__inkmoor.openPaths([p]), cert)
    const id = dialogTitled(page, 'Digital ID password')
    await id.getByLabel('Password', { exact: true }).fill('alice-pass')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('text-v5.pdf')
    await addNote(page, 'Encrypted move')

    const win2 = await nextWindow(app, () => runCommand(page, 'window.moveToNewWindow'))
    await expect.poll(() => titles(win2)).toEqual(['text-v5.pdf'])
    await waitForRender(win2)
    await expect(win2.locator('.ui-dialog')).toHaveCount(0)
    const moved = await win2.evaluate(() => {
      const d = (window as any).__inkmoor.getActiveDoc()
      return { dirty: d.state.dirty, security: d.state.info.security, method: d.state.unlock?.method, via: d.state.unlock?.via?.label, key: !!d.state.unlock?.certificateKey }
    })
    expect(moved).toEqual({ dirty: true, security: 'certificate', method: 'certificate', via: 'Alice Test', key: true })
    // Saved there, it stays encrypted for the same recipients and holds the note.
    await runCommand(win2, 'file.save')
    await expect.poll(async () => (await activeDocState(win2))?.dirty).toBe(false)
    const text = readFileSync(cert).toString('latin1')
    expect(text).toContain('/Adobe.PubSec')
    expect(text).not.toContain('Encrypted move')

    // The password-protected one goes into that window without a password prompt.
    await page.getByRole('tab', { name: /encrypted\.pdf/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to “text-v5.pdf” window' }).click()
    await expect.poll(() => titles(win2)).toEqual(['text-v5.pdf', 'encrypted.pdf'])
    await expect(win2.locator('.ui-dialog')).toHaveCount(0)
    expect(await activeDocState(win2)).toMatchObject({ title: 'encrypted.pdf', dirty: false })
    expect(await win2.evaluate(() => (window as any).__inkmoor.getActiveDoc().state.unlock?.method)).toBe('typed')
  } finally {
    await app.close()
  }
})

test('files from other apps open in the current window, or in a new window when Preferences say so', async () => {
  const secondLaunch = (app: ElectronApplication, file: string) =>
    app.evaluate(({ app }, f) => app.emit('second-instance', {}, [process.execPath, f], process.cwd()), file)

  const current = await launch()
  try {
    await openFile(current.page, fixturePath('text.pdf'))
    await secondLaunch(current.app, fixturePath('form.pdf'))
    await expect.poll(() => titles(current.page)).toEqual(['text.pdf', 'form.pdf'])
    expect(await windowCount(current.app)).toBe(1)
  } finally {
    await current.app.close()
  }

  const { app, page } = await launch([], {}, { prefs: { openFilesFromOtherApps: 'new-window' } })
  try {
    await openFile(page, fixturePath('text.pdf'))
    const win2 = await nextWindow(app, () => secondLaunch(app, fixturePath('form.pdf')))
    await expect.poll(() => titles(win2)).toEqual(['form.pdf'])
    expect(await titles(page)).toEqual(['text.pdf'])
    // A file already open is shown in its window, not opened again.
    await secondLaunch(app, fixturePath('text.pdf'))
    await expect.poll(() => page.evaluate(() => (window as any).__inkmoor.getActiveDoc()?.state.title)).toBe('text.pdf')
    expect(await windowCount(app)).toBe(2)
    expect(await titles(win2)).toEqual(['form.pdf'])

    // The option in Preferences > General.
    await runCommand(page, 'app.preferences')
    await expect(page.getByText('Open files from other apps in')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an AI app reaches a document by its old handle after the tab moved to another window', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    await s.page.waitForSelector('.viewer-page canvas')
    const [{ handle }] = dataOf(await s.agent.call('list_documents')).documents
    const win2 = await nextWindow(s.app, () => runCommand(s.page, 'window.moveToNewWindow'))
    await expect.poll(() => titles(win2)).toEqual(['text.pdf'])

    const text = await s.agent.call('get_page_text', { handle, pages: '1' })
    expect(JSON.stringify(dataOf(text))).toContain('Hello Fartcrobat page 1')
    const listed = dataOf(await s.agent.call('list_documents')).documents
    expect(listed).toHaveLength(1)
    expect(listed[0].handle).not.toBe(handle)
    expect(listed[0].path).toBe(fixturePath('text.pdf'))
  } finally {
    await s.close()
  }
})
