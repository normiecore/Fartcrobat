/** Companion messages stay in memory and are scoped to one conversation token and its MCP connection. */
import { create } from 'zustand'
import type { CallRecord } from './store'

export interface CompanionMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  delivered?: boolean
  document?: string
  documentHandle?: string
}
interface CompanionState {
  /**
   * Whether the next conversation that uses Fartcrobat joins the chat. Off until the person opens
   * the chat (armCompanion), and off again when they end it or its conversation disconnects, until
   * they allow a new conversation: who reads what they type is their choice.
   */
  autoJoin: boolean
  /** The person ended the chat (or its conversation went away): only "Allow a new conversation" arms it. */
  ended: boolean
  minimized: boolean
  revealed: boolean
  owner: { id: number; name: string; session: string } | null
  listening: boolean
  messages: CompanionMessage[]
}
export const useCompanion = create<CompanionState>(() => ({
  autoJoin: false,
  ended: false,
  minimized: false,
  revealed: false,
  owner: null,
  listening: false,
  messages: []
}))
let nextId = 0
let wake: (() => void) | null = null

/** Ends the chat: the conversation is cut off, messages are cleared and nobody joins until allowed. */
export function endCompanion() {
  useCompanion.setState({ owner: null, listening: false, messages: [], autoJoin: false, ended: true })
  wake?.()
}

/** The person opened the chat: the next conversation that uses Fartcrobat may join (not after an end). */
export function armCompanion() {
  const s = useCompanion.getState()
  if (!s.owner && !s.ended && !s.autoJoin) useCompanion.setState({ autoJoin: true })
}

/** The person closed or minimized the chat before a conversation joined: nobody joins until it is opened again. */
export function disarmCompanion() {
  const s = useCompanion.getState()
  if (!s.owner && s.autoJoin) useCompanion.setState({ autoJoin: false })
}

/**
 * Follows the AI apps connected now (none while agent access is off). The chat's conversation going
 * away ends the chat. Every app going away before a conversation joined takes the companion off
 * screen with its open chat, unless the person showed it: that takes the opening back as closing the
 * chat does, so the next app's first call, maybe hours later, does not join a chat nobody can see.
 */
export function followConnections(connected: number[]): 'ended' | 'hidden' | undefined {
  const s = useCompanion.getState()
  if (s.owner) {
    if (connected.includes(s.owner.id)) return undefined
    endCompanion()
    return 'ended'
  }
  if (connected.length || s.revealed) return undefined
  disarmCompanion()
  return 'hidden'
}

/** "Allow a new conversation" after the chat ended. */
export function allowNewConversation() {
  if (!useCompanion.getState().owner) useCompanion.setState({ autoJoin: true, ended: false })
}
export function sendCompanionMessage(text: string, document?: string, documentHandle?: string) {
  const s = useCompanion.getState()
  if (!s.owner) throw new Error('Ask your AI app to use a Fartcrobat tool first.')
  if (!text.trim() || text.length > 8000) throw new Error('Enter a message of up to 8,000 characters.')
  if (s.messages.some((m) => m.role === 'user' && !m.delivered))
    throw new Error('Your previous message is still waiting for the AI app.')
  const message: CompanionMessage = {
    id: ++nextId,
    role: 'user',
    text: text.trim(),
    document,
    documentHandle
  }
  useCompanion.setState({ messages: [...s.messages, message].slice(-100) })
  wake?.()
}

/** Short polling wait, cancelled on disconnect, end-chat or MCP cancellation. No background model. */
export async function exchangeCompanion(options: {
  connectionId: number
  name: string
  session: string
  joining: boolean
  message?: string
  replyTo?: number
  signal: AbortSignal
  waitMs: number
}) {
  const { connectionId, name, session, joining, signal, waitMs, message, replyTo } = options
  if (signal.aborted) throw new Error('Chat request cancelled.')
  let s = useCompanion.getState()
  if (joining) {
    if (s.owner)
      throw new Error('Another conversation owns this companion chat. Use the token returned to your conversation, or ask the person to end it first.')
    if (!s.autoJoin)
      throw new Error(
        s.ended
          ? 'Chat ended. Ask the person to allow a new conversation in Fartcrobat.'
          : 'The person has not opened the chat in Fartcrobat. Ask them to click Chat here first.'
      )
    if (!s.owner)
      useCompanion.setState({ owner: { id: connectionId, name, session }, revealed: true, messages: [], autoJoin: false })
    return {
      session: useCompanion.getState().owner!.session,
      status: 'joined',
      instructions:
        COMPANION_INSTRUCTIONS
    }
  }
  if (s.owner?.id !== connectionId || s.owner.session !== session)
    throw new Error(
      'This companion session ended or belongs to another connection. Join again only if asked.'
    )
  if (wake)
    throw new Error('A companion listener is already running. Wait for its result before calling again.')
  if (message !== undefined) {
    if (!message.trim() || message.length > 8000) throw new Error('Replies must contain 1–8,000 characters.')
    const user = s.messages.find((m) => m.id === replyTo && m.role === 'user' && m.delivered)
    if (!user) throw new Error('reply_to must identify a delivered user message in this chat.')
    // A response cannot be replayed or silently attached to a different question.
    if (s.messages.some((m) => m.role === 'assistant' && m.id === replyTo))
      throw new Error('That message already has a reply.')
    useCompanion.setState({
      messages: [...s.messages, { id: replyTo!, role: 'assistant' as const, text: message }].slice(-100)
    })
  }
  const take = () => {
    s = useCompanion.getState()
    if (s.owner?.session !== session) return { session, status: 'ended' }
    const pending = s.messages.find((m) => m.role === 'user' && !m.delivered)
    if (!pending) return null
    useCompanion.setState({
      messages: s.messages.map((m) => (m === pending ? { ...m, delivered: true } : m))
    })
    return { session, status: 'message', message: pending }
  }
  const immediate = take()
  if (immediate) return immediate
  useCompanion.setState({ listening: true })
  try {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        wake = null
        resolve()
      }
      wake = done
      signal.addEventListener('abort', done, { once: true })
      const timer = setTimeout(done, waitMs)
      if (signal.aborted) done()
    })
    if (signal.aborted) throw new Error('Chat request cancelled.')
    return (
      take() ?? {
        session,
        status: 'idle',
        instructions:
          'No message yet. Listen again while the person wants companion chat; do not invent a task.'
      }
    )
  } finally {
    if (useCompanion.getState().owner?.session === session) useCompanion.setState({ listening: false })
  }
}

export function activitySentence(call?: CallRecord): string {
  if (!call) return 'Ready when you are.'
  const action: Record<string, string> = {
    get_document_layout: 'Checking the layout, columns and spacing',
    get_editable_text: 'Inspecting the editable text',
    get_page_text: 'Reading the page',
    render_page: 'Looking at the page design',
    edit_text: 'Preparing text changes for your review',
    reflow_text: 'Fitting the text across columns and pages',
    rebuild_document: 'Preparing a new document layout',
    save_document: 'Saving your document',
    find_text: 'Finding text in the document',
    recognize_text: 'Recognising text on scanned pages',
    undo: 'Undoing the last change',
    get_context: 'Checking which document is open',
    show_in_app: 'Showing you the relevant page'
  }
  if (call.outcome === 'error') return `${call.title} couldn’t finish. See Agent activity for details.`
  if (call.outcome === 'declined') return 'You declined that change.'
  if (call.outcome === 'cancelled') return 'That action was cancelled.'
  if (call.outcome === 'done') return `${call.title} finished.`
  return `${action[call.tool] ?? `Working on: ${call.title.toLowerCase()}`}…`
}

/** A token is revealed only to the call that establishes ownership, never to later tokenless calls. */
export function autoJoinCompanion(connectionId: number, name: string, session: string) {
  const state = useCompanion.getState()
  if (!state.autoJoin || state.owner) return undefined
  // One conversation per arming: after it, only the person can let another one in.
  useCompanion.setState({ owner: { id: connectionId, name, session }, revealed: true, messages: [], autoJoin: false })
  return { session, status: 'joined' as const, instructions: COMPANION_INSTRUCTIONS }
}

const COMPANION_INSTRUCTIONS =
  'This conversation is now connected to the Fartcrobat companion. Keep this session token in this conversation only. Finish the current request, then call companion_chat with this session to listen. Reply to each user message with message and reply_to, and use its documentHandle for PDF operations. Continue listening while the person wants companion chat. Do not invent tasks on idle; stop when the session ends or the person asks. Report actual progress, not hidden reasoning.'
