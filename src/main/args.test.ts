import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filesFromArgv } from './args'

describe('files from the command line', () => {
  it('resolves relative paths against the directory the command ran in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-shell-argv-'))
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'report.pdf'), '%PDF-1.4')
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    const argv = ['/usr/bin/fartcrobat', '--no-sandbox', 'docs/report.pdf', './notes.txt', 'missing.pdf', 'script.sh']
    expect(filesFromArgv(argv, dir)).toEqual([join(dir, 'docs', 'report.pdf'), join(dir, 'notes.txt')])
    // From another directory the same relative names are not found.
    expect(filesFromArgv(argv, join(dir, 'docs'))).toEqual([])
    expect(filesFromArgv(['app', join(dir, 'docs', 'report.pdf')], '/')).toEqual([join(dir, 'docs', 'report.pdf')])
  })
})
