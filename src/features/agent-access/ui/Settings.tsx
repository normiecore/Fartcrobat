/** Preferences > AI apps. */
import { useEffect, useId, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileText, PlugZap } from 'lucide-react'
import { Button, Dialog, invoke, openDialog, setPrefs, showError, usePrefs } from '@renderer/sdk'
import { BlockedList, ConnectionList } from './ActivityPanel'
import { setAgentStatus, useAgentUi } from './store'
import { useCompanion } from './companionStore'
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
function Switch({
  checked,
  disabled,
  onChange,
  label
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  const id = useId()
  return (
    <label className={`${P}-switch ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={`${P}-switch-track`} aria-hidden>
        <span className={`${P}-switch-thumb`} />
      </span>
      <span className={`${P}-switch-label`}>{label}</span>
    </label>
  )
}

function ChatGPTSetup({
  close,
  config
}: {
  close: () => void
  config: { command: string; args: string[]; env: Record<string, string>; toml: string }
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog
      title="Connect ChatGPT Desktop"
      onClose={close}
      width={570}
      footer={<Button onClick={close}>Done</Button>}
    >
      <p>
        In ChatGPT Desktop, open <b>Settings → MCP servers → Add server</b>. Name it Fartcrobat and choose
        STDIO. This requires Node.js 22 or newer installed on this computer.
      </p>
      <p>Command</p>
      <pre className={`${P}-chatgpt-config`}>{config.command}</pre>
      <p>Argument (one entry, including spaces)</p>
      <pre className={`${P}-chatgpt-config`}>{config.args[0]}</pre>
      <p>Environment variable</p>
      <pre className={`${P}-chatgpt-config`}>FARTCROBAT_USER_DATA={config.env.FARTCROBAT_USER_DATA}</pre>
      <p>
        Save and restart the MCP server. In a local computer chat, use /mcp to check the connection, then ask
        which PDF is open. Workspace policies may restrict setup.
      </p>
      <details>
        <summary>Advanced: config.toml</summary>
        <pre className={`${P}-chatgpt-config`}>{config.toml}</pre>
        <Button
          onClick={() => {
            void navigator.clipboard
              .writeText(config.toml)
              .then(() => setCopied(true))
              .catch((e) => showError(e, 'Could not copy configuration'))
          }}
        >
          {copied ? 'Copied' : 'Copy configuration'}
        </Button>
        <p>
          Add this entry to your Codex host config.toml only if no fartcrobat entry exists. Update an existing
          entry rather than duplicating it.
        </p>
      </details>
      <p>This connects local desktop tools. It does not connect ChatGPT web or mobile by itself.</p>
    </Dialog>
  )
}

export function AgentSettings() {
  const prefs = usePrefs()
  const status = useAgentUi(
    useShallow((s) => ({
      policy: s.status?.policy ?? null,
      error: s.status?.error,
      connections: s.status?.connections,
      blocked: s.status?.blocked
    }))
  )
  const [installing, setInstalling] = useState(false)
  const [installMessage, setInstallMessage] = useState('')
  useEffect(() => {
    void refreshAgentStatus()
  }, [])
  const policy = status.policy
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
          Your organization {policy === 'enabled' ? 'turned this on' : 'turned this off'} for this computer,
          so it cannot be changed here.
        </p>
      )}
      <p className={`${P}-settings-about`}>
        AI apps on this computer, such as Claude Desktop, can read the documents open in Fartcrobat and any
        file you can open, make changes you can undo, and ask you here before anything that cannot be undone.
        Text they read is sent to that AI app&apos;s service. Passwords never reach the AI app, but a file
        whose password is saved on this device opens for it without asking.
      </p>
      {status.error && (
        <div className={`${P}-error`} role="alert">
          {status.error}
        </div>
      )}
      <div className={`${P}-settings-block`}>
        <b>Connected apps</b>
        <ConnectionList connections={on ? (status.connections ?? []) : []} />
        <BlockedList blocked={status.blocked ?? []} />
      </div>
      <div className={`${P}-settings-actions`}>
        <Button icon={PlugZap} disabled={installing} onClick={() => void install()}>
          Add to Claude Desktop
        </Button>
        <Button
          icon={PlugZap}
          disabled={!on}
          onClick={() => {
            void invoke('feature:agent-access:chatgptConfig')
              .then((config) => openDialog((close) => <ChatGPTSetup close={close} config={config} />))
              .catch((e) => showError(e, 'Could not prepare ChatGPT setup'))
          }}
        >
          Connect ChatGPT Desktop
        </Button>
        <Button variant="quiet" onClick={() => useCompanion.setState({ minimized: false, revealed: true })}>
          Show companion
        </Button>
        <Button
          variant="quiet"
          icon={FileText}
          onClick={() =>
            void invoke('feature:agent-access:revealAuditLog').catch((err) =>
              showError(err, 'Could not show the audit log')
            )
          }
        >
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
