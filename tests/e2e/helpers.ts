import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURES = resolve(ROOT, 'tests/fixtures')

export function fixturePath(name: string) {
  return join(FIXTURES, name)
}

export interface App {
  app: ElectronApplication
  page: Page
  userData: string
}

/**
 * Launches the built app (run `npm run build` first) with a throwaway profile. Set
 * FARTCROBAT_EXECUTABLE to a packaged app (e.g. release/linux-unpacked/fartcrobat) to test that instead.
 * Remembering passwords is off unless `opts.rememberPasswords` is set: otherwise specs would behave
 * differently on machines with a keyring (and would use it). Automatic update checks are off
 * unless `env` sets FARTCROBAT_UPDATE_CHECKS. `opts.kv` puts feature data in the settings store
 * before the app starts (Digital IDs for tests/e2e/certificate-encryption.spec.ts).
 */
export async function launch(
  files: string[] = [],
  env: Record<string, string> = {},
  opts: { rememberPasswords?: boolean; kv?: Record<string, unknown> } = {}
): Promise<App> {
  const userData = mkdtempSync(join(tmpdir(), 'fartcrobat-e2e-'))
  // `kv` seeds feature data in the settings store (e.g. 'digital-signatures:ids').
  if (!opts.rememberPasswords || opts.kv)
    writeFileSync(
      join(userData, 'fartcrobat-settings.json'),
      JSON.stringify({ prefs: opts.rememberPasswords ? {} : { rememberPasswords: false }, ...(opts.kv ? { kv: opts.kv } : {}) })
    )
  const packaged = process.env.FARTCROBAT_EXECUTABLE
  const app = await electron.launch({
    ...(packaged ? { executablePath: resolve(ROOT, packaged) } : {}),
    args: [
      ...(packaged ? [] : [join(ROOT, 'out/main/index.js')]),
      '--no-sandbox',
      '--disable-gpu',
      ...(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : []),
      ...files
    ],
    env: {
      ...process.env,
      FARTCROBAT_USER_DATA: userData,
      FARTCROBAT_MULTI_INSTANCE: '1',
      FARTCROBAT_FORCE_CLOSE: '1',
      // No update checks unless a spec turns them on (tests/e2e/updates.spec.ts).
      FARTCROBAT_UPDATE_CHECKS: '0',
      ...env
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[renderer]', m.text())
  })
  page.on('pageerror', (e) => console.log('[renderer error]', e.message))
  await page.waitForSelector('.shell')
  return { app, page, userData }
}

/** Opens a file through the same path the OS uses (no native dialog). */
export async function openFile(page: Page, path: string) {
  await page.evaluate((p) => (window as any).__fartcrobat.openPaths([p]), path)
  await page.waitForSelector('.viewer-page canvas')
}

/** Waits until the first page's canvas has been painted with non-white pixels. */
export async function waitForRender(page: Page, pageIndex = 0) {
  await page.waitForFunction(
    (i) => {
      const c = document.querySelector<HTMLCanvasElement>(`.viewer-page[data-page-index="${i}"] canvas.viewer-page-canvas`)
      if (!c || c.width < 10) return false
      const ctx = c.getContext('2d')!
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      for (let k = 0; k < d.length; k += 4 * 97) if (d[k] < 200) return true
      return false
    },
    pageIndex,
    { timeout: 30000 }
  )
}

export async function activeDocState(page: Page) {
  return page.evaluate(() => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    if (!d) return null
    const s = d.state
    return {
      title: s.title,
      dirty: s.dirty,
      pageCount: s.info.pageCount,
      currentPage: s.currentPage,
      zoom: s.zoom,
      zoomMode: s.zoomMode,
      selection: s.selection,
      journal: s.journal,
      search: { query: s.search.query, hits: s.search.hits.length, active: s.search.active }
    }
  })
}

export async function runCommand(page: Page, id: string) {
  await page.evaluate((c) => (window as any).__fartcrobat.runCommand(c), id)
}

/** A menu entry by its label, whether or not it is checkable (menuitem or menuitemcheckbox). */
export function menuItem(page: Page, name: string | RegExp) {
  return page.getByRole('menuitem', { name }).or(page.getByRole('menuitemcheckbox', { name }))
}
