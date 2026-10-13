/**
 * Main-process side of the export-create IPC channels. The renderer declares the same channels in
 * ../shared.ts (the two TypeScript projects cannot share a file outside src/shared).
 */

export interface LibreOfficeInfo {
  path: string
  version: string | null
}

export interface HtmlConvertOptions {
  pageSize: 'Letter' | 'A4' | 'Legal'
  landscape: boolean
  /** Margins in inches. */
  margin: number
  printBackground: boolean
}

declare module '@shared/ipc' {
  interface IpcApi {
    'feature:export-create:findLibreOffice': (path?: string) => LibreOfficeInfo | null
    'feature:export-create:convertOffice': (path: string) => Uint8Array | null
    'feature:export-create:convertHtml': (path: string, opts: HtmlConvertOptions) => Uint8Array
    'feature:export-create:clipboardText': () => string
  }
}
