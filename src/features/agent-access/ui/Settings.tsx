/** Preferences > AI apps. */
import { useEffect, useId, useState } from 'react'
import { FileText, PlugZap } from 'lucide-react'
import { Button, invoke, setPrefs, showError, usePrefs } from '@renderer/sdk'
import { BlockedList, ConnectionList } from './ActivityPanel'
import { setAgentStatus, useAgentUi } from './store'
import '../ipc'

const P = 'fc-agent-access'

export async function refreshAgentStatus() {
  try {
    setAgentStatus(await invoke('feature:agent-access:status'))
  } catch {
    // The main process has not started agent access (yet): the section shows the preference only.
  }
}

/** An on/off switch (a checkbox with role "switch"). */
function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  const id = useId()
  return (
    <label className={`${P}-switch ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={`${P}-switch-track`} aria-hidden>
        <span className={`${P}-switch-thumb`} />
      </span>
      <span className={`${P}-switch-label`}>{label}</span>
    </label>
  )
}

export function AgentSettings() {
  const prefs = usePrefs()
  const status = useAgentUi((s) => s.status)
  const [installing, setInstalling] = useState(false)
  const [installMessage, setInstallMessage] = useState('')
  useEffect(() => {
    void refreshAgentStatus()
  }, [])
  const policy = status?.policy ?? null
  const on = policy ? policy === 'enabled' : prefs.agentAccess
  const install = async () => {
    setInstalling(true)
    setInstallMessage('')
    try {
      setInstallMessage(await invoke('feature:agent-access:installExtension'))
    } catch (err) {
      showError(err, 'Could not add Fartcrobat to Claude Desktop')
    } finally {
      setInstalling(false)
    }
  }
  return (
    <div className={`${P}-settings`}>
      <Switch
        checked={on}
        disabled={!!policy}
        onChange={(v) => void setPrefs({ agentAccess: v })}
        label="Allow AI apps to work with your documents"
      />
      {policy && (
        <p className={`${P}-note`}>
          Your organization {policy === 'enabled' ? 'turned this on' : 'turned this off'} for this computer, so it cannot be changed here.
        </p>
      )}
      <p className={`${P}-settings-about`}>
        AI apps on this computer, such as Claude Desktop, can read the documents open in Fartcrobat and any file you can open,
        make changes you can undo, and ask you here before anything that cannot be undone. Text they read is sent to that AI
        app&apos;s service. Passwords always stay with you.
      </p>
      {status?.error && (
        <div className={`${P}-error`} role="alert">
          {status.error}
        </div>
      )}
      <div className={`${P}-settings-block`}>
        <b>Connected apps</b>
        <ConnectionList connections={on ? (status?.connections ?? []) : []} />
        <BlockedList blocked={status?.blocked ?? []} />
      </div>
      <div className={`${P}-settings-actions`}>
        <Button icon={PlugZap} disabled={installing} onClick={() => void install()}>
          Add to Claude Desktop
        </Button>
        <Button variant="quiet" icon={FileText} onClick={() => void invoke('feature:agent-access:revealAuditLog').catch((err) => showError(err, 'Could not show the audit log'))}>
          Show audit log
        </Button>
      </div>
      {installMessage && (
        <p className={`${P}-note`} role="status">
          {installMessage}
        </p>
      )}
    </div>
  )
}
