/**
 * Renderer side of the Organize Pages IPC channel. main.ts declares the same channel for the main
 * process (the two TypeScript projects cannot share a file outside src/shared).
 */

/** What is on the system clipboard, for Insert > From Clipboard. */
export interface OrganizeClipboard {
  /** Files copied in the file manager. */
  files: string[]
  /** A copied image (usually PNG). */
  image: Uint8Array | null
  /** Copied text. */
  text: string
}

declare module '@shared/ipc' {
  interface IpcApi {
    'feature:organize-pages:readClipboard': () => OrganizeClipboard
  }
}
