/** Preferences > Updates: the version, automatic checks on or off, and Check Now. */
import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/updates'
import { Button, setPrefs, Switch, useApp, usePrefs } from '@renderer/sdk'
import { CHECKS_ABOUT, lastCheckedLabel, NOTIFY_ONLY_NOTE, statusLine } from './format'
import { checkNow, refreshUpdateStatus, updateAction, useUpdates } from './store'

const P = 'fc-updates'

/** Re-renders every minute, so "5 minutes ago" stays true while Preferences is open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function UpdateSettings() {
  const prefs = usePrefs()
  const status = useUpdates((s) => s.status)
  const appVersion = useApp((s) => s.systemInfo?.appVersion)
  const now = useMinuteClock()
  const [checking, setChecking] = useState(false)
  // The status there was when Check Now last failed, and why. The failure is shown until a newer
  // status arrives (main may not have been reachable at all, and then the status cannot say so).
  const [failedAt, setFailedAt] = useState<{ status: UpdateStatus | null; message: string } | null>(null)
  const failed = failedAt !== null && failedAt.status === status
  useEffect(() => {
    void refreshUpdateStatus()
  }, [])

  // The machine policy turns updates off (no checks at all), or turns automatic checks on.
  const policy = status?.checksOff === 'policy'
  const forcedOn = !policy && status?.checksForcedOn === true
  const check = async () => {
    setChecking(true)
    setFailedAt(null)
    const outcome = await checkNow()
    setChecking(false)
    if (outcome.kind === 'error') setFailedAt({ status: useUpdates.getState().status, message: outcome.message })
  }
  const line = policy
    ? null
    : checking
      ? 'Checking for updates…'
      : failed
        ? failedAt.message
        : status && statusLine(status)

  return (
    <div className={`${P}-settings`}>
      <p className={`${P}-version`}>
        <b>Version {status?.currentVersion ?? appVersion ?? ''}</b>
      </p>
      <Switch
        checked={forcedOn || (!policy && prefs.checkForUpdates)}
        disabled={policy || forcedOn}
        onChange={(v) => void setPrefs({ checkForUpdates: v })}
        label="Check for updates automatically"
      />
      {policy && <p className={`${P}-settings-note`}>Your organization manages updates on this computer.</p>}
      {forcedOn && (
        <p className={`${P}-settings-note`}>
          Your organization turned automatic checks on for this computer, so it cannot be changed here.
        </p>
      )}
      <div className={`${P}-settings-check`}>
        <Button disabled={checking || policy} onClick={() => void check()}>
          Check Now
        </Button>
        <span className="shell-muted">{lastCheckedLabel(status?.lastChecked ?? null, now)}</span>
      </div>
      {/* Preferences covers the notification card, so what a check found shows here as well. */}
      <div className={`${P}-settings-status`} role="status">
        {line && <span>{line}</span>}
        {!checking && !policy && status && <LineAction status={status} />}
      </div>
      {status?.capability === 'notify' && !policy && (
        <p className={`${P}-settings-note`}>{NOTIFY_ONLY_NOTE}</p>
      )}
      <p className="shell-muted">{CHECKS_ABOUT}</p>
    </div>
  )
}

/** The button that moves the flow on from the status line, if any. */
function LineAction({ status }: { status: UpdateStatus }) {
  if (status.phase === 'available')
    return (
      <Button size="sm" onClick={() => updateAction('feature:updates:download')}>
        Download
      </Button>
    )
  if (status.phase === 'ready')
    return (
      <Button size="sm" onClick={() => updateAction('feature:updates:restart')}>
        Restart now
      </Button>
    )
  if (status.phase === 'error' && status.errorDuring === 'download')
    return (
      <Button size="sm" onClick={() => updateAction('feature:updates:download')}>
        Try again
      </Button>
    )
  return null
}
