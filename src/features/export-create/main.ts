/**
 * Main process of Export a PDF / Create a PDF: finds LibreOffice and converts Office files with
 * it, converts local HTML files with Chromium, and reads text from the clipboard.
 */
import { app, clipboard } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MainContext } from '@main/context'
import { convertHtmlToPdf } from './main/html'
import { convertWithLibreOffice, findLibreOffice } from './main/libreoffice'
import type { LibreOfficeInfo } from './main/types'

let cached: { preferred: string; info: LibreOfficeInfo | null } | null = null

async function detect(preferred: string, force = false): Promise<LibreOfficeInfo | null> {
  if (!force && cached && cached.preferred === preferred && (!cached.info || existsSync(cached.info.path))) return cached.info
  const info = await findLibreOffice(preferred)
  cached = { preferred, info }
  return info
}

/** LibreOffice runs one conversion at a time with our private profile. */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

export function register(ctx: MainContext) {
  ctx.handle('feature:export-create:findLibreOffice', async (_e, path) => {
    // An explicit path is checked as given (Settings > Detect); otherwise the usual places.
    return detect(path ?? ctx.store().prefs.libreOfficePath ?? '', true)
  })

  ctx.handle('feature:export-create:convertOffice', async (_e, path) => {
    const info = await detect(ctx.store().prefs.libreOfficePath ?? '')
    if (!info) return null
    const profileDir = join(app.getPath('userData'), 'libreoffice-profile')
    return serial(() => convertWithLibreOffice(info.path, path, { profileDir }))
  })

  ctx.handle('feature:export-create:convertHtml', (_e, path, opts) => convertHtmlToPdf(path, opts))

  ctx.handle('feature:export-create:clipboardText', () => clipboard.readText())
}
