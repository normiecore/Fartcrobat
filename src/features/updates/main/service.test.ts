// Updates: the main-process state machine with a fake release server, a fake updater and a fake
// quit flow (check, download, cancel, failure, dismiss, restart after the quit flow, scheduling,
// policy and preference).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PolicyReading } from '@main/policy'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  type UpdateProgress,
  type UpdateStatus
} from '@shared/updates'
import { CHECK_OFFLINE, RELEASES_BASE, type RedirectProbe } from './release'
import { UpdateService, type UpdateServiceOptions } from './service'
import { DOWNLOAD_OFFLINE, mismatchMessage, type Updater } from './updater'

const tagUrl = (v: string) => `${RELEASES_BASE}/releases/tag/v${v}`

/** A stand-in for GitHub: answers /releases/latest with a redirect to `latest`, or fails. */
class FakeGitHub {
  latest: string | Error = '0.2.0'
  requests = 0
  /** When set, requests wait until release() is called. */
  hold = false
  private held: (() => void)[] = []
  probe: RedirectProbe = async () => {
    this.requests++
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve))
    const latest = this.latest
    if (latest instanceof Error) throw latest
    return { status: 302, location: tagUrl(latest) }
  }
  release() {
    this.held.splice(0).forEach((resolve) => resolve())
  }
}

interface Download {
  onProgress: (p: UpdateProgress) => void
  signal: AbortSignal
  resolve: () => void
  reject: (err: Error) => void
}

class FakeUpdater implements Updater {
  /** What the update metadata offers; undefined: the expected version. */
  offered: string | null | undefined = undefined
  downloads: Download[] = []
  installs = 0
  async findUpdate(expected: string) {
    return this.offered === undefined ? expected : this.offered
  }
  download(onProgress: (p: UpdateProgress) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      this.downloads.push({ onProgress, signal, resolve, reject })
      signal.addEventListener('abort', () => reject(new Error('cancelled')))
    })
  }
  installAndRestart() {
    this.installs++
  }
}

/** The quit flow: the test decides whether the windows agree to close. */
class FakeQuit {
  pending: { install: () => void; settle: (ok: boolean) => void } | null = null
  calls = 0
  quitForUpdate = (install: () => void) => {
    this.calls++
    return new Promise<boolean>((settle) => (this.pending = { install, settle }))
  }
  approve() {
    const p = this.pending!
    this.pending = null
    p.install()
    p.settle(true)
  }
  cancel() {
    const p = this.pending!
    this.pending = null
    p.settle(false)
  }
}

function setup(
  o: Partial<UpdateServiceOptions> & { policyReading?: PolicyReading | null | Error; pref?: boolean } = {}
) {
  const github = new FakeGitHub()
  const updater = new FakeUpdater()
  const quit = new FakeQuit()
  const broadcasts: UpdateStatus[] = []
  const opened: string[] = []
  const prefs = { checkForUpdates: o.pref ?? true }
  const service = new UpdateService({
    currentVersion: '0.1.0',
    capability: 'install',
    base: RELEASES_BASE,
    probe: github.probe,
    updater,
    autoChecks: true,
    policy: async () => {
      if (o.policyReading instanceof Error) throw o.policyReading
      return o.policyReading ?? null
    },
    preference: () => prefs.checkForUpdates,
    broadcast: (s) => broadcasts.push(s),
    quitForUpdate: quit.quitForUpdate,
    openExternal: (url) => opened.push(url),
    ...o
  })
  return { service, github, updater, quit, broadcasts, opened, prefs }
}

/** Lets pending promises run (the fake timers do not advance). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-14T09:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateService: checking', () => {
  it('starts idle and reports the version and capability', async () => {
    const { service } = setup()
    await service.ready
    expect(service.status()).toEqual({
      currentVersion: '0.1.0',
      capability: 'install',
      phase: 'idle',
      update: null,
      progress: null,
      error: null,
      errorDuring: null,
      lastChecked: null,
      checksOff: null,
      dismissedVersion: null,
      manual: false
    })
  })

  it('a manual check finds a newer release, or says it is up to date', async () => {
    const { service, github, broadcasts } = setup()
    const status = await service.check(true)
    expect(status).toMatchObject({
      phase: 'available',
      manual: true,
      update: { version: '0.2.0', releaseUrl: tagUrl('0.2.0') }
    })
    expect(status.lastChecked).toBe(Date.now())
    expect(broadcasts.map((s) => s.phase)).toContain('checking')
    github.latest = '0.1.0'
    expect(await service.check(true)).toMatchObject({ phase: 'upToDate', update: null, manual: true })
    github.latest = '0.0.9'
    expect((await service.check(true)).phase).toBe('upToDate')
    // A pre-release marked as the latest release is not offered.
    github.latest = '0.3.0-beta.1'
    expect((await service.check(true)).phase).toBe('upToDate')
  })

  it('a failed manual check is an error the window reports; lastChecked stays', async () => {
    const { service, github } = setup()
    github.latest = '0.1.0'
    const before = (await service.check(true)).lastChecked
    vi.setSystemTime(Date.now() + 60_000)
    github.latest = new Error('net::ERR_INTERNET_DISCONNECTED')
    expect(await service.check(true)).toMatchObject({
      phase: 'error',
      errorDuring: 'check',
      error: CHECK_OFFLINE,
      manual: true,
      update: null,
      lastChecked: before
    })
  })

  it('checks automatically after start-up, then every interval, quietly', async () => {
    const { service, github } = setup()
    await service.ready
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS - 1)
    expect(github.requests).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(github.requests).toBe(1)
    expect(service.status()).toMatchObject({ phase: 'available', manual: false })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(github.requests).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(github.requests).toBe(2)
  })

  it('an automatic check that fails stays quiet (manual false)', async () => {
    const { service, github } = setup({ firstCheckDelayMs: 10 })
    github.latest = new Error('offline')
    await service.ready
    await vi.advanceTimersByTimeAsync(10)
    expect(service.status()).toMatchObject({ phase: 'error', errorDuring: 'check', manual: false })
  })

  it('an automatic check keeps showing an update already found, and does not undo a dismissal', async () => {
    const { service, github, broadcasts } = setup({ firstCheckDelayMs: 10 })
    await service.check(true)
    service.dismiss()
    broadcasts.length = 0
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(github.requests).toBe(2)
    expect(broadcasts.map((s) => s.phase)).not.toContain('checking')
    expect(service.status()).toMatchObject({ phase: 'available', manual: false, dismissedVersion: '0.2.0' })
    // Offline next time: the update found before stays.
    github.latest = new Error('offline')
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(service.status()).toMatchObject({
      phase: 'available',
      update: { version: '0.2.0' },
      dismissedVersion: '0.2.0'
    })
    // A newer version turns up: windows show it (dismissedVersion is for the older one).
    github.latest = '0.2.1'
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(service.status()).toMatchObject({
      phase: 'available',
      update: { version: '0.2.1' },
      dismissedVersion: '0.2.0'
    })
  })

  it('a manual check joins an automatic one running and reports like a manual one', async () => {
    const { service, github } = setup({ firstCheckDelayMs: 10 })
    github.hold = true
    await service.ready
    await vi.advanceTimersByTimeAsync(10)
    expect(service.status()).toMatchObject({ phase: 'checking', manual: false })
    const manual = service.check(true)
    await flush()
    github.release()
    expect(await manual).toMatchObject({ phase: 'available', manual: true })
    expect(github.requests).toBe(1)
  })

  it('the next automatic check comes an interval after a manual one', async () => {
    const { service, github } = setup()
    await service.ready
    await vi.advanceTimersByTimeAsync(5_000)
    await service.check(true)
    expect(github.requests).toBe(1)
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
    expect(github.requests).toBe(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - UPDATE_FIRST_CHECK_DELAY_MS)
    expect(github.requests).toBe(2)
  })

  it('unpackaged builds without the test switch never check on their own', async () => {
    const { service, github } = setup({ autoChecks: false })
    await service.ready
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(github.requests).toBe(0)
    expect(service.status().checksOff).toBeNull()
    expect((await service.check(true)).phase).toBe('available')
  })

  it('stops checking when the app quits', async () => {
    const { service, github } = setup({ firstCheckDelayMs: 10 })
    await service.ready
    service.stop()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(github.requests).toBe(0)
  })
})

describe('UpdateService: policy and preference', () => {
  it('policy off (or unreadable): no checks at all, manual ones included', async () => {
    for (const policyReading of ['disabled', 'invalid', new Error('reg.exe failed')] as const) {
      const { service, github } = setup({ policyReading, firstCheckDelayMs: 10 })
      await service.ready
      expect(service.status().checksOff).toBe('policy')
      expect(await service.check(true)).toMatchObject({ phase: 'idle', checksOff: 'policy', manual: false })
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
      expect(github.requests).toBe(0)
      service.stop()
    }
  })

  it('preference off: no automatic checks, manual ones still work', async () => {
    const { service, github, prefs } = setup({ pref: false, firstCheckDelayMs: 10 })
    await service.ready
    expect(service.status().checksOff).toBe('preference')
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(github.requests).toBe(0)
    expect((await service.check(true)).phase).toBe('available')
    expect(github.requests).toBe(1)
    // Turned on: automatic checks resume an interval after the last check.
    prefs.checkForUpdates = true
    service.preferenceChanged()
    expect(service.status().checksOff).toBeNull()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(github.requests).toBe(2)
    // Turned off again: the timer stops.
    prefs.checkForUpdates = false
    service.preferenceChanged()
    expect(service.status().checksOff).toBe('preference')
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3)
    expect(github.requests).toBe(2)
  })

  it('turning the preference on later checks soon when nothing was checked yet', async () => {
    const { service, github, prefs } = setup({ pref: false })
    await service.ready
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS * 4)
    prefs.checkForUpdates = true
    service.preferenceChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(github.requests).toBe(1)
  })

  it('policy on forces automatic checks whatever the preference says', async () => {
    const { service, github } = setup({ policyReading: 'enabled', pref: false, firstCheckDelayMs: 10 })
    await service.ready
    expect(service.status().checksOff).toBeNull()
    await vi.advanceTimersByTimeAsync(10)
    expect(github.requests).toBe(1)
  })

  it('nothing is checked before the policy is known', async () => {
    let read!: (r: PolicyReading | null) => void
    const { service, github } = setup({ policy: () => new Promise((resolve) => (read = resolve)) })
    expect(service.status().checksOff).toBe('policy')
    const check = service.check(true)
    await flush()
    expect(github.requests).toBe(0)
    read('disabled')
    expect(await check).toMatchObject({ phase: 'idle', checksOff: 'policy' })
    expect(github.requests).toBe(0)
  })
})

describe('UpdateService: downloading', () => {
  async function available() {
    const h = setup()
    await h.service.check(true)
    expect(h.service.status().phase).toBe('available')
    return h
  }

  it('downloads with progress, then is ready (and shows again if it was dismissed)', async () => {
    const { service, updater, broadcasts } = await available()
    service.dismiss()
    // Download from Preferences or About after closing the card: the card shows the progress.
    const done = service.download()
    await flush()
    expect(service.status()).toMatchObject({
      phase: 'downloading',
      progress: { percent: 0 },
      dismissedVersion: null
    })
    // Closed while downloading: the download goes on, and the card comes back when it is ready.
    service.dismiss()
    expect(service.status().dismissedVersion).toBe('0.2.0')
    updater.downloads[0].onProgress({ percent: 52.5, transferred: 525, total: 1000, bytesPerSecond: 100 })
    expect(service.status().progress).toEqual({
      percent: 52.5,
      transferred: 525,
      total: 1000,
      bytesPerSecond: 100
    })
    expect(broadcasts.at(-1)?.progress?.percent).toBe(52.5)
    updater.downloads[0].resolve()
    await done
    expect(service.status()).toMatchObject({
      phase: 'ready',
      progress: null,
      dismissedVersion: null,
      update: { version: '0.2.0' }
    })
  })

  it('cancel stops the download; the update is available again', async () => {
    const { service, updater } = await available()
    const done = service.download()
    await flush()
    service.cancel()
    expect(updater.downloads[0].signal.aborted).toBe(true)
    expect(service.status()).toMatchObject({ phase: 'available', progress: null, error: null })
    await done
    expect(service.status().phase).toBe('available')
    // Late progress from the cancelled download changes nothing.
    updater.downloads[0].onProgress({ percent: 90, transferred: 9, total: 10, bytesPerSecond: 1 })
    expect(service.status().progress).toBeNull()
  })

  it('a failed download keeps the update, says why, and can be tried again', async () => {
    const { service, updater } = await available()
    service.dismiss()
    const first = service.download()
    await flush()
    updater.downloads[0].reject(new Error('net::ERR_CONNECTION_RESET'))
    await first
    expect(service.status()).toMatchObject({
      phase: 'error',
      errorDuring: 'download',
      error: DOWNLOAD_OFFLINE,
      update: { version: '0.2.0' },
      progress: null,
      dismissedVersion: null
    })
    // Its card can be closed too.
    service.dismiss()
    expect(service.status().dismissedVersion).toBe('0.2.0')
    const again = service.download()
    await flush()
    expect(service.status()).toMatchObject({ phase: 'downloading', error: null, errorDuring: null })
    updater.downloads[1].resolve()
    await again
    expect(service.status().phase).toBe('ready')
  })

  it('fails with the release page on offer when the update metadata is for another version, or missing', async () => {
    for (const offered of ['0.1.5', null]) {
      const { service, updater } = await available()
      updater.offered = offered
      await service.download()
      expect(updater.downloads).toHaveLength(0)
      expect(service.status()).toMatchObject({
        phase: 'error',
        errorDuring: 'download',
        error: mismatchMessage('0.2.0')
      })
    }
  })

  it("'notify' installs: Download opens the release page", async () => {
    const { service, updater, opened } = setup({ capability: 'notify', updater: null })
    await service.check(true)
    await service.download()
    expect(opened).toEqual([tagUrl('0.2.0')])
    expect(updater.downloads).toHaveLength(0)
    expect(service.status().phase).toBe('available')
  })

  it('does not check while a download runs or an update is ready; a manual check brings the card back', async () => {
    const { service, github, updater } = await available()
    const done = service.download()
    await flush()
    service.dismiss()
    expect(await service.check(true)).toMatchObject({
      phase: 'downloading',
      manual: true,
      dismissedVersion: null
    })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(github.requests).toBe(1)
    updater.downloads[0].resolve()
    await done
    service.dismiss()
    expect(await service.check(true)).toMatchObject({ phase: 'ready', dismissedVersion: null })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(github.requests).toBe(1)
  })

  it('a background check that returns during or after a download leaves it alone', async () => {
    const { service, github, updater } = await available()
    github.hold = true
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(github.requests).toBe(2) // the automatic check waits for GitHub
    const done = service.download()
    await flush()
    updater.downloads[0].reject(new Error('net::ERR_CONNECTION_RESET'))
    await done
    github.release()
    await flush()
    expect(service.status()).toMatchObject({
      phase: 'error',
      errorDuring: 'download',
      error: DOWNLOAD_OFFLINE
    })
  })

  it('a download only starts from an available update (or after a failed download)', async () => {
    const { service, updater, github } = setup()
    await service.download()
    expect(updater.downloads).toHaveLength(0)
    github.latest = '0.1.0'
    await service.check(true)
    await service.download()
    expect(updater.downloads).toHaveLength(0)
    github.latest = new Error('offline')
    await service.check(true)
    await service.download()
    expect(updater.downloads).toHaveLength(0)
  })
})

describe('UpdateService: dismiss', () => {
  it('hides the card for this version; errors and manual checks clear it', async () => {
    const { service, github } = setup()
    service.dismiss()
    expect(service.status().dismissedVersion).toBeNull() // nothing to dismiss
    await service.check(true)
    service.dismiss()
    expect(service.status().dismissedVersion).toBe('0.2.0')
    expect((await service.check(true)).dismissedVersion).toBeNull()
    service.dismiss()
    github.latest = new Error('offline')
    // The update stays known (and shown) when a later check fails.
    expect(await service.check(true)).toMatchObject({ phase: 'available', dismissedVersion: null })
  })

  it('an error clears it', async () => {
    const { service, github } = setup({ firstCheckDelayMs: 10 })
    github.latest = '0.1.0'
    await service.check(true)
    github.latest = new Error('offline')
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(service.status()).toMatchObject({ phase: 'error', dismissedVersion: null })
  })
})

describe('UpdateService: restart', () => {
  async function ready() {
    const h = setup()
    await h.service.check(true)
    const done = h.service.download()
    await flush()
    h.updater.downloads[0].resolve()
    await done
    expect(h.service.status().phase).toBe('ready')
    return h
  }

  it('installs only after every window agreed to close', async () => {
    const { service, updater, quit } = await ready()
    const restart = service.restart()
    await flush()
    expect(quit.calls).toBe(1)
    expect(updater.installs).toBe(0)
    // Clicking again while the windows are being asked does not start another quit.
    await service.restart()
    expect(quit.calls).toBe(1)
    quit.approve()
    await restart
    expect(updater.installs).toBe(1)
  })

  it('cancelling the quit keeps the update ready and installs nothing', async () => {
    const { service, updater, quit } = await ready()
    const restart = service.restart()
    await flush()
    quit.cancel()
    await restart
    expect(updater.installs).toBe(0)
    expect(service.status().phase).toBe('ready')
    // And it can be tried again.
    const again = service.restart()
    await flush()
    quit.approve()
    await again
    expect(updater.installs).toBe(1)
  })

  it('does nothing unless an update is ready', async () => {
    const { service, quit } = setup()
    await service.restart()
    await service.check(true)
    await service.restart()
    expect(quit.calls).toBe(0)
  })
})

describe('UpdateService: release page', () => {
  it("opens the update's page, else the releases list, and nothing outside the repository", async () => {
    const { service, opened } = setup()
    await service.ready
    service.openReleasePage()
    await service.check(true)
    service.openReleasePage()
    expect(opened).toEqual([`${RELEASES_BASE}/releases`, tagUrl('0.2.0')])

    const base = 'http://127.0.0.1:4567/normiecore/Fartcrobat'
    const withTest = setup({ base, testBase: base })
    withTest.service.openReleasePage()
    expect(withTest.opened).toEqual([`${base}/releases`])
    // A base that is not github.com (and not the test base) is never opened.
    const other = setup({ base })
    other.service.openReleasePage()
    expect(other.opened).toEqual([])
  })
})
