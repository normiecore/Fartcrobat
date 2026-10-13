/**
 * UI helpers for comments: what each comment type supports, its icon, dates, the text under text
 * markup, and grouping.
 */
import { useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Circle,
  Cloud,
  EyeOff,
  Highlighter,
  MessageSquare,
  MessageSquareQuote,
  Minus,
  Paperclip,
  Pentagon,
  PenLine,
  Spline,
  Square,
  Stamp,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
  Volume2,
  WavesHorizontal
} from 'lucide-react'
import type { AnnotInfo } from '@engine/ops/annots'
import { usePageVersion, type DocumentModel, type Icon } from '@renderer/sdk'
import { cleanDate, TEXT_MARKUP, textUnderQuads, typeLabel } from './shared'

export { typeLabel }

export interface Capabilities {
  /** Stroke / main colour. */
  color: boolean
  /** Fill (interior) colour; for text boxes this is the background (MuPDF's /C). */
  fill: 'interior' | 'background' | null
  opacity: boolean
  width: boolean
  /** Line styles offered: dashed, and cloudy where the type supports it. */
  dash: boolean
  cloud: boolean
  arrows: boolean
  font: boolean
  icon: { value: string; label: string }[] | null
}

const ATTACH_ICONS = [
  { value: 'PushPin', label: 'Push pin' },
  { value: 'Paperclip', label: 'Paperclip' },
  { value: 'Graph', label: 'Graph' },
  { value: 'Tag', label: 'Tag' }
]

export function capabilities(a: Pick<AnnotInfo, 'type'>): Capabilities {
  const none: Capabilities = { color: false, fill: null, opacity: true, width: false, dash: false, cloud: false, arrows: false, font: false, icon: null }
  switch (a.type) {
    case 'Text':
      return {
        ...none,
        color: true,
        icon: [
          { value: 'Comment', label: 'Comment' },
          { value: 'Note', label: 'Note' },
          { value: 'Key', label: 'Key' },
          { value: 'Help', label: 'Help' },
          { value: 'NewParagraph', label: 'New paragraph' },
          { value: 'Paragraph', label: 'Paragraph' },
          { value: 'Insert', label: 'Insert' }
        ]
      }
    case 'FreeText':
      return { ...none, fill: 'background', width: true, dash: true, cloud: true, font: true }
    case 'Line':
      return { ...none, color: true, fill: 'interior', width: true, dash: true, arrows: true }
    case 'Square':
    case 'Circle':
    case 'Polygon':
      return { ...none, color: true, fill: 'interior', width: true, dash: true, cloud: true }
    case 'PolyLine':
      return { ...none, color: true, width: true, dash: true, arrows: true }
    case 'Ink':
      return { ...none, color: true, width: true, dash: true }
    case 'FileAttachment':
      return { ...none, color: true, icon: ATTACH_ICONS }
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
    case 'Caret':
      return { ...none, color: true }
    case 'Redact':
      return { ...none, opacity: false }
    default:
      return none
  }
}

/** How a selected comment can be resized. */
export function resizeMode(a: Pick<AnnotInfo, 'type'>): 'rect' | 'line' | 'none' {
  if (a.type === 'Line') return 'line'
  if (TEXT_MARKUP.has(a.type) || ['Text', 'FileAttachment', 'Sound', 'Caret', 'Popup'].includes(a.type)) return 'none'
  return 'rect'
}

export function canMove(a: Pick<AnnotInfo, 'type' | 'locked'>): boolean {
  return !a.locked && !TEXT_MARKUP.has(a.type) && a.type !== 'Popup'
}

export function typeIcon(a: Pick<AnnotInfo, 'type' | 'intent' | 'cloudy' | 'lineEndings'>): Icon {
  switch (a.type) {
    case 'Text':
      return MessageSquare
    case 'FreeText':
      return /Callout/i.test(a.intent ?? '') ? MessageSquareQuote : Type
    case 'Highlight':
      return Highlighter
    case 'Underline':
      return Underline
    case 'StrikeOut':
      return Strikethrough
    case 'Squiggly':
      return WavesHorizontal
    case 'Caret':
      return TextCursorInput
    case 'Line':
      return typeLabel(a) === 'Arrow' ? ArrowUpRight : Minus
    case 'Square':
      return Square
    case 'Circle':
      return Circle
    case 'Polygon':
      return a.cloudy ? Cloud : Pentagon
    case 'PolyLine':
      return Spline
    case 'Ink':
      return PenLine
    case 'Stamp':
      return Stamp
    case 'FileAttachment':
      return Paperclip
    case 'Sound':
      return Volume2
    case 'Redact':
      return EyeOff
    default:
      return MessageSquare
  }
}

/** The colour that represents a comment in lists (#rrggbb). */
export function commentColor(a: Pick<AnnotInfo, 'type' | 'color' | 'interiorColor' | 'textColor'>): string {
  const c = a.type === 'FreeText' ? (a.textColor ?? a.color) : (a.color ?? a.interiorColor)
  return c && c !== 'transparent' ? c : '#9e9e9e'
}

/** Latest meaningful date of a comment. */
export function commentDate(a: Pick<AnnotInfo, 'created' | 'modified'>): string {
  return cleanDate(a.modified) || cleanDate(a.created)
}

/** "just now", "5 minutes ago", "Yesterday, 3:04 PM", "12 Mar 2024". */
export function relativeDate(iso: string, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, now - t)
  const min = Math.round(diff / 60000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} min ago`
  const d = new Date(t)
  const today = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`
  const yesterday = new Date(now - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export function fullDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
}

/** Ids that select together: a comment and the annotations grouped with it (e.g. Replace Text). */
export function groupIds(list: AnnotInfo[], a: AnnotInfo): number[] {
  const root = a.inReplyTo !== null && a.type !== 'Text' && list.some((x) => x.id === a.inReplyTo) ? a.inReplyTo : a.id
  const ids = [root]
  for (const x of list) if (x.inReplyTo === root && x.type !== 'Text' && !ids.includes(x.id)) ids.push(x.id)
  return ids
}

/** True for annotations that appear on the page as comments (not replies, status changes or hidden). */
export function isPageComment(a: AnnotInfo): boolean {
  return !a.hidden && !(a.type === 'Text' && a.inReplyTo !== null) && a.type !== 'Popup'
}

const markedCache = new Map<string, string>()

/** Text under a text-markup comment (via the page text), '' for other types. */
export async function markedText(doc: DocumentModel, a: AnnotInfo): Promise<string> {
  if (!TEXT_MARKUP.has(a.type) || !a.quads.length) return ''
  const key = `${doc.id}:${doc.pageVersion(a.page)}:${a.id}:${a.quads.flat().join(',')}`
  const hit = markedCache.get(key)
  if (hit !== undefined) return hit
  const t = await doc.pageText(a.page)
  const text = textUnderQuads(t, a.quads)
  if (markedCache.size > 2000) markedCache.clear()
  markedCache.set(key, text)
  return text
}

export function useMarkedText(doc: DocumentModel, a: AnnotInfo | null): string {
  const version = usePageVersion(doc, a?.page ?? 0)
  const [text, setText] = useState('')
  const quadKey = a ? a.quads.flat().join(',') : ''
  useEffect(() => {
    let alive = true
    if (!a || !TEXT_MARKUP.has(a.type)) {
      setText('')
      return
    }
    markedText(doc, a)
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(''))
    return () => {
      alive = false
    }
    // the quads identify what is marked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, a?.id, a?.type, a?.page, quadKey, version])
  return text
}
