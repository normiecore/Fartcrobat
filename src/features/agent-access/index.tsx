import { useEffect } from 'react'
import { Bot } from 'lucide-react'
import { defineFeature, onMainEvent } from '@renderer/sdk'
import { ActivityPanel } from './ui/ActivityPanel'
import { FlashLayer } from './ui/FlashLayer'
import { AgentCompanion } from './ui/Companion'
import { AgentIndicator } from './ui/Indicator'
import { AgentSettings, refreshAgentStatus } from './ui/Settings'
import { setAgentStatus } from './ui/store'
import { startAgentRunner } from './runner'
import './ipc'
import './agent-access.css'

// Listen for calls as soon as the window loads, before the first render: an AI app that started
// Fartcrobat sends its first call as soon as the window exists.
if (typeof window !== 'undefined' && (window as { api?: unknown }).api) startAgentRunner()

/** Always mounted: keeps the connection status current and shows the top bar indicator. */
function AgentAccessGlobal() {
  useEffect(() => {
    startAgentRunner()
    const off = onMainEvent('agent:status', (status) => setAgentStatus(status))
    void refreshAgentStatus()
    return off
  }, [])
  return <><AgentIndicator /><AgentCompanion /></>
}

export default defineFeature({
  id: 'agent-access',
  rightPanels: [{ id: 'agent-activity', label: 'Agent activity', icon: Bot, order: 90, component: ActivityPanel }],
  pageLayers: [{ id: 'agent-access-flash', order: 95, component: FlashLayer }],
  settings: [{ id: 'ai-apps', label: 'AI apps', order: 90, component: AgentSettings }],
  globals: [AgentAccessGlobal]
})
