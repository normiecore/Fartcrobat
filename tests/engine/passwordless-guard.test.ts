// MuPDF holds a certificate-encrypted document through a temporary Standard security dictionary
// (or as plaintext), so anything that saves a document with saveToBuffer() could write that
// dictionary, its one-time passwords or the plaintext to disk. Every saveToBuffer( call in src/
// must be in a file that is known to route certificate-encrypted documents through the PubSec
// writer, or that only saves a document it built itself from a new PDFDocument.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const SRC = join(ROOT, 'src')

/** File (or folder ending in /) -> why its saveToBuffer( calls are safe. */
const ALLOWED: Record<string, string> = {
  'src/engine/ops/doc.ts': 'saveDocument: certificate-encrypted sessions go through the PubSec writer',
  'src/engine/crypt/': 'the PubSec writer itself: decrypted copies that are encrypted before they leave',
  'src/engine/util/protection.ts': 'outputs that keep the source protection (the engine outputs builder routes certificate sessions)',
  'src/features/protect-optimize/optimize.ts': 'Optimize (the engine outputs builder routes certificate sessions)',
  'src/features/digital-signatures/worker/sign.ts': 'signing, which is refused for certificate-encrypted documents',
  'src/engine/ops/pages.ts': 'extractToBytes saves a new PDFDocument it filled with grafted pages (protectBytes adds the protection)',
  'src/features/export-create/engine.ts': 'build saves a new PDFDocument made from the parts',
  'src/features/compare/report.ts': 'saves the compare report it built in a new PDFDocument',
  'src/features/comments/summary.ts': 'saves the comment summary it drew with a DocumentWriter'
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
  }
  return out
}

/** Lines that call saveToBuffer( (comments do not count). */
function callers(path: string): number[] {
  const lines = readFileSync(path, 'utf8').split('\n')
  const found: number[] = []
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').trim()
    if (code.startsWith('*') || code.startsWith('/*')) return
    if (/\bsaveToBuffer\s*\(/.test(code)) found.push(i + 1)
  })
  return found
}

const allowed = (rel: string) => Object.keys(ALLOWED).some((k) => (k.endsWith('/') ? rel.startsWith(k) : rel === k))

describe('saveToBuffer guard', () => {
  it('no saveToBuffer( call outside the allow-list', () => {
    const offenders: string[] = []
    for (const path of sourceFiles(SRC)) {
      const rel = relative(ROOT, path).split('\\').join('/')
      if (allowed(rel)) continue
      for (const line of callers(path)) offenders.push(`${rel}:${line}`)
    }
    expect(
      offenders,
      'A new saveToBuffer( call could write a certificate-encrypted document with its temporary security ' +
        'dictionary or in clear. Save through saveDocument (src/engine/ops/doc.ts) or the PubSec writer ' +
        '(src/engine/crypt/), or add the file to ALLOWED with the reason it is safe.'
    ).toEqual([])
  })

  it('finds calls and ignores comments', () => {
    expect(callers(join(SRC, 'features/compare/report.ts')).length).toBeGreaterThan(0)
    // index.ts mentions saveToBuffer() in its doc comment only.
    expect(readFileSync(join(SRC, 'engine/crypt/index.ts'), 'utf8')).toContain('saveToBuffer(')
    expect(callers(join(SRC, 'engine/crypt/index.ts'))).toEqual([])
  })
})
