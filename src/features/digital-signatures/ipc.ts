/** IPC channels of this feature (handled in main.ts). */
declare module '@shared/ipc' {
  interface IpcApi {
    /** Folder holding Digital IDs created or imported by Inkmoor (created if missing). */
    'feature:digital-signatures:idsDir': () => string
    /** Deletes a Digital ID file; only files inside the Digital IDs folder can be deleted. */
    'feature:digital-signatures:deleteId': (path: string) => boolean
  }
}

export {}
