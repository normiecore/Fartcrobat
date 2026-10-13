// organize_pages: checks the arguments and works out where pages end up. Pure, Node-testable.
import { isNoopMove, movedIndices } from '@features/organize-pages/order'
import { InvalidArgs, optInteger, pageList, plural } from './act-common'
import { pathArg } from './act-files'

export type OrganizeOperation = 'rotate' | 'delete' | 'move' | 'insert_blank' | 'insert_file' | 'duplicate'

export type OrganizePlan =
  | { op: 'rotate'; pages: number[]; degrees: 90 | 180 | 270 }
  | { op: 'delete'; pages: number[] }
  /** gap: 0 = before the first page, pageCount = after the last (the core pages.move semantics). */
  | { op: 'move'; pages: number[]; gap: number; after: number[] }
  | { op: 'insert_blank'; gap: number; count: number }
  | { op: 'insert_file'; gap: number; path: string }
  | { op: 'duplicate'; pages: number[] }

export interface OrganizeArgs {
  operation?: unknown
  angle?: unknown
  before?: unknown
  count?: unknown
  path?: unknown
}

const OPERATIONS: OrganizeOperation[] = ['rotate', 'delete', 'move', 'insert_blank', 'insert_file', 'duplicate']

/** "before" (1-based page to go in front of; omitted = the end) as a gap index. */
export function gapBefore(before: unknown, pageCount: number): number {
  const b = optInteger(before, 'before', 1, pageCount + 1)
  return b === undefined ? pageCount : b - 1
}

/** Clockwise degrees as the core rotate op takes them. */
export function rotation(angle: unknown): 90 | 180 | 270 {
  if (angle === 90 || angle === 180 || angle === 270) return angle
  if (angle === -90) return 270
  throw new InvalidArgs('angle must be 90, 180, 270 or -90 (clockwise degrees)')
}

/**
 * Checks organize_pages arguments. `pages` is the parsed page range (0-based), or null when the
 * agent gave none: delete and move need one, rotate and duplicate default to every page.
 */
export function planOrganize(args: OrganizeArgs, pages: number[] | null, pageCount: number): OrganizePlan {
  const op = args.operation as OrganizeOperation
  if (!OPERATIONS.includes(op)) throw new InvalidArgs(`operation must be one of ${OPERATIONS.join(', ')}`)
  const all = Array.from({ length: pageCount }, (_, i) => i)
  switch (op) {
    case 'rotate':
      return { op, pages: pages ?? all, degrees: rotation(args.angle) }
    case 'delete': {
      if (!pages) throw new InvalidArgs('Give the pages to delete, e.g. "3" or "2-4"')
      if (pages.length >= pageCount) throw new InvalidArgs(`Every page can't be deleted: a PDF needs at least one page (this one has ${plural(pageCount, 'page')})`)
      return { op, pages }
    }
    case 'move': {
      if (!pages) throw new InvalidArgs('Give the pages to move, e.g. "3" or "2-4"')
      const gap = gapBefore(args.before, pageCount)
      if (isNoopMove(pageCount, pages, gap)) throw new InvalidArgs(`Pages ${pageList(pages)} are already there: nothing to move`)
      return { op, pages, gap, after: movedIndices(pageCount, pages, gap) }
    }
    case 'insert_blank': {
      const count = optInteger(args.count, 'count', 1, 500) ?? 1
      return { op, gap: gapBefore(args.before, pageCount), count }
    }
    case 'insert_file':
      if (args.path === undefined) throw new InvalidArgs('insert_file needs path: the file whose pages to insert')
      return { op, gap: gapBefore(args.before, pageCount), path: pathArg(args.path) }
    case 'duplicate':
      return { op, pages: pages ?? all }
  }
}

/** 0-based indices of `count` pages inserted at `gap`. */
export function insertedIndices(gap: number, count: number): number[] {
  return Array.from({ length: count }, (_, k) => gap + k)
}

/** Where the copies made by "duplicate" land: right after the last duplicated page. */
export function duplicatedIndices(pages: number[]): number[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const at = sorted[sorted.length - 1] + 1
  return sorted.map((_, k) => at + k)
}
