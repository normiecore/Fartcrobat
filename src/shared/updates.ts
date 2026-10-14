/**
 * Updates: how the app finds out about a new release on GitHub, downloads it and installs it.
 * Shared by the main process (src/features/updates/main.ts, which owns the state) and the windows
 * (src/features/updates/index.tsx, which show it). See docs/features/updates.md.
 *
 * The main process holds one UpdateStatus and sends it to every window ('updates:status') whenever
 * it changes. Windows never keep their own copy of the flow; every button calls main.
 */

/** Where releases are published. Checks use github.com pages, never api.github.com (rate limits). */
export const UPDATE_REPO = { owner: 'normiecore', repo: 'Fartcrobat' } as const

/** First automatic check after start-up, then every UPDATE_CHECK_INTERVAL_MS while the app runs. */
export const UPDATE_FIRST_CHECK_DELAY_MS = 30_000
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * What this installation can do with an update.
 * - 'install': download inside the app and install it silently (Windows NSIS installer, Linux
 *   AppImage).
 * - 'notify': only say a new version exists; Download opens the release page in the browser
 *   (macOS until builds are signed with a Developer ID, Linux .deb and .tar.gz, unpackaged runs).
 */
export type UpdateCapability = 'install' | 'notify'

/** Why automatic checks are off, or null when they are on. */
export type UpdateChecksOff = 'policy' | 'preference' | null

export interface AvailableUpdate {
  /** "0.2.0" (no leading v). */
  version: string
  /** The release page on GitHub ("What's new", and Download where the app cannot install). */
  releaseUrl: string
}

/**
 * Where the update flow is. Transitions (main process):
 *   idle/upToDate/error --check--> checking --> upToDate | available | error
 *   available --download (capability 'install')--> downloading --> ready | error
 *   downloading --cancel--> available
 *   ready --restart--> (the app quits after asking about unsaved documents, installs, starts again)
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateProgress {
  /** 0 to 100. */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateStatus {
  /** This app's version ("0.1.0"). */
  currentVersion: string
  capability: UpdateCapability
  phase: UpdatePhase
  /** Set from 'available' on (and kept in 'error' when the error came from downloading). */
  update: AvailableUpdate | null
  /** Set while 'downloading'. */
  progress: UpdateProgress | null
  /** Plain-language message for 'error'. */
  error: string | null
  /** Whether the error happened while downloading (Try again downloads) or checking (checks). */
  errorDuring: 'check' | 'download' | null
  /** ms since epoch of the last check that reached GitHub (success or "up to date"), or null. */
  lastChecked: number | null
  /** Automatic checks are off, and why. Manual checks still work unless this is 'policy'. */
  checksOff: UpdateChecksOff
  /**
   * The machine policy turns automatic checks on: the person's preference does not apply, and
   * Preferences shows the switch on and read-only. False while the policy is being read.
   */
  checksForcedOn: boolean
  /**
   * The person closed the notification for this version (Later, or the close button). Windows hide
   * the notification card until a newer version turns up or the phase moves on. Not persisted:
   * the next start shows it again.
   */
  dismissedVersion: string | null
  /** The last check was started by the person (Help > Check for Updates...): windows report "up to date" and errors. */
  manual: boolean
}

/** IPC channels (handled in src/features/updates/main.ts). */
declare module '@shared/ipc' {
  interface IpcApi {
    'feature:updates:status': () => UpdateStatus
    /** Checks now (Help > Check for Updates..., About, Preferences). Resolves when the check is done. */
    'feature:updates:check': () => UpdateStatus
    /** Downloads the available update ('install' capability), or opens the release page ('notify'). */
    'feature:updates:download': () => void
    /** Stops a download in progress. */
    'feature:updates:cancel': () => void
    /** Hides the notification for the available or ready version until the next start. */
    'feature:updates:dismiss': () => void
    /** Quits through the normal flow (asking about unsaved documents), installs and starts again. */
    'feature:updates:restart': () => void
    /** Opens the release page of the available update, or the releases list. */
    'feature:updates:openReleasePage': () => void
  }
}
