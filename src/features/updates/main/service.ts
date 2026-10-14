// The update flow in the main process (docs/features/updates.md): owns the one UpdateStatus,
// checks for releases on a schedule and on request, downloads, and installs only after the quit
// flow approved. No Electron here (../main.ts wires it in), so tests drive it with fakes.
import { failClosed, type PolicyDecision, type PolicyReading } from '@main/policy'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  type AvailableUpdate,
  type UpdateCapability,
  type UpdateChecksOff,
  type UpdateStatus
} from '@shared/updates'
import {
  CHECK_OFFLINE,
  CHECK_TIMEOUT_MS,
  ReleaseCheckError,
  isNewerRelease,
  latestRelease,
  releasePageAllowed,
  trimBase,
  type RedirectProbe
} from './release'
import { UpdateMismatchError, downloadErrorMessage, mismatchMessage, type Updater } from './updater'

export interface UpdateServiceOptions {
  currentVersion: string
  capability: UpdateCapability
  /** Where releases are looked up (github.com, or a test server). */
  base: string
  /** A test base openReleasePage also accepts (unpackaged builds only), else null. */
  testBase?: string | null
  probe: RedirectProbe
  /** Downloads and installs; null where the capability is 'notify'. */
  updater: Updater | null
  /** Whether automatic checks may run at all (packaged builds, or a test turned them on). */
  autoChecks: boolean
  firstCheckDelayMs?: number
  checkIntervalMs?: number
  checkTimeoutMs?: number
  /** The machine policy's autoUpdate reading. A failure to read it counts as off. */
  policy(): Promise<PolicyReading | null>
  /** The person's "Check for updates automatically" preference. */
  preference(): boolean
  /** Sends the status to every window. */
  broadcast(status: UpdateStatus): void
  /**
   * Quits through the normal flow (every window asks about its unsaved documents) and calls
   * `install` once all of them agreed to close. Resolves false when the person cancelled.
   */
  quitForUpdate(install: () => void): Promise<boolean>
  openExternal(url: string): unknown
  now?(): number
}

export class UpdateService {
  private s: UpdateStatus
  private policy: PolicyDecision | null = null
  private policyKnown = false
  /** Resolves once the machine policy has been read; nothing checks before that. */
  readonly ready: Promise<void>
  private readonly startedAt: number
  /** When the last check started (automatic or not): the next automatic one is an interval later. */
  private lastAttempt: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking: Promise<void> | null = null
  private downloading: AbortController | null = null
  private restarting = false
  private stopped = false
  private readonly now: () => number

  constructor(private readonly opts: UpdateServiceOptions) {
    this.now = opts.now ?? (() => Date.now())
    this.startedAt = this.now()
    this.s = {
      currentVersion: opts.currentVersion,
      capability: opts.capability,
      phase: 'idle',
      update: null,
      progress: null,
      error: null,
      errorDuring: null,
      lastChecked: null,
      // Until the policy is known, nothing checks.
      checksOff: 'policy',
      dismissedVersion: null,
      manual: false
    }
    this.ready = opts
      .policy()
      .then(
        (reading) => {
          this.policy = failClosed(reading)
        },
        () => {
          this.policy = 'disabled'
        }
      )
      .then(() => {
        this.policyKnown = true
        this.set({ checksOff: this.checksOff() })
        this.schedule()
      })
  }

  status(): UpdateStatus {
    return {
      ...this.s,
      update: this.s.update && { ...this.s.update },
      progress: this.s.progress && { ...this.s.progress }
    }
  }

  /**
   * Checks now (`manual`: the person asked). Resolves with the status once the check is done. With
   * the policy off nothing is checked. While a download runs or an update is ready there is
   * nothing to check: a manual check then only brings the notification back.
   */
  async check(manual = true): Promise<UpdateStatus> {
    await this.ready
    if (this.stopped || this.policy === 'disabled') return this.status()
    if (!manual && !this.autoAllowed()) return this.status()
    const { phase } = this.s
    if (phase === 'downloading' || phase === 'ready') {
      if (manual) this.set({ manual: true, dismissedVersion: null })
      return this.status()
    }
    if (manual) this.set({ manual: true, dismissedVersion: null })
    // A manual check joins one already running (it then reports like a manual one).
    if (!this.checking) this.checking = this.runCheck(manual).finally(() => (this.checking = null))
    await this.checking
    return this.status()
  }

  private async runCheck(manual: boolean) {
    this.lastAttempt = this.now()
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    // An update already found stays on screen while it is looked for again.
    const known = this.s.phase === 'available' ? this.s.update : null
    if (!known)
      this.set({ phase: 'checking', update: null, progress: null, error: null, errorDuring: null, manual })
    else if (!manual) this.set({ manual: false })
    let found: AvailableUpdate | null = null
    let error: string | null = null
    try {
      found = await latestRelease(
        this.opts.base,
        this.opts.probe,
        this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS
      )
    } catch (err) {
      error = err instanceof ReleaseCheckError ? err.message : CHECK_OFFLINE
    }
    try {
      if (this.stopped) return
      // A download started meanwhile from the update already known (and may have finished or
      // failed): leave it alone.
      if (this.s.phase !== (known ? 'available' : 'checking')) {
        if (found) this.set({ lastChecked: this.now() })
        return
      }
      if (!found) {
        // Keep showing an update found earlier rather than an error.
        if (known) this.set({ phase: 'available', update: known })
        else
          this.set({
            phase: 'error',
            update: null,
            progress: null,
            error,
            errorDuring: 'check',
            dismissedVersion: null
          })
        return
      }
      const lastChecked = this.now()
      if (isNewerRelease(found.version, this.opts.currentVersion))
        this.set({
          phase: 'available',
          update: found,
          progress: null,
          error: null,
          errorDuring: null,
          lastChecked
        })
      else
        this.set({
          phase: 'upToDate',
          update: null,
          progress: null,
          error: null,
          errorDuring: null,
          lastChecked
        })
    } finally {
      this.schedule()
    }
  }

  /**
   * Download (the notification's button, and Try again after a failed download). Where the app
   * cannot install ('notify'), opens the release page instead. Resolves when the download is over.
   */
  async download(): Promise<void> {
    await this.ready
    const { phase, update } = this.s
    if (!update || !(phase === 'available' || (phase === 'error' && this.s.errorDuring === 'download')))
      return
    const updater = this.opts.updater
    if (this.opts.capability !== 'install' || !updater) {
      this.openReleasePage()
      return
    }
    const controller = new AbortController()
    this.downloading = controller
    const current = () => this.downloading === controller && !controller.signal.aborted
    this.set({
      phase: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: null,
      errorDuring: null
    })
    try {
      // The metadata the installer comes from must describe the release the person was shown.
      const offered = await updater.findUpdate(update.version)
      if (!current()) return
      if (offered !== update.version) throw new UpdateMismatchError(mismatchMessage(update.version))
      await updater.download((progress) => {
        if (current())
          this.set({ progress: { ...progress, percent: Math.max(0, Math.min(100, progress.percent)) } })
      }, controller.signal)
      if (!current()) return
      this.set({ phase: 'ready', progress: null, dismissedVersion: null })
    } catch (err) {
      if (!current()) return
      this.set({
        phase: 'error',
        progress: null,
        error: downloadErrorMessage(err),
        errorDuring: 'download',
        dismissedVersion: null
      })
    } finally {
      if (this.downloading === controller) this.downloading = null
    }
  }

  /** Stops the download; the update is available again. */
  cancel() {
    if (this.s.phase !== 'downloading' || !this.downloading) return
    this.downloading.abort()
    this.downloading = null
    this.set({ phase: 'available', progress: null })
  }

  /** The person closed the notification: hidden for this version until the next start. */
  dismiss() {
    const { phase, update } = this.s
    if (update && (phase === 'available' || phase === 'downloading' || phase === 'ready'))
      this.set({ dismissedVersion: update.version })
  }

  /**
   * Restart now: the normal quit flow first, the installer only once every window agreed to
   * close. If the person cancels, the update stays ready.
   */
  async restart(): Promise<void> {
    const updater = this.opts.updater
    if (this.s.phase !== 'ready' || !updater || this.restarting) return
    this.restarting = true
    try {
      await this.opts.quitForUpdate(() => updater.installAndRestart())
    } finally {
      this.restarting = false
    }
  }

  /** "What's new" and "Download from GitHub": the update's release page, else the releases list. */
  openReleasePage() {
    const url = this.s.update?.releaseUrl ?? `${trimBase(this.opts.base)}/releases`
    if (releasePageAllowed(url, this.opts.testBase ?? null))
      void Promise.resolve(this.opts.openExternal(url)).catch(() => {})
  }

  /** The preference changed: automatic checks start or stop. */
  preferenceChanged() {
    if (!this.policyKnown) return // `ready` applies the preference once the policy is known
    this.set({ checksOff: this.checksOff() })
    this.schedule()
  }

  /** The app is quitting: no more checks. */
  stop() {
    this.stopped = true
    clearTimeout(this.timer ?? undefined)
    this.timer = null
  }

  private checksOff(): UpdateChecksOff {
    if (this.policy === 'disabled') return 'policy'
    if (this.policy === 'enabled') return null
    return this.opts.preference() ? null : 'preference'
  }

  private autoAllowed(): boolean {
    return this.opts.autoChecks && this.policyKnown && this.checksOff() === null
  }

  /** Plans the next automatic check: the first one a while after start-up, then one per interval. */
  private schedule() {
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    if (this.stopped || !this.autoAllowed()) return
    const due =
      this.lastAttempt === null
        ? this.startedAt + (this.opts.firstCheckDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS)
        : this.lastAttempt + (this.opts.checkIntervalMs ?? UPDATE_CHECK_INTERVAL_MS)
    this.timer = setTimeout(() => void this.autoCheck(), Math.max(0, due - this.now()))
  }

  private async autoCheck() {
    this.timer = null
    if (this.stopped || !this.autoAllowed()) return
    // Nothing to look for while an update downloads or waits for a restart.
    if (this.s.phase === 'downloading' || this.s.phase === 'ready' || this.checking) {
      this.lastAttempt = this.now()
      this.schedule()
      return
    }
    await this.check(false)
  }

  private set(patch: Partial<UpdateStatus>) {
    this.s = { ...this.s, ...patch }
    try {
      this.opts.broadcast(this.status())
    } catch (err) {
      console.error('Updates: could not send the status', err)
    }
  }
}
