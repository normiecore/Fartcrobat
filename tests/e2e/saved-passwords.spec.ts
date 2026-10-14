/**
 * Passwords remembered on this device. Most tests run with FARTCROBAT_TEST_SECRET_CIPHER=1, which
 * unpackaged builds honour by using a reversible test cipher (CI runners have no keyring); a
 * packaged build ignores it, so the file is skipped with FARTCROBAT_EXECUTABLE. One test uses the
 * real safeStorage without a keyring, where the checkbox is replaced by a note.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROOT, activeDocState, fixturePath, launch, runCommand, waitForRender } from './helpers'

test.skip(!!process.env.FARTCROBAT_EXECUTABLE, 'packaged builds have no test cipher')

const TEST_CIPHER = { FARTCROBAT_TEST_SECRET_CIPHER: '1' }
/** launch() turns remembering off for every other spec. */
const REMEMBER_ON = { rememberPasswords: true }
const REMEMBER = 'Remember password on this device'
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/saved-passwords-${name}.png` })

/** A dialog by its title (the dialog frame has no accessible name). */
function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

async function openPath(page: Page, path: string) {
  await page.evaluate((p) => void (window as any).__fartcrobat.openPaths([p]), path)
}

/** A copy of a fixture in a new folder (the folder and file names never contain the password). */
function tempCopy(fixture: string, name = 'contract.pdf'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-pw-'))
  const path = join(dir, name)
  copyFileSync(fixturePath(fixture), path)
  return path
}

async function closeAll(page: Page) {
  await runCommand(page, 'file.close')
  await expect(page.locator('.home-title')).toBeVisible()
}

async function expectOpenedWithoutPrompt(page: Page, name: string) {
  await expect.poll(async () => (await activeDocState(page))?.title).toBe(name)
  await waitForRender(page)
  await expect(dialogTitled(page, 'Password required')).toHaveCount(0)
}

async function openPasswords(page: Page) {
  await runCommand(page, 'app.preferences')
  const prefs = dialogTitled(page, 'Preferences')
  await prefs.getByRole('button', { name: 'Passwords', exact: true }).click()
  return prefs
}

async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any
  }, path)
}

test('open, remember, reopen silently; Remove brings the prompt back; a changed password is replaced', async () => {
  const { app, page, userData } = await launch([], TEST_CIPHER, REMEMBER_ON)
  try {
    const file = tempCopy('encrypted.pdf')
    await openPath(page, file)
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('checkbox', { name: REMEMBER })).toBeChecked() // ticked by default
    await shot(page, 'prompt')
    await page.keyboard.type('secret')
    await page.keyboard.press('Enter')
    await waitForRender(page)

    // The store file holds no password and no path.
    const store = readFileSync(join(userData, 'saved-passwords.json'), 'utf8')
    const records: { secret: string }[] = JSON.parse(store).records
    expect(records).toHaveLength(1)
    const decoded = records.map(({ secret, ...rest }) => [Buffer.from(secret, 'base64').toString('latin1'), rest])
    expect(JSON.stringify(decoded)).not.toContain('secret')
    expect(store).not.toContain(file)

    // Reopen: no prompt.
    await closeAll(page)
    await openPath(page, file)
    await expectOpenedWithoutPrompt(page, 'contract.pdf')
    await closeAll(page)

    // Preferences > Passwords lists it; Remove forgets it and the next open asks again.
    const prefs = await openPasswords(page)
    const row = prefs.getByRole('row', { name: /contract\.pdf/ })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Document')
    await shot(page, 'preferences')
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(row).toHaveCount(0)
    await expect(prefs).toContainText('No passwords are saved on this device.')
    await page.keyboard.press('Escape')
    await openPath(page, file)
    await expect(prompt).toBeVisible()
    await prompt.getByLabel('Password', { exact: true }).fill('secret')
    await prompt.getByRole('button', { name: 'Open' }).click()
    await waitForRender(page)
    await closeAll(page)

    // The file is protected again with another password (same /ID[0]): the prompt comes back and
    // says why; the new password is remembered in place of the old one.
    copyFileSync(fixturePath('saved-passwords/encrypted-changed.pdf'), file)
    await openPath(page, file)
    await expect(prompt).toContainText('no longer opens it')
    await page.keyboard.type('changed')
    await page.keyboard.press('Enter')
    await waitForRender(page)
    await closeAll(page)
    await openPath(page, file)
    await expectOpenedWithoutPrompt(page, 'contract.pdf')
    await closeAll(page)

    // The old password still opens copies of the old file, so both are listed. Remove All.
    const again = await openPasswords(page)
    await expect(again.getByRole('row', { name: /contract\.pdf/ })).toHaveCount(2)
    await again.getByRole('button', { name: 'Remove All' }).click()
    const sure = dialogTitled(page, 'Remove all saved passwords?')
    await sure.getByRole('button', { name: 'Remove All' }).click()
    await expect(again).toContainText('No passwords are saved on this device.')
    expect(existsSync(join(userData, 'saved-passwords.json'))).toBe(false)
  } finally {
    await app.close()
  }
})

test('unticking the checkbox stores nothing, even after a wrong password, and is kept as the default', async () => {
  const { app, page, userData } = await launch([], TEST_CIPHER, REMEMBER_ON)
  try {
    const file = tempCopy('encrypted.pdf')
    await openPath(page, file)
    const prompt = dialogTitled(page, 'Password required')
    await prompt.getByRole('checkbox', { name: REMEMBER }).uncheck()
    // A typo first: the prompt that asks again keeps the box unticked.
    await prompt.getByLabel('Password', { exact: true }).fill('wrong')
    await prompt.getByRole('button', { name: 'Open' }).click()
    await expect(prompt).toContainText('is incorrect')
    await expect(prompt.getByRole('checkbox', { name: REMEMBER })).not.toBeChecked()
    await prompt.getByLabel('Password', { exact: true }).fill('secret')
    await prompt.getByRole('button', { name: 'Open' }).click()
    await waitForRender(page)
    expect(existsSync(join(userData, 'saved-passwords.json'))).toBe(false)
    await closeAll(page)
    await openPath(page, file)
    await expect(prompt.getByRole('checkbox', { name: REMEMBER })).not.toBeChecked()
  } finally {
    await app.close()
  }
})

test('Protect remembers the new password; the panel shows it saved; Forget brings the prompt back', async () => {
  const { app, page } = await launch([], TEST_CIPHER, REMEMBER_ON)
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-pw-'))
    const src = join(dir, 'report.pdf')
    copyFileSync(fixturePath('text.pdf'), src)
    const protectedPath = join(dir, 'report-protected.pdf')
    await openPath(page, src)
    await waitForRender(page)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('protect.encrypt'))
    const dialog = dialogTitled(page, 'Protect using password')
    await expect(dialog.getByRole('checkbox', { name: REMEMBER })).toBeChecked()
    await page.getByTestId('protect-open-password').fill('open-me')
    await page.getByTestId('protect-open-confirm').fill('open-me')
    await stubSaveDialog(app, protectedPath)
    await page.getByTestId('protect-apply').click()
    const done = dialogTitled(page, 'Your PDF is protected')
    await expect(done).toContainText('It is saved on this device, so the file opens here without asking.')
    await done.getByRole('button', { name: 'OK', exact: true }).click()

    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('protect.open'))
    const saved = page.getByTestId('saved-password')
    await expect(saved).toContainText('Password saved on this device')
    await shot(page, 'protect-panel')
    await closeAll(page)
    await openPath(page, protectedPath)
    await expectOpenedWithoutPrompt(page, 'report-protected.pdf')

    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('protect.open'))
    await saved.getByRole('button', { name: 'Forget' }).click()
    await expect(saved).toHaveCount(0)
    await closeAll(page)
    await openPath(page, protectedPath)
    await expect(dialogTitled(page, 'Password required')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a Digital ID password is remembered when signing and filled in next time; signing still needs the click', async () => {
  const PASSWORD = 'Signing-Pass-42'
  const { app, page } = await launch([], TEST_CIPHER, REMEMBER_ON)
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-pw-'))
    for (const name of ['one.pdf', 'two.pdf']) copyFileSync(fixturePath('text.pdf'), join(dir, name))
    await openPath(page, join(dir, 'one.pdf'))
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('one.pdf')
    await waitForRender(page)

    await runCommand(page, 'sign.manageDigitalIds')
    const prefs = dialogTitled(page, 'Preferences')
    await prefs.getByRole('button', { name: 'Create Digital ID…' }).click()
    const create = dialogTitled(page, 'Create a Digital ID')
    await create.getByLabel('Name', { exact: true }).fill('Jane Doe')
    await create.getByLabel('Email address').fill('jane@example.com')
    await create.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await create.getByLabel('Confirm password').fill(PASSWORD)
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(create).toBeHidden({ timeout: 30_000 })
    await expect(prefs.getByRole('row', { name: /Jane Doe/ })).not.toContainText('Password saved')
    await prefs.getByRole('button', { name: 'Done' }).click()

    await app.evaluate(({ ipcMain }, p) => {
      const g = globalThis as { __saveDialogCalls?: number }
      g.__saveDialogCalls = 0
      ipcMain.removeHandler('file:saveDialog')
      ipcMain.handle('file:saveDialog', () => {
        g.__saveDialogCalls = (g.__saveDialogCalls ?? 0) + 1
        return p
      })
    }, join(dir, 'one-certified.pdf'))
    const saveDialogCalls = () => app.evaluate(() => (globalThis as { __saveDialogCalls?: number }).__saveDialogCalls ?? 0)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('sign.certifyInvisible'))
    const sign = dialogTitled(page, 'Certify with a Digital ID (invisible)')
    await expect(sign.getByRole('checkbox', { name: REMEMBER })).toBeChecked()
    await expect(sign.getByLabel('Digital ID password')).toHaveValue('')
    await sign.getByLabel('Digital ID password').fill(PASSWORD)
    await sign.getByRole('button', { name: 'Certify', exact: true }).click()
    await expect(sign).toBeHidden({ timeout: 30_000 })
    await expect.poll(async () => (await activeDocState(page))?.title, { timeout: 30_000 }).toBe('one-certified.pdf')

    // Next time the password is filled in, and nothing is signed until the person clicks.
    await openPath(page, join(dir, 'two.pdf'))
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('two.pdf')
    await waitForRender(page)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('sign.certifyInvisible'))
    await expect(sign.getByLabel('Digital ID password')).toHaveValue(PASSWORD)
    await expect(sign).toContainText('Filled in with the password saved on this device.')
    await shot(page, 'sign-dialog')
    // A stray Enter does not sign with the saved password; only the click does.
    expect(await saveDialogCalls()).toBe(1)
    await sign.getByLabel('Digital ID password').press('Enter')
    await expect(sign.getByRole('button', { name: 'Certify', exact: true })).toBeEnabled()
    await sign.getByRole('button', { name: 'Cancel' }).click()
    await expect(sign).toBeHidden()
    expect((await activeDocState(page))?.dirty).toBe(false)
    expect(await saveDialogCalls()).toBe(1)

    const passwords = await openPasswords(page)
    await expect(passwords.getByRole('row', { name: /Jane Doe/ })).toContainText('Digital ID')
    await passwords.getByRole('button', { name: 'Digital IDs', exact: true }).click()
    await expect(passwords.getByRole('row', { name: /Jane Doe/ })).toContainText('Password saved')
  } finally {
    await app.close()
  }
})

test('machine policy turns remembering off: no checkbox, and saved passwords are removed at start-up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-policy-'))
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ rememberPasswords: { enabled: false } }))
  const userData = mkdtempSync(join(tmpdir(), 'fartcrobat-e2e-'))
  writeFileSync(join(userData, 'saved-passwords.json'), JSON.stringify({ version: 1, records: [] }))
  const { app, page } = await launch([], { ...TEST_CIPHER, FARTCROBAT_POLICY_FILE: policy, FARTCROBAT_USER_DATA: userData }, REMEMBER_ON)
  try {
    await expect.poll(() => existsSync(join(userData, 'saved-passwords.json'))).toBe(false)
    await openPath(page, tempCopy('encrypted.pdf'))
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('checkbox')).toHaveCount(0)
    await page.keyboard.press('Escape')
    const prefs = await openPasswords(page)
    await expect(prefs.getByRole('switch', { name: 'Remember passwords on this device' })).toBeDisabled()
    await expect(prefs).toContainText('Your organization turned this off for this computer')
  } finally {
    await app.close()
  }
})

test('a policy file that cannot be understood turns remembering off but keeps saved passwords', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-policy-'))
  const policy = join(dir, 'policy.json')
  // Meant to turn agent access off only; the trailing comma makes it invalid JSON.
  writeFileSync(policy, '{"agentAccess":{"enabled":false},}')
  const userData = mkdtempSync(join(tmpdir(), 'fartcrobat-e2e-'))
  const storeFile = join(userData, 'saved-passwords.json')
  const stored = JSON.stringify({ version: 1, records: [] })
  writeFileSync(storeFile, stored)
  const { app, page } = await launch([], { ...TEST_CIPHER, FARTCROBAT_POLICY_FILE: policy, FARTCROBAT_USER_DATA: userData }, REMEMBER_ON)
  try {
    await openPath(page, tempCopy('encrypted.pdf'))
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('checkbox')).toHaveCount(0)
    // The prompt asked passwords:status, which the store runs after any start-up wipe.
    expect(readFileSync(storeFile, 'utf8')).toBe(stored)
    await page.keyboard.press('Escape')
    const prefs = await openPasswords(page)
    await expect(prefs.getByRole('switch', { name: 'Remember passwords on this device' })).toBeDisabled()
    expect(existsSync(storeFile)).toBe(true)
  } finally {
    await app.close()
  }
})

test('Linux without a keyring: no checkbox, a note instead (real safeStorage)', async () => {
  test.skip(process.platform !== 'linux' || !!process.env.DBUS_SESSION_BUS_ADDRESS, 'needs a session without a Secret Service')
  const { app, page } = await launch([], {}, REMEMBER_ON)
  try {
    await openPath(page, tempCopy('encrypted.pdf'))
    const prompt = dialogTitled(page, 'Password required')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('needs GNOME Keyring or KWallet')
    await expect(prompt.getByRole('checkbox')).toHaveCount(0)
    await shot(page, 'no-keyring')
  } finally {
    await app.close()
  }
})

test('an AI app opens a file whose password is saved, without a dialog; the audit log has no password', async () => {
  const { app, page, userData } = await launch([], TEST_CIPHER, REMEMBER_ON)
  let client: Client | null = null
  try {
    const file = tempCopy('encrypted.pdf')
    await openPath(page, file)
    await dialogTitled(page, 'Password required').getByLabel('Password', { exact: true }).fill('secret')
    await page.keyboard.press('Enter')
    await waitForRender(page)
    await closeAll(page)

    // Fail loudly if a password prompt shows up at any point from here on.
    await page.evaluate(() => {
      const w = window as any
      w.__promptSeen = false
      new MutationObserver(() => {
        if ([...document.querySelectorAll('.ui-dialog h2')].some((h) => h.textContent === 'Password required')) w.__promptSeen = true
      }).observe(document.body, { childList: true, subtree: true })
    })

    // The built MCP shim, as Claude Desktop starts it, talking to this app instance.
    await expect.poll(() => existsSync(join(userData, 'agent-access', 'endpoint.json'))).toBe(true)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'out/agent/shim.mjs')],
      env: { ...getDefaultEnvironment(), FARTCROBAT_USER_DATA: userData },
      stderr: 'pipe'
    })
    client = new Client({ name: 'saved-passwords-e2e', version: '1.0.0' })
    await client.connect(transport)
    const result = await client.callTool({ name: 'open_document', arguments: { path: file } })
    expect(result.isError).toBeFalsy()
    const data = JSON.parse((result.content as { text: string }[])[0].text)
    expect(data).toMatchObject({ handle: expect.any(String), alreadyOpen: false })
    await expectOpenedWithoutPrompt(page, 'contract.pdf')
    expect(await page.evaluate(() => (window as any).__promptSeen)).toBe(false)

    const audit = join(userData, 'agent-access', 'audit.jsonl')
    await expect.poll(() => (existsSync(audit) ? readFileSync(audit, 'utf8') : '')).toContain('open_document')
    const lines = readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.find((l) => l.tool === 'open_document')).toMatchObject({
      document: file,
      summary: 'unlocked with a password saved on this device'
    })
    expect(readFileSync(audit, 'utf8')).not.toContain('secret')

    // Pages extracted to a file keep the protection, and the saved password covers that file too.
    const extracted = join(dirname(file), 'first page.pdf')
    const extract = await client.callTool({ name: 'extract_pages', arguments: { handle: data.handle, pages: '1', path: extracted } })
    expect(extract.isError).toBeFalsy()
    const linked = await page.evaluate((p) => (window as any).api.invoke('passwords:savedFor', { kind: 'pdf', lock: null, path: p }), extracted)
    expect(linked).toMatchObject({ label: 'contract.pdf' })
    const reopened = await client.callTool({ name: 'open_document', arguments: { path: extracted } })
    expect(reopened.isError).toBeFalsy()
    await expectOpenedWithoutPrompt(page, 'first page.pdf')
    expect(await page.evaluate(() => (window as any).__promptSeen)).toBe(false)

    // Inserting or combining the remembered file needs no prompt either, and the audit lines say
    // how it was unlocked, as for open_document.
    const plain = tempCopy('text.pdf', 'plain.pdf')
    const opened = await client.callTool({ name: 'open_document', arguments: { path: plain } })
    expect(opened.isError).toBeFalsy()
    const plainHandle = JSON.parse((opened.content as { text: string }[])[0].text).handle
    const inserted = await client.callTool({
      name: 'organize_pages',
      arguments: { handle: plainHandle, operation: 'insert_file', path: file }
    })
    expect(inserted.isError).toBeFalsy()
    const combined = await client.callTool({
      name: 'combine_files',
      arguments: { paths: [file, plain], path: join(dirname(plain), 'combined.pdf') }
    })
    expect(combined.isError).toBeFalsy()
    expect(await page.evaluate(() => (window as any).__promptSeen)).toBe(false)
    const summaryOf = (tool: string) =>
      (existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []).find((l) => l.tool === tool)
        ?.summary
    await expect.poll(() => summaryOf('organize_pages')).toContain(`from ${file} (unlocked with a password saved on this device)`)
    await expect.poll(() => summaryOf('combine_files')).toContain(`${file}: unlocked with a password saved on this device`)
    expect(summaryOf('combine_files')).not.toContain(plain + ':')
    expect(readFileSync(audit, 'utf8')).not.toContain('secret')
  } finally {
    await client?.close().catch(() => {})
    await app.close()
  }
})
