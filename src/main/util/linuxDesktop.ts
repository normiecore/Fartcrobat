import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The desktop entry name the .deb package installs (package.json desktopName). */
export const DESKTOP_FILE = 'fartcrobat.desktop'
/** Marks desktop entries Fartcrobat wrote itself (AppImage / tar.gz installs), so it may update them. */
export const GENERATED_MARKER = 'X-Fartcrobat-Generated=true'

type Env = Record<string, string | undefined>

/** $XDG_DATA_HOME/applications: where per-user desktop entries go. */
export function userApplicationsDir(env: Env = process.env, home = homedir()): string {
  const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local/share')
  return join(dataHome, 'applications')
}

/** Every applications folder desktop environments search, most important first. */
export function applicationsDirs(env: Env = process.env, home = homedir()): string[] {
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => d.startsWith('/'))
  return [userApplicationsDir(env, home), ...dataDirs.map((d) => join(d, 'applications'))]
}

/** Path of the installed fartcrobat.desktop, or null when no package installed one. */
export function findDesktopFile(env: Env = process.env, home = homedir()): string | null {
  for (const dir of applicationsDirs(env, home)) {
    const p = join(dir, DESKTOP_FILE)
    if (existsSync(p)) return p
  }
  return null
}

/** Whether the desktop entry at `path` was written by Fartcrobat (not by a package). */
export function isGeneratedDesktopFile(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(GENERATED_MARKER)
  } catch {
    return false
  }
}

/**
 * Quotes a program path for the Exec key of a desktop entry: quoted-argument escaping first,
 * then the escaping every desktop entry string value gets (so a backslash ends up doubled twice).
 */
export function desktopExecQuote(path: string): string {
  const quoted = '"' + path.replace(/[\\"`$]/g, (c) => '\\' + c).replace(/%/g, '%%') + '"'
  return quoted.replace(/\\/g, '\\\\')
}

/** A desktop entry that opens PDFs (and the other types Fartcrobat reads) with `executable`. */
export function desktopEntry(executable: string, icon: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Fartcrobat',
    'GenericName=PDF Editor',
    'Comment=Read, edit, comment on and sign PDF documents',
    `Exec=${desktopExecQuote(executable)} %F`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Office;Viewer;',
    'MimeType=application/pdf;',
    'Keywords=pdf;acrobat;reader;editor;sign;forms;',
    'StartupWMClass=Fartcrobat',
    GENERATED_MARKER,
    ''
  ].join('\n')
}
