// Shared parts of the update rehearsals (README.md): the fake GitHub, what it was asked, and the
// update card. The rehearsals drive a packaged Fartcrobat that is installed for real.
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))

/** The rehearsal's settings, from the environment the runner script sets. */
export function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: run the rehearsal through its runner script (README.md)`)
  return v
}

export interface GitHubRequest {
  method: string
  host: string | null
  path: string | null
  accept?: string | null
  status: number
  range?: string
  bytes?: number
  location?: string
  refused?: boolean
}

export interface FakeGitHub {
  /** http://127.0.0.1:<port>, for the app's proxy setting. */
  proxy: string
  setLatest(tag: string): Promise<void>
  requests(): Promise<GitHubRequest[]>
  stop(): void
}

/** Starts fake-github.mjs over `releases` (one folder per tag) with `latest` as the newest release. */
export async function startFakeGitHub(opts: { releases: string; latest: string; cert: string; key: string; log?: string }): Promise<FakeGitHub> {
  if (opts.log && existsSync(opts.log)) rmSync(opts.log)
  const child: ChildProcess = spawn(
    process.execPath,
    [join(HERE, 'fake-github.mjs'), '--releases', opts.releases, '--latest', opts.latest, '--cert', opts.cert, '--key', opts.key, ...(opts.log ? ['--log', opts.log] : [])],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (d) => {
      out += String(d)
      const m = /listening (\d+)/.exec(out)
      if (m) resolve(Number(m[1]))
    })
    child.once('exit', (code) => reject(new Error(`fake-github exited (${code})`)))
  })
  const proxy = `http://127.0.0.1:${port}`
  const control = (path: string) => fetch(`${proxy}${path}`).then((r) => r.text())
  return {
    proxy,
    async setLatest(tag) {
      await control(`/__control/latest?tag=${encodeURIComponent(tag)}`)
    },
    async requests() {
      return (await control('/__control/requests'))
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as GitHubRequest)
    },
    stop() {
      child.kill()
    }
  }
}

/** What the app asked GitHub, in a few words per request (for the report). */
export function describe(requests: GitHubRequest[]): string[] {
  return requests.map((r) => `${r.status} ${r.method} ${r.host ?? ''}${r.path ?? ''}${r.range ? ` [${r.range}]` : ''}${r.accept?.includes('json') ? ' (json)' : ''}`)
}

/** Base64 SHA-512 of a file, as latest*.yml writes it. */
export function sha512(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha512')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('base64')))
      .on('error', reject)
  })
}

/** The sha512 a release's latest*.yml gives for its installer. */
export function ymlSha512(yml: string): string {
  const m = /^sha512: (\S+)$/m.exec(readFileSync(yml, 'utf8'))
  if (!m) throw new Error(`no sha512 in ${yml}`)
  return m[1]
}

export const updateCard = (page: Page) => page.getByRole('region', { name: 'Update' })

export async function version(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app }) => app.getVersion())
}

/** Help > Check for Updates..., the way a person finds it. */
export async function checkFromHelpMenu(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('menuitem', { name: /^Help$/ }).hover()
  await page.getByRole('menuitem', { name: 'Check for Updates...' }).click()
}

/** Downloads the offered version from the card and waits until it is ready to install. */
export async function downloadUpdate(page: Page, newVersion: string) {
  const card = updateCard(page)
  await expect(card).toContainText(`Fartcrobat ${newVersion} is available.`, { timeout: 60_000 })
  await card.getByRole('button', { name: 'Download' }).click()
  await expect(card).toContainText(`Fartcrobat ${newVersion} is ready to install.`, { timeout: 240_000 })
}

export const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(process.env.REHEARSAL_OUT ?? 'test-results', `rehearsal-${name}.png`), animations: 'disabled' }).catch(() => {})
