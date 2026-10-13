/**
 * Converts a local HTML file to PDF with Chromium (a hidden window and printToPDF). Offline:
 * nothing but local files and inline data is loaded; every network request is blocked.
 */
import { BrowserWindow, session } from 'electron'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HtmlConvertOptions } from './types'

const LOCAL = /^(file|data|blob|about|devtools|chrome):/i
let counter = 0

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export async function convertHtmlToPdf(path: string, opts: HtmlConvertOptions): Promise<Uint8Array> {
  if (!existsSync(path)) throw new Error(`${basename(path)} does not exist`)
  // A private in-memory session per conversion: no cookies, no cache, no network.
  const ses = session.fromPartition(`fartcrobat-html-${process.pid}-${++counter}`, { cache: false })
  let blocked = 0
  ses.webRequest.onBeforeRequest((details, callback) => {
    const local = LOCAL.test(details.url)
    if (!local) blocked++
    callback({ cancel: !local })
  })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!LOCAL.test(url)) e.preventDefault()
  })
  try {
    await withTimeout(
      win.loadURL(pathToFileURL(path).toString()).catch((err) => {
        // Sub-resources that fail (blocked network) do not matter; a page that does not load does.
        if (!win.webContents.getURL()) throw err
      }),
      60000,
      'The web page took too long to load'
    )
    // Let web fonts and images that are available locally finish.
    await withTimeout(
      win.webContents
        .executeJavaScript(
          `Promise.all([document.fonts ? document.fonts.ready : 0, ...[...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r }))]).then(() => 1)`
        )
        .catch(() => 1),
      15000,
      'The web page took too long to load'
    ).catch(() => 1)
    const margin = Math.max(0, Math.min(2, opts.margin))
    const pdf = await win.webContents.printToPDF({
      pageSize: opts.pageSize,
      landscape: opts.landscape,
      printBackground: opts.printBackground,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
      generateDocumentOutline: true,
      generateTaggedPDF: true
    })
    if (blocked) console.log(`[export-create] blocked ${blocked} network request(s) while converting ${basename(path)}`)
    return new Uint8Array(pdf)
  } finally {
    win.destroy()
    try {
      ses.webRequest.onBeforeRequest(null)
      await ses.clearStorageData()
    } catch {}
  }
}
