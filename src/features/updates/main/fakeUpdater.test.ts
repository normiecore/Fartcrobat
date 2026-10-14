// Updates: the fake updater the end-to-end tests use in place of electron-updater
// (FARTCROBAT_FAKE_UPDATER): progress, failure, cancel, and what it logs instead of installing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateProgress } from '@shared/updates'
import { fakeUpdater, readFakeConfig, type FakeUpdaterConfig } from './fakeUpdater'

describe('fake updater', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fc-fake-updater-'))
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const make = (config: Partial<FakeUpdaterConfig>) => {
    const log = join(dir, 'install.log')
    const quitHandlers: ((code: number) => void)[] = []
    const updater = fakeUpdater({
      config: () => ({ steps: 4, stepMs: 100, total: 1000, failDownload: false, installLog: log, ...config }),
      onQuit: (handler) => quitHandlers.push(handler)
    })
    const lines = () => {
      try {
        return readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return []
      }
    }
    return { updater, lines, quit: (code = 0) => quitHandlers.forEach((h) => h(code)), quitHandlers }
  }

  it('reads its settings file with defaults', () => {
    const file = join(dir, 'fake.json')
    writeFileSync(
      file,
      JSON.stringify({ steps: 5, stepMs: 150, total: 1000000, failDownload: false, installLog: '/abs/file' })
    )
    expect(readFakeConfig(file)).toEqual({
      steps: 5,
      stepMs: 150,
      total: 1000000,
      failDownload: false,
      installLog: '/abs/file',
      version: undefined
    })
    writeFileSync(file, '{"failDownload":true,"steps":0,"version":"0.9.0"}')
    expect(readFakeConfig(file)).toMatchObject({
      steps: 1,
      stepMs: 150,
      failDownload: true,
      installLog: null,
      version: '0.9.0'
    })
    expect(() => readFakeConfig(join(dir, 'missing.json'))).toThrow()
  })

  it('offers the version it is asked for, unless its settings name another', async () => {
    expect(await make({}).updater.findUpdate('0.2.0')).toBe('0.2.0')
    expect(await make({ version: '0.1.9' }).updater.findUpdate('0.2.0')).toBe('0.1.9')
    expect(await make({ version: null }).updater.findUpdate('0.2.0')).toBeNull()
  })

  it('reports `steps` progress updates `stepMs` apart, then logs a restart install', async () => {
    const { updater, lines, quit } = make({})
    await updater.findUpdate('0.2.0')
    const progress: UpdateProgress[] = []
    const done = updater.download((p) => progress.push(p), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(250)
    expect(progress.map((p) => p.percent)).toEqual([25, 50])
    await vi.advanceTimersByTimeAsync(150)
    await done
    expect(progress.map((p) => p.transferred)).toEqual([250, 500, 750, 1000])
    expect(progress.every((p) => p.total === 1000 && p.bytesPerSecond > 0)).toBe(true)
    updater.installAndRestart()
    expect(lines()).toEqual([{ version: '0.2.0', silent: true, runAfter: true }])
    // The app then quits: nothing is installed a second time.
    quit()
    expect(lines()).toHaveLength(1)
  })

  it('quitting normally after a download installs without starting again', async () => {
    const { updater, lines, quit, quitHandlers } = make({ steps: 1 })
    await updater.findUpdate('0.2.0')
    const done = updater.download(() => {}, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(quitHandlers).toHaveLength(1)
    quit()
    expect(lines()).toEqual([{ version: '0.2.0', silent: true, runAfter: false }])
  })

  it('a quit with an error exit code, or before a download finished, installs nothing', async () => {
    const { updater, lines, quit } = make({ steps: 1 })
    await updater.findUpdate('0.2.0')
    quit()
    updater.installAndRestart()
    expect(lines()).toEqual([])
    const done = updater.download(() => {}, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    await done
    quit(1)
    expect(lines()).toEqual([])
  })

  it('fails halfway with failDownload, and stops when cancelled', async () => {
    const failing = make({ failDownload: true })
    await failing.updater.findUpdate('0.2.0')
    const progress: number[] = []
    const failed = failing.updater.download((p) => progress.push(p.percent), new AbortController().signal)
    failed.catch(() => {})
    await vi.advanceTimersByTimeAsync(1000)
    await expect(failed).rejects.toThrow('net::ERR_CONNECTION_RESET')
    expect(progress).toEqual([25, 50])
    failing.quit()
    expect(failing.lines()).toEqual([])

    const cancelled = make({})
    await cancelled.updater.findUpdate('0.2.0')
    const controller = new AbortController()
    const run = cancelled.updater.download(() => {}, controller.signal)
    run.catch(() => {})
    await vi.advanceTimersByTimeAsync(150)
    controller.abort()
    await expect(run).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(1000)
    cancelled.updater.installAndRestart()
    expect(cancelled.lines()).toEqual([])
  })
})
