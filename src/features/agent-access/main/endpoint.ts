// Where the app listens, and the files that tell the shim how to reach it and how to start it.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appImageFile } from '@main/util/appImage'
import { atomicWrite } from '@main/util/atomicWrite'
import {
  AGENT_DIR,
  APP_FILE,
  AUDIT_FILE,
  ENDPOINT_FILE,
  type AgentAppInfo,
  type AgentEndpoint
} from '@shared/agent/protocol'
import { randomHex } from './auth'

export interface ListenAddress {
  /** Named pipe or socket path. */
  address: string
  /** The private folder holding the socket, removed on stop (null on Windows). */
  dir: string | null
}

export const agentDir = (userData: string) => join(userData, AGENT_DIR)
export const endpointFile = (userData: string) => join(agentDir(userData), ENDPOINT_FILE)
export const appFile = (userData: string) => join(agentDir(userData), APP_FILE)
export const auditFile = (userData: string) => join(agentDir(userData), AUDIT_FILE)

/**
 * A new random address: a named pipe on Windows, else a socket in a new folder only this user can
 * enter (so nobody else can even try to connect).
 */
export async function newAddress(
  platform: NodeJS.Platform = process.platform,
  tmp = tmpdir()
): Promise<ListenAddress> {
  if (platform === 'win32') return { address: `\\\\.\\pipe\\fartcrobat-agent-${randomHex(16)}`, dir: null }
  const dir = await mkdtemp(join(tmp, 'fartcrobat-agent-'))
  await chmod(dir, 0o700)
  return { address: join(dir, 'agent.sock'), dir }
}

export function removeAddress(addr: ListenAddress) {
  if (!addr.dir) return
  try {
    rmSync(addr.dir, { recursive: true, force: true })
  } catch {}
}

async function writeJson(file: string, value: unknown, mode?: number) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await atomicWrite(
    file,
    new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n'),
    mode === undefined ? {} : { mode }
  )
}

/** endpoint.json holds the token, so only this user may read it. */
export function writeEndpointFile(userData: string, endpoint: AgentEndpoint): Promise<void> {
  return writeJson(endpointFile(userData), endpoint, 0o600)
}

export function writeAppFile(userData: string, info: AgentAppInfo): Promise<void> {
  return writeJson(appFile(userData), info)
}

/**
 * How the shim starts this app: a packaged build starts by itself, a development build needs its
 * app path. An AppImage runs from a temporary mount (APPDIR) that is gone once it quits, so it is
 * started again from the .AppImage file.
 */
export function launchInfo(
  execPath: string,
  isPackaged: boolean,
  appPath: string,
  appVersion: string,
  env: NodeJS.ProcessEnv = process.env
): Omit<AgentAppInfo, 'enabled'> {
  const executable = (isPackaged && appImageFile(execPath, env)) || execPath
  return { executable, args: isPackaged ? [] : [appPath], appVersion }
}

/**
 * An update installed the AppImage the shim starts under a new file name (electron-updater keeps
 * the version in the name): app.json names the new file. Synchronous, because it runs while the
 * app quits; the next start writes app.json again anyway.
 */
export function retargetAppFile(userData: string, from: string, to: string) {
  const file = appFile(userData)
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentAppInfo> | null
    if (!info || info.executable !== from) return
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ ...info, executable: to }, null, 2) + '\n')
    renameSync(temp, file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Agent access: could not update app.json', err)
  }
}

/**
 * Removes endpoint.json unless another start has replaced it since (its token differs).
 * Synchronous: it runs while the app quits.
 */
export function removeEndpointFile(userData: string, token: string) {
  const file = endpointFile(userData)
  try {
    const current = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentEndpoint>
    if (current && current.token !== token) return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
  }
  try {
    rmSync(file, { force: true })
  } catch {}
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Removes an endpoint.json left by a run that did not quit normally, so the shim does not try a dead address. */
export function removeStaleEndpointFile(userData: string) {
  const file = endpointFile(userData)
  let pid: unknown
  try {
    pid = (JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentEndpoint>)?.pid
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
  }
  if (typeof pid === 'number' && pid !== process.pid && processAlive(pid)) return
  try {
    rmSync(file, { force: true })
  } catch {}
}
