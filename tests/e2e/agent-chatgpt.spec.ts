// Connect ChatGPT Desktop: the setup it shows works as written, run with Node as ChatGPT runs it.
// The release workflow also runs this against the packaged app, where the helper is a copy in
// userData (src/features/agent-access/main/helperCopy.ts).
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { dataOf, startSession, startShim, type Agent } from './agent-helpers'

test('Connect ChatGPT Desktop names a helper that runs; installed copies keep it in userData', async () => {
  const s = await startSession()
  let gpt: Agent | undefined
  try {
    const { page } = s
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.preferences'))
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await prefs.getByRole('button', { name: 'AI apps', exact: true }).click()
    await prefs.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true }).click()
    const setup = page.getByRole('dialog', { name: 'Connect ChatGPT Desktop' })
    // Command, argument, environment variable.
    const fields = setup.locator('pre')
    await expect(fields.nth(0)).toHaveText('node')
    const helper = (await fields.nth(1).textContent())!
    // An AppImage's resources move on every launch: the path must not point into them.
    if (process.env.FARTCROBAT_EXECUTABLE) expect(helper).toBe(join(s.userData, 'agent-helper', 'shim.mjs'))
    await expect(fields.nth(2)).toHaveText(`FARTCROBAT_USER_DATA=${s.userData}`)
    gpt = await startShim(s.userData, { name: 'codex', version: '1.0' }, helper)
    expect(dataOf(await gpt.call('list_documents'))).toEqual({ documents: [] })
  } finally {
    await gpt?.close()
    await s.close()
  }
})
