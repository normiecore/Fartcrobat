import { execFile } from 'node:child_process'
import { shell } from 'electron'
import type { DefaultAppStatus } from '@shared/types'

const DESKTOP_FILE = 'fartcrobat.desktop'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** Whether Fartcrobat is the default app for .pdf files, and how the user can change it. */
export async function defaultAppStatus(): Promise<DefaultAppStatus> {
  switch (process.platform) {
    case 'linux': {
      const out = (await run('xdg-mime', ['query', 'default', 'application/pdf'])).trim()
      return {
        isDefault: out ? out === DESKTOP_FILE : null,
        canSetDirectly: true,
        instructions: 'Fartcrobat can make itself the default PDF app for your account.'
      }
    }
    case 'win32': {
      const out = await run('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice',
        '/v',
        'ProgId'
      ])
      const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out)
      return {
        isDefault: m ? /fartcrobat/i.test(m[1]) : null,
        canSetDirectly: false,
        instructions:
          'Windows asks you to confirm this yourself. In the Settings window that opens, find ".pdf" and choose Fartcrobat.'
      }
    }
    case 'darwin':
      return {
        isDefault: null,
        canSetDirectly: false,
        instructions:
          'In Finder, select any PDF, press Cmd+I (Get Info), choose Fartcrobat under "Open with", then click "Change All…".'
      }
    default:
      return { isDefault: null, canSetDirectly: false, instructions: 'Set Fartcrobat as default in your system settings.' }
  }
}

export async function setDefaultApp(): Promise<DefaultAppStatus> {
  if (process.platform === 'linux') {
    await run('xdg-mime', ['default', DESKTOP_FILE, 'application/pdf'])
  } else if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Fartcrobat')
  }
  return defaultAppStatus()
}
