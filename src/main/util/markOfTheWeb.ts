import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { PRODUCT_NAME } from '@shared/identity'

/**
 * Marks a file Inkmoor wrote out of a PDF (an attachment) as coming from the Internet, as a
 * browser marks a download: on Windows the Zone.Identifier stream (SmartScreen, Office Protected
 * View), on macOS the com.apple.quarantine attribute (Gatekeeper). Never fails: a file system
 * without streams or attributes just keeps the file unmarked.
 */
export interface MarkDeps {
  platform: string
  writeFile(path: string, data: string): Promise<unknown>
  run(file: string, args: string[]): Promise<unknown>
  now(): number
}

/** Windows: the Zone.Identifier stream's contents (zone 3, the Internet). */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n'

/** macOS: the com.apple.quarantine value, "flags;hex seconds since 1970;agent;" (no event id). */
export function quarantineValue(nowMs: number): string {
  return `0083;${Math.floor(nowMs / 1000).toString(16)};${PRODUCT_NAME};`
}

const defaults: MarkDeps = {
  platform: process.platform,
  writeFile: (path, data) => writeFile(path, data),
  run: (file, args) =>
    new Promise((resolve, reject) =>
      execFile(file, args, { timeout: 5000, windowsHide: true }, (err) => (err ? reject(err) : resolve(undefined)))
    ),
  now: () => Date.now()
}

export async function markAsDownloaded(path: string, deps: Partial<MarkDeps> = {}): Promise<void> {
  const d = { ...defaults, ...deps }
  try {
    if (d.platform === 'win32') await d.writeFile(`${path}:Zone.Identifier`, ZONE_IDENTIFIER)
    else if (d.platform === 'darwin') await d.run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(d.now()), path])
  } catch {}
}
