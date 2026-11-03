/**
 * Converts a local HTML file to PDF with Chromium (a hidden window and printToPDF). Offline and
 * static: the page's scripts do not run, it cannot navigate away, and nothing is loaded but inline
 * data and files in the HTML file's folder (see htmlPolicy.ts); every other request is blocked.
 */
import { BrowserWindow, session } from 'electron'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { htmlLoadPolicy } from './htmlPolicy'
import type { HtmlConvertOptions } from './types'

/** Isolated world for our own wait script (the page's scripts are off). */
const WAIT_WORLD = 1001
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
  const policy = htmlLoadPolicy(path)
  if (!policy.allowsNavigation(policy.pageUrl)) {
    throw new Error(`${basename(path)} is on a network share. Copy it to this computer to convert it.`)
  }
  let blocked = 0
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok =
      details.resourceType === 'mainFrame' ? policy.allowsNavigation(details.url) : policy.allowsResource(details.url)
    if (!ok) blocked++
    callback({ cancel: !ok })
  })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  // Anything that bypasses webRequest (WebRTC) goes to a proxy that does not exist.
  await ses.setProxy({ proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' })
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const refuseNavigation = (e: Electron.Event, url: string) => {
    if (!policy.allowsNavigation(url)) e.preventDefault()
  }
  win.webContents.on('will-navigate', refuseNavigation)
  win.webContents.on('will-redirect', refuseNavigation)
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !policy.allowsResource(e.url)) e.preventDefault()
  })
  try {
    await withTimeout(
      win.loadURL(policy.pageUrl).catch((err) => {
        // Sub-resources that fail (blocked network) do not matter; a page that does not load does.
        if (!win.webContents.getURL()) throw err
      }),
      60000,
      'The web page took too long to load'
    )
    // Let web fonts and images that are available locally finish.
    await withTimeout(
      win.webContents
        .executeJavaScriptInIsolatedWorld(WAIT_WORLD, [
          {
            code: `Promise.all([document.fonts ? document.fonts.ready : 0, ...[...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r }))]).then(() => 1)`
          }
        ])
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
