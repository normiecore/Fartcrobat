/**
 * Renderer side of the OCR IPC channels. main.ts declares the same channels for the main process
 * (the two TypeScript projects cannot share a file outside src/shared).
 */

/** A language data file the user added (in <userData>/tessdata). */
export interface InstalledLanguage {
  /** Tesseract code, e.g. "fra" or "chi_sim". */
  code: string
  file: string
  path: string
  size: number
}

declare module '@shared/ipc' {
  interface IpcApi {
    /** Creates <userData>/tessdata when needed and returns its path. */
    'feature:ocr:languageDir': () => string
    /** Language data files in <userData>/tessdata. */
    'feature:ocr:languages': () => InstalledLanguage[]
    /** Deletes the data file(s) of a language. Returns the remaining languages. */
    'feature:ocr:removeLanguage': (code: string) => InstalledLanguage[]
  }
}
