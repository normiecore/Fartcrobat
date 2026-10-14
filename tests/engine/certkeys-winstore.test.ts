// The Windows certificate store helper (src/main/certkeys/winCertStore.ts, winStoreScripts.ts,
// windowsStoreSource.ts): the PowerShell 5.1 rules for the script text, the long-lived process (one
// per app session, one request at a time), error mapping, and, when a PowerShell is available, the
// real helper against a test certificate store.
//
// PowerShell: $PWSH, else /usr/local/bin/pwsh or /usr/bin/pwsh (pwsh 7 on Linux, with HOME set to a
// temporary folder so .NET uses a private certificate store), or the stock Windows PowerShell 5.1 on
// Windows. Without one that runs `exit 0`, those blocks are skipped. On Windows the store tests import
// the test certificates into the real CurrentUser\My and AddressBook (and remove them afterwards), so
// they only run on CI or with FARTCROBAT_WINSTORE_TESTS=1.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CertKeyError } from '@main/certkeys/source'
import {
  PowerShellHelper,
  POWERSHELL_ARGS,
  WinStoreError,
  decryptRecipients,
  defaultPowerShellPath,
  listEncryptionCertificates,
  probeRecipients,
  type HelperOptions
} from '@main/certkeys/winCertStore'
import {
  DECRYPT_BODY,
  LIST_BODY,
  PRELUDE,
  buildScript,
  endMarker,
  literal
} from '@main/certkeys/winStoreScripts'
import { createWindowsStore, testPowerShellOptions, toCertKeyError } from '@main/certkeys/windowsStoreSource'

const IS_WIN = process.platform === 'win32'

/** A PowerShell that starts and exits 0, or null. */
function findPowerShell(): string | null {
  const candidates = IS_WIN
    ? [process.env.PWSH, defaultPowerShellPath()]
    : [process.env.PWSH, '/usr/local/bin/pwsh', '/usr/bin/pwsh']
  for (const exe of candidates) {
    if (!exe || !existsSync(exe)) continue
    const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      timeout: 60_000,
      windowsHide: true
    })
    if (r.status === 0) return exe
  }
  return null
}

const PS = findPowerShell()
// Off Windows, HOME decides where .NET keeps CurrentUser stores: a temporary one keeps the person's own
// store (and pwsh's caches) out of the tests.
const HOME = !IS_WIN && PS ? mkdtempSync(join(tmpdir(), 'fc-winstore-home-')) : null
const helperOpts: HelperOptions =
  IS_WIN && !process.env.PWSH
    ? {}
    : PS
      ? { powershellPath: PS, env: { ...process.env, HOME: HOME ?? undefined } }
      : {}

afterAll(async () => {
  if (!HOME) return
  // A helper that was just stopped may still be writing pwsh's caches there as it exits.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(HOME, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 50) throw err
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}, 30_000)

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'resolved'
  } catch (e) {
    if (e instanceof WinStoreError || e instanceof CertKeyError) return e.code
    throw e
  }
}

describe('script text', () => {
  const sources = { PRELUDE, DECRYPT_BODY, LIST_BODY, endMarker: endMarker(1) }

  it('is ASCII, has no backtick or dollar-brace, so it embeds in template literals and survives any code page', () => {
    for (const [name, s] of Object.entries(sources)) {
      // eslint-disable-next-line no-control-regex
      expect(s, name).not.toMatch(/[^\x09\x0a\x0d\x20-\x7e]/)
      expect(s.includes('`'), name).toBe(false)
      expect(s.includes('${'), name).toBe(false)
    }
  })

  it('avoids PowerShell 6+/7 syntax and .NET Core-only APIs (stand-in for PSScriptAnalyzer)', () => {
    const banned = [
      /\?\?/,
      /\?\./,
      /&&/,
      /\|\|/,
      /-Parallel\b/,
      /-AsArray\b/,
      /-AsHashtable\b/,
      /-Stable\b/,
      /-EscapeHandling\b/,
      /\bGet-Error\b/,
      /\$PSStyle\b/,
      /\$IsWindows\b/,
      /HashData\b/,
      /ToHexString\b/,
      /ExportSubjectPublicKeyInfo/,
      /RSAEncryptionPadding/,
      /Cert:\\/,
      /::new\(/,
      /\bclean\s*\{/,
      /ConvertTo-Json|ConvertFrom-Json/,
      // a ternary: `$a ? $b : $c`
      /\$\w+\s+\?\s/
    ]
    for (const [name, s] of Object.entries(sources))
      for (const re of banned) expect(s, `${name} ${re}`).not.toMatch(re)
  })

  it('stays small (bytes before data)', () => {
    const size = buildScript(DECRYPT_BODY, { Blobs: [], Mode: 'probe', Thumbprint: '' }, 1).length
    expect(size).toBeLessThan(14_000)
  })

  it('is one script block that ends with an empty line, with no empty or comment lines inside', () => {
    const s = buildScript(LIST_BODY, { IncludeOthers: true }, 42)
    expect(s.startsWith('& {\n$FcId = 42\n')).toBe(true)
    expect(s.endsWith('\n}\n\n')).toBe(true)
    const inner = s.slice(0, -2).split('\n')
    expect(inner.filter((l) => l.trim() === '')).toEqual([])
    expect(inner.filter((l) => l.trim().startsWith('#'))).toEqual([])
    expect(s).toContain('$IncludeOthers = $true')
    // one line (it runs as soon as it is read), ASCII, then the empty line
    const end = endMarker(42)
    expect(end.endsWith('\n\n')).toBe(true)
    expect(end.trimEnd().includes('\n')).toBe(false)
    expect(end).toContain("[Console]::Out.WriteLine('FCEND:42')")
    expect(end).toContain("Write-Output 'FCEND:42'")
    expect(() => endMarker(-1)).toThrow()
  })

  it('only takes literal values from a safe alphabet, and safe names and ids', () => {
    expect(() => buildScript(LIST_BODY, { X: "a'; Remove-Item x; '" }, 1)).toThrow()
    expect(() => buildScript(LIST_BODY, { X: ['ok', '$(evil)'] }, 1)).toThrow()
    expect(() => buildScript(LIST_BODY, { 'X; evil': 'a' }, 1)).toThrow()
    expect(() => buildScript(LIST_BODY, { FcId: 'QUJD' }, 1)).toThrow()
    expect(() => buildScript(LIST_BODY, {}, -1)).toThrow()
    expect(() => buildScript(LIST_BODY, {}, 1.5)).toThrow()
    expect(() => literal('a b')).toThrow()
    expect(() => literal('é')).toThrow()
    expect(buildScript(DECRYPT_BODY, { Blobs: ['QUJD', 'REVG'], Mode: 'probe' }, 1)).toMatch(
      /\$Blobs = @\(\n'QUJD'\n'REVG'\n\)/
    )
  })

  it('splits long values over lines of at most about 1000 characters', () => {
    const big = Buffer.alloc(40_000, 7).toString('base64')
    const s = buildScript(DECRYPT_BODY, { Blobs: [big, 'QUJD'], Mode: 'decrypt', Thumbprint: '' }, 3)
    for (const line of s.split('\n')) expect(line.length).toBeLessThanOrEqual(1010)
    const lit = literal(big)
    expect(lit.startsWith("('")).toBe(true)
    expect(lit.replace(/[()'+\s]/g, '')).toBe(big)
  })
})

describe('error mapping', () => {
  it('turns helper codes into the codes the renderer knows, with plain messages', () => {
    const cases: Array<[WinStoreError, string]> = [
      [new WinStoreError('KEY_ACCESS_DENIED', 'x', { hresult: '0x80090010' }), 'KEY_UNAVAILABLE'],
      [new WinStoreError('UI_REQUIRED', 'x', { hresult: '0x80090022' }), 'KEY_UNAVAILABLE'],
      [new WinStoreError('DECRYPT_FAILED', 'x', { hresult: '0x80090005' }), 'ERROR'],
      [new WinStoreError('HELPER_FAILED', 'x'), 'ERROR'],
      [new WinStoreError('BAD_INPUT', 'x'), 'ERROR'],
      [new WinStoreError('NOT_WINDOWS', 'x'), 'ERROR'],
      [new WinStoreError('ABORTED', 'x'), 'CANCELLED'],
      [new WinStoreError('CANCELLED', 'x', { hresult: '0x8010006E' }), 'CANCELLED'],
      [new WinStoreError('WRONG_PIN', 'x'), 'WRONG_PIN'],
      [new WinStoreError('PIN_BLOCKED', 'x'), 'PIN_BLOCKED'],
      [new WinStoreError('CARD_NOT_PRESENT', 'x'), 'CARD_NOT_PRESENT'],
      [new WinStoreError('NO_MATCHING_CERT', 'x'), 'NO_MATCHING_CERT'],
      [new WinStoreError('UNSUPPORTED', 'x'), 'UNSUPPORTED'],
      [new WinStoreError('CONSTRAINED_LANGUAGE', 'x'), 'CONSTRAINED_LANGUAGE'],
      [
        new WinStoreError('POWERSHELL_UNAVAILABLE', 'x', { path: 'C:\\Windows\\x.exe' }),
        'POWERSHELL_UNAVAILABLE'
      ],
      [new WinStoreError('TIMEOUT', 'x'), 'TIMEOUT'],
      [new WinStoreError('ERROR', 'Access to C:\\Users\\me\\key denied', { hresult: '0x80004005' }), 'ERROR']
    ]
    for (const [err, want] of cases) {
      const mapped = toCertKeyError(err)
      expect(mapped, err.code).toBeInstanceOf(CertKeyError)
      expect(mapped.code, err.code).toBe(want)
      expect(mapped.message, err.code).not.toMatch(/[\\/]|\bx\b/)
      expect(mapped.message.length, err.code).toBeGreaterThan(5)
    }
    // the HRESULT helps people report problems with keys (it is not a secret)
    expect(toCertKeyError(cases[0][0]).message).toContain('(Windows error 0x80090010)')
    expect(toCertKeyError(new WinStoreError('ERROR', 'x', { hresult: 'not hex' })).message).not.toContain(
      'Windows error'
    )
    expect(toCertKeyError(new WinStoreError('WRONG_PIN', 'x', { hresult: '0x8010006B' })).message).toBe(
      'The smart card PIN was wrong.'
    )
    expect(toCertKeyError(new Error('boom')).code).toBe('ERROR')
  })

  it('takes test PowerShell options from the environment of unpackaged builds only', () => {
    const env = {
      FARTCROBAT_TEST_POWERSHELL: '/usr/bin/pwsh',
      FARTCROBAT_TEST_POWERSHELL_HOME: '/tmp/x',
      PATH: '/bin'
    }
    expect(testPowerShellOptions(env, true)).toEqual({})
    expect(testPowerShellOptions({ PATH: '/bin' }, false)).toEqual({})
    const o = testPowerShellOptions(env, false)
    expect(o.powershellPath).toBe('/usr/bin/pwsh')
    expect(o.env?.HOME).toBe('/tmp/x')
    expect(o.env?.PATH).toBe('/bin')
    expect(
      testPowerShellOptions({ FARTCROBAT_TEST_POWERSHELL: '/usr/bin/pwsh' }, false).env?.HOME
    ).toBeUndefined()
  })
})

describe('outside Windows', () => {
  it('refuses without an explicit PowerShell path', async () => {
    const helper = new PowerShellHelper({ platform: 'linux' })
    expect(helper.supported).toBe(false)
    expect(await code(helper.run(LIST_BODY, { IncludeOthers: false }, { timeoutMs: 1000 }))).toBe(
      'NOT_WINDOWS'
    )
    const store = createWindowsStore({ platform: 'darwin', enabled: () => true })
    expect(await store.state()).toBe('not-windows')
    expect(await store.probe([new Uint8Array([0x30, 0])])).toEqual([])
    expect(await store.listEncryptionCertificates({ includeOthers: true })).toEqual([])
    expect(store.running()).toBe(false)
    const candidate = { id: 'windows-store:' + 'A'.repeat(40) } as never
    expect(await code(store.decrypt([new Uint8Array([0x30, 0])], candidate, { actor: 'person' }))).toBe(
      'ERROR'
    )
  })

  it('reports a missing PowerShell, and tries again after stop()', async () => {
    const missing = IS_WIN ? 'C:\\nonexistent\\powershell.exe' : '/nonexistent/powershell.exe'
    const helper = new PowerShellHelper({ powershellPath: missing })
    expect(await code(helper.run(LIST_BODY, { IncludeOthers: false }, { timeoutMs: 10_000 }))).toBe(
      'POWERSHELL_UNAVAILABLE'
    )
    expect(helper.blocked).toBe('unavailable')
    expect(helper.running()).toBe(false)
    // fails at once without trying to start PowerShell again
    expect(await code(helper.run(LIST_BODY, { IncludeOthers: false }, { timeoutMs: 10_000 }))).toBe(
      'POWERSHELL_UNAVAILABLE'
    )
    helper.stop()
    expect(helper.blocked).toBe(null)

    const store = createWindowsStore({ platform: 'win32', enabled: () => true, powershellPath: missing })
    expect(await store.state()).toBe('available')
    expect(await store.probe([new Uint8Array([0x30, 0])])).toEqual([])
    expect(await store.state()).toBe('unavailable')
    expect(await code(store.listEncryptionCertificates({ includeOthers: false }))).toBe(
      'POWERSHELL_UNAVAILABLE'
    )
    store.stop()
    expect(await store.state()).toBe('available')
  })

  it('is off when the preference is off', async () => {
    let on = false
    const store = createWindowsStore({
      platform: 'win32',
      enabled: () => on,
      powershellPath: '/nonexistent/powershell.exe'
    })
    expect(await store.state()).toBe('off')
    expect(await store.probe([new Uint8Array([0x30, 0])])).toEqual([])
    expect(await store.listEncryptionCertificates({ includeOthers: false })).toEqual([])
    const candidate = { id: 'windows-store:' + 'A'.repeat(40) } as never
    expect(await code(store.decrypt([new Uint8Array([0x30, 0])], candidate, { actor: 'agent' }))).toBe(
      'KEY_UNAVAILABLE'
    )
    on = true
    expect(await store.state()).toBe('available')
  })
})

describe.skipIf(!PS)('the long-lived helper', () => {
  let helper: PowerShellHelper
  beforeAll(() => {
    helper = new PowerShellHelper(helperOpts)
  })
  afterEach(() => helper.stop())

  const pidOf = async (): Promise<number> => {
    const r = await helper.run(
      'Write-FcResult ([ordered]@{ ok = $true; pid = $PID })',
      {},
      { timeoutMs: 60_000 }
    )
    expect(r.ok).toBe(true)
    return r.pid as number
  }

  it('is started as the stock Windows PowerShell with fixed arguments', () => {
    expect(POWERSHELL_ARGS).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'])
    expect(defaultPowerShellPath({ SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    expect(defaultPowerShellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('serves several requests from one process, one at a time', async () => {
    expect(helper.running()).toBe(false)
    const first = await pidOf()
    expect(helper.running()).toBe(true)
    expect(helper.pid).toBe(first)
    // queued while one runs: each gets its own answer, in order
    const order: number[] = []
    const answers = await Promise.all(
      [1, 2, 3].map((n) =>
        helper
          .run(
            `Start-Sleep -Milliseconds 200; Write-FcResult ([ordered]@{ ok = $true; n = ${n}; pid = $PID })`,
            {},
            { timeoutMs: 60_000 }
          )
          .then((r) => {
            order.push(r.n as number)
            return r
          })
      )
    )
    expect(answers.map((r) => r.n)).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
    for (const r of answers) expect(r.pid).toBe(first)
    // variables of one request do not reach the next
    await helper.run('$Leak = 5; Write-FcResult ([ordered]@{ ok = $true })', {}, { timeoutMs: 60_000 })
    const r = await helper.run(
      'Write-FcResult ([ordered]@{ ok = $true; leak = $Leak })',
      {},
      { timeoutMs: 60_000 }
    )
    expect(r.leak).toBe(null)
  })

  it('starts a new process after stop()', async () => {
    const first = await pidOf()
    helper.stop()
    expect(helper.running()).toBe(false)
    const second = await pidOf()
    expect(second).not.toBe(first)
  })

  it('kills the process on a timeout; the next request starts a new one', async () => {
    const first = await pidOf()
    expect(await code(helper.run('Start-Sleep -Seconds 30', {}, { timeoutMs: 1500 }))).toBe('TIMEOUT')
    expect(helper.running()).toBe(false)
    const second = await pidOf()
    expect(second).not.toBe(first)
  })

  it('can be cancelled, also while waiting in the queue', async () => {
    const first = await pidOf()
    const ac = new AbortController()
    const slow = helper.run('Start-Sleep -Seconds 30', {}, { timeoutMs: 60_000, signal: ac.signal })
    const queued = helper.run(
      'Write-FcResult ([ordered]@{ ok = $true; pid = $PID })',
      {},
      { timeoutMs: 60_000 }
    )
    const before = new AbortController()
    before.abort()
    const alreadyCancelled = helper.run(
      'Write-FcResult ([ordered]@{ ok = $true })',
      {},
      { timeoutMs: 60_000, signal: before.signal }
    )
    setTimeout(() => ac.abort(), 500)
    expect(await code(slow)).toBe('ABORTED')
    // the request after it runs in a new process
    const r = await queued
    expect(r.pid).not.toBe(first)
    expect(await code(alreadyCancelled)).toBe('ABORTED')
  })

  it('fails a request waiting in the process when stop() is called', async () => {
    await pidOf()
    const slow = helper.run('Start-Sleep -Seconds 30', {}, { timeoutMs: 60_000 })
    setTimeout(() => helper.stop(), 500)
    expect(await code(slow)).toBe('ABORTED')
    expect(helper.running()).toBe(false)
  })

  it('turns an unexpected failure inside a body into a structured answer', async () => {
    const r = await helper.run("throw 'unexpected'", {}, { timeoutMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERROR')
    expect(r.message).toBe('unexpected')
  })

  it('fails at once (not after the timeout) when a block prints no answer, and keeps the process', async () => {
    const first = await pidOf()
    const t0 = Date.now()
    expect(await code(helper.run("[Console]::Error.WriteLine('boom')", {}, { timeoutMs: 50_000 }))).toBe(
      'HELPER_FAILED'
    )
    expect(Date.now() - t0).toBeLessThan(20_000)
    // a block that does not even parse
    expect(
      await code(helper.runScript(() => "& {\n[Console]::Out.WriteLine('x' +\n}\n\n", { timeoutMs: 50_000 }))
    ).toBe('HELPER_FAILED')
    expect(await pidOf()).toBe(first)
  })

  it('ignores stray output, and answers meant for other requests', async () => {
    const r = await helper.run(
      "Write-Output 'noise'; [Console]::Out.WriteLine('FCJSON:999999:{\"ok\":false}'); [Console]::Out.WriteLine('FCEND:999999'); [Console]::Out.WriteLine('PS> FCJSON'); Write-FcResult ([ordered]@{ ok = $true; v = 'kept' })",
      {},
      { timeoutMs: 60_000 }
    )
    expect(r).toEqual({ ok: true, v: 'kept' })
  })

  it('carries non-ASCII text through the ASCII-only JSON writer', async () => {
    const r = await helper.run(
      "Write-FcResult ([ordered]@{ ok = $true; s = ('Store Test Me ' + [char]0xE9 + [char]0xE8 + ' ' + [char]0xD83D + [char]0xDD11 + ' \"q\" \\ ' + [char]9); n = 7; b = $false; a = @(1, 'x') })",
      {},
      { timeoutMs: 60_000 }
    )
    expect(r).toEqual({ ok: true, s: 'Store Test Me éè \u{1F511} "q" \\ \t', n: 7, b: false, a: [1, 'x'] })
  })

  it('fails the request when the process dies, then starts a new one', async () => {
    const first = await pidOf()
    expect(await code(helper.run('[Environment]::Exit(3)', {}, { timeoutMs: 60_000 }))).toBe('HELPER_FAILED')
    expect(helper.running()).toBe(false)
    expect(await pidOf()).not.toBe(first)
  })

  it('detects Constrained Language Mode before doing anything, and refuses until stop()', async () => {
    const r = await helper.runScript(
      (id) =>
        buildScript(LIST_BODY, { IncludeOthers: false }, id).replace(
          '& {\n',
          "& {\n$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n"
        ),
      { timeoutMs: 60_000 }
    )
    expect(r).toEqual({ ok: false, code: 'CONSTRAINED_LANGUAGE', languageMode: 'ConstrainedLanguage' })
    expect(helper.blocked).toBe('constrained')
    expect(helper.running()).toBe(false)
    expect(
      await code(helper.run('Write-FcResult ([ordered]@{ ok = $true })', {}, { timeoutMs: 60_000 }))
    ).toBe('CONSTRAINED_LANGUAGE')
    helper.stop()
    expect(helper.blocked).toBe(null)
    expect(
      (await helper.run('Write-FcResult ([ordered]@{ ok = $true })', {}, { timeoutMs: 60_000 })).ok
    ).toBe(true)
  })

  // A PowerShell that is in Constrained Language Mode from the start, as under AppLocker or WDAC: a
  // wrapper that switches the mode before passing our stdin on (POSIX shells only).
  it.skipIf(IS_WIN)('reports Constrained Language Mode as the store state and on every call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-winstore-clm-'))
    const wrapper = join(dir, 'powershell')
    writeFileSync(
      wrapper,
      `#!/bin/sh\n{ printf '%s\\n\\n' "\\$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'"; cat; } | exec '${PS}' "$@"\n`,
      { mode: 0o755 }
    )
    const store = createWindowsStore({
      platform: 'win32',
      enabled: () => true,
      powershellPath: wrapper,
      env: helperOpts.env
    })
    try {
      expect(await store.state()).toBe('available')
      expect(await store.probe([new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])])).toEqual([])
      expect(await store.state()).toBe('constrained')
      expect(store.running()).toBe(false)
      const err = await store.listEncryptionCertificates({ includeOthers: false }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CertKeyError)
      expect((err as CertKeyError).code).toBe('CONSTRAINED_LANGUAGE')
      expect((err as CertKeyError).message).toContain('Constrained Language Mode')
      const candidate = { id: 'windows-store:' + 'A'.repeat(40) } as never
      expect(await code(store.decrypt([new Uint8Array([0x30, 0])], candidate, { actor: 'person' }))).toBe(
        'CONSTRAINED_LANGUAGE'
      )
      // "Lock smart card" or turning the switch off and on tries again (and finds it constrained again)
      store.stop()
      expect(await store.state()).toBe('available')
      await store.probe([new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])])
      expect(await store.state()).toBe('constrained')
    } finally {
      store.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- the helper against a test certificate store ----

const FIX = join(__dirname, '../fixtures/passwordless')
const PKI = join(FIX, 'pki/winstore')
const pki = (f: string): string => join(PKI, f)
const pem = (name: string): string => readFileSync(pki(`${name}.pem`), 'utf8')
const thumbOf = (name: string): string =>
  createHash('sha1')
    .update(readFileSync(pki(`${name}.cer`)))
    .digest('hex')
    .toUpperCase()
const SEED = new Uint8Array([...Array(20).keys()].map((i) => i * 7 + 1).concat([0xfc, 0xff, 0xff, 0xff]))
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

interface ExpectedFile {
  file: string
  recipients: Array<{
    envelope: number
    index: number | null
    cert: string
    keyEncryption: string
    damaged?: boolean
  }>
  opensWith: string[]
  permissions: Record<string, number>
  seedHex: Record<string, string>
}
const EXPECTED: ExpectedFile[] = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8')).files

/** Test-only: the /Recipients blobs of a fixture (each has one /Recipients array of hex strings). */
function recipientsOf(file: string): Uint8Array[] {
  const text = readFileSync(join(FIX, file)).toString('latin1')
  const m = /\/Recipients\s*\[([^\]]*)\]/.exec(text)
  if (!m || /\(/.test(m[1])) throw new Error(`no hex /Recipients in ${file}`)
  return [...m[1].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map(
    (h) => new Uint8Array(Buffer.from(h[1].replace(/\s+/g, ''), 'hex'))
  )
}

// node-forge CMS helpers (from the spike), to make envelopes the fixtures do not have.
const toBin = (b: Uint8Array): string => Buffer.from(b).toString('binary')
const fromBin = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'binary'))
type Asn1 = forge.asn1.Asn1
const kids = (node: Asn1): Asn1[] => node.value as Asn1[]

/** EnvelopedData, RSAES-PKCS1-v1_5 key transport and AES-256-CBC content, recipients in order. */
function forgeEnvelope(certPems: string[], content: Uint8Array): Uint8Array {
  const p7 = forge.pkcs7.createEnvelopedData()
  for (const p of certPems) p7.addRecipient(forge.pki.certificateFromPem(p))
  p7.content = forge.util.createBuffer(toBin(content))
  p7.encrypt(undefined, forge.pki.oids['aes256-CBC'])
  return fromBin(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

/**
 * Same, but each RecipientInfo carries the certificate's issuer Name exactly as encoded in the
 * certificate: node-forge rebuilds it and double-encodes non-ASCII UTF8String values.
 */
function forgeEnvelopeRawIssuer(certPems: string[], content: Uint8Array): Uint8Array {
  const p7 = forge.pkcs7.createEnvelopedData()
  const issuers: Asn1[] = []
  for (const p of certPems) {
    p7.addRecipient(forge.pki.certificateFromPem(p))
    const der = forge.pem.decode(p)[0].body
    const tbs = kids(forge.asn1.fromDer(der))[0]
    const fields = kids(tbs)
    const hasVersion = fields[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC
    issuers.push(fields[hasVersion ? 3 : 2])
  }
  p7.content = forge.util.createBuffer(toBin(content))
  p7.encrypt(undefined, forge.pki.oids['aes256-CBC'])
  const asn1 = p7.toAsn1()
  // ContentInfo -> [0] -> EnvelopedData -> recipientInfos SET -> KeyTransRecipientInfo -> issuerAndSerialNumber
  const recipientInfos = kids(kids(kids(kids(asn1)[1])[0])[1])
  recipientInfos.forEach((ri, i) => {
    kids(kids(ri)[1])[0] = issuers[i]
  })
  return fromBin(forge.asn1.toDer(asn1).getBytes())
}

const OPENSSL = spawnSync('openssl', ['version'], { timeout: 30_000, windowsHide: true }).status === 0

/** An ECDH (KeyAgreeRecipientInfo) envelope for a certificate, made with OpenSSL. */
function opensslEnvelope(certPem: string, content: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'fc-winstore-ossl-'))
  try {
    writeFileSync(join(dir, 'in.bin'), content)
    writeFileSync(join(dir, 'cert.pem'), certPem)
    const args = [
      'cms',
      '-encrypt',
      '-binary',
      '-aes256',
      '-outform',
      'DER',
      '-in',
      join(dir, 'in.bin'),
      '-out',
      join(dir, 'out.der')
    ]
    const r = spawnSync('openssl', [...args, '-recip', join(dir, 'cert.pem')], {
      timeout: 30_000,
      windowsHide: true
    })
    if (r.status !== 0) throw new Error(`openssl cms failed: ${r.stderr}`)
    return new Uint8Array(readFileSync(join(dir, 'out.der')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Windows PowerShell 5.1 (.NET Framework) cannot make some envelopes .NET 5+ can.
const IS_PS51 = IS_WIN && !process.env.PWSH
const STORE_TESTS =
  Boolean(PS) && (!IS_WIN || Boolean(process.env.CI) || process.env.FARTCROBAT_WINSTORE_TESTS === '1')

function runPs(args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...(helperOpts.env ?? process.env), TERM: 'dumb' }
  // as the helper does: PowerShell 7's module paths (CI shells are pwsh) break Windows PowerShell 5.1
  if (IS_PS51) delete env.PSModulePath
  const r = spawnSync(PS!, ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], {
    env,
    timeout: 120_000,
    windowsHide: true
  })
  if (r.status !== 0) throw new Error(`PowerShell failed (${r.status}): ${r.stderr}`)
  return r.stdout.toString()
}

const IMPORTED = ['recipient', 'me-enc', 'me-sign', 'me-noku', 'me-ec', 'me-expired', 'me-nokey', 'colleague']

/** Windows only: removes test certificates (and their keys) from CurrentUser\My and AddressBook. */
function removeFromStore(thumbprints: string[]): void {
  const list = thumbprints.map((t) => `'${t.replace(/[^0-9A-F]/g, '')}'`).join(', ')
  runPs([
    '-Command',
    [
      `$want = @(${list})`,
      "foreach ($name in 'My', 'AddressBook') {",
      "  $st = New-Object System.Security.Cryptography.X509Certificates.X509Store $name, 'CurrentUser'",
      "  $st.Open('ReadWrite')",
      '  foreach ($c in @($st.Certificates)) {',
      '    if ($want -notcontains $c.Thumbprint) { continue }',
      '    try {',
      '      $k = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)',
      '      if ($null -eq $k) { $k = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($c) }',
      "      if ($k -and $k.GetType().Name -like '*Cng') { $k.Key.Delete() }",
      '      elseif ($k -is [System.Security.Cryptography.RSACryptoServiceProvider]) { $k.PersistKeyInCsp = $false; $k.Clear() }',
      '    } catch { }',
      '    $st.Remove($c)',
      '  }',
      '  $st.Close()',
      '}'
    ].join('\n')
  ])
}

describe.skipIf(!STORE_TESTS)('with PowerShell and a test certificate store', () => {
  let helper: PowerShellHelper
  let store: ReturnType<typeof createWindowsStore>

  beforeAll(() => {
    // Off Windows this fills the private store under the temporary HOME.
    runPs(['-ExecutionPolicy', 'Bypass', '-File', join(FIX, 'winstore', 'import_store.ps1'), '-Pki', PKI])
    helper = new PowerShellHelper(helperOpts)
    store = createWindowsStore({ platform: 'win32', enabled: () => true, ...helperOpts })
  }, 180_000)

  afterAll(() => {
    helper?.stop()
    store?.stop()
    if (IS_WIN) removeFromStore(IMPORTED.map(thumbOf))
  }, 180_000)

  it('lists encryption certificates that have private keys, and Other People on request', async () => {
    const mine = await listEncryptionCertificates(helper, {})
    const byThumb = new Map(mine.map((c) => [c.thumbprint, c]))
    for (const name of ['recipient', 'me-enc', 'me-noku', 'me-ec', 'me-expired'])
      expect(byThumb.has(thumbOf(name)), name).toBe(true)
    for (const name of ['me-sign', 'me-nokey', 'colleague'])
      expect(byThumb.has(thumbOf(name)), name).toBe(false)
    expect(byThumb.get(thumbOf('me-noku'))!.encryptionUsage).toBe('unrestricted')
    expect(byThumb.get(thumbOf('me-noku'))!.subject).toContain('CN=Store Test Me (no key usage) éè \u{1F511}')
    expect(byThumb.get(thumbOf('me-ec'))!.encryptionUsage).toBe('keyAgreement')
    const enc = byThumb.get(thumbOf('me-enc'))!
    expect(enc.encryptionUsage).toBe('keyEncipherment')
    expect(enc.keyUsage).toBe(0x30)
    expect(enc.ekus).toEqual(['1.3.6.1.5.5.7.3.4'])
    expect(enc.email).toBe('me@example.test')
    expect(Buffer.from(enc.der)).toEqual(readFileSync(pki('me-enc.cer')))
    expect(Date.parse(byThumb.get(thumbOf('me-expired'))!.notAfter)).toBeLessThan(Date.now())

    // through the WindowsStore interface (Protect > Encrypt with Certificate)
    const all = await store.listEncryptionCertificates({ includeOthers: true })
    const colleague = all.find((c) => c.thumbprint === thumbOf('colleague'))!
    expect(colleague).toMatchObject({
      store: 'CurrentUser\\AddressBook',
      hasPrivateKey: false,
      email: 'colleague@example.test',
      keyType: 'rsa'
    })
    expect(all.find((c) => c.thumbprint === thumbOf('me-ec'))!.keyType).toBe('ec')
    const encCert = all.find((c) => c.thumbprint === thumbOf('me-enc'))!
    expect(encCert).toMatchObject({
      store: 'CurrentUser\\My',
      keyType: 'rsa',
      hasPrivateKey: true,
      email: 'me@example.test'
    })
    expect(encCert.serial).toMatch(/^[0-9A-F]+$/)
    expect(Buffer.from(encCert.der)).toEqual(readFileSync(pki('me-enc.cer')))
    const own = await store.listEncryptionCertificates({ includeOthers: false })
    expect(own.some((c) => c.thumbprint === thumbOf('colleague'))).toBe(false)
  })

  // Every fixture alice can open: the store holds alice's certificate and key as "recipient".
  const aliceFiles = EXPECTED.filter((f) => f.opensWith.includes('alice'))
  it.each(aliceFiles.map((f) => [f.file, f] as const))(
    'opens %s: probe, then decrypt to the expected seed',
    async (_name, f) => {
      const blobs = recipientsOf(f.file)
      const mine = f.recipients.find((r) => r.cert === 'alice' && !r.damaged)!
      const candidates = await store.probe(blobs)
      expect(candidates.length).toBe(1)
      const c = candidates[0]
      expect(c).toMatchObject({
        id: 'windows-store:' + thumbOf('recipient'),
        source: 'windows-store',
        label: 'Alice Test',
        fingerprint: thumbOf('recipient'),
        envelope: mine.envelope,
        index: mine.index,
        keyType: 'rsa',
        needs: 'nothing'
      })
      expect(c.subject).toContain('CN=Alice Test')
      expect(c.issuer).toContain('CN=Fartcrobat Test CA')
      expect(c.expired).toBeUndefined()

      const oaep = mine.keyEncryption === '1.2.840.113549.1.1.7'
      let r
      try {
        r = await store.decrypt(blobs, c, { actor: 'agent' })
      } catch (err) {
        // .NET Framework's EnvelopedCms may not know OAEP with SHA-256; the Windows job records it.
        if (IS_PS51 && oaep) {
          console.info(
            `OAEP-SHA256 decrypt on Windows PowerShell 5.1: ${(err as CertKeyError).code} ${(err as Error).message}`
          )
          return
        }
        throw err
      }
      expect(r.envelope).toBe(mine.envelope)
      expect(hex(r.content.subarray(0, 20))).toBe(f.seedHex.alice)
      expect(Buffer.from(r.content.subarray(20, 24)).readUInt32BE(0)).toBe(f.permissions.alice)
      expect(r.via).toEqual({
        source: 'windows-store',
        label: 'Alice Test',
        subject: c.subject,
        fingerprint: thumbOf('recipient'),
        hardware: false
      })
      // a software key: no smart card to lock
      expect(store.running()).toBe(false)
    }
  )

  it('says who a file is for when none of the certificates match', async () => {
    const blobs = recipientsOf('stranger-only.pdf')
    expect(await store.probe(blobs)).toEqual([])
    const err = await decryptRecipients(helper, blobs).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WinStoreError)
    expect((err as WinStoreError).code).toBe('NO_MATCHING_CERT')
    const detail = (err as WinStoreError).detail as { recipients: Array<{ issuer: string; serial: string }> }
    expect(detail.recipients[0].issuer).toContain('CN=Fartcrobat Test CA')
    expect(await code(probeRecipients(helper, blobs))).toBe('NO_MATCHING_CERT')
    const candidate = { id: 'windows-store:' + thumbOf('recipient') } as never
    expect(await code(store.decrypt(blobs, candidate, { actor: 'person' }))).toBe('NO_MATCHING_CERT')
    // the EC fixture is for a certificate the store does not have
    expect(await store.probe(recipientsOf('v5-ec.pdf'))).toEqual([])
  })

  it.skipIf(!OPENSSL)(
    'ECDH (KeyAgreeRecipientInfo): listed as an EC key, UNSUPPORTED on .NET for Linux',
    async () => {
      const blob = opensslEnvelope(pem('me-ec'), SEED)
      const [c] = await store.probe([blob])
      if (IS_WIN && !c) {
        // .NET Framework may not even read a key agreement envelope; the Windows job records it.
        const p = await probeRecipients(helper, [blob]).catch((e: unknown) => e)
        console.info(`ECDH probe on Windows: ${JSON.stringify(p instanceof WinStoreError ? p.detail : p)}`)
        return
      }
      expect(c).toMatchObject({ fingerprint: thumbOf('me-ec'), keyType: 'ec', label: 'Store Test Me (EC)' })
      const outcome = await code(store.decrypt([blob], c, { actor: 'person' }))
      if (IS_WIN) {
        console.info(`ECDH decrypt outcome on Windows: ${outcome}`)
        expect(['resolved', 'UNSUPPORTED', 'KEY_UNAVAILABLE', 'ERROR']).toContain(outcome)
      } else expect(outcome).toBe('UNSUPPORTED')
    }
  )

  it('finds the person among several RecipientInfos, and in a later envelope', async () => {
    const blob = forgeEnvelope([pem('colleague'), pem('me-enc')], SEED)
    const r = await decryptRecipients(helper, [blob])
    expect(r.index).toBe(1)
    expect(r.thumbprint).toBe(thumbOf('me-enc'))
    expect(r.content).toEqual(SEED)
    expect(r.hardware).toBe(false)
    const two = await decryptRecipients(helper, [forgeEnvelope([pem('colleague')], SEED), blob])
    expect(two.blob).toBe(1)
  })

  it('node-forge mangles non-ASCII issuer names; copying the raw issuer DER fixes it', async () => {
    const pems = [pem('colleague'), pem('me-noku')]
    const broken = forgeEnvelope(pems, SEED)
    const p = await probeRecipients(helper, [broken])
    expect(p.candidates[0].issuerMatch).toBe(false)
    expect(p.recipients[1].issuer).not.toContain('CN=Store Test Me (no key usage) éè \u{1F511}')
    expect(await code(decryptRecipients(helper, [broken]))).toBe('NO_MATCHING_CERT')
    const fixed = forgeEnvelopeRawIssuer(pems, SEED)
    const r = await decryptRecipients(helper, [fixed])
    expect(r.index).toBe(1)
    expect(r.thumbprint).toBe(thumbOf('me-noku'))
    expect(r.name).toBe('Store Test Me (no key usage) éè \u{1F511}')
    expect(r.content).toEqual(SEED)
    const [c] = await store.probe([fixed])
    expect(c.label).toBe('Store Test Me (no key usage) éè \u{1F511}')
  })

  it('opens with an expired certificate (expired keys still decrypt) and says it is expired', async () => {
    const blob = forgeEnvelopeRawIssuer([pem('me-expired')], SEED)
    const [c] = await store.probe([blob])
    expect(c).toMatchObject({ fingerprint: thumbOf('me-expired'), expired: true, keyType: 'rsa' })
    const r = await store.decrypt([blob], c, { actor: 'person' })
    expect(r.content).toEqual(SEED)
  })

  it.skipIf(IS_PS51)(
    'decrypts .NET envelopes with a SubjectKeyIdentifier recipient and with RSA-OAEP SHA-256',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fc-winstore-net-'))
      try {
        const script = join(dir, 'net_envelope.ps1')
        writeFileSync(
          script,
          [
            'param([string]$CertPath, [string]$IdType, [string]$Padding, [string]$Hex)',
            "$ErrorActionPreference = 'Stop'",
            '$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [IO.File]::ReadAllBytes($CertPath))',
            '$bytes = [byte[]]@(for ($i = 0; $i -lt $Hex.Length; $i += 2) { [Convert]::ToByte($Hex.Substring($i, 2), 16) })',
            '$ci = New-Object System.Security.Cryptography.Pkcs.ContentInfo (, $bytes)',
            "$alg = New-Object System.Security.Cryptography.Pkcs.AlgorithmIdentifier (New-Object System.Security.Cryptography.Oid '2.16.840.1.101.3.4.1.42')",
            '$cms = New-Object System.Security.Cryptography.Pkcs.EnvelopedCms $ci, $alg',
            "$sit = if ($IdType -eq 'ski') { 'SubjectKeyIdentifier' } else { 'IssuerAndSerialNumber' }",
            "if ($Padding -eq 'oaep256') {",
            '  $rcp = New-Object System.Security.Cryptography.Pkcs.CmsRecipient $sit, $cert, ([System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)',
            '} else {',
            '  $rcp = New-Object System.Security.Cryptography.Pkcs.CmsRecipient $sit, $cert',
            '}',
            '$cms.Encrypt($rcp)',
            '[Console]::Out.WriteLine([Convert]::ToBase64String($cms.Encode()))'
          ].join('\n')
        )
        const envelope = (idType: string, padding: string): Uint8Array =>
          new Uint8Array(
            Buffer.from(
              runPs(['-File', script, pki('me-enc.cer'), idType, padding, hex(SEED)]).trim(),
              'base64'
            )
          )
        const ski = envelope('ski', 'pkcs1')
        const p = await probeRecipients(helper, [ski])
        expect(p.recipients[0].idType).toBe('SubjectKeyIdentifier')
        expect(p.recipients[0].ski).toMatch(/^[0-9A-F]{40}$/)
        expect((await decryptRecipients(helper, [ski])).content).toEqual(SEED)
        const oaep = envelope('issuer', 'oaep256')
        const r = await decryptRecipients(helper, [oaep])
        expect(r.keyEncryptionAlgorithm).toBe('1.2.840.113549.1.1.7')
        expect(r.content).toEqual(SEED)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('skips a malformed blob and still opens the next one', async () => {
    const good = forgeEnvelope([pem('me-enc')], SEED)
    const garbage = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])
    const p = await probeRecipients(helper, [garbage, good])
    expect(p.recipients[0].error).toBe('BAD_BLOB')
    const r = await decryptRecipients(helper, [garbage, good])
    expect(r.blob).toBe(1)
    expect(r.content).toEqual(SEED)
  })

  it('restricts decryption to the chosen certificate', async () => {
    const blobs = recipientsOf('v5-two-recipients.pdf')
    expect(await code(decryptRecipients(helper, blobs, { thumbprint: thumbOf('me-enc') }))).toBe(
      'NO_MATCHING_CERT'
    )
    expect(
      (await decryptRecipients(helper, blobs, { thumbprint: thumbOf('recipient').toLowerCase() })).thumbprint
    ).toBe(thumbOf('recipient'))
    expect(await code(decryptRecipients(helper, blobs, { thumbprint: "x' + 1" }))).toBe('BAD_INPUT')
    const notMine = { id: 'windows-store:' + thumbOf('me-enc') } as never
    expect(await code(store.decrypt(blobs, notMine, { actor: 'person' }))).toBe('NO_MATCHING_CERT')
    expect(await code(store.decrypt(blobs, { id: 'digital-id:abc' } as never, { actor: 'person' }))).toBe(
      'ERROR'
    )
  })

  it('handles a long recipient list and a big envelope (data travels on stdin, long values split)', async () => {
    const colleague = pem('colleague')
    const blobs = Array.from({ length: 150 }, () => forgeEnvelope([colleague], SEED))
    // one envelope with 40 RecipientInfos: its base64 is far longer than one literal line
    blobs.push(forgeEnvelope([...Array.from({ length: 39 }, () => colleague), pem('me-enc')], SEED))
    expect(Buffer.from(blobs[150]).toString('base64').length).toBeGreaterThan(10_000)
    expect(blobs.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(50_000)
    const r = await decryptRecipients(helper, blobs)
    expect(r.blob).toBe(150)
    expect(r.index).toBe(39)
    expect(r.content).toEqual(SEED)
  })

  it('runs calls one at a time in one process, and remembers that a key is not hardware', async () => {
    const blob = forgeEnvelope([pem('me-enc')], SEED)
    const fresh = createWindowsStore({ platform: 'win32', enabled: () => true, ...helperOpts })
    try {
      const [c] = await fresh.probe([blob])
      expect(c.hardware).toBe(null)
      const results = await Promise.all([1, 2, 3].map(() => fresh.decrypt([blob], c, { actor: 'person' })))
      for (const r of results) expect(r.content).toEqual(SEED)
      const [again] = await fresh.probe([blob])
      expect(again).toMatchObject({ hardware: false, needs: 'nothing' })
      expect(fresh.running()).toBe(false)
    } finally {
      fresh.stop()
    }
    const pids = await Promise.all(
      [1, 2].map(() =>
        helper.run('Write-FcResult ([ordered]@{ ok = $true; pid = $PID })', {}, { timeoutMs: 60_000 })
      )
    )
    expect(pids[0].pid).toBe(pids[1].pid)
  })
})

// Keys made by Windows itself (not imported from a .p12), non-exportable, in a KSP and in a CSP.
describe.skipIf(!IS_WIN || !STORE_TESTS)('real Windows key storage (Windows only)', () => {
  const helper = new PowerShellHelper(helperOpts)
  afterAll(() => helper.stop())

  for (const [label, extra, provider] of [
    [
      'non-exportable CNG key',
      "-Provider 'Microsoft Software Key Storage Provider'",
      'Microsoft Software Key Storage Provider'
    ],
    [
      'non-exportable CAPI key',
      "-Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -KeySpec KeyExchange",
      'Microsoft Enhanced RSA and AES Cryptographic Provider'
    ]
  ] as const) {
    it(`decrypts with a ${label} and says it is not hardware`, async () => {
      const [thumbprint, derB64] = runPs([
        '-Command',
        `$c = New-SelfSignedCertificate -Type DocumentEncryptionCert -Subject 'CN=Fartcrobat helper test' ` +
          `-CertStoreLocation Cert:\\CurrentUser\\My -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy NonExportable ${extra} ` +
          `-NotAfter (Get-Date).AddDays(1); [Console]::Out.WriteLine($c.Thumbprint + ' ' + [Convert]::ToBase64String($c.RawData))`
      ])
        .trim()
        .split(' ')
      try {
        const listed = await listEncryptionCertificates(helper, {})
        expect(listed.some((c) => c.thumbprint === thumbprint)).toBe(true)
        const der = Buffer.from(derB64, 'base64').toString('binary')
        const certPem = forge.pem.encode({ type: 'CERTIFICATE', body: der })
        const r = await decryptRecipients(helper, [forgeEnvelopeRawIssuer([certPem], SEED)])
        expect(r.thumbprint).toBe(thumbprint)
        expect(r.content).toEqual(SEED)
        expect(r.hardware).toBe(false)
        // .NET Framework may open a CAPI key through CNG, which then names the software KSP
        console.info(`${label}: provider ${r.provider}`)
        expect([provider, 'Microsoft Software Key Storage Provider']).toContain(r.provider)
      } finally {
        removeFromStore([thumbprint])
      }
    })
  }
})
