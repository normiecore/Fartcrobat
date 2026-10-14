/**
 * What the main-process bundle may import. electron-vite builds main as an ES module and defines
 * __dirname there with a shim that it inserts after the last `import ... from '...'` it finds by
 * text. @noble/hashes and @noble/ciphers have such lines in their doc comments, so bundling them
 * into main puts the shim inside a comment, __dirname is undefined and the app does not start. The
 * engine worker and the renderer are built differently and may use them.
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

/** Every package the main process imports, with a file that imports it. */
function mainPackages(): Map<string, string> {
  const seen = new Set<string>()
  const packages = new Map<string, string>()
  const queue = entries()
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2]
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
    const packages = mainPackages()
    expect(packages.size).toBeGreaterThan(5) // the walk found the main process's imports
    const noble = [...packages].filter(([spec]) => spec.startsWith('@noble/'))
    expect(noble).toEqual([])
  })
})
