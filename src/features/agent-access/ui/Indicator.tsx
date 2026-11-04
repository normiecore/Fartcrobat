/**
 * "Claude connected" at the right end of the top bar, on Home and with documents, while an AI app
 * is connected. It pulses while a call runs; clicking it shows the Agent activity panel (a popover
 * on Home, where there is no right panel).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { Bot, X } from 'lucide-react'
import { FloatingAt, IconButton, PanelFrame, toggleRightPanel, useApp } from '@renderer/sdk'
import { useCompanion } from './companionStore'
import { ActivityView } from './ActivityPanel'
import { appLabel, connectedLabel, useAgentUi } from './store'

const P = 'fc-agent-access'
const POPOVER_WIDTH = 340

export function AgentIndicator() {
  const minimized = useCompanion(s => s.minimized)
  // Main sends a new status at every call start and finish: take only what the button shows.
  const { count, label, names, busy } = useAgentUi(
    useShallow((s) => {
      const list = s.status?.connections ?? []
      return {
        count: list.length,
        label: list.length ? connectedLabel(list) : 'AI companion',
        names: [...new Set(list.map((c) => appLabel(c.client.name)))].join(', '),
        busy: s.running > 0 || list.some((c) => c.running > 0)
      }
    })
  )
  const hasDoc = useApp((s) => s.activeDocId !== null)
  const panelOpen = useApp((s) => s.rightPanelId === 'agent-activity')
  const readMode = useApp((s) => s.readMode)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)

  // The top bar is rendered by the shell, which leaves it out in Read Mode: find it again then.
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('.shell-topbar')
    if (el !== host) setHost(el)
  }, [host, readMode])
  // The popover belongs to Home; a document shows the right panel instead.
  useEffect(() => {
    if (hasDoc) setPopover(null)
  }, [hasDoc])

  if ((!count && !minimized) || !host || readMode) return null
  const open = () => {
    if (minimized) { useCompanion.setState({ minimized: false, revealed: true }); return }

    if (hasDoc) {
      toggleRightPanel('agent-activity')
      return
    }
    const r = button.current?.getBoundingClientRect()
    setPopover(popover || !r ? null : { x: Math.max(4, r.right - POPOVER_WIDTH), y: r.bottom + 4 })
  }
  return (
    <>
      {createPortal(
        <button
          ref={button}
          type="button"
          className={`${P}-indicator ${busy ? 'is-busy' : ''} ${panelOpen || popover ? 'is-open' : ''}`}
          title={`${names} can work with your documents. ${busy ? 'Working now. ' : ''}Click to see what it did.`}
          aria-label={`${label}${busy ? ', working' : ''}. Show agent activity`}
          aria-expanded={hasDoc ? panelOpen : !!popover}
          onClick={open}
        >
          <span className={`${P}-indicator-dot`} aria-hidden />
          <Bot size={15} aria-hidden />
          <span>{label}</span>
        </button>,
        host
      )}
      {popover && (
        <FloatingAt x={popover.x} y={popover.y} onClose={() => setPopover(null)}>
          <div className={`${P}-popover`} style={{ width: POPOVER_WIDTH }} role="dialog" aria-label="Agent activity">
            <PanelFrame title="Agent activity" actions={<IconButton icon={X} label="Close" size={16} onClick={() => setPopover(null)} />}>
              <ActivityView onLeave={() => setPopover(null)} />
            </PanelFrame>
          </div>
        </FloatingAt>
      )}
    </>
  )
}
