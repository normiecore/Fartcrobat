/**
 * Parsers for the small system queries Fartcrobat runs to find the default printer and the
 * default PDF app. Kept free of Electron so they can be unit tested.
 */

/** `lpstat -d` (CUPS, Linux and macOS): "system default destination: Office_Laser". */
export function parseLpstatDefault(output: string): string | null {
  const m = /^system default destination:\s*(.+?)\s*$/im.exec(output)
  return m ? m[1] : null
}

/**
 * `reg query "HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows" /v Device` (Windows):
 * "    Device    REG_SZ    HP LaserJet 400,winspool,Ne01:". Printer names cannot contain commas.
 */
export function parseWindowsDevice(output: string): string | null {
  const value = regValue(output, 'Device')
  if (!value) return null
  const name = value.split(',')[0].trim()
  return name || null
}

/** The data of a `reg query ... /v <name>` result line (the whole value, spaces included). */
export function regValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s{2,}(.*?)\s*$/.exec(line) ?? /^\s*(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/.exec(line)
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[2]
  }
  return null
}

/** The ProgId Fartcrobat's Windows installer registers for .pdf (electron-builder.yml, win.fileAssociations). */
export const WINDOWS_PROG_ID = 'Fartcrobat.Document'

/** Whether a .pdf UserChoice ProgId means Fartcrobat opens PDFs. */
export function isFartcrobatProgId(progId: string, exeName = 'Fartcrobat.exe'): boolean {
  const id = progId.trim().toLowerCase()
  return id === WINDOWS_PROG_ID.toLowerCase() || id === `applications\\${exeName.toLowerCase()}`
}
