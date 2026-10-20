import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { GripHorizontal, MessageCircle, Minus, Send, Settings, X } from 'lucide-react'
import { getActiveDoc, invoke, openPreferences, useApp } from '@renderer/sdk'
import { usePopupEscape } from '@renderer/ui/Menu'
import { shimForwardsCompanion } from '@shared/agent/protocol'
import { useInlineReview } from './reviewState'
import { BOOT } from '../tools/common'
import { appLabel, latestCall, useAgentUi } from './store'
import {
  activitySentence,
  allowNewConversation,
  armCompanion,
  disarmCompanion,
  endCompanion,
  sendCompanionMessage,
  useCompanion
} from './companionStore'
import {
  clampPosition,
  displayPosition,
  exceedsThreshold,
  parseSaved,
  sameDisplay,
  type Display,
  type Point,
  type Size
} from './companionPosition'

const P = 'fc-agent-access-companion'
const POSITION_KEY = 'agent-companion-position'
/** Arrow keys on "Move companion" save once the person stops pressing them. */
const SAVE_DELAY = 300
/** Parts of the card a press can drag; text to read or type inside them never starts a drag. */
const DRAG_ZONE = '[data-companion-drag]'
const NO_DRAG = 'textarea, input, select, a[href], [contenteditable]'
const STEPS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}
/** The card before it is first measured. */
const ASSUMED: Size = { width: 304, height: 150 }
const viewport = (): Size => ({ width: window.innerWidth, height: window.innerHeight })

interface Drag {
  id: number
  /** Where the card showed when pressed, and where the drag has taken it (both kept in the window). */
  origin: Point
  to: Point
  /** Past the threshold: the card follows the pointer and the click that ends it is eaten. */
  active: boolean
  /** Escape took it back to the start; the click that ends it is eaten too. */
  cancelled: boolean
  /** Escape: back to the start. */
  cancel(): void
  /** Stops listening without moving the card. */
  abort(): void
}

/** Small vector sprites stay sharp at every screen scale. Branding identifies the connected app. */
export const CompanionAvatar = memo(function CompanionAvatar({ provider, busy = false }: { provider: string; busy?: boolean }) {
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
})

/** The conversation: re-renders only when a message arrives or is delivered, not as the person types. */
const CompanionMessages = memo(function CompanionMessages({ name }: { name: string }) {
  const messages = useCompanion((s) => s.messages)
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [messages])
  return (
    <div ref={log} className={`${P}-messages`} role="log" aria-label="Companion conversation" aria-live="polite">
      {!messages.length && <p className={`${P}-hint`}>What would you like to do with this document?</p>}
      {messages.map((m) => (
        <div key={`${m.role}-${m.id}`} className={`${P}-message is-${m.role}`}>
          <b>{m.role === 'user' ? 'You' : name}</b>
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
  )
})

export function AgentCompanion() {
  const companion = useCompanion(
    useShallow((s) => ({
      owner: s.owner,
      minimized: s.minimized,
      revealed: s.revealed,
      autoJoin: s.autoJoin,
      listening: s.listening
    }))
  )
  const owner = companion.owner
  const ownerId = owner?.id
  const pending = useCompanion((s) => s.messages.some((m) => m.role === 'user' && !m.delivered))
  // Main sends a new status at every call start and finish: take only what the card shows.
  const agent = useAgentUi(
    useShallow((s) => {
      const connections = s.status?.connections ?? []
      const outdated = connections.find((c) => !shimForwardsCompanion(c.shimVersion))
      return {
        known: !!s.status,
        enabled: !!s.status?.enabled,
        connected: connections.length > 0,
        firstClient: connections[0]?.client.name,
        outdated: outdated ? appLabel(outdated.client.name) : null,
        ownerConnected: connections.some((c) => c.id === ownerId)
      }
    })
  )
  const call = useAgentUi((s) => latestCall(s.calls, ownerId))
  const reviewing = useInlineReview((s) => !!s.review)
  const readMode = useApp((s) => s.readMode)
  const [chat, setChat] = useState(false)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  // Where the person put the card (saved; null until they move it) and where it shows (never saved).
  const [preferred, setPreferred] = useState<Point | null>(null)
  const [display, setDisplay] = useState<Display>(() => displayPosition(null, ASSUMED, viewport()))
  // A move made during a review is where the person wants the card, over the panel or not.
  const [movedInReview, setMovedInReview] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const root = useRef<HTMLElement>(null)
  /** The card's size with everything showing (not collapsed). */
  const size = useRef(ASSUMED)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const displayRef = useRef(display)
  displayRef.current = display
  const reviewingRef = useRef(reviewing)
  reviewingRef.current = reviewing
  const saved = useRef<{ position: Point | null; minimized: boolean }>({ position: null, minimized: false })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const provider = owner?.name ?? appLabel(agent.firstClient)
  const busy = !reviewing && (call?.outcome === 'running' || call?.outcome === 'pending')
  const message = !agent.enabled
    ? 'AI access is turned off.'
    : !agent.connected
      ? 'Connect your AI app to get started.'
      : reviewing ? 'Your edits are ready to review on the page.' : activitySentence(call)

  // Opening the chat lets the next conversation in; closing it before one joins takes that back.
  const hideChat = () => {
    setChat(false)
    disarmCompanion()
  }
  const hidden = !loaded || readMode || companion.minimized || (!agent.connected && !companion.revealed && !owner)
  // Only a chat on screen takes Escape: in Read Mode it leaves Read Mode. During a drag Escape
  // puts the card back instead.
  usePopupEscape(chat && !hidden, () => {
    if (drag.current?.active && !drag.current.cancelled) drag.current.cancel()
    else hideChat()
  })

  const saveNow = () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const { position, minimized } = saved.current
    void invoke('store:set', POSITION_KEY, { ...(position ?? {}), minimized }).catch(() => {})
  }
  const saveRef = useRef(saveNow)
  saveRef.current = saveNow
  /** The person moved the card. */
  const moveTo = (p: Point) => {
    setPreferred(p)
    if (reviewingRef.current) setMovedInReview(true)
    saved.current.position = p
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, SAVE_DELAY)
  }

  useEffect(() => {
    let alive = true
    void invoke('store:get', POSITION_KEY)
      .then((value) => {
        if (!alive) return
        const { position, minimized } = parseSaved(value)
        saved.current.position = position
        if (position) setPreferred(position)
        if (minimized !== undefined) useCompanion.setState({ minimized })
        setLoaded(true)
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    // A move still waiting to be saved is saved when the window goes.
    const flush = () => {
      if (saveTimer.current) saveRef.current()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      alive = false
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
  useEffect(() => {
    // Its conversation went away: nobody else joins until the person allows a new conversation.
    if (owner && agent.known && (!agent.enabled || !agent.ownerConnected)) {
      endCompanion()
      // A message half typed for that conversation must not go to the next one.
      setDraft('')
    }
  }, [owner, agent.known, agent.enabled, agent.ownerConnected])
  const session = owner?.session
  useEffect(() => {
    // A new conversation starts without the last one's notice ("Chat ended and cleared.").
    if (session) setNotice('')
  }, [session])
  useEffect(() => {
    if (!reviewing) setMovedInReview(false)
  }, [reviewing])
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const fit = () => {
      // The card follows the pointer through a transform from where it showed: leave it be.
      if (drag.current?.active) return
      if (!el.classList.contains('is-collapsed')) size.current = { width: el.offsetWidth, height: el.offsetHeight }
      const panel =
        reviewing && !movedInReview ? document.querySelector('.fc-agent-access-inline-panel')?.getBoundingClientRect() : null
      const next = displayPosition(preferred, size.current, viewport(), panel?.width && panel.height ? panel : null, !chat)
      setDisplay((d) => (sameDisplay(d, next) ? d : next))
    }
    fit()
    window.addEventListener('resize', fit)
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    // The review panel comes and goes with the right panel, and resizes with it.
    const timer = reviewing ? setInterval(fit, 250) : undefined
    return () => {
      window.removeEventListener('resize', fit)
      observer.disconnect()
      clearInterval(timer)
    }
  }, [hidden, preferred, chat, reviewing, movedInReview])
  useEffect(() => {
    if (!loaded) return
    saved.current.minimized = companion.minimized
    saveRef.current()
  }, [loaded, companion.minimized])

  /** A press on a drag zone becomes a drag once it moves past the threshold; until then it is a click. */
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const el = root.current
    const target = e.target as Element
    if (!el || e.button !== 0 || !e.isPrimary || !target.closest(DRAG_ZONE) || target.closest(NO_DRAG)) return
    const card: HTMLElement = el
    drag.current?.abort()
    const origin = { x: displayRef.current.x, y: displayRef.current.y }
    const width = card.offsetWidth
    const height = card.offsetHeight
    const start = { x: e.clientX, y: e.clientY }
    let frame = 0
    const d: Drag = { id: e.pointerId, origin, to: origin, active: false, cancelled: false, cancel: () => finish('escape'), abort: () => finish('abort') }
    drag.current = d
    const paint = () => {
      frame = 0
      card.style.transform = `translate3d(${d.to.x - origin.x}px, ${d.to.y - origin.y}px, 0)`
    }
    const release = () => {
      cancelAnimationFrame(frame)
      card.classList.remove('is-dragging')
      card.style.transform = ''
      if (card.hasPointerCapture(d.id)) card.releasePointerCapture(d.id)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id || d.cancelled) return
      // The button went up where no event reached the window.
      if (!(ev.buttons & 1)) return void finish(d.active ? 'up' : 'abort')
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!d.active) {
        if (!exceedsThreshold(dx, dy, e.pointerType)) return
        d.active = true
        // Captured only now: captured from the press, the click would go to the card, not the button.
        try {
          card.setPointerCapture(d.id)
        } catch {
          return void finish('abort')
        }
        card.classList.add('is-dragging')
      }
      d.to = clampPosition(origin.x + dx, origin.y + dy, width, height, window.innerWidth, window.innerHeight)
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id) return
      // Released by Escape: the press still ends with a pointerup, whose click is eaten.
      if (ev.type === 'lostpointercapture' && d.cancelled) return
      finish('up')
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !d.active || d.cancelled) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      d.cancel()
    }
    const menu = (ev: Event) => {
      if (d.active) ev.preventDefault()
    }
    function finish(how: 'up' | 'escape' | 'abort') {
      if (how === 'escape') {
        // Back to where the press started; the press goes on until the button is up.
        if (!d.active || d.cancelled) return
        d.cancelled = true
        release()
        return
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('contextmenu', menu, true)
      card.removeEventListener('lostpointercapture', up)
      if (drag.current === d) drag.current = null
      if (how === 'up' && d.active && !d.cancelled) {
        // Where the card is now, without a frame at the old place before React renders it there.
        card.style.left = `${d.to.x}px`
        card.style.top = `${d.to.y}px`
        setDisplay({ ...d.to, collapsed: false })
        moveTo(d.to)
      }
      release()
      if (how === 'up' && d.active) {
        suppressClick.current = true
        setTimeout(() => (suppressClick.current = false), 0)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true)
    window.addEventListener('contextmenu', menu, true)
    card.addEventListener('lostpointercapture', up)
  }

  const minimize = () => {
    hideChat()
    useCompanion.setState({ minimized: true })
  }
  if (hidden) return null
  const zone = { 'data-companion-drag': '' }
  return createPortal(
    <section
      ref={root}
      className={`${P} ${display.collapsed ? 'is-collapsed' : ''}`}
      style={{ left: display.x, top: display.y }}
      aria-label="AI companion"
      onPointerDown={onPointerDown}
      onClickCapture={(e) => {
        if (!suppressClick.current) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className={`${P}-controls`} {...zone}>
        <button
          type="button"
          className={`${P}-drag`}
          aria-label="Move companion"
          title="Drag to move, or use arrow keys"
          onKeyDown={(e) => {
            const step = STEPS[e.key]
            const el = root.current
            if (!step || !el) return
            e.preventDefault()
            e.stopPropagation()
            const by = e.shiftKey ? 64 : 16
            const from = displayRef.current
            moveTo(
              clampPosition(
                from.x + step[0] * by,
                from.y + step[1] * by,
                el.offsetWidth,
                el.offsetHeight,
                window.innerWidth,
                window.innerHeight
              )
            )
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
          {...zone}
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
        <div className={`${P}-bubble`} role="status" {...zone}>
          {message}
        </div>
      </div>
      {!chat ? (
        <button
          type="button"
          className={`${P}-chat-toggle`}
          {...zone}
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
          <div className={`${P}-chat-head`} {...zone}>
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
              {companion.autoJoin && agent.outdated && (
                <p className={`${P}-hint`}>
                  {agent.outdated} uses the Fartcrobat extension from an older version, which doesn’t
                  connect to this chat by itself. Add it again in Preferences &gt; AI apps, then restart{' '}
                  {agent.outdated}.
                </p>
              )}
              <p className={`${P}-hint`}>
                Your desktop AI session must stay active. This companion doesn’t run its own model.
              </p>
            </div>
          ) : (
            <>
              <CompanionMessages name={owner.name} />
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const doc = getActiveDoc()
                  try {
                    sendCompanionMessage(
                      draft,
                      doc?.state.title,
                      doc ? `${owner.session.split('-chat-')[0]}-${BOOT}-${doc.id}` : undefined
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
                  disabled={!draft.trim() || pending || !agent.enabled}
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
