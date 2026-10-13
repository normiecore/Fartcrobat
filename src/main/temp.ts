import { app } from 'electron'
import { TempFiles } from './util/tempFiles'

let instance: TempFiles | null = null

/** This session's private temporary folder (print jobs, attachments opened in other apps). */
export function sessionTemp(): TempFiles {
  if (!instance) instance = new TempFiles(app.getPath('temp'))
  return instance
}
