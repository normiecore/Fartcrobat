/**
 * Certificate encryption (PDF public-key security, /Adobe.PubSec). The test Digital IDs and files are
 * in tests/fixtures/passwordless/ (make_pubsec.py; the keys are for tests only). Digital IDs are put
 * in the test profile's settings before the app starts, as Preferences > Digital IDs would list them.
 * Remembering uses the test cipher (FARTCROBAT_TEST_SECRET_CIPHER=1), which packaged builds ignore,
 * so the file is skipped with FARTCROBAT_EXECUTABLE. The Windows certificate store test runs the
 * helper with PowerShell 7 on Linux against a private test store, and skips without pwsh.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, activeDocState, fixturePath, launch, runCommand, waitForRender } from './helpers'

test.skip(!!process.env.FARTCROBAT_EXECUTABLE, 'packaged builds have no test cipher')

const TEST_CIPHER = { FARTCROBAT_TEST_SECRET_CIPHER: '1' }
const FIX = 'passwordless'
const PKI = fixturePath(`${FIX}/pki`)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/certificate-encryption-${name}.png` })

/** A dialog by its title (the dialog frame has no accessible name). */
function dialogTitled(page: Page, title: string | RegExp) {
  return page.locator('.ui-dialog').filter({ has: page.getByRole('heading', { name: title, exact: typeof title === 'string' }) })
}

/** A Digital ID as Preferences > Digital IDs stores it ('digital-signatures:ids'), from the fixture PKI. */
function digitalId(name: string, label: string, dir: string) {
  const der = readFileSync(join(PKI, `${name}.cer`))
  const path = join(dir, `${name}.p12`)
  copyFileSync(join(PKI, `${name}.p12`), path)
  return {
    id: createHash('sha256').update(der).digest('hex').toUpperCase(),
    path,
    name: label,
    email: '',
    organization: 'Fartcrobat Test Keys',
    issuer: 'Fartcrobat Test CA',
    notBefore: '2025-01-01T00:00:00.000Z',
    notAfter: '2045-01-01T00:00:00.000Z',
    keyType: 'RSA 2048',
    certificate: der.toString('base64'),
    selfSigned: false,
    createdByApp: false,
    addedAt: 0
  }
}

/** Launches with the given Digital IDs listed, remembering on (test cipher). */
async function launchWithIds(ids: { name: string; label: string }[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-ids-'))
  return launch([], { ...TEST_CIPHER, ...env }, {
    rememberPasswords: true,
    kv: { 'digital-signatures:ids': ids.map((i) => digitalId(i.name, i.label, dir)) }
  })
}

/** A copy of a fixture in a new folder. */
function tempCopy(fixture: string, name: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'fartcrobat-cert-')), name)
  copyFileSync(fixturePath(`${FIX}/${fixture}`), path)
  return path
}

/** Starts a command that may open a dialog, without waiting for it to finish. */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => void (window as any).__fartcrobat.runCommand(c), id)
}

async function openPath(page: Page, path: string) {
  await page.evaluate((p) => void (window as any).__fartcrobat.openPaths([p]), path)
}

async function closeActive(page: Page) {
  await runCommand(page, 'file.close')
}

async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any
  }, path)
}

async function stubOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as any
  }, paths)
}

/** Fails the test if a Digital ID password prompt shows up from here on. */
async function watchForPrompts(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__promptSeen = false
    new MutationObserver(() => {
      const titles = [...document.querySelectorAll('.ui-dialog h2')].map((h) => h.textContent)
      if (titles.some((t) => t === 'Digital ID password' || t === 'Password required')) w.__promptSeen = true
    }).observe(document.body, { childList: true, subtree: true })
  })
}

const promptSeen = (page: Page) => page.evaluate(() => (window as any).__promptSeen as boolean)

async function expectOpened(page: Page, title: string) {
  await expect.poll(async () => (await activeDocState(page))?.title).toBe(title)
  await waitForRender(page)
}

/** Engine facts of the active document. */
function activeInfo(page: Page) {
  return page.evaluate(() => {
    const doc = (window as any).__fartcrobat.getActiveDoc()
    const info = doc.state.info
    return {
      security: info.security as string | null,
      encryption: info.encryption as string | null,
      permissions: info.permissions as Record<string, boolean>,
      title: info.metadata.title as string,
      unlock: doc.state.unlock ? { method: doc.state.unlock.method, access: doc.state.unlock.access, via: doc.state.unlock.via ?? null } : null
    }
  })
}

/** Bytes a certificate-encrypted file written by Fartcrobat must (not) contain. */
function expectCertificateFile(path: string) {
  const text = readFileSync(path).toString('latin1')
  expect(text).toContain('/Adobe.PubSec')
  expect(text).not.toMatch(/\/Filter\s*\/Standard/)
  expect(text).not.toContain('Hello secret world')
}

test('a Digital ID opens a certificate-encrypted file; the password is remembered; edits save back encrypted', async () => {
  const { app, page } = await launchWithIds([{ name: 'alice', label: 'Alice Test' }])
  try {
    const file = tempCopy('text-v5.pdf', 'report.pdf')
    await openPath(page, file)
    const prompt = dialogTitled(page, 'Digital ID password')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Alice Test')
    await expect(prompt.getByRole('checkbox', { name: 'Remember password on this device' })).toBeChecked()
    await shot(page, 'digital-id-prompt')
    await prompt.getByLabel('Password', { exact: true }).fill('wrong')
    await page.keyboard.press('Enter')
    await expect(prompt).toContainText('incorrect')
    await prompt.getByLabel('Password', { exact: true }).fill('alice-pass')
    await page.keyboard.press('Enter')
    await expectOpened(page, 'report.pdf')
    const info = await activeInfo(page)
    expect(info.security).toBe('certificate')
    expect(info.encryption).toContain('Adobe.PubSec')
    expect(info.unlock).toMatchObject({ method: 'certificate', access: 'owner', via: { source: 'digital-id', label: 'Alice Test' } })

    // The Protect panel says how the file is protected and which key opened it.
    await runCommand(page, 'protect.open')
    await expect(page.getByTestId('security-status')).toContainText('Certificate security')
    await expect(page.getByTestId('certificate-facts')).toContainText('Alice Test')
    await shot(page, 'protect-panel')

    // An edit is saved back with the same certificate security, and the file reopens silently.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.setMetadata({ title: 'Edited title' }))
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await runCommand(page, 'file.save')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    expectCertificateFile(file)
    await closeActive(page)
    await expect(page.locator('.home-title')).toBeVisible()

    await watchForPrompts(page)
    await openPath(page, file)
    await expectOpened(page, 'report.pdf')
    expect(await promptSeen(page)).toBe(false)
    expect((await activeInfo(page)).title).toBe('Edited title')
    expect((await activeInfo(page)).unlock?.via).toMatchObject({ savedPassword: true })

    // Revert reads the file again with the key the tab already has.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.setMetadata({ title: 'Not saved' }))
    await startCommand(page, 'file.revert')
    await dialogTitled(page, 'Revert').getByRole('button', { name: 'Revert' }).click()
    await expect.poll(async () => (await activeInfo(page)).title).toBe('Edited title')
    expect(await promptSeen(page)).toBe(false)
  } finally {
    await app.close()
  }
})

test('a file for someone else says who it is for and offers to add a Digital ID', async () => {
  const { app, page } = await launchWithIds([{ name: 'alice', label: 'Alice Test' }])
  try {
    await openPath(page, tempCopy('stranger-only.pdf', 'not-mine.pdf'))
    const dialog = dialogTitled(page, 'Cannot open “not-mine.pdf”')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('None of your certificates or Digital IDs can open it')
    await expect(dialog).toContainText('Fartcrobat Test CA')
    await expect(dialog.getByRole('button', { name: 'Add Digital ID…' })).toBeVisible()
    await shot(page, 'no-match')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.length)).toBe(0)
  } finally {
    await app.close()
  }
})

test('a restricted recipient gets the permissions of their envelope; signing is disabled with the reason', async () => {
  const { app, page } = await launchWithIds([{ name: 'alice', label: 'Alice Test' }])
  try {
    // v5-two-envelopes: Bob has full access, Alice may only print.
    await openPath(page, tempCopy('v5-two-envelopes.pdf', 'print-only.pdf'))
    const prompt = dialogTitled(page, 'Digital ID password')
    await prompt.getByLabel('Password', { exact: true }).fill('alice-pass')
    await page.keyboard.press('Enter')
    await expectOpened(page, 'print-only.pdf')
    const info = await activeInfo(page)
    expect(info.unlock?.access).toBe('user')
    expect(info.permissions).toMatchObject({ print: true, edit: false, copy: false, annotate: false })

    // "Use a certificate" lists the signing tools disabled, with the reason.
    await startCommand(page, 'sign.useCertificate')
    await expect(page.getByText('Signing certificate-encrypted documents is not supported yet')).toBeVisible()
    await expect(page.getByRole('button', { name: /Digitally sign/ })).toBeDisabled()
    await shot(page, 'signing-disabled')
  } finally {
    await app.close()
  }
})

test('saving a signed certificate-encrypted file warns that its signatures will no longer validate', async () => {
  const { app, page } = await launchWithIds([{ name: 'alice', label: 'Alice Test' }])
  try {
    const file = tempCopy('v5-signed.pdf', 'signed.pdf')
    await openPath(page, file)
    const prompt = dialogTitled(page, 'Digital ID password')
    await prompt.getByLabel('Password', { exact: true }).fill('alice-pass')
    await page.keyboard.press('Enter')
    await expectOpened(page, 'signed.pdf')
    const before = readFileSync(file)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.setMetadata({ title: 'Changed' }))
    await startCommand(page, 'file.save')
    const warn = dialogTitled(page, 'Invalidate signatures?')
    await expect(warn).toBeVisible()
    await expect(warn).toContainText('Saving will invalidate 1 signature')
    await shot(page, 'signature-warning')
    await warn.getByRole('button', { name: 'Cancel' }).click()
    expect(Buffer.compare(readFileSync(file), before)).toBe(0)
    await startCommand(page, 'file.save')
    await dialogTitled(page, 'Invalidate signatures?').getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    expectCertificateFile(file)
  } finally {
    await app.close()
  }
})

test('Encrypt with Certificate for two recipients: each one opens the file with their own Digital ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-cert-'))
  const plain = join(dir, 'plain.pdf')
  copyFileSync(fixturePath('text.pdf'), plain)
  const encrypted = join(dir, 'for-alice-and-bob.pdf')
  {
    const { app, page } = await launchWithIds([{ name: 'alice', label: 'Alice Test' }])
    try {
      await openPath(page, plain)
      await expectOpened(page, 'plain.pdf')
      await startCommand(page, 'protect.encryptCertificate')
      const dialog = page.getByTestId('cert-encrypt-dialog')
      await expect(dialog).toBeVisible()
      // The person's own Digital ID is a recipient already.
      await expect(dialog.getByTestId('cert-recipient')).toHaveCount(1)
      await expect(dialog.getByTestId('cert-recipient').first()).toContainText('Alice Test')
      await dialog.getByTestId('cert-add-recipients').click()
      const picker = dialogTitled(page, 'Add recipients')
      await picker.getByRole('radio', { name: 'Certificate files' }).check()
      await stubOpenDialog(app, [join(PKI, 'bob.cer')])
      await picker.getByRole('button', { name: 'Choose Certificate Files…' }).click()
      await expect(picker.getByTestId('cert-pick-row')).toContainText('Bob')
      await page.getByTestId('cert-pick-add').click()
      await expect(dialog.getByTestId('cert-recipient')).toHaveCount(2)
      await shot(page, 'encrypt-dialog')
      await stubSaveDialog(app, encrypted)
      await page.getByTestId('cert-encrypt-apply').click()
      await expect(page.getByTestId('cert-encrypt-summary')).toBeVisible()
      await shot(page, 'encrypt-summary')
      await page.keyboard.press('Enter')
      expectCertificateFile(encrypted)
      // The tab reopened from the new file without asking, as its creator.
      await expect.poll(async () => (await activeInfo(page)).security).toBe('certificate')
      expect((await activeInfo(page)).unlock).toMatchObject({ method: 'certificate', access: 'owner' })
    } finally {
      await app.close()
    }
  }
  for (const [name, label, password] of [
    ['alice', 'Alice Test', 'alice-pass'],
    ['bob', 'Bob Tëst', 'bob-pass']
  ]) {
    const { app, page } = await launchWithIds([{ name, label }])
    try {
      await openPath(page, encrypted)
      const prompt = dialogTitled(page, 'Digital ID password')
      await expect(prompt).toContainText(label)
      await prompt.getByLabel('Password', { exact: true }).fill(password)
      await page.keyboard.press('Enter')
      await expectOpened(page, 'for-alice-and-bob.pdf')
      expect((await activeInfo(page)).unlock).toMatchObject({ method: 'certificate', via: { label } })
    } finally {
      await app.close()
    }
  }
})

test('an agent opens a certificate-encrypted file silently with a remembered Digital ID; the audit line names the ID and no secret', async () => {
  const { app, page, userData } = await launchWithIds([{ name: 'alice', label: 'Alice Test' }])
  let client: Client | null = null
  try {
    const file = tempCopy('text-v5.pdf', 'agent.pdf')
    // The person opens it once and leaves "Remember password on this device" ticked.
    await openPath(page, file)
    await dialogTitled(page, 'Digital ID password').getByLabel('Password', { exact: true }).fill('alice-pass')
    await page.keyboard.press('Enter')
    await expectOpened(page, 'agent.pdf')
    await closeActive(page)
    await expect(page.locator('.home-title')).toBeVisible()
    await watchForPrompts(page)

    await expect.poll(() => existsSync(join(userData, 'agent-access', 'endpoint.json'))).toBe(true)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'out/agent/shim.mjs')],
      env: { ...getDefaultEnvironment(), FARTCROBAT_USER_DATA: userData },
      stderr: 'pipe'
    })
    client = new Client({ name: 'certificate-encryption-e2e', version: '1.0.0' })
    await client.connect(transport)
    const result = await client.callTool({ name: 'open_document', arguments: { path: file } })
    expect(result.isError).toBeFalsy()
    const data = JSON.parse((result.content as { text: string }[])[0].text)
    await expectOpened(page, 'agent.pdf')
    expect(await promptSeen(page)).toBe(false)

    // Pages extracted to a new tab keep the certificate security and open with the same key.
    const extract = await client.callTool({ name: 'extract_pages', arguments: { handle: data.handle, pages: '1-2' } })
    expect(extract.isError).toBeFalsy()
    await expect.poll(async () => (await activeInfo(page)).security).toBe('certificate')
    expect((await activeInfo(page)).unlock?.method).toBe('source')
    expect(await promptSeen(page)).toBe(false)

    const audit = join(userData, 'agent-access', 'audit.jsonl')
    await expect.poll(() => (existsSync(audit) ? readFileSync(audit, 'utf8') : '')).toContain('open_document')
    const lines = readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.find((l) => l.tool === 'open_document')).toMatchObject({
      document: file,
      summary: 'opened with Digital ID Alice Test (password saved on this device)'
    })
    const text = readFileSync(audit, 'utf8')
    expect(text).not.toContain('alice-pass')
    const seed = JSON.parse(readFileSync(fixturePath(`${FIX}/expected.json`), 'utf8')).files.find((f: { file: string }) => f.file === 'text-v5.pdf')
      .seedHex.alice as string
    expect(text.toLowerCase()).not.toContain(seed)
  } finally {
    await client?.close().catch(() => {})
    await app.close()
  }
})

/** pwsh on this machine, when it runs. */
function powershell(): string | null {
  for (const p of [process.env.PWSH, '/usr/local/bin/pwsh', '/usr/bin/pwsh'].filter(Boolean) as string[]) {
    try {
      execFileSync(p, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 60_000 })
      return p
    } catch {}
  }
  return null
}

test('the Windows certificate store opens a file without a prompt (helper run with PowerShell 7 and a private test store)', async () => {
  test.skip(process.platform === 'win32', 'on Windows the helper uses the real store (see certkeys-winstore.test.ts)')
  const pwsh = powershell()
  test.skip(!pwsh, 'needs PowerShell (pwsh)')
  // A private .NET store: HOME decides where .NET on Linux keeps CurrentUser\My.
  const home = mkdtempSync(join(tmpdir(), 'fartcrobat-store-'))
  execFileSync(
    pwsh!,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixturePath(`${FIX}/winstore/import_store.ps1`), '-Pki', join(PKI, 'winstore')],
    { env: { ...process.env, HOME: home }, stdio: 'ignore', timeout: 120_000 }
  )
  const { app, page } = await launch([], { FARTCROBAT_TEST_POWERSHELL: pwsh!, FARTCROBAT_TEST_POWERSHELL_HOME: home })
  try {
    await watchForPrompts(page)
    const file = tempCopy('v5-classic.pdf', 'store.pdf')
    await openPath(page, file)
    await expectOpened(page, 'store.pdf')
    expect(await promptSeen(page)).toBe(false)
    const info = await activeInfo(page)
    expect(info.unlock).toMatchObject({ method: 'certificate', via: { source: 'windows-store', hardware: false } })
    await runCommand(page, 'protect.open')
    await expect(page.getByTestId('certificate-facts')).toContainText('Windows certificate store')
    await shot(page, 'windows-store')
  } finally {
    await app.close()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
