/** Pure helpers for the bookmark tree UI (no DOM, unit-tested). */
import type { Bookmark } from './types'

export interface FlatRow {
  bookmark: Bookmark
  depth: number
  parentId: number | null
  hasChildren: boolean
  expanded: boolean
}

/** Rows of the tree that are visible with the given expanded set, in display order. */
export function flattenVisible(tree: Bookmark[], expanded: ReadonlySet<number>): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (list: Bookmark[], depth: number, parentId: number | null) => {
    for (const b of list) {
      const hasChildren = b.children.length > 0
      const isOpen = hasChildren && expanded.has(b.id)
      rows.push({ bookmark: b, depth, parentId, hasChildren, expanded: isOpen })
      if (isOpen) walk(b.children, depth + 1, b.id)
    }
  }
  walk(tree, 0, null)
  return rows
}

export interface Located {
  bookmark: Bookmark
  parentId: number | null
  siblings: Bookmark[]
  index: number
}

export function locate(tree: Bookmark[], id: number): Located | null {
  const walk = (list: Bookmark[], parentId: number | null): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (b.id === id) return { bookmark: b, parentId, siblings: list, index: i }
      const inner = walk(b.children, b.id)
      if (inner) return inner
    }
    return null
  }
  return walk(tree, null)
}

/** Ids of the ancestors of a bookmark, outermost first. */
export function ancestorsOf(tree: Bookmark[], id: number): number[] {
  const path: number[] = []
  const walk = (list: Bookmark[]): boolean => {
    for (const b of list) {
      if (b.id === id) return true
      path.push(b.id)
      if (walk(b.children)) return true
      path.pop()
    }
    return false
  }
  return walk(tree) ? path : []
}

/** Every bookmark that has children (for "Expand all"). */
export function parentIds(tree: Bookmark[]): number[] {
  const out: number[] = []
  const walk = (list: Bookmark[]) => {
    for (const b of list) {
      if (b.children.length) {
        out.push(b.id)
        walk(b.children)
      }
    }
  }
  walk(tree)
  return out
}

/** Bookmarks whose `open` flag is set in the PDF (initial expanded state). */
export function initiallyOpen(tree: Bookmark[]): number[] {
  const out: number[] = []
  const walk = (list: Bookmark[]) => {
    for (const b of list) {
      if (b.open && b.children.length) out.push(b.id)
      walk(b.children)
    }
  }
  walk(tree)
  return out
}

export function isSelfOrDescendant(tree: Bookmark[], ancestorId: number, id: number): boolean {
  if (ancestorId === id) return true
  return ancestorsOf(tree, id).includes(ancestorId)
}

/**
 * The bookmark for the section the reader is in: the last bookmark (in document order) whose
 * destination is on the furthest page not after `page`.
 */
export function currentBookmarkId(tree: Bookmark[], page: number): number | null {
  let best: { id: number; page: number } | null = null
  const walk = (list: Bookmark[]) => {
    for (const b of list) {
      const p = b.dest?.page
      if (p !== undefined && p <= page && (!best || p >= best.page)) best = { id: b.id, page: p }
      walk(b.children)
    }
  }
  walk(tree)
  return best ? (best as { id: number }).id : null
}

/** The row to highlight for a bookmark: itself when visible, else its closest visible ancestor. */
export function visibleRowFor(tree: Bookmark[], id: number, expanded: ReadonlySet<number>): number {
  const chain = ancestorsOf(tree, id)
  for (let i = 0; i < chain.length; i++) {
    if (!expanded.has(chain[i])) return chain[i]
  }
  return id
}

export type DropPosition = 'before' | 'after' | 'inside'

/**
 * Converts a drop on `targetId` into moveBookmark arguments: the new parent (null = top level) and
 * the index among the new siblings without the dragged bookmark. Null when the drop is not allowed.
 */
export function computeMove(
  tree: Bookmark[],
  draggedId: number,
  targetId: number,
  position: DropPosition,
  expanded: ReadonlySet<number>
): { parentId: number | null; index: number } | null {
  if (isSelfOrDescendant(tree, draggedId, targetId)) return null
  const target = locate(tree, targetId)
  if (!target) return null
  if (position === 'inside') return { parentId: targetId, index: -1 }
  if (position === 'after' && target.bookmark.children.length && expanded.has(targetId)) {
    // The line below an expanded parent sits above its first child.
    return { parentId: targetId, index: 0 }
  }
  const siblings = target.siblings.filter((b) => b.id !== draggedId)
  const at = siblings.findIndex((b) => b.id === targetId)
  return { parentId: target.parentId, index: position === 'before' ? at : at + 1 }
}

/** Whether a move would leave the tree unchanged. */
export function isNoopMove(tree: Bookmark[], draggedId: number, move: { parentId: number | null; index: number }): boolean {
  const cur = locate(tree, draggedId)
  if (!cur || cur.parentId !== move.parentId) return false
  const index = move.index < 0 ? cur.siblings.length - 1 : move.index
  return index === cur.index
}

/**
 * Where a new bookmark for a page position goes: at the level of the selected bookmark (top level
 * when none), after the last bookmark at that level that points at or before the position. This keeps bookmarks in
 * reading order instead of dropping them wherever the selection happens to be.
 */
export function insertionPoint(
  tree: Bookmark[],
  selectedId: number | null,
  page: number,
  y: number | null = null
): { parentId: number | null; index: number } {
  const loc = selectedId !== null ? locate(tree, selectedId) : null
  const siblings = loc ? loc.siblings : tree
  const top = y ?? 0
  let index = 0
  siblings.forEach((b, i) => {
    if (b.dest && (b.dest.page < page || (b.dest.page === page && (b.dest.y ?? 0) <= top))) index = i + 1
  })
  return { parentId: loc ? loc.parentId : null, index }
}

/** A readable bookmark title from selected text. */
export function titleFromText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= 120) return t
  const cut = t.slice(0, 120)
  const space = cut.lastIndexOf(' ')
  return (space > 60 ? cut.slice(0, space) : cut) + '…'
}
