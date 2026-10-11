import { app, BrowserWindow } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrintJob } from '@shared/types'

let jobCounter = 0

/** Prints pre-rendered page images through Chromium's printing pipeline. */
export async function printImages(job: PrintJob): Promise<{ ok: boolean; error?: string }> {
  if (!job.pages.length) return { ok: false, error: 'Nothing to print' }
  const dir = join(app.getPath('temp'), `fartcrobat-print-${process.pid}-${++jobCounter}`)
  mkdirSync(dir, { recursive: true })
  const imgs: string[] = []
  job.pages.forEach((p, i) => {
    const name = `p${i}.${p.mime === 'image/png' ? 'png' : 'jpg'}`
    writeFileSync(join(dir, name), Buffer.from(p.data))
    const wIn = (p.widthPt / 72).toFixed(3)
    const hIn = (p.heightPt / 72).toFixed(3)
    const style =
      job.fit === 'actual'
        ? `width:${wIn}in;height:${hIn}in`
        : 'max-width:100%;max-height:100%;width:auto;height:auto'
    imgs.push(`<div class="page"><img src="${name}" style="${style}"></div>`)
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
  writeFileSync(htmlPath, html)

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await win.loadURL(pathToFileURL(htmlPath).toString())
    await win.webContents.executeJavaScript(
      'Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r })))'
    )
    return await new Promise((resolve) => {
      win.webContents.print(
        {
          silent: !!job.silent,
          printBackground: true,
          copies: job.copies ?? 1,
          color: job.color !== false,
          landscape: !!job.landscape,
          deviceName: job.deviceName || undefined,
          duplexMode: job.duplex,
          margins: { marginType: 'none' }
        },
        (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason })
      )
    })
  } finally {
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }, 60_000)
  }
}

export async function listPrinters(win: BrowserWindow | null) {
  const target = win ?? BrowserWindow.getAllWindows()[0]
  if (!target) return []
  const printers = await target.webContents.getPrintersAsync()
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    isDefault: !!(p as any).isDefault || (p.options as any)?.['printer-is-default'] === 'true'
  }))
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
