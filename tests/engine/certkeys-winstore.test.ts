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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CertKeyError } from '@main/certkeys/source'
import {
  PowerShellHelper,
  POWERSHELL_ARGS,
  WinStoreError,
  defaultPowerShellPath,
  type HelperOptions
} from '@main/certkeys/winCertStore'
import { DECRYPT_BODY, LIST_BODY, PRELUDE, buildScript, endMarker, literal } from '@main/certkeys/winStoreScripts'
import { createWindowsStore, testPowerShellOptions, toCertKeyError } from '@main/certkeys/windowsStoreSource'

const IS_WIN = process.platform === 'win32'

/** A PowerShell that starts and exits 0, or null. */
function findPowerShell(): string | null {
  const candidates = IS_WIN ? [process.env.PWSH, defaultPowerShellPath()] : [process.env.PWSH, '/usr/local/bin/pwsh', '/usr/bin/pwsh']
  for (const exe of candidates) {
    if (!exe || !existsSync(exe)) continue
    const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 60_000, windowsHide: true })
    if (r.status === 0) return exe
  }
  return null
}

const PS = findPowerShell()
// Off Windows, HOME decides where .NET keeps CurrentUser stores: a temporary one keeps the person's own
// store (and pwsh's caches) out of the tests.
const HOME = !IS_WIN && PS ? mkdtempSync(join(tmpdir(), 'fc-winstore-home-')) : null
const helperOpts: HelperOptions =
  IS_WIN && !process.env.PWSH ? {} : PS ? { powershellPath: PS, env: { ...process.env, HOME: HOME ?? undefined } } : {}

afterAll(() => {
  if (HOME) rmSync(HOME, { recursive: true, force: true })
})

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
  const sources = { PRELUDE, DECRYPT_BODY, LIST_BODY }

  it('is ASCII, has no backtick or dollar-brace, so it embeds in template literals and survives any code page', () => {
    for (const [name, s] of Object.entries(sources)) {
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
    for (const [name, s] of Object.entries(sources)) for (const re of banned) expect(s, `${name} ${re}`).not.toMatch(re)
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
    expect(endMarker(42)).toBe("Write-Output 'FCEND:42'\n\n")
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
    expect(buildScript(DECRYPT_BODY, { Blobs: ['QUJD', 'REVG'], Mode: 'probe' }, 1)).toMatch(/\$Blobs = @\(\n'QUJD'\n'REVG'\n\)/)
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
      [new WinStoreError('POWERSHELL_UNAVAILABLE', 'x', { path: 'C:\\Windows\\x.exe' }), 'POWERSHELL_UNAVAILABLE'],
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
    expect(toCertKeyError(new WinStoreError('ERROR', 'x', { hresult: 'not hex' })).message).not.toContain('Windows error')
    expect(toCertKeyError(new WinStoreError('WRONG_PIN', 'x', { hresult: '0x8010006B' })).message).toBe('The smart card PIN was wrong.')
    expect(toCertKeyError(new Error('boom')).code).toBe('ERROR')
  })

  it('takes test PowerShell options from the environment of unpackaged builds only', () => {
    const env = { FARTCROBAT_TEST_POWERSHELL: '/usr/bin/pwsh', FARTCROBAT_TEST_POWERSHELL_HOME: '/tmp/x', PATH: '/bin' }
    expect(testPowerShellOptions(env, true)).toEqual({})
    expect(testPowerShellOptions({ PATH: '/bin' }, false)).toEqual({})
    const o = testPowerShellOptions(env, false)
    expect(o.powershellPath).toBe('/usr/bin/pwsh')
    expect(o.env?.HOME).toBe('/tmp/x')
    expect(o.env?.PATH).toBe('/bin')
    expect(testPowerShellOptions({ FARTCROBAT_TEST_POWERSHELL: '/usr/bin/pwsh' }, false).env?.HOME).toBeUndefined()
  })
})

describe('outside Windows', () => {
  it('refuses without an explicit PowerShell path', async () => {
    const helper = new PowerShellHelper({ platform: 'linux' })
    expect(helper.supported).toBe(false)
    expect(await code(helper.run(LIST_BODY, { IncludeOthers: false }, { timeoutMs: 1000 }))).toBe('NOT_WINDOWS')
    const store = createWindowsStore({ platform: 'darwin', enabled: () => true })
    expect(await store.state()).toBe('not-windows')
    expect(await store.probe([new Uint8Array([0x30, 0])])).toEqual([])
    expect(await store.listEncryptionCertificates({ includeOthers: true })).toEqual([])
    expect(store.running()).toBe(false)
    const candidate = { id: 'windows-store:' + 'A'.repeat(40) } as never
    expect(await code(store.decrypt([new Uint8Array([0x30, 0])], candidate, { actor: 'person' }))).toBe('ERROR')
  })

  it('reports a missing PowerShell, and tries again after stop()', async () => {
    const missing = IS_WIN ? 'C:\\nonexistent\\powershell.exe' : '/nonexistent/powershell.exe'
    const helper = new PowerShellHelper({ powershellPath: missing })
    expect(await code(helper.run(LIST_BODY, { IncludeOthers: false }, { timeoutMs: 10_000 }))).toBe('POWERSHELL_UNAVAILABLE')
    expect(helper.blocked).toBe('unavailable')
    expect(helper.running()).toBe(false)
    // fails at once without trying to start PowerShell again
    expect(await code(helper.run(LIST_BODY, { IncludeOthers: false }, { timeoutMs: 10_000 }))).toBe('POWERSHELL_UNAVAILABLE')
    helper.stop()
    expect(helper.blocked).toBe(null)

    const store = createWindowsStore({ platform: 'win32', enabled: () => true, powershellPath: missing })
    expect(await store.state()).toBe('available')
    expect(await store.probe([new Uint8Array([0x30, 0])])).toEqual([])
    expect(await store.state()).toBe('unavailable')
    expect(await code(store.listEncryptionCertificates({ includeOthers: false }))).toBe('POWERSHELL_UNAVAILABLE')
    store.stop()
    expect(await store.state()).toBe('available')
  })

  it('is off when the preference is off', async () => {
    let on = false
    const store = createWindowsStore({ platform: 'win32', enabled: () => on, powershellPath: '/nonexistent/powershell.exe' })
    expect(await store.state()).toBe('off')
    expect(await store.probe([new Uint8Array([0x30, 0])])).toEqual([])
    expect(await store.listEncryptionCertificates({ includeOthers: false })).toEqual([])
    const candidate = { id: 'windows-store:' + 'A'.repeat(40) } as never
    expect(await code(store.decrypt([new Uint8Array([0x30, 0])], candidate, { actor: 'agent' }))).toBe('KEY_UNAVAILABLE')
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
    const r = await helper.run('Write-FcResult ([ordered]@{ ok = $true; pid = $PID })', {}, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    return r.pid as number
  }

  it('is started as the stock Windows PowerShell with fixed arguments', () => {
    expect(POWERSHELL_ARGS).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'])
    expect(defaultPowerShellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
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
          .run(`Start-Sleep -Milliseconds 200; Write-FcResult ([ordered]@{ ok = $true; n = ${n}; pid = $PID })`, {}, { timeoutMs: 60_000 })
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
    const r = await helper.run('Write-FcResult ([ordered]@{ ok = $true; leak = $Leak })', {}, { timeoutMs: 60_000 })
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
    const queued = helper.run('Write-FcResult ([ordered]@{ ok = $true; pid = $PID })', {}, { timeoutMs: 60_000 })
    const before = new AbortController()
    before.abort()
    const alreadyCancelled = helper.run('Write-FcResult ([ordered]@{ ok = $true })', {}, { timeoutMs: 60_000, signal: before.signal })
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
    expect(await code(helper.run("[Console]::Error.WriteLine('boom')", {}, { timeoutMs: 50_000 }))).toBe('HELPER_FAILED')
    expect(Date.now() - t0).toBeLessThan(20_000)
    // a block that does not even parse
    expect(await code(helper.runScript(() => "& {\n[Console]::Out.WriteLine('x' +\n}\n\n", { timeoutMs: 50_000 }))).toBe('HELPER_FAILED')
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
        buildScript(LIST_BODY, { IncludeOthers: false }, id).replace('& {\n', "& {\n$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n"),
      { timeoutMs: 60_000 }
    )
    expect(r).toEqual({ ok: false, code: 'CONSTRAINED_LANGUAGE', languageMode: 'ConstrainedLanguage' })
    expect(helper.blocked).toBe('constrained')
    expect(helper.running()).toBe(false)
    expect(await code(helper.run('Write-FcResult ([ordered]@{ ok = $true })', {}, { timeoutMs: 60_000 }))).toBe('CONSTRAINED_LANGUAGE')
    helper.stop()
    expect(helper.blocked).toBe(null)
    expect((await helper.run('Write-FcResult ([ordered]@{ ok = $true })', {}, { timeoutMs: 60_000 })).ok).toBe(true)
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
    const store = createWindowsStore({ platform: 'win32', enabled: () => true, powershellPath: wrapper, env: helperOpts.env })
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
      expect(await code(store.decrypt([new Uint8Array([0x30, 0])], candidate, { actor: 'person' }))).toBe('CONSTRAINED_LANGUAGE')
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
