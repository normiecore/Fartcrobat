/**
 * What the main-process bundle may import.
 *
 * - No @noble/*. electron-vite builds main as an ES module and defines __dirname there with a shim
 *   that it inserts after the last `import ... from '...'` it finds by text. @noble/hashes and
 *   @noble/ciphers have such lines in their doc comments, so bundling them into main puts the shim
 *   inside a comment, __dirname is undefined and the app does not start. The engine worker and the
 *   renderer are built differently and may use them.
 * - node-forge only through import(): rollup runs a CommonJS package's whole body when the chunk
 *   that holds it loads, and node-forge takes tens of milliseconds, which every app start would pay
 *   before the first window. Only a Digital ID decrypt needs it (src/main/certkeys/digitalIdSource.ts),
 *   so it goes into a chunk of its own that loads then.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const ALIASES: Record<string, string> = {
  '@shared/': 'src/shared/',
  '@engine/': 'src/engine/',
  '@features/': 'src/features/',
  '@renderer/': 'src/renderer/src/',
  '@main/': 'src/main/'
}

/** The main process's entry points: src/main/index.ts and every feature's main.ts. */
function entries(): string[] {
  const out = [join(ROOT, 'src/main/index.ts')]
  const features = join(ROOT, 'src/features')
  for (const name of readdirSync(features)) {
    const file = join(features, name, 'main.ts')
    if (existsSync(file)) out.push(file)
  }
  return out
}

function resolveSource(from: string, spec: string): string | null {
  let base: string | null = null
  if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else
    for (const [prefix, dir] of Object.entries(ALIASES))
      if (spec.startsWith(prefix)) base = join(ROOT, dir, spec.slice(prefix.length))
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return null
}

interface ImportEdge {
  spec: string
  /** import('...'): loaded when that code runs, not when the module loads. */
  dynamic: boolean
}

/** The imports of a source file that stay in the built code (`import type` is erased). */
function importsOf(text: string): ImportEdge[] {
  const out: ImportEdge[] = []
  const re =
    /(?:^|\n)\s*(?:import|export)\s+(type\s)?[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of text.matchAll(re)) {
    if (m[1]) continue
    const spec = m[2] ?? m[3]
    if (spec) out.push({ spec, dynamic: false })
    else out.push({ spec: m[4], dynamic: true })
  }
  return out
}

/**
 * Every package the main process imports, with a file that imports it. With `startup`, only what
 * loads when the app starts: what the entry points import statically, not through import().
 */
function mainPackages({ startup }: { startup: boolean }): Map<string, string> {
  const seen = new Set<string>()
  const packages = new Map<string, string>()
  const queue = entries()
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const { spec, dynamic } of importsOf(readFileSync(file, 'utf8'))) {
      if (startup && dynamic) continue
      const local = resolveSource(file, spec)
      if (local) queue.push(local)
      else if (!spec.startsWith('.') && !Object.keys(ALIASES).some((p) => spec.startsWith(p)))
        if (!packages.has(spec)) packages.set(spec, relative(ROOT, file))
    }
  }
  return packages
}

describe('main-process bundle', () => {
  it('does not import @noble/* (its doc comments break the ES module shim that defines __dirname)', () => {
    const packages = mainPackages({ startup: false })
    expect(packages.size).toBeGreaterThan(5) // the walk found the main process's imports
    const noble = [...packages].filter(([spec]) => spec.startsWith('@noble/'))
    expect(noble).toEqual([])
  })

  it('loads node-forge only when a Digital ID decrypts (import()), never at app start', () => {
    // Still reachable: Digital IDs open certificate-encrypted files with it.
    expect(mainPackages({ startup: false }).has('node-forge')).toBe(true)
    const atStart = mainPackages({ startup: true })
    expect(atStart.size).toBeGreaterThan(5)
    const forge = [...atStart].filter(([spec]) => spec === 'node-forge' || spec.startsWith('node-forge/'))
    expect(forge).toEqual([])
  })

  it('tells static imports from import() and erased type imports', () => {
    const text = [
      "import a from 'pkg-a'",
      "import type { B } from 'pkg-b'",
      "export type { C } from 'pkg-c'",
      "export { d } from 'pkg-d'",
      "import 'pkg-e'",
      "type F = typeof import('pkg-f')",
      "const g = await import('pkg-g')"
    ].join('\n')
    expect(importsOf(text)).toEqual([
      { spec: 'pkg-a', dynamic: false },
      { spec: 'pkg-d', dynamic: false },
      { spec: 'pkg-e', dynamic: false },
      { spec: 'pkg-f', dynamic: true },
      { spec: 'pkg-g', dynamic: true }
    ])
  })
})
