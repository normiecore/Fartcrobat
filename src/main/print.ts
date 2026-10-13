import { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrintJob } from '@shared/types'
import { sessionTemp } from './temp'
import { sheetStyle } from './util/printSheet'
import { parseLpstatDefault, parseWindowsDevice } from './util/systemDefaults'

/** Hidden windows of print jobs in progress. */
const printWindows = new Set<BrowserWindow>()

/**
 * Prints pre-rendered page images through Chromium's printing pipeline. The images live in a
 * private temporary folder (only this user can read it) that is removed, together with the hidden
 * print window, as soon as the job has been handed to the printer.
 */
export async function printImages(job: PrintJob): Promise<{ ok: boolean; error?: string }> {
  if (!job.pages.length) return { ok: false, error: 'Nothing to print' }
  const temp = sessionTemp()
  const dir = temp.newDir('print-')
  let win: BrowserWindow | null = null
  try {
    const imgs: string[] = []
    job.pages.forEach((p, i) => {
      const name = `p${i}.${p.mime === 'image/png' ? 'png' : 'jpg'}`
      writeFileSync(join(dir, name), Buffer.from(p.data), { mode: 0o600 })
      imgs.push(`<div class="page"><img src="${name}" style="${sheetStyle(job.fit, p.widthPt, p.heightPt)}"></div>`)
    })
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(job.jobName ?? 'Fartcrobat')}</title>
<style>
@page { margin: 0; }
html, body { margin: 0; padding: 0; background: white; }
.page { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
img { display: block; object-fit: contain; }
</style></head><body>${imgs.join('')}</body></html>`
    const htmlPath = join(dir, 'print.html')
    writeFileSync(htmlPath, html, { mode: 0o600 })

    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false } })
    printWindows.add(win)
    const w = win
    w.on('closed', () => printWindows.delete(w))
    await w.loadURL(pathToFileURL(htmlPath).toString())
    await w.webContents.executeJavaScript(
      'Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r })))'
    )
    return await new Promise((resolve) => {
      w.webContents.print(
        {
          silent: !!job.silent,
          printBackground: true,
          copies: job.copies ?? 1,
          color: job.color !== false,
          landscape: !!job.landscape,
          deviceName: job.deviceName || undefined,
          duplexMode: job.duplex,
          pageSize: job.pageSize,
          margins: { marginType: 'none' }
        },
        (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason })
      )
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // Chromium has spooled the job once the callback ran: nothing here is needed any more.
    if (win && !win.isDestroyed()) win.destroy()
    temp.removeDir(dir)
  }
}

/** Stops print jobs that are still being prepared (the app is quitting). */
export function destroyPrintWindows() {
  for (const w of printWindows) if (!w.isDestroyed()) w.destroy()
  printWindows.clear()
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true, env: env ?? process.env }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** The name of the system's default printer, or null when there is none or it cannot be told. */
export async function defaultPrinterName(): Promise<string | null> {
  if (process.platform === 'win32') {
    return parseWindowsDevice(await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device']))
  }
  // CUPS (Linux, macOS); the C locale keeps the output in English.
  return parseLpstatDefault(await run('lpstat', ['-d'], { ...process.env, LC_ALL: 'C', LANG: 'C' }))
}

export async function listPrinters(win: BrowserWindow | null) {
  const target = win ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  if (!target) return []
  const [printers, def] = await Promise.all([target.webContents.getPrintersAsync(), defaultPrinterName().catch(() => null)])
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    // Electron no longer reports the default printer; ask the OS (older Electron/CUPS options as a fallback).
    isDefault: def !== null ? p.name === def : !!(p as any).isDefault || (p.options as any)?.['printer-is-default'] === 'true'
  }))
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
