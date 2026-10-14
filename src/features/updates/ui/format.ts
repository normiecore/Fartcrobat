/**
 * What the windows say about the update flow: which card to show for a status, the progress and
 * "last checked" texts, and what a manual check found. No React or renderer imports, so these are
 * unit tested in Node (format.test.ts).
 */
import type { UpdateProgress, UpdateStatus } from '@shared/updates'

export const MANAGED_MESSAGE = 'Updates are managed by your organization.'
export const CHECK_FAILED_MESSAGE =
  "Couldn't check for updates. Check your internet connection and try again."
export const CHECKS_ABOUT =
  'Checking asks GitHub for the latest release. Nothing about you or your documents is sent.'
export const NOTIFY_ONLY_NOTE =
  'On this system Fartcrobat tells you about new versions, and you download them from GitHub.'

export function upToDateMessage(version: string): string {
  return `Fartcrobat ${version} is up to date.`
}

/** The notification card a window shows. */
export type CardView = 'available' | 'downloading' | 'ready' | 'downloadError'

/**
 * The card for this status, or null for none. Nothing is shown while checking, when up to date,
 * or when a check failed (automatic checks fail silently; manual ones say so in a toast).
 *
 * The person's close button, or Later, hides the card for that version: main keeps the version in
 * dismissedVersion and clears it when the download becomes ready or fails, so the card comes back
 * once for each of those.
 */
export function cardView(status: UpdateStatus | null): CardView | null {
  const update = status?.update
  if (!status || !update) return null
  let view: CardView | null = null
  if (status.phase === 'available') view = 'available'
  else if (status.phase === 'downloading') view = 'downloading'
  else if (status.phase === 'ready') view = 'ready'
  else if (status.phase === 'error' && status.errorDuring === 'download') view = 'downloadError'
  if (!view) return null
  if (status.dismissedVersion !== null && status.dismissedVersion === update.version) return null
  return view
}

/** Whole percent, 0 to 100. */
export function percentOf(progress: UpdateProgress | null): number {
  if (!progress) return 0
  let p = progress.percent
  if (!Number.isFinite(p)) p = progress.total > 0 ? (progress.transferred / progress.total) * 100 : 0
  return Math.max(0, Math.min(100, Math.floor(p)))
}

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

/** "52 of 115 MB": both sizes in the unit that suits the total. */
export function sizeLabel(transferred: number, total: number): string {
  const done = Math.max(0, Math.min(transferred, total))
  if (total >= GB) return `${(done / GB).toFixed(1)} of ${(total / GB).toFixed(1)} GB`
  if (total >= 10 * MB) return `${Math.round(done / MB)} of ${Math.round(total / MB)} MB`
  if (total >= MB) return `${(done / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`
  return `${Math.round(done / KB)} of ${Math.max(1, Math.round(total / KB))} KB`
}

/** "45% (52 of 115 MB)", or "45%" when the size is not known. */
export function progressLabel(progress: UpdateProgress | null): string {
  const percent = `${percentOf(progress)}%`
  if (!progress || !(progress.total > 0)) return percent
  return `${percent} (${sizeLabel(progress.transferred, progress.total)})`
}

/** "Last checked: just now", "Last checked: 5 minutes ago", "Last checked: 12 Oct 2026, 10:42". */
export function lastCheckedLabel(lastChecked: number | null, now = Date.now()): string {
  if (lastChecked === null) return 'Not checked yet'
  const minutes = Math.floor((now - lastChecked) / 60_000)
  if (minutes < 1) return 'Last checked: just now'
  if (minutes < 60) return `Last checked: ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  return `Last checked: ${new Date(lastChecked).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
}

/** What a check the person asked for found, for the message they get. */
export type CheckOutcome =
  | { kind: 'policy' }
  | { kind: 'upToDate'; version: string }
  /** The check failed: `message` says why (main's plain-language message). */
  | { kind: 'error'; message: string }
  /** The card shows it (available, downloading, ready, or a download that failed). */
  | { kind: 'update' }
  /** Nothing to say (another check is still running). */
  | { kind: 'none' }

export function checkOutcome(status: UpdateStatus): CheckOutcome {
  if (status.checksOff === 'policy') return { kind: 'policy' }
  switch (status.phase) {
    case 'upToDate':
      return { kind: 'upToDate', version: status.currentVersion }
    case 'error':
      return status.errorDuring === 'download'
        ? { kind: 'update' }
        : { kind: 'error', message: status.error ?? CHECK_FAILED_MESSAGE }
    case 'available':
    case 'downloading':
    case 'ready':
      return { kind: 'update' }
    default:
      return { kind: 'none' }
  }
}

/**
 * One line about where the flow is, for Preferences > Updates: null when there is nothing to say.
 * A failed automatic check stays silent here too; a failed manual one says so.
 */
export function statusLine(status: UpdateStatus): string | null {
  const v = status.update?.version
  switch (status.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'upToDate':
      return upToDateMessage(status.currentVersion)
    case 'available':
      return `Fartcrobat ${v} is available.`
    case 'downloading':
      return `Downloading Fartcrobat ${v}… ${progressLabel(status.progress)}`
    case 'ready':
      return `Fartcrobat ${v} is ready to install. Restart Fartcrobat to finish.`
    case 'error':
      if (status.errorDuring === 'download') return `Couldn't download Fartcrobat ${v}.`
      return status.manual ? (status.error ?? CHECK_FAILED_MESSAGE) : null
    default:
      return null
  }
}
