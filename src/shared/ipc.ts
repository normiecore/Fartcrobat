import type { AgentCallRequest, AgentStatus } from './agent/bridge'
import type {
  RememberPasswordRequest,
  SavedPasswordCandidate,
  SavedPasswordInfo,
  SavedPasswordsStatus,
  SavedPasswordTarget
} from './passwords'
import type {
  DefaultAppStatus,
  MenuModel,
  OpenDialogOptions,
  PasswordAccess,
  Preferences,
  PrintJob,
  RecentFile,
  SaveDialogOptions,
  SystemInfo
} from './types'

/**
 * Request/response channels from the renderer to the main process.
 *
 * Features that need main-process code add their own channels with declaration merging, using
 * the `feature:<featureId>:<method>` naming scheme:
 *
 *   declare module '@shared/ipc' {
 *     interface IpcApi { 'feature:ocr:languages': () => string[] }
 *   }
 */
export interface IpcApi {
  'file:openDialog': (opts: OpenDialogOptions) => string[]
  'file:saveDialog': (opts: SaveDialogOptions) => string | null
  'file:read': (path: string) => Uint8Array
  'file:write': (path: string, data: Uint8Array) => void
  'file:exists': (path: string) => boolean
  'file:stat': (path: string) => { size: number; mtimeMs: number } | null
  /** A path for `name` in a new private temporary folder (removed when the app quits). */
  'file:tempPath': (name: string) => string
  'app:launchFiles': () => string[]
  'app:systemInfo': () => SystemInfo
  /** Quits the app: every window is asked about unsaved documents first (File > Exit, Cmd+Q). */
  'app:quit': () => void
  /** The renderer's answer to app:beforeQuit: its documents are closed, the window may close. */
  'app:quitConfirmed': () => void
  /** The renderer's answer to app:beforeQuit: the user cancelled, keep the window (and the app) open. */
  'app:quitCancelled': () => void
  /** Restarts the app through the normal quit flow (settings are saved first). */
  'app:relaunch': () => void
  'prefs:get': () => Preferences
  'prefs:set': (patch: Partial<Preferences>) => Preferences
  'store:get': (key: string) => unknown
  'store:set': (key: string, value: unknown) => void
  'recent:list': () => RecentFile[]
  'recent:add': (file: Omit<RecentFile, 'openedAt'>) => RecentFile[]
  'recent:remove': (path: string) => RecentFile[]
  'recent:clear': () => void
  'menu:set': (model: MenuModel) => void
  'window:setTitle': (title: string) => void
  'window:setFullScreen': (on: boolean) => void
  'window:isFullScreen': () => boolean
  'window:new': () => void
  /** The files this window has open (reopened if its renderer crashes). */
  'window:setOpenFiles': (paths: string[]) => void
  /** Runs a native text-editing command in this window's focused text field. */
  'window:editCommand': (action: EditCommand) => void
  'shell:openExternal': (url: string) => void
  'shell:showItemInFolder': (path: string) => void
  /**
   * Opens a file or folder with the system's default app. Returns an error message ('' on
   * success); programs and scripts (.exe, .js, .app, .desktop...) are refused.
   */
  'shell:openPath': (path: string) => string
  'defaultApp:status': () => DefaultAppStatus
  'defaultApp:set': () => DefaultAppStatus
  'print:images': (job: PrintJob) => { ok: boolean; error?: string }
  'print:printers': () => { name: string; displayName: string; isDefault: boolean }[]
  'clipboard:writeText': (text: string) => void
  'clipboard:readImage': () => Uint8Array | null
  'clipboard:writeImage': (png: Uint8Array) => void
  /** Whether passwords can be remembered on this device now, and how many are. */
  'passwords:status': () => SavedPasswordsStatus
  /** Saved passwords that may open the target, best first ([] when remembering is off). */
  'passwords:find': (target: SavedPasswordTarget) => SavedPasswordCandidate[]
  /** Saves a password the person typed; its ref, or null when remembering is unavailable. */
  'passwords:remember': (request: RememberPasswordRequest) => string | null
  /** A saved password opened the target: link the target's keys to it and note the use. */
  'passwords:used': (ref: string, target: SavedPasswordTarget, meta?: { label?: string; level?: PasswordAccess }) => void
  /** A saved password did not open the target: the target's keys no longer lead to it. */
  'passwords:failed': (ref: string, target: SavedPasswordTarget) => void
  /** The saved password that would be tried first for the target (no secret), or null. */
  'passwords:savedFor': (target: SavedPasswordTarget) => SavedPasswordInfo | null
  'passwords:list': () => SavedPasswordInfo[]
  /** Forgets the given saved passwords, or all of them; returns how many were removed. */
  'passwords:forget': (refs: string[] | 'all') => number
  /** Forgets whatever the target's keys lead to ("Forget" in Protect, removing a Digital ID). */
  'passwords:forgetFor': (target: SavedPasswordTarget) => number
}

/** Events pushed from the main process to the renderer. */
export interface IpcEvents {
  'app:openFiles': (paths: string[]) => void
  'menu:command': (commandId: string) => void
  'app:beforeQuit': () => void
  'window:fullScreenChanged': (on: boolean) => void
  /** Agent access: run a tool in this window (see src/shared/agent/bridge.ts). */
  'agent:request': (request: AgentCallRequest) => void
  /** Agent access: the agent cancelled a call (close its dialog, stop its work). */
  'agent:cancel': (id: string) => void
  /** Agent access: connections or settings changed. */
  'agent:status': (status: AgentStatus) => void
}

/** Native text-editing commands (the Edit menu acting on a focused text field). */
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'

export type IpcChannel = keyof IpcApi
export type IpcArgs<K extends IpcChannel> = Parameters<IpcApi[K]>
export type IpcResult<K extends IpcChannel> = Awaited<ReturnType<IpcApi[K]>>

/** Shape of the object the preload script exposes on `window.api`. */
export interface PreloadApi {
  invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcResult<K>>
  on<K extends keyof IpcEvents>(event: K, listener: IpcEvents[K]): () => void
  /** Absolute path for a File object dropped onto the window. */
  pathForFile(file: File): string
  platform: string
}

export const ALLOWED_EVENT_CHANNELS: (keyof IpcEvents)[] = [
  'app:openFiles',
  'menu:command',
  'app:beforeQuit',
  'window:fullScreenChanged',
  'agent:request',
  'agent:cancel',
  'agent:status'
]
