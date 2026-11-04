import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electronPath from 'electron'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Form scripts run in the app's renderer, on Electron's V8, which compiles some patterns very
// differently from the V8 in Node (which runs the other tests). These run the script interpreter
// on Electron's V8, as Node, with the flag the app gives the renderer (src/main/index.ts).

const root = resolve(__dirname, '../..')
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'inkmoor-regex-'))
  const entry = join(dir, 'entry.ts')
  writeFileSync(
    entry,
    `export { Interpreter } from ${JSON.stringify(join(root, 'src/features/forms-fill/js/interpreter'))}\n` +
      `export { FormRuntime } from ${JSON.stringify(join(root, 'src/features/forms-fill/js/runtime'))}\n`
  )
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(dir, 'interp.cjs'),
    logLevel: 'silent',
    alias: { '@engine': join(root, 'src/engine'), '@shared': join(root, 'src/shared') }
  })
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

interface Outcome {
  ms: number
  result?: unknown
  error?: string
}

/**
 * Runs each script in a fresh interpreter (or, with `doc`, as a document-level script as the
 * document opens) on Electron's V8. Fails the test if the whole run takes longer than `timeout`.
 */
function runInElectron(scripts: { src: string; doc?: boolean }[], timeout = 20000): Outcome[] {
  const runner = join(dir, 'run.cjs')
  writeFileSync(
    runner,
    `const { Interpreter, FormRuntime } = require('./interp.cjs')
const scripts = JSON.parse(process.argv[2])
for (const { src, doc } of scripts) {
  const start = performance.now()
  const out = {}
  try {
    if (doc) {
      const rt = new FormRuntime({ fields: [], values: {}, calcOrder: [], docScripts: [src] })
      out.error = rt.problems.map((p) => p.message).join('; ') || undefined
    } else out.result = new Interpreter({}).run(src)
  } catch (e) {
    out.error = e.message
  }
  out.ms = performance.now() - start
  process.stdout.write(JSON.stringify(out) + '\\n')
}
`
  )
  const r = spawnSync(electronPath as unknown as string, ['--enable-experimental-regexp-engine', runner, JSON.stringify(scripts)], {
    cwd: dir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout
  })
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  expect(r.error?.message ?? r.stderr, `stopped after ${lines.length} of ${scripts.length} scripts`).toBeFalsy()
  expect(lines).toHaveLength(scripts.length)
  return lines.map((l) => JSON.parse(l) as Outcome)
}

describe("form scripts' regular expressions on Electron's V8", () => {
  it('refuses patterns that take long to compile, before compiling them', () => {
    // V8 compiles a word boundary with the u flag (when case is ignored), and ^ and $ in
    // multiline mode, as a hidden choice; a chain of empty alternations around them takes
    // seconds to minutes to compile (about 3x longer per group).
    const chain = (unit: string, n: number) => `(?:${unit}|)`.repeat(n) + 'x'
    const attacks = [
      `/${chain('\\b', 14)}/iu.test("")`,
      `/${chain('\\b', 18)}/iu.test("")`,
      `/${chain('\\B', 18)}/iu.test("y")`,
      `/${chain('(?i:\\b)', 16)}/u.test("")`,
      `new RegExp(${JSON.stringify(chain('\\b', 18))}, "iu").test("")`,
      `/${chain('$', 18)}/imsu.test("")`,
      `/${chain('(?m:$)', 18)}/iu.test("")`,
      `/${chain('(?m:$)|(?m:$)(?m:$)', 13)}/iu.test("")`
    ]
    const scripts = [...attacks.map((src) => ({ src })), { src: attacks[1], doc: true }]
    const outcomes = runInElectron(scripts)
    outcomes.forEach((o, i) => {
      expect(o.ms, scripts[i].src).toBeLessThan(500)
      expect(o.error, scripts[i].src).toMatch(/took too long/)
    })
  })

  it('still runs the same constructs in reasonable patterns', () => {
    const outcomes = runInElectron([
      { src: String.raw`/\bfoo\b/iu.test("a FOO b")` },
      { src: String.raw`/^b$/m.test("a\nb")` },
      { src: String.raw`/(?m:^b$)/iu.test("a\nB")` },
      { src: String.raw`/^${'(?:\\b|)'.repeat(6)}x$/iu.test("x")` },
      { src: String.raw`"one two".replace(/\b\w/gu, function (c) { return c.toUpperCase() })` }
    ])
    expect(outcomes.map((o) => o.error)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(outcomes.map((o) => o.result)).toEqual([true, true, true, true, 'One Two'])
    for (const o of outcomes) expect(o.ms).toBeLessThan(500)
  })
})
