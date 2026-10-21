/**
 * Where the companion card sits. The person's preferred position is saved and changes only when
 * they move the card; the displayed position is worked out from it at every layout (kept inside
 * the window, and off the review panel while a review is open) and is never saved, so opening the
 * chat near an edge or a review no longer moves the card for good. No React or DOM, so this is
 * unit tested in Node.
 */

export interface Point {
  x: number
  y: number
}
export interface Size {
  width: number
  height: number
}
/** A screen rectangle in CSS px, as getBoundingClientRect gives it. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}
export interface Display extends Point {
  /** Only the controls and the avatar show: the card would cover the review panel otherwise. */
  collapsed: boolean
}

/** Distance kept from the window edges; the top bar stays uncovered. */
export const EDGE = 8
export const TOP = 40
/** Space left between the card and the review panel. */
export const GAP = 8
/** The card with only its controls and avatar (`.is-collapsed`). */
export const COLLAPSED: Size = { width: 88, height: 104 }

/** Keeps a card of the given size inside the viewport. */
export function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
): Point {
  return {
    x: Math.max(EDGE, Math.min(x, viewportWidth - width - EDGE)),
    y: Math.max(TOP, Math.min(y, viewportHeight - height - EDGE))
  }
}

/** Bottom right, clear of the document's scroll bar. */
export function defaultPosition(viewport: Size): Point {
  return { x: viewport.width - 330, y: viewport.height - 220 }
}

/** Pixels a press must move before it becomes a drag: a mouse is steady, a finger or pen is not. */
export function dragThreshold(pointerType: string): number {
  return pointerType === 'mouse' ? 3 : 8
}

/** True once a press moved far enough to be a drag rather than a click. */
export function exceedsThreshold(dx: number, dy: number, pointerType: string): boolean {
  return Math.hypot(dx, dy) > dragThreshold(pointerType)
}

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function box(p: Point, size: Size): Box {
  return { left: p.x, top: p.y, right: p.x + size.width, bottom: p.y + size.height }
}

/**
 * Where the card shows: the preferred position (or the default one) kept inside the viewport and,
 * when `avoid` (the review panel) is given, moved to its left if it would cover it. Without room
 * there, the card collapses to its controls and avatar, unless `canCollapse` is false (an open chat
 * stays open).
 */
export function displayPosition(
  preferred: Point | null,
  size: Size,
  viewport: Size,
  avoid: Box | null = null,
  canCollapse = true
): Display {
  const want = preferred ?? defaultPosition(viewport)
  const p = clampPosition(want.x, want.y, size.width, size.height, viewport.width, viewport.height)
  if (!avoid || !overlaps(box(p, size), avoid)) return { ...p, collapsed: false }
  const left = avoid.left - size.width - GAP
  if (left >= EDGE) return { x: left, y: p.y, collapsed: false }
  if (!canCollapse) return { ...p, collapsed: false }
  const c = clampPosition(want.x, want.y, COLLAPSED.width, COLLAPSED.height, viewport.width, viewport.height)
  return { x: Math.max(EDGE, Math.min(c.x, avoid.left - COLLAPSED.width - GAP)), y: c.y, collapsed: true }
}

export function sameDisplay(a: Display, b: Display): boolean {
  return a.x === b.x && a.y === b.y && a.collapsed === b.collapsed
}

/** The saved value: `{x, y, minimized}`, where x and y are missing until the person moves the card. */
export function parseSaved(value: unknown): { position: Point | null; minimized?: boolean } {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const position =
    typeof v.x === 'number' && Number.isFinite(v.x) && typeof v.y === 'number' && Number.isFinite(v.y)
      ? { x: v.x, y: v.y }
      : null
  return { position, ...(typeof v.minimized === 'boolean' ? { minimized: v.minimized } : {}) }
}
