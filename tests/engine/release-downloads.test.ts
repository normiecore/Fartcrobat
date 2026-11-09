// scripts/release-downloads.mjs: the release workflow's check that each build made the one file per
// computer that README.md and the release notes name, and nothing a person could run by mistake.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../../scripts/release-downloads.mjs')
const dirs: string[] = []

function build(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-downloads-'))
  dirs.push(dir)
  for (const f of files) {
    if (f.endsWith('/')) mkdirSync(join(dir, f))
    else writeFileSync(join(dir, f), '')
  }
  return dir
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const WIN = ['Inkmoor-Setup-0.2.1-x64.exe', 'Inkmoor-Setup-0.2.1-x64.exe.blockmap', 'Inkmoor-Setup-0.2.1-arm64.exe', 'latest.yml']
const MAC = ['Inkmoor-0.2.1-arm64.dmg', 'Inkmoor-0.2.1-x64.dmg', 'Inkmoor-0.2.1-x64.dmg.blockmap', 'Inkmoor-0.2.1-arm64-mac.zip', 'latest-mac.yml']
const LINUX = ['inkmoor_0.2.1_amd64.deb', 'Inkmoor-x86_64.AppImage', 'inkmoor-0.2.1.tar.gz', 'latest-linux.yml']

describe('release-downloads', () => {
  it('accepts a build with exactly the files the table names', () => {
    expect(run('--dir', build([...WIN, '__uninstaller-nsis-inkmoor.exe', 'win-unpacked/']), '--version', '0.2.1', '--platform', 'win').status).toBe(0)
    expect(run('--dir', build(MAC), '--version', '0.2.1', '--platform', 'mac').status).toBe(0)
    expect(run('--dir', build(LINUX), '--version', '0.2.1', '--platform', 'linux').status).toBe(0)
  })

  it('refuses a missing file and an installer the table does not name', () => {
    const missing = run('--dir', build(WIN.filter((f) => !f.includes('arm64'))), '--version', '0.2.1', '--platform', 'win')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('Inkmoor-Setup-0.2.1-arm64.exe (Windows on Arm (Snapdragon, Surface Pro X)) is missing')

    // The installer for both processors that 0.2.0 also shipped.
    const combined = run('--dir', build([...WIN, 'Inkmoor-Setup-0.2.1.exe']), '--version', '0.2.1', '--platform', 'win')
    expect(combined.status).toBe(1)
    expect(combined.stderr).toContain('Inkmoor-Setup-0.2.1.exe is an installer the download table does not name')

    // 0.2.0's name for the Intel dmg, without the processor.
    const unnamed = run('--dir', build([...MAC.filter((f) => f !== 'Inkmoor-0.2.1-x64.dmg'), 'Inkmoor-0.2.1.dmg']), '--version', '0.2.1', '--platform', 'mac')
    expect(unnamed.status).toBe(1)
    expect(unnamed.stderr).toContain('Inkmoor-0.2.1-x64.dmg (Mac with an Intel processor) is missing')
    expect(unnamed.stderr).toContain('Inkmoor-0.2.1.dmg is an installer')
  })

  it('checks every platform without --platform, and prints the notes only when the files are all there', () => {
    const all = build([...WIN, ...MAC, ...LINUX])
    const notes = run('--dir', all, '--version', '0.2.1', '--notes')
    expect(notes.status).toBe(0)
    expect(notes.stdout).toMatch(/^## Download\n/)
    for (const f of ['Inkmoor-Setup-0.2.1-x64.exe', 'Inkmoor-Setup-0.2.1-arm64.exe', 'Inkmoor-0.2.1-arm64.dmg', 'Inkmoor-0.2.1-x64.dmg', 'inkmoor_0.2.1_amd64.deb', 'Inkmoor-x86_64.AppImage'])
      expect(notes.stdout).toContain(`[${f}](https://github.com/normiecore/Inkmoor/releases/download/v0.2.1/${f})`)

    const partial = run('--dir', build(WIN), '--version', '0.2.1', '--notes')
    expect(partial.status).toBe(1)
    expect(partial.stdout).toBe('')
  })

  it('takes the version from package.json by default and rejects an unknown platform', () => {
    const r = run('--dir', build([]), '--platform', 'win')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Inkmoor-Setup-\d+\.\d+\.\d+-x64\.exe .* is missing/)
    expect(run('--dir', build([]), '--platform', 'beos').status).toBe(2)
  })
})
