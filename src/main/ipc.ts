import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { IpcApi, IpcChannel, IpcEvents } from '@shared/ipc'

type Handler<K extends IpcChannel> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<IpcApi[K]>
) => ReturnType<IpcApi[K]> | Promise<Awaited<ReturnType<IpcApi[K]>>>

/** Registers a typed handler for a renderer -> main request channel. */
export function handle<K extends IpcChannel>(channel: K, handler: Handler<K>) {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => handler(event, ...(args as Parameters<IpcApi[K]>)))
}

/** Sends a typed event to a window's renderer. */
export function send<K extends keyof IpcEvents>(win: BrowserWindow | null | undefined, event: K, ...args: Parameters<IpcEvents[K]>) {
  if (!win || win.isDestroyed()) return
  win.webContents.send(event, ...args)
}
