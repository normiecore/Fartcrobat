// Agent access: the argument helpers every tool handler uses (tools/common.tsx).
import { beforeAll, describe, expect, it, vi } from 'vitest'

let common: typeof import('@features/agent-access/tools/common')

beforeAll(async () => {
  // The platform module reads the preload bridge from window when it loads; the registry loads
  // the features (and with them the SDK) first, as in the app.
  vi.stubGlobal('window', {})
  await import('@renderer/app/registry')
  common = await import('@features/agent-access/tools/common')
})

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(common.ToolError)
    return (err as InstanceType<typeof common.ToolError>).code
  }
}

describe('parsePages', () => {
  it('reads single pages, ranges, lists and "last" as sorted unique 0-based indices', () => {
    const { parsePages } = common
    expect(parsePages('3', 10)).toEqual([2])
    expect(parsePages('2-5', 10)).toEqual([1, 2, 3, 4])
    expect(parsePages('1,3,7-9', 10)).toEqual([0, 2, 6, 7, 8])
    expect(parsePages('last', 10)).toEqual([9])
    expect(parsePages('8-last', 10)).toEqual([7, 8, 9])
    expect(parsePages(' 5 - 3 , 4, 3 ', 10)).toEqual([2, 3, 4])
    expect(parsePages('ALL', 3)).toEqual([0, 1, 2])
    expect(parsePages('1,,2', 3)).toEqual([0, 1])
  })

  it('uses the fallback when no pages are given', () => {
    const { parsePages } = common
    expect(parsePages(undefined, 3)).toEqual([0, 1, 2])
    expect(parsePages(null, 3)).toEqual([0, 1, 2])
    expect(parsePages('', 3)).toEqual([0, 1, 2])
    expect(parsePages(undefined, 5, 'current', 3)).toEqual([3])
    // the current page is kept inside the document
    expect(parsePages(undefined, 5, 'current', 9)).toEqual([4])
  })

  it('rejects pages that do not exist and text it cannot read', () => {
    const { parsePages } = common
    expect(codeOf(() => parsePages('0', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages('6', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages('2-9', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages('first', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages('1;2', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages('-3', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages(',', 5))).toBe('invalid_args')
    expect(codeOf(() => parsePages(3, 5))).toBe('invalid_args')
    expect(() => parsePages('2-9', 5)).toThrow(/Page 9 does not exist: the document has 5 pages/)
  })
})

describe('pageIndex', () => {
  it('turns a 1-based page number into an index', () => {
    expect(common.pageIndex(1, 3)).toBe(0)
    expect(common.pageIndex(3, 3)).toBe(2)
  })

  it('rejects anything but a page of the document', () => {
    const { pageIndex } = common
    expect(codeOf(() => pageIndex(0, 3))).toBe('invalid_args')
    expect(codeOf(() => pageIndex(4, 3))).toBe('invalid_args')
    expect(codeOf(() => pageIndex(1.5, 3))).toBe('invalid_args')
    expect(codeOf(() => pageIndex('2', 3))).toBe('invalid_args')
    expect(codeOf(() => pageIndex(undefined, 3))).toBe('invalid_args')
    expect(() => pageIndex(7, 3, 'before')).toThrow(/^before 7 does not exist/)
  })
})

describe('rectArg', () => {
  it('normalises the corners so x0 <= x1 and y0 <= y1', () => {
    expect(common.rectArg([10, 20, 30, 40])).toEqual([10, 20, 30, 40])
    expect(common.rectArg([30, 40, 10, 20])).toEqual([10, 20, 30, 40])
    expect(common.rectArg([30, 20, 10, 40])).toEqual([10, 20, 30, 40])
  })

  it('rejects anything but four finite numbers', () => {
    const { rectArg } = common
    expect(codeOf(() => rectArg([1, 2, 3]))).toBe('invalid_args')
    expect(codeOf(() => rectArg([1, 2, 3, 4, 5]))).toBe('invalid_args')
    expect(codeOf(() => rectArg([1, 2, '3', 4]))).toBe('invalid_args')
    expect(codeOf(() => rectArg([1, 2, NaN, 4]))).toBe('invalid_args')
    expect(codeOf(() => rectArg([1, 2, Infinity, 4]))).toBe('invalid_args')
    expect(codeOf(() => rectArg({ x: 1 }))).toBe('invalid_args')
    expect(() => rectArg(null, 'region')).toThrow(/^region must be/)
  })
})

describe('handles', () => {
  it('parses window and document ids, and whether the handle is from this load of the window', () => {
    const { BOOT, parseHandle } = common
    expect(BOOT).toMatch(/^[a-z0-9]+$/)
    expect(parseHandle(`w3-${BOOT}-doc-12`)).toEqual({ windowId: 'w3', docId: 'doc-12', current: true })
    expect(parseHandle(`w10-${BOOT}-doc-1`)).toEqual({ windowId: 'w10', docId: 'doc-1', current: true })
    // Before a reload or a restart the same window and document numbers named other documents.
    const earlier = BOOT === 'zz9' ? 'zz8' : 'zz9'
    expect(parseHandle(`w3-${earlier}-doc-12`)).toEqual({ windowId: 'w3', docId: 'doc-12', current: false })
  })

  it('rejects anything else', () => {
    const { parseHandle } = common
    for (const h of ['', 'doc-1', 'w3', 'w3-doc-1', 'w3-b-doc-', 'w3-b-doc-x', 'x3-b-doc-1', 'w3-b-doc-1-extra', ' w3-b-doc-1', 'w-b-doc-1', 'w3--doc-1', 'w3-B-doc-1'])
      expect(parseHandle(h)).toBeNull()
  })

  it('makes handles that parse back', () => {
    const ctx = { request: { windowId: 'w7' } } as Parameters<typeof common.handleOf>[0]
    const handle = common.handleOf(ctx, { id: 'doc-4' } as Parameters<typeof common.handleOf>[1])
    expect(handle).toBe(`w7-${common.BOOT}-doc-4`)
    expect(common.parseHandle(handle)).toEqual({ windowId: 'w7', docId: 'doc-4', current: true })
  })
})

describe('small helpers', () => {
  it('rounds points to 0.01', () => {
    expect(common.round([1.234, 5.678, -0.005, 100])).toEqual([1.23, 5.68, -0, 100])
  })

  it('names Claude apps "Claude" and other apps as they report themselves', () => {
    const ctx = (name: string) => ({ request: { client: { name, version: '1' } } }) as Parameters<typeof common.clientLabel>[0]
    expect(common.clientLabel(ctx('claude-ai'))).toBe('Claude')
    expect(common.clientLabel(ctx('Claude Desktop'))).toBe('Claude')
    expect(common.clientLabel(ctx('my-agent'))).toBe('my-agent')
    expect(common.clientLabel(ctx(''))).toBe('An AI agent')
  })
})
