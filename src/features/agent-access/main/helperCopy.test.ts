// The copy of the MCP helper that AI apps set up by hand run (Connect ChatGPT Desktop).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshHelperCopy } from './helperCopy'

const dirs: string[] = []
function folder() {
  const d = mkdtempSync(join(tmpdir(), 'helper-copy-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('refreshHelperCopy', () => {
  it('creates the copy when asked, keeps it in step with the shipped helper, and creates none at start-up', async () => {
    const d = folder()
    const shipped = join(d, 'resources', 'shim.mjs')
    const copy = join(d, 'userData', 'agent-helper', 'shim.mjs')
    mkdirSync(join(d, 'resources'))
    writeFileSync(shipped, 'v1')

    // At start-up, before any AI app was set up: nothing is written.
    expect(await refreshHelperCopy(shipped, copy, false)).toBe(false)
    expect(existsSync(copy)).toBe(false)

    // Connect ChatGPT Desktop.
    expect(await refreshHelperCopy(shipped, copy, true)).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('v1')

    // An update ships a new helper: the next start replaces the copy, and leaves no temporary file.
    writeFileSync(shipped, 'v2')
    expect(await refreshHelperCopy(shipped, copy, false)).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('v2')
    expect(readdirSync(join(d, 'userData', 'agent-helper'))).toEqual(['shim.mjs'])
  })

  it('two setups at once both get the copy', async () => {
    const d = folder()
    const shipped = join(d, 'shim.mjs')
    writeFileSync(shipped, 'x'.repeat(1 << 20))
    const copy = join(d, 'userData', 'agent-helper', 'shim.mjs')
    expect(await Promise.all([refreshHelperCopy(shipped, copy, true), refreshHelperCopy(shipped, copy, true)])).toEqual([true, true])
    expect(readdirSync(join(d, 'userData', 'agent-helper'))).toEqual(['shim.mjs'])
  })

  it('fails when the shipped helper is missing', async () => {
    const d = folder()
    await expect(refreshHelperCopy(join(d, 'missing.mjs'), join(d, 'copy.mjs'), true)).rejects.toThrow(/ENOENT/)
  })
})
