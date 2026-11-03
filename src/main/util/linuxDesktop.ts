import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LEGACY, PRODUCT_NAME, productNames } from '@shared/identity'

/**
 * The desktop entry name the .deb package installs (package.json desktopName). It keeps its first
 * name for good (src/shared/identity.ts): xdg-mime defaults point at it.
 */
export const DESKTOP_FILE = LEGACY.desktopFile
/**
 * Marks desktop entries the app wrote itself (AppImage / tar.gz installs), so it may update them.
 * The key carries the product name; entries written before a rename carry the old one.
 */
export const GENERATED_MARKER = 'X-Fartcrobat-Generated=true'
const markerFor = (name: string) => `X-${name.replace(/[^A-Za-z0-9-]/g, '')}-Generated=true`
/** Every marker an entry this app wrote may carry, current first. */
export const GENERATED_MARKERS: readonly string[] = [...new Set([markerFor(productNames()[0]), GENERATED_MARKER])]

/** Whether desktop entry text was written by this app (under any of its names). */
export const hasGeneratedMarker = (content: string): boolean =>
  content.split('\n').some((line) => GENERATED_MARKERS.includes(line.trim()))

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
    return hasGeneratedMarker(readFileSync(path, 'utf8'))
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
    `Name=${PRODUCT_NAME}`,
    'GenericName=PDF Editor',
    'Comment=Read, edit, comment on and sign PDF documents',
    `Exec=${desktopExecQuote(executable)} %F`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Office;Viewer;',
    'MimeType=application/pdf;',
    'Keywords=pdf;acrobat;reader;editor;sign;forms;',
    `StartupWMClass=${PRODUCT_NAME}`,
    GENERATED_MARKERS[0],
    ''
  ].join('\n')
}

/**
 * The entry this app writes for `executable`, when `content` is an entry it wrote earlier for the
 * same executable that differs (written under the name it had before a rename, say); null when
 * there is nothing to change or the entry is not this install's.
 */
export function refreshedDesktopEntry(content: string, executable: string, icon: string): string | null {
  if (!hasGeneratedMarker(content)) return null
  if (!content.split('\n').includes(`Exec=${desktopExecQuote(executable)} %F`)) return null
  const fresh = desktopEntry(executable, icon)
  return content === fresh ? null : fresh
}

/**
 * A generated entry that starts `from`, changed to start `to` instead; null when `content` is not
 * a generated entry or starts something else (another Fartcrobat install the person chose).
 */
export function retargetDesktopEntry(content: string, from: string, to: string): string | null {
  if (!hasGeneratedMarker(content)) return null
  const lines = content.split('\n')
  const exec = `Exec=${desktopExecQuote(from)} %F`
  if (!lines.includes(exec)) return null
  return lines.map((line) => (line === exec ? `Exec=${desktopExecQuote(to)} %F` : line)).join('\n')
}
