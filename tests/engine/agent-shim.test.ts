// The MCP shim's pieces that do not need a running app: result mapping, where it looks for the
// app, how it starts it and how it waits for a started app. The stdio round trip is in
// agent-shim-stdio.test.ts.
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_DIR, APP_FILE, ENDPOINT_FILE, type AgentEndpoint } from '@shared/agent/protocol'
import { AGENT_TOOLS } from '@shared/agent/tools'
import {
  AppLink,
  MESSAGES,
  ShimError,
  parseEndpoint,
  readEndpoint,
  userDataDir,
  waitForEndpoint
} from '../../src/agent-shim/app'
import {
  WMI_LAUNCH_SCRIPT,
  findApp,
  installCandidates,
  launchMethod,
  macBundle,
  parseAppInfo,
  parseRegQuery,
  quoteWindowsArg,
  startApp,
  windowsCommandLine,
  windowsInstallCandidates,
  type LaunchedApp
} from '../../src/agent-shim/launch'
import { clientInfo, errorResult, mcpTools, toCallToolResult } from '../../src/agent-shim/result'

const token = (c: string) => c.repeat(64)
const endpoint = (over: Partial<AgentEndpoint> = {}): AgentEndpoint => ({
  protocol: 1,
  address: '/tmp/fartcrobat-agent-x/agent.sock',
  token: token('a'),
  pid: 1234,
  appVersion: '0.1.0',
  ...over
})

describe('agent shim: MCP results', () => {
  it('lists every catalogue tool with its schema and hints, and nothing app-side', () => {
    const tools = mcpTools()
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name))
    expect(tools).toHaveLength(31)
    for (const [i, tool] of tools.entries()) {
      const def = AGENT_TOOLS[i]
      expect(tool).toEqual({
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations
      })
      expect(tool).not.toHaveProperty('gate')
      expect(tool).not.toHaveProperty('category')
    }
  })

  it('turns data into one indented JSON text block', () => {
    const data = { documents: [{ handle: 'w1-doc-1', title: 'Report', pages: 3 }] }
    expect(toCallToolResult({ data })).toEqual({
      content: [{ type: 'text', text: JSON.stringify(data, null, 1) }]
    })
    expect(toCallToolResult({ data: 0 }).content).toEqual([{ type: 'text', text: '0' }])
    expect(toCallToolResult({ data: null }).content).toEqual([{ type: 'text', text: 'null' }])
  })

  it('turns images into image blocks after the data', () => {
    const result = toCallToolResult({
      data: { page: 1 },
      images: [
        { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { data: '/9j/4AAQ', mimeType: 'image/jpeg' }
      ]
    })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ page: 1 }, null, 1) },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }
    ])
  })

  it('turns errors into isError with "[code] message" and nothing else', () => {
    expect(
      toCallToolResult({
        data: { ignored: true },
        error: { code: 'declined', message: 'The person declined in Fartcrobat.' }
      })
    ).toEqual({
      content: [{ type: 'text', text: '[declined] The person declined in Fartcrobat.' }],
      isError: true
    })
    expect(toCallToolResult(errorResult('disabled', MESSAGES.disabled))).toEqual({
      content: [
        { type: 'text', text: '[disabled] Agent access is turned off in Fartcrobat (Preferences > AI apps).' }
      ],
      isError: true
    })
  })

  it('says a tool that returned nothing is done', () => {
    expect(toCallToolResult({})).toEqual({ content: [{ type: 'text', text: 'Done.' }] })
  })

  it('passes on the AI app as it introduced itself, leaving a missing name empty', () => {
    expect(clientInfo({ name: 'claude-ai', version: '0.14.0' })).toEqual({
      name: 'claude-ai',
      version: '0.14.0'
    })
    expect(clientInfo({ name: '  Claude  ', version: 3 })).toEqual({ name: 'Claude', version: '' })
    // Fartcrobat words a nameless AI app itself ("AI app", "An AI agent"), so nothing is made up here.
    for (const info of [undefined, null, 'claude', {}, { name: '' }, { name: '   ' }, { name: 7 }])
      expect(clientInfo(info)).toEqual({ name: '', version: '' })
  })
})

describe('agent shim: where the app is', () => {
  it('uses FARTCROBAT_USER_DATA when set', () => {
    expect(
      userDataDir({ FARTCROBAT_USER_DATA: '/tmp/profile', APPDATA: 'C:\\x' }, 'win32', 'C:\\Users\\me')
    ).toBe('/tmp/profile')
  })

  it('follows Electron on Windows: %APPDATA%\\Fartcrobat', () => {
    expect(userDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Fartcrobat'
    )
    expect(userDataDir({}, 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Roaming\\Fartcrobat')
  })

  it('follows Electron on macOS and Linux', () => {
    expect(userDataDir({ XDG_CONFIG_HOME: '/x' }, 'darwin', '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Fartcrobat'
    )
    expect(userDataDir({ XDG_CONFIG_HOME: '/home/me/.cfg' }, 'linux', '/home/me')).toBe(
      '/home/me/.cfg/Fartcrobat'
    )
    expect(userDataDir({}, 'linux', '/home/me')).toBe('/home/me/.config/Fartcrobat')
  })

  it('accepts only complete endpoint files', () => {
    expect(parseEndpoint(endpoint())).toEqual(endpoint())
    expect(parseEndpoint({ ...endpoint(), extra: 1 })).toEqual(endpoint())
    expect(parseEndpoint({ ...endpoint(), appVersion: undefined })).toEqual(endpoint({ appVersion: '' }))
    for (const bad of [
      null,
      'text',
      [],
      { ...endpoint(), token: undefined },
      { ...endpoint(), token: 'abc' },
      { ...endpoint(), token: 'g'.repeat(64) },
      { ...endpoint(), address: '' },
      { ...endpoint(), address: 7 },
      { ...endpoint(), protocol: '1' },
      { ...endpoint(), pid: 1.5 }
    ])
      expect(parseEndpoint(bad)).toBeNull()
  })

  it('reads app.json and finds the installed app on Windows', () => {
    expect(parseAppInfo({ executable: '/opt/Fartcrobat/fartcrobat', args: [], appVersion: '0.1.0' })).toEqual(
      {
        executable: '/opt/Fartcrobat/fartcrobat',
        args: []
      }
    )
    expect(parseAppInfo({ executable: '/usr/bin/electron', args: ['/src/app'] })?.args).toEqual(['/src/app'])
    expect(parseAppInfo({ executable: '' })).toBeNull()
    expect(parseAppInfo({ executable: 'x', args: [1] })).toBeNull()
    // Whether agent access is on, when the app recorded it.
    expect(parseAppInfo({ executable: 'x', args: [], enabled: false })).toEqual({
      executable: 'x',
      args: [],
      enabled: false
    })
    expect(parseAppInfo({ executable: 'x', enabled: true })?.enabled).toBe(true)
    expect(parseAppInfo({ executable: 'x', enabled: 'no' })).not.toHaveProperty('enabled')

    const reg = [
      '',
      'HKEY_CURRENT_USER\\Software\\bd977413-7ee9-5f76-80a8-7e980aa59bd1',
      '    InstallLocation    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\Fartcrobat',
      ''
    ].join('\r\n')
    expect(parseRegQuery(reg)).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Fartcrobat')
    expect(
      parseRegQuery('ERROR: The system was unable to find the specified registry key or value.')
    ).toBeNull()

    expect(
      windowsInstallCandidates(
        { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
        ['D:\\Apps\\Fartcrobat', null]
      )
    ).toEqual([
      'D:\\Apps\\Fartcrobat\\Fartcrobat.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Fartcrobat\\Fartcrobat.exe',
      'C:\\Program Files\\Fartcrobat\\Fartcrobat.exe'
    ])
    // The per-user default without LOCALAPPDATA, and no duplicates.
    expect(
      windowsInstallCandidates({ USERPROFILE: 'C:\\Users\\me' }, [
        'C:\\Users\\me\\AppData\\Local\\Programs\\Fartcrobat'
      ])
    ).toEqual(['C:\\Users\\me\\AppData\\Local\\Programs\\Fartcrobat\\Fartcrobat.exe'])
  })

  it('knows where the installers put the app on each system', () => {
    expect(installCandidates('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\me', [null, null])).toEqual([
      'C:\\L\\Programs\\Fartcrobat\\Fartcrobat.exe'
    ])
    expect(installCandidates('darwin', {}, '/Users/me')).toEqual([
      '/Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat',
      '/Users/me/Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat'
    ])
    expect(installCandidates('linux', {}, '/home/me')).toEqual(['/opt/Fartcrobat/fartcrobat'])
  })
})

describe('agent shim: files in userData', () => {
  let userData: string
  const write = (name: string, value: unknown) => {
    mkdirSync(join(userData, AGENT_DIR), { recursive: true })
    writeFileSync(join(userData, AGENT_DIR, name), typeof value === 'string' ? value : JSON.stringify(value))
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'fc-shim-unit-'))
  })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it('reads endpoint.json, treating a missing or half-written file as no endpoint', async () => {
    expect(await readEndpoint(userData)).toBeNull()
    write(ENDPOINT_FILE, '{"protocol": 1, "addr')
    expect(await readEndpoint(userData)).toBeNull()
    write(ENDPOINT_FILE, endpoint())
    expect(await readEndpoint(userData)).toEqual(endpoint())
  })

  it('starts the app from app.json only while its executable exists', async () => {
    // With its own profile the shim never falls back to an installed copy.
    const env = { FARTCROBAT_USER_DATA: userData }
    expect(await findApp(userData, env, 'linux')).toBeNull()
    write(APP_FILE, { executable: process.execPath, args: ['app'], appVersion: '0.1.0' })
    expect(await findApp(userData, env, 'linux')).toEqual({ executable: process.execPath, args: ['app'] })
    write(APP_FILE, { executable: join(userData, 'gone', 'fartcrobat'), args: [], appVersion: '0.1.0' })
    expect(await findApp(userData, env, 'linux')).toBeNull()
    // With agent access off it is not started anyway, so the shim can say so.
    write(APP_FILE, { executable: join(userData, 'gone', 'fartcrobat'), args: [], enabled: false })
    expect(await findApp(userData, env, 'linux')).toEqual({
      executable: join(userData, 'gone', 'fartcrobat'),
      args: [],
      enabled: false
    })
  })

  it('says agent access is off without starting anything when app.json says so', async () => {
    const link = new AppLink({ shimVersion: 'test', env: { FARTCROBAT_USER_DATA: userData }, log: () => {} })
    const client = { name: 'claude-ai', version: '1' }
    // A program that does not exist: had the shim tried to start it, it would say Fartcrobat is not running.
    const missing = join(userData, 'gone', 'fartcrobat')
    write(APP_FILE, { executable: missing, args: [], appVersion: '0.1.0', enabled: false })
    expect(await link.call('list_documents', {}, { client })).toEqual(
      errorResult('disabled', MESSAGES.disabled)
    )
    write(APP_FILE, { executable: missing, args: [], appVersion: '0.1.0', enabled: true })
    expect(await link.call('list_documents', {}, { client })).toEqual(
      errorResult('failed', MESSAGES.notRunning)
    )
  })

  it('waits for a fresh endpoint, ignoring the one a crashed run left', async () => {
    write(ENDPOINT_FILE, endpoint({ token: token('a') }))
    const waiting = waitForEndpoint(userData, {
      previousToken: token('a'),
      intervalMs: 10,
      timeoutMs: 20_000
    })
    write(ENDPOINT_FILE, endpoint({ token: token('b'), pid: 99 }))
    expect(await waiting).toEqual(endpoint({ token: token('b'), pid: 99 }))
  })

  it('reports an open app that does not accept the connection when the started process hands over', async () => {
    const app = { pid: 1, exited: Promise.resolve({ code: 0, signal: null }) }
    const err = await waitForEndpoint(userData, {
      app,
      intervalMs: 10,
      graceMs: 50,
      timeoutMs: 20_000
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ShimError)
    // Agent access may be off there, or the app may still be starting or quitting: not certain.
    expect(err).toMatchObject({ code: 'failed', message: MESSAGES.handedOver })
  })

  it('reports an app that stops with an error, and one that never answers', async () => {
    const crashed = { pid: 1, exited: Promise.resolve({ code: 3, signal: null }) }
    await expect(waitForEndpoint(userData, { app: crashed, intervalMs: 10 })).rejects.toMatchObject({
      code: 'failed',
      message: 'Fartcrobat could not be started (it stopped with exit code 3).'
    })
    const silent = { pid: 1, exited: new Promise<never>(() => {}) }
    await expect(
      waitForEndpoint(userData, { app: silent, intervalMs: 10, timeoutMs: 50 })
    ).rejects.toMatchObject({
      code: 'failed',
      message: MESSAGES.startTimeout
    })
  })

  it('stops waiting when the shim shuts down', async () => {
    const stop = new AbortController()
    const waiting = waitForEndpoint(userData, { intervalMs: 10_000, timeoutMs: 60_000, signal: stop.signal })
    stop.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
  })
})

/** A child process the test ends as it likes. */
class FakeChild extends EventEmitter {
  pid = 4321
  killed = false
  unref() {}
  kill() {
    this.killed = true
    return true
  }
}

interface Spawned {
  command: string
  args: readonly string[]
  options: SpawnOptions
  child: FakeChild
}

/** A spawn that records each process; `end` runs a tick later to play its life. */
function fakeSpawn(end: (spawned: Spawned) => void) {
  const spawned: Spawned[] = []
  const run = (command: string, args: readonly string[], options: SpawnOptions) => {
    const entry = { command, args, options, child: new FakeChild() }
    spawned.push(entry)
    setImmediate(() => end(entry))
    return entry.child as unknown as ChildProcess
  }
  return { run, spawned }
}

const starts = (s: Spawned) => s.child.emit('spawn')
const startsAndExits = (code: number) => (s: Spawned) => {
  s.child.emit('spawn')
  s.child.emit('exit', code, null)
}

/** Whether the promise settles soon (a launcher's exit must not count as the app's). */
async function settles(promise: LaunchedApp['exited']): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((done) => setTimeout(() => done(false), 30))
  ])
}

/**
 * Splits the arguments of a Windows command line the way the Microsoft C runtime and
 * CommandLineToArgvW do: 2n backslashes and a quotation mark give n backslashes and start or end a
 * quoted part, 2n+1 give n backslashes and a literal quotation mark, other backslashes are literal.
 */
function splitWindowsArgs(line: string): string[] {
  const args: string[] = []
  let i = 0
  const blank = (ch: string | undefined) => ch === ' ' || ch === '\t'
  for (;;) {
    while (blank(line[i])) i++
    if (i >= line.length) return args
    let arg = ''
    let quoted = false
    while (i < line.length && (quoted || !blank(line[i]))) {
      let backslashes = 0
      while (line[i] === '\\') {
        backslashes++
        i++
      }
      if (line[i] === '"') {
        arg += '\\'.repeat(backslashes >> 1)
        if (backslashes % 2) arg += '"'
        else quoted = !quoted
        i++
      } else {
        arg += '\\'.repeat(backslashes)
        if (i < line.length && (quoted || !blank(line[i]))) arg += line[i++]
      }
    }
    args.push(arg)
  }
}

describe('agent shim: starting the app', () => {
  const winExe = String.raw`C:\Users\O'Brien $(calc); & x\AppData\Local\Programs\Fartcrobat\Fartcrobat.exe`
  const winDir = String.raw`C:\Users\O'Brien $(calc); & x\AppData\Local\Programs\Fartcrobat`
  const winEnv = { SystemRoot: String.raw`C:\Windows`, APPDATA: String.raw`C:\Users\me\AppData\Roaming` }
  const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
  const macExe = '/Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat'

  it('quotes Windows arguments so that programs read them back unchanged', () => {
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg(String.raw`C:\My Files\app`)).toBe(String.raw`"C:\My Files\app"`)
    expect(quoteWindowsArg('say "hi"')).toBe(String.raw`"say \"hi\""`)
    expect(quoteWindowsArg('C:\\with space\\')).toBe('"C:\\with space\\\\"')
    expect(quoteWindowsArg(String.raw`a\\"b`)).toBe(String.raw`"a\\\\\"b"`)
    const tricky = [
      'plain',
      '',
      ' ',
      'two words',
      'tab\there',
      '"',
      '""',
      '\\',
      '\\\\server\\share\\with space\\',
      String.raw`trailing\\`,
      String.raw`a\"b`,
      String.raw`a\\"b c`,
      String.raw`"quoted\"`,
      '%PATH% & | ^ < > $env:x',
      'naïve 文件'
    ]
    expect(splitWindowsArgs(tricky.map(quoteWindowsArg).join(' '))).toEqual(tricky)
  })

  it('builds the Windows command line with the program name always quoted', () => {
    expect(windowsCommandLine({ executable: winExe, args: [] })).toBe(`"${winExe}"`)
    const args = [String.raw`D:\src\fartcrobat app`, '--flag', '']
    const line = windowsCommandLine({ executable: winExe, args })
    expect(line.startsWith(`"${winExe}" `)).toBe(true)
    expect(splitWindowsArgs(line.slice(winExe.length + 3))).toEqual(args)
    // Windows reads the program name up to the next quotation mark, so it cannot hold one.
    expect(() => windowsCommandLine({ executable: 'C:\\a"b\\x.exe', args: [] })).toThrow()
  })

  it('chooses how to start the app', () => {
    const packaged = (executable: string) => ({ executable, args: [] })
    expect(launchMethod(packaged(winExe), winEnv, 'win32')).toBe('wmi')
    expect(launchMethod({ executable: winExe, args: ['D:\\src'] }, winEnv, 'win32')).toBe('wmi')
    expect(launchMethod(packaged(macExe), {}, 'darwin')).toBe('launch-services')
    expect(
      launchMethod(packaged('/Users/me/Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat'), {}, 'darwin')
    ).toBe('launch-services')
    expect(launchMethod(packaged('/opt/Fartcrobat/fartcrobat'), {}, 'linux')).toBe('direct')
    // Development builds on macOS start Electron with the app's path.
    expect(
      launchMethod({ executable: '/src/Electron.app/Contents/MacOS/Electron', args: ['/src'] }, {}, 'darwin')
    ).toBe('direct')
    expect(launchMethod(packaged('/usr/local/bin/fartcrobat'), {}, 'darwin')).toBe('direct')
    // A separate profile is named in the environment, which only a direct start passes on.
    const profile = { FARTCROBAT_USER_DATA: '/tmp/profile' }
    expect(launchMethod(packaged(winExe), { ...winEnv, ...profile }, 'win32')).toBe('direct')
    expect(launchMethod(packaged(macExe), profile, 'darwin')).toBe('direct')

    expect(macBundle(macExe)).toBe('/Applications/Fartcrobat.app')
    expect(macBundle('/Applications/Fartcrobat.app/Contents/Frameworks/x')).toBeNull()
    expect(macBundle('Fartcrobat.app/Contents/MacOS/Fartcrobat')).toBeNull()
  })

  it('starts the app through WMI on Windows, passing the command line in the environment', async () => {
    const { run, spawned } = fakeSpawn(startsAndExits(0))
    const log: string[] = []
    const app = await startApp(
      { executable: winExe, args: [] },
      { env: winEnv, platform: 'win32', spawn: run, log: (m) => log.push(m) }
    )
    expect(spawned).toHaveLength(1)
    const [ps] = spawned
    expect(ps.command).toBe(powershell)
    expect(ps.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WMI_LAUNCH_SCRIPT])
    expect(ps.options).toMatchObject({ stdio: 'ignore', windowsHide: true })
    expect(ps.options.env).toEqual({
      ...winEnv,
      FARTCROBAT_LAUNCH_COMMAND: `"${winExe}"`,
      FARTCROBAT_LAUNCH_DIR: winDir
    })
    // The script is always the same: nothing from the path is pasted into it.
    expect(WMI_LAUNCH_SCRIPT).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create')
    expect(WMI_LAUNCH_SCRIPT).toContain('CommandLine = $env:FARTCROBAT_LAUNCH_COMMAND')
    expect(WMI_LAUNCH_SCRIPT).toContain('CurrentDirectory = $env:FARTCROBAT_LAUNCH_DIR')
    // No quotation marks, which Windows would have to escape on PowerShell's command line.
    expect(WMI_LAUNCH_SCRIPT).not.toContain('"')
    // WMI's process is not this helper's child: its exit says nothing about the app.
    expect(app.pid).toBeUndefined()
    expect(await settles(app.exited)).toBe(false)
    expect(log).toEqual(['Started Fartcrobat through WMI.'])
  })

  it('starts the app directly when WMI fails', async () => {
    const endings: [string, (s: Spawned) => void][] = [
      ['exit code 2', startsAndExits(2)],
      ['spawn powershell.exe ENOENT', (s) => s.child.emit('error', new Error('spawn powershell.exe ENOENT'))]
    ]
    for (const [failure, ending] of endings) {
      const { run, spawned } = fakeSpawn((s) => (s.command === powershell ? ending(s) : starts(s)))
      const log: string[] = []
      const app = await startApp(
        { executable: winExe, args: [] },
        {
          env: { ...winEnv, ELECTRON_RUN_AS_NODE: '1' },
          platform: 'win32',
          spawn: run,
          log: (m) => log.push(m),
          launcherTimeoutMs: 20
        }
      )
      expect(spawned.map((s) => s.command)).toEqual([powershell, winExe])
      expect(spawned[1].args).toEqual([])
      expect(spawned[1].options).toEqual({
        cwd: winDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: winEnv
      })
      expect(app.pid).toBe(4321)
      expect(log).toEqual([`Could not start Fartcrobat through WMI (${failure}); starting it directly.`])
    }

    // A path WMI could not be given starts directly without trying.
    const { run, spawned } = fakeSpawn(starts)
    await startApp(
      { executable: 'C:\\odd"name\\Fartcrobat.exe', args: [] },
      { env: winEnv, platform: 'win32', spawn: run }
    )
    expect(spawned.map((s) => s.command)).toEqual(['C:\\odd"name\\Fartcrobat.exe'])
  })

  it('waits for the app rather than start a second copy when WMI is slow to answer', async () => {
    const { run, spawned } = fakeSpawn(starts)
    const log: string[] = []
    const app = await startApp(
      { executable: winExe, args: [] },
      { env: winEnv, platform: 'win32', spawn: run, log: (m) => log.push(m), launcherTimeoutMs: 20 }
    )
    expect(spawned.map((s) => s.command)).toEqual([powershell])
    expect(spawned[0].child.killed).toBe(false)
    expect(app.pid).toBeUndefined()
    expect(await settles(app.exited)).toBe(false)
    expect(log).toEqual(['WMI has not finished starting Fartcrobat after 0.02 seconds; waiting for it.'])
  })

  it('starts a separate profile directly, with its environment', async () => {
    const { run, spawned } = fakeSpawn(startsAndExits(0))
    const env = { ...winEnv, FARTCROBAT_USER_DATA: 'D:\\profile' }
    const app = await startApp(
      { executable: winExe, args: ['D:\\src'] },
      { env, platform: 'win32', spawn: run }
    )
    expect(spawned.map((s) => [s.command, s.args])).toEqual([[winExe, ['D:\\src']]])
    expect(spawned[0].options).toMatchObject({ cwd: winDir, detached: true, env })
    // A second instance that hands over to the running app exits with 0.
    expect(await app.exited).toEqual({ code: 0, signal: null })
  })

  it('starts the app through LaunchServices on macOS', async () => {
    const opened = fakeSpawn(startsAndExits(0))
    const app = await startApp(
      { executable: macExe, args: [] },
      { env: {}, platform: 'darwin', spawn: opened.run }
    )
    expect(opened.spawned.map((s) => [s.command, s.args])).toEqual([
      ['/usr/bin/open', ['-a', '/Applications/Fartcrobat.app']]
    ])
    // open exits with 0 once the launch has begun: that is not a second instance handing over.
    expect(app.pid).toBeUndefined()
    expect(await settles(app.exited)).toBe(false)

    const failed = fakeSpawn((s) => (s.command === '/usr/bin/open' ? startsAndExits(1)(s) : starts(s)))
    await startApp({ executable: macExe, args: [] }, { env: {}, platform: 'darwin', spawn: failed.run })
    expect(failed.spawned.map((s) => s.command)).toEqual(['/usr/bin/open', macExe])
    expect(failed.spawned[1].options.cwd).toBe('/Applications/Fartcrobat.app/Contents/MacOS')
  })

  it('starts the app directly on Linux, in its own folder and not as Node', async () => {
    const { run, spawned } = fakeSpawn(starts)
    const env = { HOME: '/home/me', ELECTRON_RUN_AS_NODE: '1' }
    const app = await startApp(
      { executable: '/opt/Fartcrobat/fartcrobat', args: [] },
      { env, platform: 'linux', spawn: run }
    )
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ command: '/opt/Fartcrobat/fartcrobat', args: [] })
    expect(spawned[0].options).toEqual({
      cwd: '/opt/Fartcrobat',
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { HOME: '/home/me' }
    })
    expect(app.pid).toBe(4321)
    expect(await settles(app.exited)).toBe(false)
  })
})
