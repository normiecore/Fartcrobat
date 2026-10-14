// What downloads and installs an update: electron-updater in installed copies (./electronUpdater.ts),
// a fake in tests (./fakeUpdater.ts). The service only talks to this interface.
import type { UpdateProgress } from '@shared/updates'

export interface Updater {
  /**
   * Reads the release's update metadata (latest.yml, latest-linux.yml) and resolves with the
   * version it would install, or null when it offers none. `expected` is the version the release
   * check found.
   */
  findUpdate(expected: string): Promise<string | null>
  /**
   * Downloads what findUpdate found, reporting progress. Rejects when it fails, or when `signal`
   * aborts (the person cancelled).
   */
  download(onProgress: (progress: UpdateProgress) => void, signal: AbortSignal): Promise<void>
  /**
   * Installs the downloaded update silently and starts the new version. Called only once every
   * window agreed to close; the app quits right after. Quitting normally instead installs the
   * update without starting it again (each updater arranges that itself once a download is done).
   */
  installAndRestart(): void
}

/** The release has no update metadata for this install, or it is for another version. */
export class UpdateMismatchError extends Error {}

export const DOWNLOAD_OFFLINE = "Couldn't download the update. Check your internet connection and try again."
export const DOWNLOAD_FAILED = "Couldn't download the update. Try again, or download it from GitHub."
export const DOWNLOAD_DAMAGED = 'The downloaded update was damaged. Try again.'
export const DOWNLOAD_NO_SPACE =
  "There isn't enough disk space to download the update. Free up some space and try again."
export const mismatchMessage = (version: string) =>
  `Fartcrobat ${version} can't be installed from inside the app. Download it from GitHub instead.`

/** What the person reads when a download fails. */
export function downloadErrorMessage(err: unknown): string {
  if (err instanceof UpdateMismatchError) return err.message
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  const text = err instanceof Error ? err.message : String(err)
  if (code === 'ENOSPC' || /ENOSPC|no space left/i.test(text)) return DOWNLOAD_NO_SPACE
  if (/checksum mismatch|sha512|sha2 /i.test(text)) return DOWNLOAD_DAMAGED
  if (
    /net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|timed out|timeout/i.test(
      text
    )
  )
    return DOWNLOAD_OFFLINE
  return DOWNLOAD_FAILED
}
