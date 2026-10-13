/** Right panel "Agent activity" (also shown in a popover on Home): connections and recent calls. */
import { Ban, Bot, Check, CircleAlert, Loader2, Settings, ShieldX, Unplug } from 'lucide-react'
import type { AgentConnectionInfo } from '@shared/agent/bridge'
import { Button, EmptyState, invoke, openPreferences, Section, showError, type DocumentModel } from '@renderer/sdk'
import { appLabel, documentLabel, durationLabel, timeLabel, useAgentUi, type CallRecord } from './store'
import '../ipc'

const P = 'fc-agent-access'

export function disconnect(connectionId?: number) {
  const call = connectionId === undefined ? invoke('feature:agent-access:disconnect') : invoke('feature:agent-access:disconnect', connectionId)
  void call.catch((err) => showError(err, 'Could not disconnect'))
}

const OUTCOME: Record<CallRecord['outcome'], { label: string; icon: typeof Check }> = {
  running: { label: 'Running', icon: Loader2 },
  done: { label: 'Done', icon: Check },
  declined: { label: 'You declined', icon: ShieldX },
  cancelled: { label: 'Cancelled', icon: Ban },
  error: { label: 'Failed', icon: CircleAlert }
}

function CallRow({ call }: { call: CallRecord }) {
  const o = OUTCOME[call.outcome]
  const doc = documentLabel(call.document)
  return (
    <li className={`${P}-call is-${call.outcome}`}>
      <o.icon size={15} className={`${P}-call-icon`} aria-label={o.label} />
      <div className={`${P}-call-text`}>
        <div className={`${P}-call-head`}>
          <span className={`${P}-call-title`} title={call.title}>
            {call.title}
          </span>
          <time className={`${P}-call-time`} dateTime={new Date(call.started).toISOString()}>
            {timeLabel(call.started)}
          </time>
        </div>
        <div className={`${P}-call-meta`}>
          {[doc, call.outcome === 'done' || call.outcome === 'running' ? '' : o.label, call.ms !== undefined ? durationLabel(call.ms) : '']
            .filter(Boolean)
            .join(' · ')}
        </div>
        {call.error && call.outcome === 'error' && <div className={`${P}-call-error`}>{call.error}</div>}
      </div>
    </li>
  )
}

export function ConnectionList({ connections, compact }: { connections: AgentConnectionInfo[]; compact?: boolean }) {
  if (!connections.length) return <p className={`shell-muted ${P}-none`}>No AI app is connected.</p>
  return (
    <ul className={`${P}-connections`} aria-label="Connected AI apps">
      {connections.map((c) => (
        <li key={c.id} className={`${P}-connection`}>
          <Bot size={16} />
          <div className={`${P}-connection-text`}>
            <span className={`${P}-connection-name`}>
              {appLabel(c.client.name)}
              {!compact && c.client.version ? <span className="shell-muted"> {c.client.version}</span> : null}
            </span>
            <span className="shell-muted">
              Connected since {timeLabel(c.since, false)}
              {c.running ? ` · ${c.running} running` : ''}
            </span>
          </div>
          <Button size="sm" icon={Unplug} onClick={() => disconnect(c.id)}>
            Disconnect
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** Connections, recent calls and a way to the settings. `onLeave` closes a popover around it. */
export function ActivityView({ onLeave }: { onLeave?: () => void }) {
  const status = useAgentUi((s) => s.status)
  const calls = useAgentUi((s) => s.calls)
  const connections = status?.connections ?? []
  return (
    <div className={`${P}-activity`}>
      {status && !status.enabled && (
        <p className={`${P}-note`}>Agent access is turned off. AI apps cannot work with your documents.</p>
      )}
      <Section
        title="Connected apps"
        actions={
          connections.length > 1 ? (
            <Button size="sm" variant="quiet" onClick={() => disconnect()}>
              Disconnect all
            </Button>
          ) : undefined
        }
      >
        <ConnectionList connections={connections} compact />
      </Section>
      <Section title="Recent activity">
        {calls.length ? (
          <ul className={`${P}-calls`} aria-label="Recent agent activity">
            {calls.map((c) => (
              <CallRow key={c.id} call={c} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={Bot} title="No activity yet">
            When an AI app reads or changes your documents, each step shows here.
          </EmptyState>
        )}
      </Section>
      <div className={`${P}-activity-footer`}>
        <Button
          size="sm"
          variant="quiet"
          icon={Settings}
          onClick={() => {
            onLeave?.()
            openPreferences('ai-apps')
          }}
        >
          AI apps settings
        </Button>
      </div>
    </div>
  )
}

export function ActivityPanel(_props: { doc: DocumentModel }) {
  return <ActivityView />
}
