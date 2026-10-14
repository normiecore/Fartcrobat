// A stand-in for electron-updater in unpackaged test builds (FARTCROBAT_FAKE_UPDATER names its
// settings file): it reports download progress, can fail, and writes what it would install to a
// log instead of installing anything.
import { appendFileSync, readFileSync } from 'node:fs'
import type { Updater } from './updater'

export interface FakeUpdaterConfig {
  /** Progress reports before the download is done. */
  steps: number
  stepMs: number
  /** Download size in bytes. */
  total: number
  /** Fail (as if the connection dropped) halfway through the download. */
  failDownload: boolean
  /** Each install appends a JSON line here: {"version","silent","runAfter"}. */
  installLog: string | null
  /** The version the update metadata offers (default: the one the release check found). */
  version?: string | null
}

const DEFAULTS: FakeUpdaterConfig = {
  steps: 5,
  stepMs: 150,
  total: 1_000_000,
  failDownload: false,
  installLog: null
}

export function readFakeConfig(file: string): FakeUpdaterConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<FakeUpdaterConfig>
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  return {
    steps: Math.max(1, Math.round(num(raw.steps, DEFAULTS.steps))),
    stepMs: num(raw.stepMs, DEFAULTS.stepMs),
    total: num(raw.total, DEFAULTS.total),
    failDownload: raw.failDownload === true,
    installLog: typeof raw.installLog === 'string' && raw.installLog ? raw.installLog : null,
    version: typeof raw.version === 'string' || raw.version === null ? raw.version : undefined
  }
}

export interface FakeUpdaterOptions {
  /** Reads the settings (each time, so a test can change them between downloads). */
  config(): FakeUpdaterConfig
  /** Calls `handler` once when the app quits, with its exit code (Electron's 'quit' event). */
  onQuit(handler: (exitCode: number) => void): void
  append?(file: string, text: string): void
}

export function fakeUpdater(opts: FakeUpdaterOptions): Updater {
  const append = opts.append ?? ((file, text) => appendFileSync(file, text))
  let offered: string | null = null
  let downloaded: string | null = null
  let installed = false
  let quitHandlerAdded = false

  const log = (runAfter: boolean) => {
    if (installed || !downloaded) return
    installed = true
    try {
      const file = opts.config().installLog
      if (file) append(file, JSON.stringify({ version: downloaded, silent: true, runAfter }) + '\n')
    } catch (err) {
      console.error('Fake updater: could not write the install log', err)
    }
  }

  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('cancelled'))
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })

  return {
    async findUpdate(expected) {
      const config = opts.config()
      offered = config.version === undefined ? expected : config.version
      return offered
    },

    async download(onProgress, signal) {
      const config = opts.config()
      const version = offered
      if (!version) throw new Error('Nothing to download')
      const steps = config.failDownload ? Math.floor(config.steps / 2) : config.steps
      const started = Date.now()
      for (let i = 1; i <= steps; i++) {
        await wait(config.stepMs, signal)
        const transferred = Math.round((config.total * i) / config.steps)
        const seconds = Math.max(0.001, (Date.now() - started) / 1000)
        onProgress({
          percent: (100 * i) / config.steps,
          transferred,
          total: config.total,
          bytesPerSecond: Math.round(transferred / seconds)
        })
      }
      if (config.failDownload) {
        await wait(config.stepMs, signal)
        throw new Error('net::ERR_CONNECTION_RESET')
      }
      downloaded = version
      // Like electron-updater's autoInstallOnAppQuit: quitting installs without starting again.
      if (!quitHandlerAdded) {
        quitHandlerAdded = true
        opts.onQuit((exitCode) => {
          if (exitCode === 0) log(false)
        })
      }
    },

    installAndRestart() {
      log(true)
    }
  }
}
