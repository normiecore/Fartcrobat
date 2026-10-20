/** Right panel "Agent activity" (also shown in a popover on Home): connections and recent calls. */
import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Ban, Bot, Check, CircleAlert, Loader2, Settings, ShieldX, Unplug } from 'lucide-react'
import type { AgentConnectionInfo } from '@shared/agent/bridge'
import { shimForwardsCompanion } from '@shared/agent/protocol'
import { Button, EmptyState, invoke, openPreferences, Section, showError, type DocumentModel } from '@renderer/sdk'
import { appLabel, documentLabel, durationLabel, timeLabel, useAgentUi, type CallRecord } from './store'
import { useCompanion } from './companionStore'
import '../ipc'

const P = 'fc-agent-access'

export function disconnect(connectionId?: number) {
  const call = connectionId === undefined ? invoke('feature:agent-access:disconnect') : invoke('feature:agent-access:disconnect', connectionId)
  void call.catch((err) => showError(err, 'Could not disconnect'))
}

export function allow(clientName: string) {
  void invoke('feature:agent-access:allow', clientName).catch((err) => showError(err, 'Could not allow the AI app again'))
}

const OUTCOME: Record<CallRecord['outcome'], { label: string; icon: typeof Check }> = {
  running: { label: 'Running', icon: Loader2 },
  done: { label: 'Done', icon: Check },
  declined: { label: 'You declined', icon: ShieldX },
  cancelled: { label: 'Cancelled', icon: Ban },
  error: { label: 'Failed', icon: CircleAlert },
  pending: { label: 'Still running', icon: Loader2 }
}

// A record keeps its identity until its call changes, so only that row renders again.
const CallRow = memo(function CallRow({ call }: { call: CallRecord }) {
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
})

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
            {!shimForwardsCompanion(c.shimVersion) && (
              <span className="shell-muted">Uses the extension from an older Fartcrobat: add it again to chat in Fartcrobat.</span>
            )}
          </div>
          <Button size="sm" icon={Unplug} title="It cannot connect again until you allow it." onClick={() => disconnect(c.id)}>
            Disconnect
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** AI apps the person disconnected (by the name they report): they stay out until allowed again. */
export function BlockedList({ blocked }: { blocked: string[] }) {
  if (!blocked.length) return null
  return (
    <ul className={`${P}-connections`} aria-label="Disconnected AI apps">
      {blocked.map((name) => (
        <li key={name} className={`${P}-connection is-blocked`}>
          <Unplug size={16} />
          <div className={`${P}-connection-text`}>
            <span className={`${P}-connection-name`}>
              {appLabel(name)}
              {name && appLabel(name) !== name ? <span className="shell-muted"> ({name})</span> : null}
            </span>
            <span className="shell-muted">Disconnected. It cannot connect again until you allow it.</span>
          </div>
          <Button size="sm" onClick={() => allow(name)}>
            Allow again
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** Connections, recent calls and a way to the settings. `onLeave` closes a popover around it. */
export function ActivityView({ onLeave }: { onLeave?: () => void }) {
  const status = useAgentUi(useShallow((s) => ({ off: s.status?.enabled === false, connections: s.status?.connections, blocked: s.status?.blocked })))
  const calls = useAgentUi((s) => s.calls)
  const connections = status.connections ?? []
  return (
    <div className={`${P}-activity`}>
      <Button size="sm" onClick={() => { useCompanion.setState({ minimized: false, revealed: true }); onLeave?.() }}>Show companion</Button>
      {status.off && (
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
        <BlockedList blocked={status.blocked ?? []} />
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
