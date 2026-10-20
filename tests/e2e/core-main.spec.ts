import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activeDocState, FIXTURES, fixturePath, launch, openFile, ROOT, runCommand, waitForRender } from './helpers'

// ---- helpers -------------------------------------------------------------------------------------

/** Lets windows ask about unsaved changes (the other specs close windows without asking). */
const ASK_ON_CLOSE = { FARTCROBAT_FORCE_CLOSE: '' }

async function docTitles(page: Page): Promise<string[]> {
  // window.__fartcrobat appears once the window has booted (after its launch files opened).
  return page.evaluate(() => (window as any).__fartcrobat?.useApp.getState().docs.map((d: any) => d.state.title) ?? [])
}

async function markDirty(page: Page) {
  await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.markDirty())
  await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
}

async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)
}

async function newWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const next = app.waitForEvent('window')
  await runCommand(page, 'file.newWindow')
  const p = await next
  await p.waitForSelector('.shell')
  return p
}

/** An answer that never comes (the message box stays open). */
const NEVER = -1

/** Replaces native message boxes: answers with the queued responses (default 0) and records them. */
async function stubMessageBoxes(app: ElectronApplication, answers: number[] = []) {
  await app.evaluate(({ dialog }, queued) => {
    const g = globalThis as any
    g.__boxes = []
    g.__answers = queued
    dialog.showMessageBox = ((...args: any[]) => {
      const opts = args.find((a) => a && typeof a === 'object' && 'message' in a)
      g.__boxes.push({ title: opts.title, message: opts.message, buttons: opts.buttons })
      const response = g.__answers.length ? g.__answers.shift() : 0
      if (response === -1) return new Promise(() => {})
      return Promise.resolve({ response, checkboxChecked: false })
    }) as any
  }, answers)
}

async function boxes(app: ElectronApplication): Promise<{ title: string; message: string; buttons: string[] }[]> {
  return app.evaluate(() => (globalThis as any).__boxes ?? [])
}

async function waitForExit(app: ElectronApplication) {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

async function closeQuietly(app: ElectronApplication) {
  try {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))])
  } catch {}
}

/** Runs JavaScript in a window's renderer from the main process (works across renderer crashes). */
async function inWindow<T>(app: ElectronApplication, id: number, code: string): Promise<T> {
  return app.evaluate(({ BrowserWindow }, a) => BrowserWindow.fromId(a.id)!.webContents.executeJavaScript(a.code), { id, code })
}

async function windowId(app: ElectronApplication, page: Page): Promise<number> {
  const bw = await app.browserWindow(page)
  return bw.evaluate((w) => w.id)
}

// ---- quitting ------------------------------------------------------------------------------------

test('Exit asks about unsaved documents in every window; Cancel keeps every tab; the app then really quits', async () => {
  const { app, page } = await launch([], ASK_ON_CLOSE)
  const proc = app.process()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await openFile(page, fixturePath('form.pdf'))
    await markDirty(page)
    const page2 = await newWindow(app, page)
    await openFile(page2, fixturePath('compare-a.pdf'))
    expect(await windowCount(app)).toBe(2)

    // File > Exit (Ctrl+Q) in the first window.
    await page.keyboard.press('Control+q')
    await expect(page.getByText('Save changes?')).toBeVisible()
    await expect(page.getByText('Do you want to save changes to “form.pdf” before closing?')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/core-main-quit-prompt.png' })

    // Asking again (Exit, then the window's close button) does not stack a second question.
    await runCommand(page, 'app.quit')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()))
    await page.waitForTimeout(500)
    await expect(page.locator('.ui-dialog')).toHaveCount(1)

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Save changes?')).toBeHidden()
    // The clean tab before the unsaved one was not closed by the cancelled quit.
    expect(await docTitles(page)).toEqual(['text.pdf', 'form.pdf'])
    await page.waitForTimeout(800)
    expect(await app.evaluate(() => process.pid)).toBeGreaterThan(0)
    await page.screenshot({ path: 'test-results/core-main-quit-cancelled.png' })

    // Quit from the native side (macOS Cmd+Q, the Dock, logging out): one question, then exit.
    await app.evaluate(({ app }) => setTimeout(() => app.quit(), 0))
    await expect(page.getByText('Save changes?')).toBeVisible()
    await page.getByRole('button', { name: "Don't Save" }).click()
    await waitForExit(app)
    expect(proc.exitCode).toBe(0)
  } finally {
    await closeQuietly(app)
  }
})

test('closing the last window with unsaved changes asks once, then the app exits', async () => {
  const { app, page } = await launch([], ASK_ON_CLOSE)
  try {
    await openFile(page, fixturePath('text.pdf'))
    await markDirty(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(page.getByText('Save changes?')).toBeVisible()
    await page.getByRole('button', { name: "Don't Save" }).click()
    await waitForExit(app)
  } finally {
    await closeQuietly(app)
  }
})

// ---- crashes and hangs ---------------------------------------------------------------------------

test('a window whose renderer crashed or hangs can always be closed, and a crashed one can reload its documents', async () => {
  const { app, page } = await launch([], ASK_ON_CLOSE)
  try {
    await openFile(page, fixturePath('text.pdf'))
    await openFile(page, fixturePath('form.pdf'))
    await markDirty(page)
    const page2 = await newWindow(app, page)
    const page3 = await newWindow(app, page)
    const id1 = await windowId(app, page)
    const id2 = await windowId(app, page2)
    const id3 = await windowId(app, page3)
    const crash = (id: number) => app.evaluate(({ BrowserWindow }, i) => BrowserWindow.fromId(i)!.webContents.forcefullyCrashRenderer(), id)

    // A crash offers to reload the window, which reopens its documents.
    await stubMessageBoxes(app, [0 /* Reload */, 1 /* Close Window */, NEVER])
    await crash(id1)
    await expect.poll(async () => (await boxes(app)).length, { timeout: 15000 }).toBe(1)
    expect((await boxes(app))[0].message).toBe('This window stopped working.')
    expect((await boxes(app))[0].buttons).toEqual(['Reload', 'Close Window'])
    await expect
      .poll(() => inWindow<string[] | null>(app, id1, 'window.__fartcrobat ? window.__fartcrobat.useApp.getState().docs.map(d => d.state.title) : null'), { timeout: 30000 })
      .toEqual(['text.pdf', 'form.pdf'])
    await new Promise((r) => setTimeout(r, 1000))
    await app.evaluate(async ({ BrowserWindow }, id) => {
      const img = await BrowserWindow.fromId(id)!.webContents.capturePage()
      const fs = (process as any).getBuiltinModule('node:fs')
      fs.writeFileSync('test-results/core-main-crash-reloaded.png', img.toPNG())
    }, id1)

    // ...or to close it.
    await crash(id1)
    await expect.poll(() => windowCount(app), { timeout: 15000 }).toBe(2)

    // The close button closes a crashed window at once, even with the message still showing.
    await crash(id3)
    await expect.poll(async () => (await boxes(app)).length, { timeout: 15000 }).toBe(3)
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), id3)
    await expect.poll(() => windowCount(app), { timeout: 15000 }).toBe(1)

    // A hung window: after a few seconds the user is offered to close it anyway.
    await openFile(page2, fixturePath('compare-a.pdf'))
    await markDirty(page2)
    await newWindow(app, page2) // keeps the app running once this window has closed
    await stubMessageBoxes(app, [0 /* Close Anyway */])
    await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id)!
      void w.webContents.executeJavaScript('setTimeout(() => { const t = Date.now(); while (Date.now() - t < 30000); }, 50); 1')
      setTimeout(() => w.close(), 400)
    }, id2)
    await expect.poll(() => windowCount(app), { timeout: 25000 }).toBe(1)
    const asked = await boxes(app)
    expect(asked.map((b) => b.title)).toEqual(['Fartcrobat is not responding'])
    expect(asked[0].buttons).toEqual(['Close Anyway', 'Wait'])
  } finally {
    await closeQuietly(app)
  }
})

// ---- opening files from the OS -----------------------------------------------------------------

test('a second launch opens relative paths and file:// URIs, and brings the window forward', async () => {
  const { app, page } = await launch()
  try {
    // argv as a second `electron out/main/index.js` process gives it, started in the fixtures folder.
    const exe = await app.evaluate(() => process.argv.slice(0, 2))
    await app.evaluate(({ app }, a) => app.emit('second-instance', {}, [...a.exe, '--no-sandbox', 'text.pdf'], a.cwd, {}), { exe, cwd: FIXTURES })
    await expect.poll(() => docTitles(page)).toEqual(['text.pdf'])
    const uri = pathToFileURL(fixturePath('form.pdf')).toString()
    await app.evaluate(({ app }, a) => app.emit('second-instance', {}, [...a.exe, '--some-flag', a.uri], '/', {}), { exe, uri })
    await expect.poll(() => docTitles(page)).toEqual(['text.pdf', 'form.pdf'])
    // Launching again without files (Start menu, dock) restores the window instead of doing nothing.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await app.evaluate(({ app }, e) => app.emit('second-instance', {}, e, '/', {}), exe)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false)
    expect(await windowCount(app)).toBe(1)
    await waitForRender(page)
    await page.screenshot({ path: 'test-results/core-main-second-launch.png' })
  } finally {
    await closeQuietly(app)
  }
})

test('files handed over while the window is still loading are all opened', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'fartcrobat-e2e-'))
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, FARTCROBAT_USER_DATA: userData, FARTCROBAT_MULTI_INSTANCE: '1', FARTCROBAT_FORCE_CLOSE: '1' } as Record<string, string>
  })
  try {
    const names = ['text.pdf', 'form.pdf', 'compare-a.pdf', 'compare-b.pdf', 'mixed-sizes.pdf', 'scanned.pdf']
    // One process per file, 60 ms apart from the moment the window exists (selecting several PDFs
    // in a file manager and pressing Enter): the first ones arrive before the renderer has booted.
    await app.evaluate(async ({ app, BrowserWindow }, list) => {
      // Electron delivers `second-instance` from the main loop, so emit only from timer callbacks.
      // This evaluate itself can start in the middle of the app's `new BrowserWindow(...)` (the
      // inspector runs it at the next JS interrupt check): the window is listed already but the app
      // has not registered it yet, and an event emitted right there would get a second window.
      do {
        await new Promise((r) => setTimeout(r, 2))
      } while (!BrowserWindow.getAllWindows().length)
      for (const f of list) {
        app.emit('second-instance', {}, ['/opt/Fartcrobat/fartcrobat', f], '/', {})
        await new Promise((r) => setTimeout(r, 60))
      }
    }, names.map(fixturePath))
    // Every file goes to the one window, not to windows of their own.
    expect(await windowCount(app)).toBe(1)
    const page = await app.firstWindow()
    await page.waitForSelector('.shell')
    await expect.poll(async () => (await docTitles(page)).sort(), { timeout: 30000 }).toEqual([...names].sort())
  } finally {
    await closeQuietly(app)
  }
})

test('a file opened while no window is open (macOS dock) gets a new window', async () => {
  const { app, page } = await launch()
  try {
    // Keep the process alive without windows, as macOS does.
    await app.evaluate(({ app }) => {
      app.on('before-quit', (e) => e.preventDefault())
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => windowCount(app)).toBe(0)
    expect(page).toBeTruthy()
    const next = app.waitForEvent('window')
    await app.evaluate(({ app }, f) => app.emit('open-file', { preventDefault() {} }, f), fixturePath('text.pdf'))
    const page2 = await next
    await page2.waitForSelector('.shell')
    await expect.poll(() => docTitles(page2), { timeout: 30000 }).toEqual(['text.pdf'])
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await closeQuietly(app)
  }
})

// ---- saving --------------------------------------------------------------------------------------

test('Save As adds .pdf without silently replacing an existing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-main-save-'))
  writeFileSync(join(dir, 'out.pdf'), 'KEEP')
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await stubMessageBoxes(app, [1 /* Cancel */, 0 /* Replace */])
    await app.evaluate(({ dialog }, d) => {
      const g = globalThis as any
      g.__saveCalls = []
      g.__saveAnswers = [`${d}/out`, `${d}/new`, `${d}/out`]
      dialog.showSaveDialog = (async (...args: any[]) => {
        const opts = args.find((a) => a && typeof a === 'object' && 'properties' in a)
        g.__saveCalls.push({ defaultPath: opts.defaultPath, properties: opts.properties })
        return { canceled: false, filePath: g.__saveAnswers.shift() }
      }) as any
    }, dir)

    // "out" would become out.pdf, which exists: the user is asked, says Cancel and picks "new".
    await runCommand(page, 'file.saveAs')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('new.pdf')
    expect(readFileSync(join(dir, 'out.pdf'), 'utf8')).toBe('KEEP')
    expect(readFileSync(join(dir, 'new.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
    const calls = await app.evaluate(() => (globalThis as any).__saveCalls)
    expect(calls[0].properties).toEqual(expect.arrayContaining(['showOverwriteConfirmation', 'createDirectory']))
    expect(calls[1].defaultPath).toBe(join(dir, 'out.pdf'))
    expect((await boxes(app))[0].message).toBe('“out.pdf” already exists. Do you want to replace it?')

    // Choosing Replace overwrites it.
    await runCommand(page, 'file.saveAs')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('out.pdf')
    expect(readFileSync(join(dir, 'out.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
  } finally {
    await closeQuietly(app)
  }
})

// ---- files from inside PDFs, temporary files, printing -----------------------------------------

test('attachments are written to a private folder and programs are never opened', async () => {
  const { app, page } = await launch()
  let root = ''
  try {
    await app.evaluate(({ shell }) => {
      const g = globalThis as any
      g.__opened = []
      shell.openPath = (async (p: string) => {
        g.__opened.push(p)
        return ''
      }) as any
    })
    const result = await page.evaluate(async () => {
      const api = (window as any).api
      const out: Record<string, string> = {}
      for (const name of ['Invoice.pdf.exe', 'run.sh', 'notes.txt', '../../escape.txt']) {
        const path: string = await api.invoke('file:tempPath', name)
        await api.invoke('file:write', path, new TextEncoder().encode('data'))
        out[name] = path + '\n' + (await api.invoke('shell:openPath', path))
      }
      return out
    })
    const [exePath, exeResult] = result['Invoice.pdf.exe'].split('\n')
    expect(exeResult).toMatch(/For your safety, Fartcrobat does not open “Invoice\.pdf\.exe”/)
    expect(result['run.sh'].split('\n')[1]).toMatch(/For your safety/)
    const [txtPath, txtResult] = result['notes.txt'].split('\n')
    expect(txtResult).toBe('')
    const escaped = result['../../escape.txt'].split('\n')[0]
    expect(escaped.endsWith('/escape.txt')).toBe(true)
    expect(await app.evaluate(() => (globalThis as any).__opened)).toEqual([txtPath, escaped])

    // One private folder for the session, a separate folder per file.
    const sessionRoot = join(exePath, '../..')
    root = sessionRoot
    expect(sessionRoot).toBe(join(txtPath, '../..'))
    expect(sessionRoot).toBe(join(escaped, '../..'))
    expect(statSync(sessionRoot).mode & 0o777).toBe(0o700)
    expect(readdirSync(sessionRoot).length).toBe(4)
  } finally {
    await closeQuietly(app)
  }
  // Removed when the app quits.
  expect(root).not.toBe('')
  expect(existsSync(root)).toBe(false)
})

test('printing removes its hidden window and page images as soon as the job is handed over', async () => {
  const { app, page } = await launch()
  try {
    const png = readFileSync(fixturePath('scan.png'))
    const res = await page.evaluate(async (data) => {
      const api = (window as any).api
      return api.invoke('print:images', {
        pages: [{ data: new Uint8Array(data), mime: 'image/png', widthPt: 612, heightPt: 792 }],
        silent: true,
        deviceName: 'no-such-printer-fartcrobat',
        jobName: 'test'
      })
    }, [...png])
    expect(typeof res.ok).toBe('boolean')
    expect(await windowCount(app)).toBe(1)
    const tempRoots = await app.evaluate(({ app }) => {
      const fs = (process as any).getBuiltinModule('node:fs')
      const path = (process as any).getBuiltinModule('node:path')
      const tmp = app.getPath('temp')
      return fs
        .readdirSync(tmp)
        .filter((n: string) => n.startsWith(`fartcrobat-${process.pid}-`))
        .map((n: string) => ({ root: n, entries: fs.readdirSync(path.join(tmp, n)) }))
    })
    for (const r of tempRoots) expect(r.entries.filter((e: string) => e.startsWith('print-'))).toEqual([])
    // The default printer is looked up from the OS (none here) and the call still lists printers.
    const printers = await page.evaluate(() => (window as any).api.invoke('print:printers'))
    expect(Array.isArray(printers)).toBe(true)
  } finally {
    await closeQuietly(app)
  }
})

// ---- the Edit menu in text fields ---------------------------------------------------------------

test('Edit menu commands act on the focused text field, and on the document otherwise', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'edit.find')
    const find = page.getByLabel('Find in document')
    await find.fill('hello world')
    await find.focus()
    const id = await windowId(app, page)
    const menuCommand = (cmd: string) =>
      app.evaluate(({ BrowserWindow }, a) => BrowserWindow.fromId(a.id)!.webContents.send('menu:command', a.cmd), { id, cmd })

    // The native Edit menu follows the focus: Paste is available in the field.
    const editMenu = () =>
      app.evaluate(({ Menu }) => {
        const edit = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Edit')!
        return edit.submenu!.items.filter((i) => i.type !== 'separator').map((i) => `${i.label}:${i.enabled}`)
      })
    await expect.poll(editMenu).toEqual(expect.arrayContaining(['Undo:true', 'Cut:true', 'Copy:true', 'Paste:true', 'Delete:true', 'Select All:true']))

    await menuCommand('edit.selectAll')
    await expect
      .poll(() => find.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, 11])
    expect((await activeDocState(page))?.selection.kind).toBe('none')
    await page.screenshot({ path: 'test-results/core-main-edit-field.png' })

    await app.evaluate(({ clipboard }) => clipboard.writeText('pasted text'))
    await menuCommand('edit.paste')
    await expect(find).toHaveValue('pasted text')
    await menuCommand('edit.undo')
    await expect(find).toHaveValue('hello world')
    await menuCommand('edit.selectAll')
    await menuCommand('edit.cut')
    await expect(find).toHaveValue('')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('hello world')

    // Outside text fields the same commands act on the document.
    await page.locator('.viewer-page').first().click({ position: { x: 5, y: 5 } })
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT')
    await expect.poll(editMenu).toEqual(expect.arrayContaining(['Paste:false', 'Cut:false']))
    await menuCommand('edit.selectAll')
    await expect.poll(async () => (await activeDocState(page))?.selection.kind).toBe('text')
    await menuCommand('edit.copy')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('quick brown fox')

    // The in-app Menu shows the same Edit menu (dark theme).
    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } })))
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).hover()
    await expect(page.getByRole('menuitem', { name: 'Paste' })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/core-main-edit-menu-dark.png' })
  } finally {
    await closeQuietly(app)
  }
})

// ---- privacy, security and packaging -----------------------------------------------------------

test('no spell-check dictionary downloads on Windows and Linux, and every app:// response carries the CSP', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ session }) => {
      const g = globalThis as any
      g.__downloads = []
      session.defaultSession.on('spellcheck-dictionary-download-begin', (_e, lang) => g.__downloads.push(lang))
    })
    await runCommand(page, 'app.preferences')
    const name = page.getByPlaceholder('e.g. Jane Smith')
    await name.click()
    await page.keyboard.type('Teh quick borwn fox', { delay: 20 })
    await page.waitForTimeout(1500)
    if (process.platform !== 'darwin') {
      // Chromium downloads a dictionary for each language as the session starts, before this
      // listener exists, so the language list is what shows there was none (util/spellcheck.ts).
      expect(await app.evaluate(({ session }) => session.defaultSession.getSpellCheckerLanguages())).toEqual([])
      expect(await app.evaluate(() => (globalThis as any).__downloads)).toEqual([])
    }

    const worker = readdirSync(join(ROOT, 'out/renderer/assets')).find((n) => /^worker-.*\.js$/.test(n))
    expect(worker).toBeTruthy()
    const csp = await app.evaluate(async ({ session }, w) => {
      const out: (string | null)[] = []
      for (const u of ['app://fartcrobat/index.html', `app://fartcrobat/assets/${w}`]) {
        const res = await session.defaultSession.fetch(u)
        out.push(res.headers.get('content-security-policy'))
      }
      return out
    }, worker)
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8'))![1]
    expect(csp).toEqual([meta, meta])
  } finally {
    await closeQuietly(app)
  }
})

test('restarting saves settings first and goes through the normal quit', async () => {
  const { app, page, userData } = await launch()
  try {
    await app.evaluate(({ app }, dir) => {
      const fs = (process as any).getBuiltinModule('node:fs')
      app.relaunch = (() => fs.writeFileSync(`${dir}/relaunched`, '1')) as any
    }, userData)
    await page.evaluate(async () => {
      const api = (window as any).api
      await api.invoke('prefs:set', { authorName: 'Restart Tester' })
      setTimeout(() => void api.invoke('app:relaunch'), 50)
    })
    await waitForExit(app)
    expect(JSON.parse(readFileSync(join(userData, 'fartcrobat-settings.json'), 'utf8')).prefs.authorName).toBe('Restart Tester')
    expect(existsSync(join(userData, 'relaunched'))).toBe(true)
  } finally {
    await closeQuietly(app)
  }
})

test('Linux "Make default" registers a desktop entry for AppImage installs', async () => {
  test.skip(process.platform !== 'linux', 'Linux only')
  const data = mkdtempSync(join(tmpdir(), 'core-main-xdg-'))
  mkdirSync(join(data, 'apps'))
  const appImage = join(data, 'apps', 'Fartcrobat 0.1.0.AppImage')
  writeFileSync(appImage, '')
  // An AppImage runs its executable from inside its mount folder (APPDIR).
  const packaged = process.env.FARTCROBAT_EXECUTABLE
  const executable = packaged ? resolve(ROOT, packaged) : (createRequire(import.meta.url)('electron') as string)
  const mount = dirname(executable)
  const xdg = { XDG_DATA_HOME: data, XDG_DATA_DIRS: join(data, 'none') }
  // APPIMAGE and APPDIR passed on by another AppImage app that started this one: not this app's
  // file. A packaged copy registers its own executable; an unpackaged one cannot register.
  const other = await launch([], { ...xdg, APPIMAGE: join(data, 'apps', 'Other.AppImage'), APPDIR: '/tmp/.mount_OtherX' })
  try {
    const status = await other.page.evaluate(() => (window as any).api.invoke('defaultApp:status'))
    expect(status.canSetDirectly).toBe(!!packaged)
    if (packaged) {
      await other.page.evaluate(() => (window as any).api.invoke('defaultApp:set'))
      expect(readFileSync(join(data, 'applications/fartcrobat.desktop'), 'utf8')).toContain(`Exec="${executable}" %F`)
    }
  } finally {
    await closeQuietly(other.app)
  }
  const { app, page } = await launch([], { ...xdg, APPIMAGE: appImage, APPDIR: mount })
  try {
    const status = await page.evaluate(() => (window as any).api.invoke('defaultApp:status'))
    expect(status.canSetDirectly).toBe(true)
    await page.evaluate(() => (window as any).api.invoke('defaultApp:set'))
    const entry = readFileSync(join(data, 'applications/fartcrobat.desktop'), 'utf8')
    expect(entry).toContain(`Exec="${appImage}" %F`)
    expect(entry).toContain('MimeType=application/pdf;')
  } finally {
    await closeQuietly(app)
  }
})

test('the main and preload bundles contain their dependencies (installers ship no node_modules)', () => {
  const allowed = new Set(['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
  for (const file of ['out/main/index.js', 'out/preload/index.cjs']) {
    const code = readFileSync(join(ROOT, file), 'utf8')
    // Specifiers have no spaces and no `${`: that skips log text such as electron-updater's
    // `downloading it from "${url}"`.
    const specs = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'./$\s][^"'\s]*)["']/g)].map((m) => m[1])
    expect(specs.length, file).toBeGreaterThan(0)
    expect(specs.filter((s) => !allowed.has(s)), file).toEqual([])
  }
})
