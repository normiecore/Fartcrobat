// The MCP shim's pieces that do not need a running app: result mapping, where it looks for the
// app, and how it waits for a started app. The stdio round trip is in agent-shim-stdio.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_DIR, APP_FILE, ENDPOINT_FILE, type AgentEndpoint } from '@shared/agent/protocol'
import { AGENT_TOOLS } from '@shared/agent/tools'
import {
  MESSAGES,
  ShimError,
  parseEndpoint,
  readEndpoint,
  userDataDir,
  waitForEndpoint
} from '../../src/agent-shim/app'
import {
  findApp,
  installCandidates,
  parseAppInfo,
  parseRegQuery,
  windowsInstallCandidates
} from '../../src/agent-shim/launch'
import { errorResult, mcpTools, toCallToolResult } from '../../src/agent-shim/result'

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

  it('reports agent access off when the started process hands over to a running app', async () => {
    const app = { pid: 1, exited: Promise.resolve({ code: 0, signal: null }) }
    const err = await waitForEndpoint(userData, {
      app,
      intervalMs: 10,
      graceMs: 50,
      timeoutMs: 20_000
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ShimError)
    expect(err).toMatchObject({ code: 'disabled', message: MESSAGES.disabled })
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
