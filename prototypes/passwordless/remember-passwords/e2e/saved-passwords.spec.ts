/**
 * DRAFT (not run: needs the app changes). Port target: tests/e2e/saved-passwords.spec.ts.
 *
 * Runs with FARTCROBAT_TEST_SECRET_CIPHER=1, which unpackaged builds honour by using a
 * reversible test cipher (never in packaged builds), because CI runners have no keyring. One
 * test uses the real safeStorage on CI as it is (no keyring: the checkbox is replaced by a note).
 * A real-keyring run is possible locally with keyring/run-with-keyring.sh from the prototype.
 */
import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, runCommand, waitForRender } from './helpers'

const TEST_CIPHER = { FARTCROBAT_TEST_SECRET_CIPHER: '1' }

function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

async function openPath(page: Page, path: string) {
  await page.evaluate((p) => void (window as any).__fartcrobat.openPaths([p]), path)
}

function tempCopy(fixture: string, name = 'secret.pdf'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-pw-'))
  const path = join(dir, name)
  copyFileSync(fixturePath(fixture), path)
  return path
}

test('open, remember, reopen silently; a saved password that stopped working falls back to the prompt', async () => {
  const { app, page, userData } = await launch([], TEST_CIPHER)
  try {
    const file = tempCopy('encrypted.pdf')
    await openPath(page, file)
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    const remember = prompt.getByRole('checkbox', { name: 'Remember password on this device' })
    await expect(remember).toBeChecked() // default on (sticky)
    await page.keyboard.type('secret')
    await page.keyboard.press('Enter')
    await waitForRender(page)

    // The store file holds no password and no path.
    const store = readFileSync(join(userData, 'saved-passwords.json'), 'utf8')
    expect(store).not.toContain('secret')
    expect(store).not.toContain(file)

    // Reopen: no prompt.
    await runCommand(page, 'file.close')
    await expect(page.locator('.home-title')).toBeVisible()
    await openPath(page, file)
    await waitForRender(page)
    await expect(prompt).toHaveCount(0)
    expect((await activeDocState(page))?.title).toBe('secret.pdf')

    // The file is protected again with another password (same /ID[0]): the prompt comes back
    // and says why; the new password is remembered in place of the old one.
    await runCommand(page, 'file.close')
    copyFileSync(fixturePath('saved-passwords/encrypted-changed.pdf'), file)
    await openPath(page, file)
    await expect(prompt).toContainText('no longer opens it')
    await page.keyboard.type('changed')
    await page.keyboard.press('Enter')
    await waitForRender(page)
    await runCommand(page, 'file.close')
    await openPath(page, file)
    await waitForRender(page)
    await expect(prompt).toHaveCount(0)

    // Preferences > Passwords lists one entry; Remove forgets it and the next open asks again.
    await runCommand(page, 'file.close')
    await runCommand(page, 'app.preferences')
    await page.getByRole('tab', { name: 'Passwords' }).click()
    const row = page.getByRole('row', { name: /secret\.pdf/ })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(row).toHaveCount(0)
    await page.keyboard.press('Escape')
    await openPath(page, file)
    await expect(prompt).toBeVisible()
  } finally {
    await app.close()
  }
})

test('unticking the checkbox stores nothing and is remembered as the default', async () => {
  const { app, page, userData } = await launch([], TEST_CIPHER)
  try {
    const file = tempCopy('encrypted.pdf')
    await openPath(page, file)
    const prompt = dialogTitled(page, 'Password required')
    await prompt.getByRole('checkbox', { name: 'Remember password on this device' }).uncheck()
    await prompt.getByRole('textbox').fill('secret') // dialog-scoped: getByLabel('Password') matches the dialog itself
    await prompt.getByRole('button', { name: 'Open' }).click()
    await waitForRender(page)
    expect(existsSync(join(userData, 'saved-passwords.json'))).toBe(false)
    await runCommand(page, 'file.close')
    await openPath(page, file)
    await expect(prompt.getByRole('checkbox', { name: 'Remember password on this device' })).not.toBeChecked()
  } finally {
    await app.close()
  }
})

test('Linux without a keyring: no checkbox, a note instead (real safeStorage)', async () => {
  test.skip(process.platform !== 'linux' || !!process.env.DBUS_SESSION_BUS_ADDRESS, 'needs a session without a Secret Service')
  const { app, page } = await launch([])
  try {
    await openPath(page, tempCopy('encrypted.pdf'))
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('checkbox')).toHaveCount(0)
    await expect(prompt).toContainText('needs GNOME Keyring or KWallet')
  } finally {
    await app.close()
  }
})

test('machine policy turns remembering off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-policy-'))
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ rememberPasswords: { enabled: false } }))
  const { app, page } = await launch([], { ...TEST_CIPHER, FARTCROBAT_POLICY_FILE: policy })
  try {
    await openPath(page, tempCopy('encrypted.pdf'))
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('checkbox')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

// Agent access (after the MCP bridge lands): in tests/e2e/agent-access.spec.ts, open a file whose
// password is saved through the shim's open_document; expect a handle back without any dialog,
// and an audit.jsonl line { tool: 'open_document', summary: 'unlocked with a password saved on
// this device' } that does not contain the password.
