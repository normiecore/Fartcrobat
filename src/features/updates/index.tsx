/**
 * Updates, the window side: the notification card, Help > Check for Updates..., and
 * Preferences > Updates. The main process (main.ts) finds, downloads and installs new releases;
 * see docs/features/updates.md.
 */
import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import { defineFeature, dismissToast, onMainEvent, toast } from '@renderer/sdk'
import { CHECK_FAILED_MESSAGE, MANAGED_MESSAGE, upToDateMessage } from './ui/format'
import { UpdateSettings } from './ui/Settings'
import { checkNow, receiveUpdateStatus, refreshUpdateStatus } from './ui/store'
import { UpdateCard } from './ui/UpdateCard'
import './updates.css'

/** Always mounted: keeps the window's copy of the status current and shows the card. */
function UpdatesGlobal() {
  useEffect(() => {
    const off = onMainEvent('updates:status', receiveUpdateStatus)
    void refreshUpdateStatus()
    return off
  }, [])
  return <UpdateCard />
}

/**
 * Help > Check for Updates...: the card shows a new version; anything else gets a toast here (only
 * in the window that asked: the other windows just get the new status).
 */
async function checkForUpdates() {
  // A slow network: say that something is happening rather than nothing at all.
  let waiting = 0
  const slow = setTimeout(() => (waiting = toast('Checking for updates…', { timeout: 0 })), 600)
  const outcome = await checkNow()
  clearTimeout(slow)
  if (waiting) dismissToast(waiting)
  if (outcome.kind === 'policy') toast(MANAGED_MESSAGE)
  else if (outcome.kind === 'upToDate') toast(upToDateMessage(outcome.version), { kind: 'success' })
  else if (outcome.kind === 'error') toast(CHECK_FAILED_MESSAGE, { kind: 'error' })
}

export default defineFeature({
  id: 'updates',
  commands: [
    {
      id: 'help.checkForUpdates',
      label: 'Check for Updates...',
      icon: RefreshCw,
      requiresDocument: false,
      keywords: ['update', 'upgrade', 'new version', 'release', 'download'],
      run: () => checkForUpdates()
    }
  ],
  // Right after About Fartcrobat (core's Help group).
  menus: [{ menu: 'help', group: 'help', command: 'help.checkForUpdates', order: 4 }],
  settings: [{ id: 'updates', label: 'Updates', order: 95, component: UpdateSettings }],
  globals: [UpdatesGlobal]
})
