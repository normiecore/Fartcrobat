import { describe, expect, it } from 'vitest'
import {
  COLLAPSED,
  EDGE,
  GAP,
  TOP,
  clampPosition,
  defaultPosition,
  displayPosition,
  exceedsThreshold,
  overlaps,
  parseSaved,
  sameDisplay
} from '@features/agent-access/ui/companionPosition'

const viewport = { width: 1280, height: 800 }
const card = { width: 304, height: 150 }
const withChat = { width: 304, height: 520 }
// The review panel in the right panel: 300 px wide, next to the 52 px rail.
const panel = { left: 928, top: 80, right: 1228, bottom: 800 }

describe('companion position', () => {
  it('keeps the card inside the window, below the top bar', () => {
    expect(clampPosition(-50, 0, 304, 150, 1280, 800)).toEqual({ x: EDGE, y: TOP })
    expect(clampPosition(2000, 2000, 304, 150, 1280, 800)).toEqual({ x: 1280 - 304 - EDGE, y: 800 - 150 - EDGE })
    expect(clampPosition(100, 200, 304, 150, 1280, 800)).toEqual({ x: 100, y: 200 })
    // a window narrower than the card: its left edge stays visible
    expect(clampPosition(100, 200, 304, 150, 200, 800).x).toBe(EDGE)
  })

  it('tells a click from a drag: 3 px for a mouse, 8 px for a finger or pen', () => {
    expect(exceedsThreshold(2, 2, 'mouse')).toBe(false)
    expect(exceedsThreshold(3, 0, 'mouse')).toBe(false)
    expect(exceedsThreshold(3, 1, 'mouse')).toBe(true)
    expect(exceedsThreshold(5, 5, 'touch')).toBe(false)
    expect(exceedsThreshold(0, 9, 'touch')).toBe(true)
    expect(exceedsThreshold(6, 6, 'pen')).toBe(true)
    expect(exceedsThreshold(-4, 0, 'mouse')).toBe(true)
  })

  it('finds overlapping boxes, not touching ones', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 }
    expect(overlaps(a, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true)
    expect(overlaps(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false)
    expect(overlaps(a, { left: 0, top: 11, right: 10, bottom: 20 })).toBe(false)
  })

  it('shows the preferred position kept in the window, and never changes it', () => {
    const preferred = { x: 900, y: 600 }
    // the chat opens near the bottom: the card shows higher...
    const open = displayPosition(preferred, withChat, viewport)
    expect(open).toEqual({ x: 900, y: 800 - 520 - EDGE, collapsed: false })
    // ...and goes back down when it closes: the preferred position did not drift
    expect(displayPosition(preferred, card, viewport)).toEqual({ x: 900, y: 600, collapsed: false })
    expect(preferred).toEqual({ x: 900, y: 600 })
    // a smaller window clamps it, a larger one brings it back
    expect(displayPosition(preferred, card, { width: 800, height: 600 })).toEqual({ x: 800 - 304 - EDGE, y: 600 - 150 - EDGE, collapsed: false })
    expect(displayPosition(preferred, card, viewport)).toEqual({ x: 900, y: 600, collapsed: false })
  })

  it('starts at the bottom right until the person moves it', () => {
    expect(defaultPosition(viewport)).toEqual({ x: 950, y: 580 })
    expect(displayPosition(null, card, viewport)).toEqual({ x: 950, y: 580, collapsed: false })
    expect(displayPosition(null, card, { width: 1600, height: 900 })).toEqual({ x: 1270, y: 680, collapsed: false })
  })

  it('moves off the review panel to its left, or collapses when there is no room', () => {
    // over the panel: to its left, same height
    expect(displayPosition({ x: 950, y: 580 }, card, viewport, panel)).toEqual({
      x: panel.left - 304 - GAP,
      y: 580,
      collapsed: false
    })
    // clear of the panel: where the person put it
    expect(displayPosition({ x: 100, y: 580 }, card, viewport, panel)).toEqual({ x: 100, y: 580, collapsed: false })
    // above the panel's top edge only partly: still moved
    expect(displayPosition({ x: 950, y: TOP }, card, viewport, panel).x).toBe(panel.left - 304 - GAP)
    // a narrow window: no room for the card, so only its controls and avatar show
    const narrow = { width: 600, height: 800 }
    const narrowPanel = { left: 248, top: 80, right: 548, bottom: 800 }
    expect(displayPosition({ x: 300, y: 500 }, card, narrow, narrowPanel)).toEqual({
      x: narrowPanel.left - COLLAPSED.width - GAP,
      y: 500,
      collapsed: true
    })
    // an open chat is not hidden: it stays where it is
    expect(displayPosition({ x: 280, y: 500 }, card, narrow, narrowPanel, false)).toEqual({ x: 280, y: 500, collapsed: false })
    // no room even for the avatar: it collapses at the left edge
    expect(displayPosition({ x: 300, y: 500 }, card, narrow, { ...narrowPanel, left: 50 })).toEqual({ x: EDGE, y: 500, collapsed: true })
  })

  it('compares displays and reads saved values defensively', () => {
    expect(sameDisplay({ x: 1, y: 2, collapsed: false }, { x: 1, y: 2, collapsed: false })).toBe(true)
    expect(sameDisplay({ x: 1, y: 2, collapsed: false }, { x: 1, y: 2, collapsed: true })).toBe(false)
    expect(parseSaved({ x: 10, y: 20, minimized: true })).toEqual({ position: { x: 10, y: 20 }, minimized: true })
    expect(parseSaved({ minimized: false })).toEqual({ position: null, minimized: false })
    expect(parseSaved({ x: Number.NaN, y: 2 })).toEqual({ position: null })
    expect(parseSaved({ x: '1', y: 2 })).toEqual({ position: null })
    expect(parseSaved(null)).toEqual({ position: null })
    expect(parseSaved('x')).toEqual({ position: null })
  })
})
