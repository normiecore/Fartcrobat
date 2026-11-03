import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PRODUCT_NAME } from '@shared/identity'
import type { DefaultAppStatus } from '@shared/types'
import { appImageFile } from './util/appImage'
import {
  DESKTOP_FILE,
  desktopEntry,
  findDesktopFile,
  isGeneratedDesktopFile,
  refreshedDesktopEntry,
  retargetDesktopEntry,
  userApplicationsDir
} from './util/linuxDesktop'
import { isInkmoorProgId, regValue } from './util/systemDefaults'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/**
 * Linux: the program a desktop entry should start. AppImages run from $APPIMAGE (the mounted
 * executable changes on every start), but only when this process runs from it (another AppImage
 * that started this one passes its own on); tar.gz installs run the executable in place.
 * Unpackaged (development) runs cannot register themselves.
 */
function linuxExecutable(): string | null {
  return appImageFile(process.execPath, process.env) ?? (app.isPackaged ? process.execPath : null)
}

/** The icon theme name of the app icon desktop entries the app writes use. */
const LINUX_ICON = 'inkmoor'

/** Copies the app icon to the user's icon theme folder so the desktop entry has an icon. */
function installLinuxIcon(): string {
  try {
    const src = join(__dirname, '../../resources/icon.png')
    const dir = join(dirname(userApplicationsDir()), 'icons/hicolor/512x512/apps')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${LINUX_ICON}.png`), readFileSync(src))
  } catch {}
  return LINUX_ICON
}

/**
 * Makes sure a fartcrobat.desktop entry exists for this installation. The .deb package installs
 * one; AppImage and tar.gz installs get a per-user one written here (and kept up to date when
 * the AppImage moves). Returns false when there is none and none can be written.
 */
function ensureLinuxDesktopFile(): boolean {
  const existing = findDesktopFile()
  const exe = linuxExecutable()
  if (existing && !isGeneratedDesktopFile(existing)) return true
  if (!exe) return !!existing
  const dir = userApplicationsDir()
  const path = join(dir, DESKTOP_FILE)
  const content = desktopEntry(exe, installLinuxIcon())
  try {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, content, { mode: 0o644 })
    }
    return true
  } catch (err) {
    console.error('Could not write the desktop entry', err)
    return !!existing
  }
}

/**
 * Brings the desktop entry this install wrote for itself up to date (its name after a rename), at
 * start. Only an entry that starts this very executable is touched; nothing is created.
 */
export function refreshLinuxDesktopFile() {
  const exe = linuxExecutable()
  if (!exe) return
  const path = join(userApplicationsDir(), DESKTOP_FILE)
  try {
    const content = refreshedDesktopEntry(readFileSync(path, 'utf8'), exe, LINUX_ICON)
    if (content === null) return
    installLinuxIcon()
    writeFileSync(path, content, { mode: 0o644 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not update the desktop entry', err)
  }
}

/**
 * An update installed the AppImage at `from` under a new name, `to` (electron-updater does that
 * when the old name has a version in it, and deletes the old file). Points the desktop entry
 * Inkmoor wrote for itself at the new file, so PDFs and launchers still open it. Synchronous,
 * because it runs while the app quits.
 */
export function linuxAppImageMoved(from: string, to: string) {
  const path = join(userApplicationsDir(), DESKTOP_FILE)
  try {
    const content = retargetDesktopEntry(readFileSync(path, 'utf8'), from, to)
    if (content !== null) writeFileSync(path, content, { mode: 0o644 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not update the desktop entry', err)
  }
}

/** Whether Inkmoor is the default app for .pdf files, and how the user can change it. */
export async function defaultAppStatus(): Promise<DefaultAppStatus> {
  switch (process.platform) {
    case 'linux': {
      const out = (await run('xdg-mime', ['query', 'default', 'application/pdf'])).trim()
      const installed = !!findDesktopFile() || !!linuxExecutable()
      return {
        isDefault: out ? out === DESKTOP_FILE : null,
        canSetDirectly: installed,
        instructions: installed
          ? 'Inkmoor can make itself the default PDF app for your account.'
          : 'Install Inkmoor (for example the .deb package) to make it your default PDF app, or choose it under "Open with" in your file manager.'
      }
    }
    case 'win32': {
      const out = await run('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice',
        '/v',
        'ProgId'
      ])
      const progId = regValue(out, 'ProgId')
      return {
        isDefault: progId ? isInkmoorProgId(progId, basename(process.execPath)) : null,
        canSetDirectly: false,
        instructions:
          'Windows asks you to confirm this yourself. In the Settings window that opens, find ".pdf" and choose Inkmoor.'
      }
    }
    case 'darwin':
      return {
        isDefault: null,
        canSetDirectly: false,
        instructions:
          'In Finder, select any PDF, press Cmd+I (Get Info), choose Inkmoor under "Open with", then click "Change All…".'
      }
    default:
      return { isDefault: null, canSetDirectly: false, instructions: 'Set Inkmoor as default in your system settings.' }
  }
}

export async function setDefaultApp(): Promise<DefaultAppStatus> {
  if (process.platform === 'linux') {
    if (ensureLinuxDesktopFile()) {
      await run('update-desktop-database', [userApplicationsDir()])
      await run('xdg-mime', ['default', DESKTOP_FILE, 'application/pdf'])
    }
  } else if (process.platform === 'win32') {
    // Opens Inkmoor's page in Settings > Default apps (the installer registers the app's
    // capabilities under RegisteredApplications as "Inkmoor").
    await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(PRODUCT_NAME)}`)
  }
  return defaultAppStatus()
}
