// Agent access, main process: Electron glue around ./main/service (see docs/features/agent-access.md).
import { app, BrowserWindow, shell, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appVersion } from '@main/appVersion'
import type { MainContext } from '@main/context'
import { allWindows, createWindow, showWindow } from '@main/windows'
import type { AgentCallReply, AgentCallRequest, AgentProgress, AgentStatus } from '@shared/agent/bridge'
import { launchInfo } from './main/endpoint'
import type { WindowHost } from './main/router'
import { AgentAccess } from './main/service'

// Same channels as ipc.ts (that file is part of the renderer project, this one of the main one).
declare module '@shared/ipc' {
  interface IpcApi {
    'feature:agent-access:reply': (reply: AgentCallReply) => void
    'feature:agent-access:progress': (progress: AgentProgress) => void
    'feature:agent-access:status': () => AgentStatus
    'feature:agent-access:disconnect': (connectionId?: number) => void
    'feature:agent-access:allow': (clientName?: string) => void
    'feature:agent-access:ready': () => { waitMs?: number }
    'feature:agent-access:attention': () => void
    'feature:agent-access:revealAuditLog': () => void
    'feature:agent-access:installExtension': () => string
    'feature:agent-access:chatgptConfig': () => { command: string; args: string[]; env: Record<string, string>; toml: string }
  }
}

const windowId = (wc: WebContents) => `w${wc.id}`

/**
 * The app's document windows for the router, and when each renderer can take requests: once its
 * runner says so ('ready'). A window whose renderer never gets that far is not sent anything; the
 * router gives up on it after a while.
 */
class ElectronWindows implements WindowHost {
  /** By webContents id: the renderer listens for agent requests. */
  private readonly listening = new Set<number>()
  private readonly waiters = new Map<number, ((ok: boolean) => void)[]>()

  constructor(
    private readonly ctx: MainContext,
    private readonly gone: (windowId: string) => void
  ) {
    // Every window, from its first navigation; print windows too, but they are never routed to.
    app.on('browser-window-created', (_e, win) => this.watch(win))
  }

  windows(): string[] {
    return allWindows().map((w) => windowId(w.webContents))
  }

  current(): string | null {
    const win = this.ctx.currentWindow()
    return win && !win.isDestroyed() ? windowId(win.webContents) : null
  }

  create(): string {
    return windowId(createWindow().webContents)
  }

  ready(id: string): Promise<boolean> {
    const win = this.find(id)
    if (!win) return Promise.resolve(false)
    const wc = win.webContents
    const wcId = wc.id
    // A crashed window waits for the person to reload or close it: don't hold calls for that.
    if (wc.isCrashed()) return Promise.resolve(false)
    if (this.listening.has(wcId)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const list = this.waiters.get(wcId) ?? []
      list.push(resolve)
      this.waiters.set(wcId, list)
    })
  }

  request(id: string, request: AgentCallRequest) {
    const win = this.find(id)
    if (!win) throw new Error('the window is closed')
    this.ctx.send(win, 'agent:request', request)
  }

  cancel(id: string, callId: string) {
    this.ctx.send(this.find(id), 'agent:cancel', callId)
  }

  /** The renderer used an agent-access channel: its request listener is registered. */
  markListening(wc: WebContents) {
    const wcId = wc.id
    if (this.listening.has(wcId)) return
    this.listening.add(wcId)
    this.settle(wcId, true)
  }

  private find(id: string): BrowserWindow | undefined {
    return allWindows().find((w) => windowId(w.webContents) === id)
  }

  private settle(wcId: number, ok: boolean) {
    const list = this.waiters.get(wcId)
    this.waiters.delete(wcId)
    list?.forEach((resolve) => resolve(ok))
  }

  private watch(win: BrowserWindow) {
    const wc = win.webContents
    const wcId = wc.id
    const id = windowId(wc)
    // The renderer is replaced: requests it was running are lost, new ones wait for it to boot.
    const lost = () => {
      this.listening.delete(wcId)
      this.gone(id)
    }
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) lost()
    })
    wc.on('render-process-gone', lost)
    win.on('closed', () => {
      lost()
      this.settle(wcId, false)
    })
  }
}

/**
 * The Claude Desktop extension shipped with the app. Unpackaged, it is built next to this bundle
 * (out/agent beside out/main), wherever the app was started from.
 */
function extensionPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'agent', 'fartcrobat.mcpb')
    : join(__dirname, '..', 'agent', 'fartcrobat.mcpb')
}

/** A shorter wait before calls answer still_running, for tests of unpackaged builds only. */
function testWaitMs(): number | undefined {
  const ms = Number(process.env.FARTCROBAT_AGENT_WAIT_MS)
  return !app.isPackaged && Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** Windows whose taskbar button flashes until they get the focus. */
const flashing = new WeakSet<BrowserWindow>()

export function register(ctx: MainContext) {
  const host = new ElectronWindows(ctx, (id) => agent.windowGone(id))
  const agent = new AgentAccess({
    userData: app.getPath('userData'),
    appVersion: appVersion(),
    launch: launchInfo(process.execPath, app.isPackaged, app.getAppPath(), appVersion()),
    host,
    broadcast: (status) => {
      for (const win of allWindows()) ctx.send(win, 'agent:status', status)
    }
  })

  ctx.handle('feature:agent-access:status', (e) => {
    host.markListening(e.sender)
    return agent.status()
  })
  ctx.handle('feature:agent-access:ready', (e) => {
    host.markListening(e.sender)
    const waitMs = testWaitMs()
    return waitMs ? { waitMs } : {}
  })
  ctx.handle('feature:agent-access:reply', (e, reply) => {
    host.markListening(e.sender)
    agent.reply(windowId(e.sender), reply)
  })
  ctx.handle('feature:agent-access:progress', (e, progress) => {
    host.markListening(e.sender)
    agent.progress(windowId(e.sender), progress)
  })
  ctx.handle('feature:agent-access:disconnect', (_e, connectionId) => {
    agent.disconnect(typeof connectionId === 'number' ? connectionId : undefined)
  })
  ctx.handle('feature:agent-access:allow', (_e, clientName) => {
    agent.allow(typeof clientName === 'string' ? clientName : undefined)
  })
  ctx.handle('feature:agent-access:attention', (e) => {
    host.markListening(e.sender)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    showWindow(win)
    // Windows refuses focus to an app in the background: flash the taskbar button instead.
    if (process.platform === 'win32' && !win.isFocused() && !flashing.has(win)) {
      flashing.add(win)
      win.flashFrame(true)
      win.once('focus', () => {
        flashing.delete(win)
        if (!win.isDestroyed()) win.flashFrame(false)
      })
    }
  })
  ctx.handle('feature:agent-access:revealAuditLog', async () => {
    await agent.audit.ensure()
    shell.showItemInFolder(agent.audit.file)
  })
  ctx.handle('feature:agent-access:chatgptConfig', () => {
    const shim = app.isPackaged ? join(process.resourcesPath, 'agent', 'shim.mjs') : join(__dirname, '..', 'agent', 'shim.mjs')
    if (!existsSync(shim)) throw new Error('The MCP helper is missing. Build or reinstall Fartcrobat first.')
    const command = 'node'
    const args = [shim]
    const env = { FARTCROBAT_USER_DATA: app.getPath('userData') }
    // JSON strings are valid TOML basic strings; no shell interpolation or config rewriting.
    const toml = `[mcp_servers.fartcrobat]\ncommand = "node"\nargs = [${JSON.stringify(shim)}]\n\n[mcp_servers.fartcrobat.env]\nFARTCROBAT_USER_DATA = ${JSON.stringify(env.FARTCROBAT_USER_DATA)}\n`
    return { command, args, env, toml }
  })
  ctx.handle('feature:agent-access:installExtension', async () => {
    const path = extensionPath()
    if (!existsSync(path)) return 'The Claude Desktop extension is not included in this copy of Fartcrobat.'
    return shell.openPath(path)
  })

  ctx.store().onPrefsChange((prefs, prev) => {
    if (prefs.agentAccess !== prev.agentAccess) void agent.setPreference(prefs.agentAccess)
  })
  app.on('will-quit', () => agent.shutdown())
  void agent.setPreference(ctx.store().prefs.agentAccess)
}
