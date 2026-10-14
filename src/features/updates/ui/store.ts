/**
 * The window's copy of the update status. Main owns the flow and sends every change to every
 * window ('updates:status'); this only mirrors the last one so the card, Preferences and the
 * command read the same thing. Every button calls main.
 */
import { create } from 'zustand'
import type { UpdateStatus } from '@shared/updates'
import { invoke, showError } from '@renderer/sdk'
import { checkOutcome, type CheckOutcome } from './format'

export const useUpdates = create<{ status: UpdateStatus | null }>(() => ({ status: null }))

// Counts the statuses main has sent. An answer to an older request must not replace a newer
// status that arrived while it was on its way.
let received = 0

/** A status main sent to every window. */
export function receiveUpdateStatus(status: UpdateStatus) {
  received++
  useUpdates.setState({ status })
}

async function request(channel: 'feature:updates:status' | 'feature:updates:check'): Promise<UpdateStatus> {
  const before = received
  const status = await invoke(channel)
  if (received === before) useUpdates.setState({ status })
  return status
}

export async function refreshUpdateStatus() {
  try {
    await request('feature:updates:status')
  } catch {
    // Main has not started the update service (yet): nothing is shown until it sends a status.
  }
}

let checking: Promise<CheckOutcome> | null = null

/**
 * Checks GitHub now and says what was found. A second request while one runs waits for the same
 * check rather than starting another.
 */
export function checkNow(): Promise<CheckOutcome> {
  checking ??= request('feature:updates:check')
    .then(checkOutcome, (): CheckOutcome => ({ kind: 'error' }))
    .finally(() => (checking = null))
  return checking
}

type Action =
  | 'feature:updates:download'
  | 'feature:updates:cancel'
  | 'feature:updates:dismiss'
  | 'feature:updates:restart'
  | 'feature:updates:openReleasePage'

const FAILED: Record<Action, string> = {
  'feature:updates:download': 'Could not start the download',
  'feature:updates:cancel': 'Could not stop the download',
  'feature:updates:dismiss': 'Could not close the notification',
  'feature:updates:restart': 'Could not restart Fartcrobat',
  'feature:updates:openReleasePage': 'Could not open the release page'
}

/** Asks main to do something with the update; main sends the new status to every window. */
export function updateAction(action: Action) {
  invoke(action).catch((err) => showError(err, FAILED[action]))
}
