import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GripHorizontal, MessageCircle, Minus, Send, Settings, X } from 'lucide-react'
import { invoke, openPreferences, useActiveDoc, useApp } from '@renderer/sdk'
import { usePopupEscape } from '@renderer/ui/Menu'
import { shimForwardsCompanion } from '@shared/agent/protocol'
import { useInlineReview } from './reviewState'
import { BOOT } from '../tools/common'
import { appLabel, useAgentUi } from './store'
import {
  activitySentence,
  allowNewConversation,
  armCompanion,
  disarmCompanion,
  endCompanion,
  sendCompanionMessage,
  useCompanion
} from './companionStore'

const P = 'fc-agent-access-companion'
const POSITION_KEY = 'agent-companion-position'
export function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
) {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(40, Math.min(y, viewportHeight - height - 8))
  }
}

/** Small vector sprites stay sharp at every screen scale. Branding identifies the connected app. */
export function CompanionAvatar({ provider, busy = false }: { provider: string; busy?: boolean }) {
  const claude = provider === 'Claude'
  const [pose, setPose] = useState(0)
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setInterval> | undefined
    const update = () => {
      clearInterval(timer)
      setPose(0)
      if (busy && !motion.matches) timer = setInterval(() => setPose(p => (p + 1) % 3), 1100)
    }
    update()
    motion.addEventListener('change', update)
    return () => { clearInterval(timer); motion.removeEventListener('change', update) }
  }, [busy])
  return (
    <svg
      className={`${P}-avatar ${busy ? 'is-busy' : ''}`}
      data-pose={pose}
      viewBox="0 0 80 64"
      aria-label={claude ? 'Claude pixel companion' : 'OpenAI inspired companion'}
      role="img"
    >
      {claude ? (
        <g fill="#c68162" shapeRendering="crispEdges" transform={pose === 1 ? "translate(0 -2) rotate(-3 40 32)" : pose === 2 ? "rotate(3 40 32)" : undefined}>
          <path d="M18 12h44v34H18zM10 23h8v17h-8zM62 23h8v17h-8zM22 46h8v12h-8zM50 46h8v12h-8z" />
          <path fill="#282422" d="M27 25h6v8h-6zM47 25h6v8h-6z" />
        </g>
      ) : (
        <g>
          <g transform={pose === 1 ? "rotate(-5 40 30)" : pose === 2 ? "rotate(5 40 30)" : undefined} fill="none" stroke="#5c9f91" strokeWidth="7" strokeLinejoin="round">
            {Array.from({ length: 6 }, (_, i) => (
              <path
                key={i}
                transform={`rotate(${i * 60} 40 30)`}
                d="M40 9c16-10 29 8 18 20l-18 11-12-7V19z"
              />
            ))}
          </g>
          <rect x="25" y="22" width="30" height="21" rx="10" fill="#e2f3eb" />
          <circle cx="34" cy="31" r="2.5" fill="#1e4239" />
          <circle cx="46" cy="31" r="2.5" fill="#1e4239" />
          <path d="M35 50l-3 7m13-7 3 7" stroke="#5c9f91" strokeWidth="5" strokeLinecap="round" />
        </g>
      )}
    </svg>
  )
}

export function AgentCompanion() {
  const status = useAgentUi((s) => s.status)
  const calls = useAgentUi((s) => s.calls)
  const companion = useCompanion()
  const reviewing = useInlineReview(s => !!s.review)
  const readMode = useApp((s) => s.readMode)
  const doc = useActiveDoc()
  const [chat, setChat] = useState(false)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [position, setPosition] = useState({
    x: Math.max(8, window.innerWidth - 330),
    y: Math.max(40, window.innerHeight - 220)
  })
  const [loaded, setLoaded] = useState(false)
  const root = useRef<HTMLElement>(null)
  const messages = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null)
  const positionRef = useRef(position)
  positionRef.current = position
  const owner = companion.owner
  const connections = status?.connections ?? []
  const outdated = connections.find((c) => !shimForwardsCompanion(c.shimVersion))
  const provider = owner?.name ?? appLabel(connections[0]?.client.name)
  const call = calls.find(
    (c) =>
      c.tool !== 'companion_chat' &&
      c.tool !== 'wait_for_result' &&
      (!owner || c.id.startsWith(`${owner.id}:`))
  )
  const busy = !reviewing && (call?.outcome === 'running' || call?.outcome === 'pending')
  const message = !status?.enabled
    ? 'AI access is turned off.'
    : !connections.length
      ? 'Connect your AI app to get started.'
      : reviewing ? 'Your edits are ready to review on the page.' : activitySentence(call)

  // Opening the chat lets the next conversation in; closing it before one joins takes that back.
  const hideChat = () => {
    setChat(false)
    disarmCompanion()
  }
  usePopupEscape(chat, hideChat)
  useEffect(() => {
    let alive = true
    void invoke('store:get', POSITION_KEY)
      .then((value) => {
        if (!alive) return
        const p = value as { x?: unknown; y?: unknown; minimized?: unknown } | null
        if (
          p &&
          typeof p.x === 'number' &&
          Number.isFinite(p.x) &&
          typeof p.y === 'number' &&
          Number.isFinite(p.y)
        )
          setPosition({ x: p.x, y: p.y })
        if (typeof p?.minimized === 'boolean') useCompanion.setState({ minimized: p.minimized })
        setLoaded(true)
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    // Its conversation went away: nobody else joins until the person allows a new conversation.
    if (owner && status && (!status.enabled || !status.connections.some((c) => c.id === owner.id))) {
      endCompanion()
      // A message half typed for that conversation must not go to the next one.
      setDraft('')
    }
  }, [owner, status])
  const session = owner?.session
  useEffect(() => {
    // A new conversation starts without the last one's notice ("Chat ended and cleared.").
    if (session) setNotice('')
  }, [session])
  useEffect(() => {
    if (!loaded) return
    const fit = () => {
      const r = root.current?.getBoundingClientRect()
      if (!r) return
      setPosition((p) => clampPosition(p.x, p.y, r.width, r.height, window.innerWidth, window.innerHeight))
    }
    fit()
    window.addEventListener('resize', fit)
    const observer = new ResizeObserver(fit)
    if (root.current) observer.observe(root.current)
    return () => {
      window.removeEventListener('resize', fit)
      observer.disconnect()
    }
  }, [loaded, chat, companion.minimized, readMode])
  useEffect(() => {
    if (messages.current) messages.current.scrollTop = messages.current.scrollHeight
  }, [companion.messages, chat])
  useEffect(() => {
    if (loaded) void invoke('store:set', POSITION_KEY, { ...positionRef.current, minimized: companion.minimized }).catch(() => {})
  }, [loaded, companion.minimized])
  const persist = (minimized: boolean) => {
    void invoke('store:set', POSITION_KEY, { ...positionRef.current, minimized }).catch(() => {})
  }
  const minimize = () => {
    hideChat()
    useCompanion.setState({ minimized: true })
    persist(true)
  }
  if (!loaded || readMode || companion.minimized || (!connections.length && !companion.revealed && !owner))
    return null
  const pending = companion.messages.some((m) => m.role === 'user' && !m.delivered)
  return createPortal(
    <section ref={root} className={P} style={{ left: position.x, top: position.y }} aria-label="AI companion">
      <div className={`${P}-controls`}>
        <button
          type="button"
          className={`${P}-drag`}
          aria-label="Move companion"
          title="Drag to move, or use arrow keys"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, originX: position.x, originY: position.y }
          }}
          onPointerMove={(e) => {
            if (!drag.current || !root.current) return
            const r = root.current.getBoundingClientRect()
            setPosition(
              clampPosition(
                drag.current.originX + e.clientX - drag.current.x,
                drag.current.originY + e.clientY - drag.current.y,
                r.width,
                r.height,
                window.innerWidth,
                window.innerHeight
              )
            )
          }}
          onPointerUp={() => {
            drag.current = null
            persist(false)
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onKeyDown={(e) => {
            const offsets: Record<string, [number, number]> = {
              ArrowLeft: [-16, 0],
              ArrowRight: [16, 0],
              ArrowUp: [0, -16],
              ArrowDown: [0, 16]
            }
            const d = offsets[e.key]
            const r = root.current?.getBoundingClientRect()
            if (!d || !r) return
            e.preventDefault()
            e.stopPropagation()
            const next = clampPosition(
              position.x + d[0],
              position.y + d[1],
              r.width,
              r.height,
              window.innerWidth,
              window.innerHeight
            )
            positionRef.current = next
            setPosition(next)
            persist(false)
          }}
        >
          <GripHorizontal size={16} />
          <span>{provider === 'AI app' ? 'Companion' : provider}</span>
        </button>
        <button type="button" aria-label="Companion settings" onClick={() => openPreferences('ai-apps')}>
          <Settings size={14} />
        </button>
        <button type="button" aria-label="Minimize companion to Agent activity" onClick={minimize}>
          <Minus size={16} />
        </button>
      </div>
      <div className={`${P}-presence`}>
        <button
          type="button"
          className={`${P}-avatar-button`}
          aria-label={chat ? 'Hide companion chat' : 'Chat with companion'}
          aria-expanded={chat}
          onClick={() => {
            if (chat) hideChat()
            else {
              armCompanion()
              setChat(true)
            }
          }}
        >
          <CompanionAvatar provider={provider} busy={busy} />
        </button>
        <div className={`${P}-bubble`} role="status">
          {message}
        </div>
      </div>
      {!chat ? (
        <button
          type="button"
          className={`${P}-chat-toggle`}
          onClick={() => {
            armCompanion()
            setChat(true)
          }}
        >
          <MessageCircle size={14} />
          {owner ? 'Continue chat' : 'Chat here'}
        </button>
      ) : (
        <div className={`${P}-chat`}>
          <div className={`${P}-chat-head`}>
            <span>
              {owner
                ? companion.listening
                  ? `${owner.name} is listening`
                  : `Connected to ${owner.name}`
                : companion.autoJoin ? 'Waiting for a conversation' : 'Chat ended'}
            </span>
            <button type="button" aria-label="Hide chat" onClick={hideChat}>
              <X size={14} />
            </button>
          </div>
          {!owner ? (
            <div className={`${P}-setup`}>
              <p>
                {companion.autoJoin
                  ? 'Ask Claude or ChatGPT to use Fartcrobat. The next conversation that does connects to this chat, no invitation needed.'
                  : 'Chat ended. No conversation can connect until you allow a new one.'}
              </p>
              {!companion.autoJoin && (
                <button type="button" onClick={allowNewConversation}>
                  Allow a new conversation
                </button>
              )}
              {companion.autoJoin && outdated && (
                <p className={`${P}-hint`}>
                  {appLabel(outdated.client.name)} uses the Fartcrobat extension from an older version, which doesn’t
                  connect to this chat by itself. Add it again in Preferences &gt; AI apps, then restart{' '}
                  {appLabel(outdated.client.name)}.
                </p>
              )}
              <p className={`${P}-hint`}>
                Your desktop AI session must stay active. This companion doesn’t run its own model.
              </p>
            </div>
          ) : (
            <>
              <div
                ref={messages}
                className={`${P}-messages`}
                role="log"
                aria-label="Companion conversation"
                aria-live="polite"
              >
                {!companion.messages.length && (
                  <p className={`${P}-hint`}>What would you like to do with this document?</p>
                )}
                {companion.messages.map((m) => (
                  <div key={`${m.role}-${m.id}`} className={`${P}-message is-${m.role}`}>
                    <b>{m.role === 'user' ? 'You' : owner.name}</b>
                    <p>{m.text}</p>
                    {m.role === 'user' && (
                      <small>
                        {m.delivered ? 'Received by AI app' : 'Waiting for AI app'}
                        {m.document ? ` · ${m.document}` : ''}
                      </small>
                    )}
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  try {
                    sendCompanionMessage(
                      draft,
                      doc?.state.title,
                      doc && owner ? `${owner.session.split('-chat-')[0]}-${BOOT}-${doc.id}` : undefined
                    )
                    setDraft('')
                    setNotice('')
                  } catch (e) {
                    setNotice((e as Error).message)
                  }
                }}
              >
                <textarea
                  aria-label="Message companion"
                  placeholder={`Ask ${owner.name}…`}
                  value={draft}
                  maxLength={8000}
                  rows={2}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      e.currentTarget.form?.requestSubmit()
                    }
                  }}
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={!draft.trim() || pending || !status?.enabled}
                >
                  <Send size={16} />
                </button>
              </form>
              <div className={`${P}-chat-footer`}>
                <small>Messages go to {owner.name}’s service.</small>
                <button
                  type="button"
                  onClick={() => {
                    endCompanion()
                    setDraft('')
                    setNotice('Chat ended and cleared.')
                  }}
                >
                  End &amp; clear
                </button>
              </div>
              {!companion.listening && (
                <p className={`${P}-hint`}>Waiting for your AI app to listen. If replies stop, resume the same conversation there.</p>
              )}
            </>
          )}
          {notice && (
            <p role="status" className={`${P}-hint`}>
              {notice}
            </p>
          )}
        </div>
      )}
    </section>,
    document.body
  )
}
