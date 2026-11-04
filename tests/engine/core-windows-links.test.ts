import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileSpecToPath } from '@features/edit-images-links/filespec'
import { externalUrlToOpen, stripMailtoAttachments } from '@main/util/externalUrl'
import { markAsDownloaded, quarantineValue, ZONE_IDENTIFIER } from '@main/util/markOfTheWeb'
import { UNSAFE_EXTENSIONS, unsafeToOpenReason } from '@main/util/unsafeFiles'
import { isRemotePath } from '@shared/remotePath'
import { regExe, system32Exe } from '@shared/winSystem'

const ROOT = resolve(__dirname, '../..')

describe('network paths', () => {
  it('treats UNC, device and //host paths as remote on Windows', () => {
    for (const p of [
      '\\\\host\\share\\a.pdf',
      '//host/share/a.pdf',
      '\\\\?\\UNC\\host\\share\\a.pdf',
      '\\\\.\\UNC\\host\\share',
      '\\\\host@SSL\\DavWWWRoot\\a.docx',
      '\\/host/share',
      ' \\\\host\\share'
    ]) {
      expect(isRemotePath(p, 'win32'), p).toBe(true)
    }
    for (const p of ['C:\\Users\\me\\a.pdf', 'Z:\\mapped\\a.pdf', '\\Users\\me\\a.pdf', 'docs\\a.pdf', '/C/Users/a.pdf']) {
      expect(isRemotePath(p, 'win32'), p).toBe(false)
    }
  })

  it('treats file:// URLs with a host as remote on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(isRemotePath('file://host/share/a.pdf', platform)).toBe(true)
      expect(isRemotePath('FILE://host/share/a.pdf', platform)).toBe(true)
      expect(isRemotePath('file:////host/share/a.pdf', platform)).toBe(true)
      expect(isRemotePath('file:\\\\host\\share\\a.pdf', platform)).toBe(true)
      expect(isRemotePath('file:///home/me/a.pdf', platform)).toBe(false)
      expect(isRemotePath('file://localhost/home/me/a.pdf', platform)).toBe(false)
      expect(isRemotePath('file:/home/me/a.pdf', platform)).toBe(false)
    }
  })

  it('keeps POSIX paths local elsewhere', () => {
    expect(isRemotePath('//host/share/a.pdf', 'linux')).toBe(false)
    expect(isRemotePath('/home/me/a.pdf', 'darwin')).toBe(false)
  })

  it('recognises link targets that become network paths on Windows', () => {
    expect(isRemotePath(fileSpecToPath('//host/share/a.exe', true), 'win32')).toBe(true)
    expect(isRemotePath(fileSpecToPath('/C/docs/a.pdf', true), 'win32')).toBe(false)
  })
})

describe('Windows system programs', () => {
  it('starts reg.exe and friends by full path from %SystemRoot%', () => {
    expect(regExe({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\reg.exe')
    expect(regExe({ SystemRoot: 'D:\\Win\\' })).toBe('D:\\Win\\System32\\reg.exe')
    expect(regExe({ windir: 'E:\\Windows' })).toBe('E:\\Windows\\System32\\reg.exe')
    expect(regExe({})).toBe('C:\\Windows\\System32\\reg.exe')
    expect(system32Exe('where.exe', {})).toBe('C:\\Windows\\System32\\where.exe')
  })

  it('never starts a system program by bare name', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p)
      }
    }
    walk(join(ROOT, 'src'))
    const bare = /\b(?:execFile|execFileSync|spawn|spawnSync|run)\(\s*'(?:reg|reg\.exe|powershell|powershell\.exe|pwsh|cmd|cmd\.exe|where|where\.exe|xattr|certutil)'/
    const offenders = files.filter((f) => bare.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })
})

describe('file types never opened from a PDF', () => {
  it('include shortcuts, remote desktop, sandbox, theme, query and add-in files', () => {
    const wanted = ['rdp', 'wsb', 'theme', 'themepack', 'deskthemepack', 'iqy', 'dqy', 'slk', 'xla', 'xlam', 'ppa', 'ppam', 'vsto',
      'appinstaller', 'appx', 'appxbundle', 'msix', 'msixbundle', 'one', 'onepkg', 'msu', 'mht', 'mhtml', 'library-ms', 'search-ms',
      'searchconnector-ms', 'settingcontent-ms', 'diagcab', 'url', 'website', 'xll', 'wiz', 'cpl', 'reg', 'scf', 'lnk']
    expect(wanted.filter((e) => !UNSAFE_EXTENSIONS.has(e))).toEqual([])
    const file = { isFile: () => true, isDirectory: () => false, mode: 0o644 }
    for (const name of ['remote.rdp', 'box.WSB', 'query.iqy', 'sheet.slk', 'notes.one', 'page.mhtml', 'look.themepack'])
      expect(unsafeToOpenReason(`C:\\tmp\\${name}`, file, 'win32'), name).toMatch(/does not open/)
  })
})

describe('mail links', () => {
  it('drops attach and attachment parameters in any case or encoding', () => {
    expect(stripMailtoAttachments('mailto:a@b.c?subject=Hi&attach=C:\\secret.txt&body=x')).toBe('mailto:a@b.c?subject=Hi&body=x')
    expect(stripMailtoAttachments('MAILTO:a@b.c?ATTACHMENT=%2Fetc%2Fpasswd')).toBe('MAILTO:a@b.c')
    expect(stripMailtoAttachments('mailto:a@b.c?%61ttach=x&Attachments=y&cc=d@e.f')).toBe('mailto:a@b.c?cc=d@e.f')
    expect(stripMailtoAttachments('mailto:a@b.c?attach=x#frag')).toBe('mailto:a@b.c#frag')
    expect(stripMailtoAttachments('mailto:a@b.c?subject=attach%3Dx')).toBe('mailto:a@b.c?subject=attach%3Dx')
    expect(stripMailtoAttachments('mailto:a@b.c')).toBe('mailto:a@b.c')
  })

  it('leaves web links alone and refuses other schemes', () => {
    expect(externalUrlToOpen('https://example.com/?attach=1')).toBe('https://example.com/?attach=1')
    expect(externalUrlToOpen('mailto:a@b.c?attach=x')).toBe('mailto:a@b.c')
    expect(externalUrlToOpen('file://host/share/a.exe')).toBeNull()
    expect(externalUrlToOpen('ms-settings:x')).toBeNull()
  })
})

describe('marking attachments as downloaded', () => {
  const fake = (platform: string, fail = false) => {
    const writes: [string, string][] = []
    const runs: [string, string[]][] = []
    return {
      writes,
      runs,
      deps: {
        platform,
        now: () => 0x65000000 * 1000 + 999,
        writeFile: async (p: string, d: string) => {
          if (fail) throw new Error('no streams here')
          writes.push([p, d])
        },
        run: async (f: string, a: string[]) => {
          if (fail) throw new Error('no xattr')
          runs.push([f, a])
        }
      }
    }
  }

  it('writes a Zone.Identifier stream with zone 3 on Windows', async () => {
    const f = fake('win32')
    await markAsDownloaded('C:\\Users\\me\\Downloads\\a.docx', f.deps)
    expect(f.writes).toEqual([['C:\\Users\\me\\Downloads\\a.docx:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n']])
    expect(ZONE_IDENTIFIER).toContain('ZoneId=3')
    expect(f.runs).toEqual([])
  })

  it('sets com.apple.quarantine with /usr/bin/xattr on macOS', async () => {
    const f = fake('darwin')
    await markAsDownloaded('/Users/me/a.docx', f.deps)
    expect(quarantineValue(0x65000000 * 1000 + 999)).toBe('0083;65000000;Inkmoor;')
    expect(f.runs).toEqual([['/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;65000000;Inkmoor;', '/Users/me/a.docx']]])
    expect(f.writes).toEqual([])
  })

  it('does nothing on Linux and never throws', async () => {
    const f = fake('linux')
    await markAsDownloaded('/home/me/a.docx', f.deps)
    expect([...f.writes, ...f.runs]).toEqual([])
    await expect(markAsDownloaded('C:\\a.docx', fake('win32', true).deps)).resolves.toBeUndefined()
    await expect(markAsDownloaded('/a.docx', fake('darwin', true).deps)).resolves.toBeUndefined()
  })
})
