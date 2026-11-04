import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { ALLOWED_EVENT_CHANNELS, type PreloadApi } from '@shared/ipc'

const CHANNEL = /^(file|app|prefs|store|recent|menu|window|shell|defaultApp|print|clipboard|passwords|certkeys):[A-Za-z]+$|^feature:[a-z0-9-]+:[A-Za-z0-9]+$/

const api: PreloadApi = {
  invoke(channel, ...args) {
    if (!CHANNEL.test(channel)) return Promise.reject(new Error(`Blocked IPC channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args) as any
  },
  on(event, listener) {
    if (!ALLOWED_EVENT_CHANNELS.includes(event)) throw new Error(`Blocked IPC event ${event}`)
    const wrapped = (_e: unknown, ...args: unknown[]) => (listener as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
  pathForFile(file: File) {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
