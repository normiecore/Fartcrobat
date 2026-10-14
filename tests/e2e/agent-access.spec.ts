import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { SERVER_INSTRUCTIONS } from '../../src/shared/agent/protocol'
import { AGENT_TOOLS } from '../../src/shared/agent/tools'
import { activeDocState, fixturePath, waitForRender } from './helpers'
import {
  appPageText,
  dataOf,
  endpointFile,
  errorOf,
  expectAudit,
  startSession,
  undoLabel
} from './agent-helpers'

// Agent access end to end, the way Claude Desktop uses it: the built app with its own profile, the
// built MCP shim started over stdio by an MCP client that introduces itself as "claude-ai", and
// tool calls whose effects are checked in the app (document state, undo labels, confirmations,
// the indicator and the Agent activity panel) and in the audit log.

/** "w<window>-<load>-doc-<n>": the middle part changes whenever the window loads again. */
const HANDLE = /^w\d+-[a-z0-9]+-doc-\d+$/

// Animations finished, so dialogs are not caught fading in.
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/agent-access-${name}.png`, animations: 'disabled' })

function workDir() {
  return mkdtempSync(join(tmpdir(), 'fartcrobat-agent-'))
}

/** Selects text on a page of the active document, as dragging over it would. */
async function selectText(page: Page, pageIndex: number, needle: string) {
  await page.evaluate(
    async ({ pageIndex, needle }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const t = await d.pageText(pageIndex)
      const start = t.text.indexOf(needle)
      if (start < 0) throw new Error('text not found: ' + needle)
      d.setSelection({ kind: 'text', ranges: [{ page: pageIndex, start, end: start + needle.length }] })
    },
    { pageIndex, needle }
  )
}

/** A confirmation an agent call is waiting for: Decline must be the default (focused) button. */
async function confirmation(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Requested by Claude through agent access.')
  await expect(dialog.getByRole('button', { name: 'Decline', exact: true })).toBeFocused()
  return dialog
}

test('an AI app lists the tools, opens a document and sees what the person is looking at', async () => {
  const s = await startSession()
  try {
    const { agent, page } = s
    // tools/list: every catalogue tool, with the instructions the model gets.
    expect(agent.client.getServerVersion()).toMatchObject({ name: 'fartcrobat' })
    expect(agent.client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    const { tools } = await agent.client.listTools()
    expect(tools).toHaveLength(AGENT_TOOLS.length)
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name))

    // Nothing open yet.
    expect(dataOf(await agent.call('list_documents'))).toEqual({ documents: [] })

    const opened = dataOf(await agent.call('open_document', { path: fixturePath('text.pdf') }))
    expect(opened.handle).toMatch(HANDLE)
    expect(opened).toMatchObject({
      title: 'text.pdf',
      path: fixturePath('text.pdf'),
      pageCount: 5,
      active: true,
      alreadyOpen: false,
      unsavedChanges: false,
      encrypted: false
    })
    await waitForRender(page)
    expect((await activeDocState(page))?.title).toBe('text.pdf')
    const { documents } = dataOf(await agent.call('list_documents'))
    expect(documents).toEqual([expect.objectContaining({ handle: opened.handle, title: 'text.pdf', active: true })])
    // Opening it again returns the same tab.
    expect(dataOf(await agent.call('open_document', { path: fixturePath('text.pdf') }))).toMatchObject({
      handle: opened.handle,
      alreadyOpen: true
    })

    // The person selects text: the agent sees it, with where it is.
    await selectText(page, 0, 'quick brown fox')
    const withSelection = dataOf(await agent.call('get_context'))
    expect(withSelection).toMatchObject({
      document: { handle: opened.handle },
      lookingAtThisDocument: true,
      currentPage: 1,
      selection: { kind: 'text', text: 'quick brown fox', pages: [{ page: 1 }] }
    })
    expect(withSelection.selection.pages[0].rects).toHaveLength(1)

    // The person goes to page 3.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(2))
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(2)
    const onPage3 = dataOf(await agent.call('get_context', { handle: opened.handle }))
    expect(onPage3.currentPage).toBe(3)
    expect(onPage3.visiblePages).toContain(3)

    await expectAudit(s.userData, agent.calls, ['quick brown fox'])
  } finally {
    await s.close()
  }
})

test('find_text and add_annotations: a highlight the person can undo, the indicator and the activity panel', async () => {
  const NOTE = 'Ask Dana about the fox clause'
  const QUERY = 'quick brown fox'
  const s = await startSession()
  try {
    const { agent, page } = s
    const { handle } = dataOf(await agent.call('open_document', { path: fixturePath('text.pdf') }))
    await waitForRender(page)

    const found = dataOf(await agent.call('find_text', { query: QUERY, pages: '1' }))
    expect(found.count).toBe(1)
    expect(found.hits[0]).toMatchObject({ page: 1, text: QUERY })
    const rects: number[][] = found.hits[0].rects
    expect(rects.length).toBeGreaterThan(0)

    const added = dataOf(await agent.call('add_annotations', { handle, items: [{ type: 'highlight', page: 1, rects, text: NOTE }] }))
    expect(added.created).toEqual([{ id: expect.any(Number), page: 1, type: 'highlight' }])
    expect(added.author).toBe('Agent (Claude)')
    expect(added.undoLabel).toBe('Agent: Add Highlight')

    // The comment is in the document, on the text that was found.
    const { annotations } = dataOf(await agent.call('list_annotations', { handle }))
    expect(annotations).toEqual([
      expect.objectContaining({ id: added.created[0].id, page: 1, type: 'Highlight', text: NOTE, markedText: QUERY, author: 'Agent (Claude)' })
    ])

    // Edit > Undo names it as the agent's change.
    await expect.poll(() => undoLabel(page)).toBe(added.undoLabel)
    await expect(page.getByRole('toolbar', { name: 'Document toolbar' }).getByRole('button', { name: `Undo ${added.undoLabel}`, exact: true })).toBeEnabled()
    expect((await activeDocState(page))?.dirty).toBe(true)

    // The top bar says Claude is connected.
    const indicator = page.getByRole('button', { name: /^Claude connected/ })
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveText('Claude connected')
    await expect(indicator).toHaveAccessibleName('Claude connected. Show agent activity')
    await indicator.screenshot({ path: 'test-results/agent-access-indicator.png', animations: 'disabled' })
    await page.locator('.shell-topbar').screenshot({ path: 'test-results/agent-access-topbar.png', animations: 'disabled' })

    // Clicking it opens the Agent activity panel with the calls.
    await indicator.click()
    const activity = page.getByRole('list', { name: 'Recent agent activity' })
    await expect(activity).toBeVisible()
    const rows = activity.getByRole('listitem')
    await expect(rows).toHaveCount(agent.calls.length)
    // Newest first.
    await expect(rows.first()).toContainText('List comments and markup')
    await expect(rows.nth(1)).toContainText('Add comments and markup')
    await expect(rows.nth(1)).toContainText('text.pdf')
    await expect(rows.nth(2)).toContainText('Find text')
    await expect(page.getByRole('list', { name: 'Connected AI apps' })).toContainText('Claude')
    await expect(indicator).toHaveAttribute('aria-expanded', 'true')
    await shot(page, 'activity-panel')

    // The agent's undo works like the person's.
    const undone = dataOf(await agent.call('undo', { handle }))
    expect(undone.undone).toBe(added.undoLabel)
    await expect(rows.first()).toContainText('Undo')
    expect(dataOf(await agent.call('list_annotations', { handle })).count).toBe(0)
    await expect(rows).toHaveCount(agent.calls.length)

    const lines = await expectAudit(s.userData, agent.calls, [NOTE, QUERY])
    const add = lines.find((l) => l.tool === 'add_annotations')!
    expect(add).toMatchObject({ client: 'claude-ai', outcome: 'done', document: fixturePath('text.pdf'), summary: 'added 1 highlight' })
    expect(add.args).toEqual({ handle, items: '[not recorded]' })
    expect(lines.find((l) => l.tool === 'find_text')!.args).toEqual({ query: '[not recorded]', pages: '1' })
  } finally {
    await s.close()
  }
})

test('apply_redactions asks the person first: Decline stops it, Apply removes the text', async () => {
  const dir = workDir()
  const source = join(dir, 'invoices.pdf')
  copyFileSync(fixturePath('text.pdf'), source)
  const s = await startSession()
  try {
    const { agent, page } = s
    const { handle } = dataOf(await agent.call('open_document', { path: source }))
    await waitForRender(page)

    const marked = dataOf(await agent.call('mark_redactions', { handle, pattern: 'email' }))
    expect(marked).toMatchObject({ marked: 5, matches: 5, pages: [1, 2, 3, 4, 5] })
    expect(marked.undoLabel).toMatch(/^Agent: /)
    await expect.poll(() => undoLabel(page)).toBe(marked.undoLabel)
    expect(dataOf(await agent.call('list_annotations', { handle, types: ['Redact'] })).count).toBe(5)

    // Declined: nothing is removed and the agent is told not to retry.
    const declined = agent.start('apply_redactions', { handle })
    const dialog = await confirmation(page, 'Apply redactions?')
    await expect(dialog).toContainText('The content under 5 redaction marks on pages 1-5 of “invoices.pdf” will be removed')
    // While the call waits for the person, the indicator says Claude is working.
    await expect(page.getByRole('button', { name: 'Claude connected, working. Show agent activity' })).toBeVisible()
    await shot(page, 'confirm-redactions')
    await dialog.getByRole('button', { name: 'Decline', exact: true }).click()
    const refusal = errorOf(await declined)
    expect(refusal).toContain('[declined]')
    expect(refusal).toContain('Do not retry unless they ask')
    await expect(dialog).toBeHidden()
    expect(await appPageText(page, 0)).toContain('billing0@example.com')
    // The Agent activity panel shows that the person declined.
    await page.getByRole('button', { name: /^Claude connected/ }).click()
    const latest = page.getByRole('list', { name: 'Recent agent activity' }).getByRole('listitem').first()
    await expect(latest).toContainText('Apply redactions')
    await expect(latest).toContainText('invoices.pdf · You declined')
    expect(dataOf(await agent.call('list_annotations', { handle, types: ['Redact'] })).count).toBe(5)

    // Allowed: the marks are applied and the addresses are gone from every page.
    const applying = agent.start('apply_redactions', { handle })
    const again = await confirmation(page, 'Apply redactions?')
    await again.getByRole('button', { name: 'Apply redactions', exact: true }).click()
    const applied = dataOf(await applying)
    expect(applied).toMatchObject({ applied: 5, pages: [1, 2, 3, 4, 5] })
    expect(applied.undoLabel).toMatch(/^Agent: /)
    const text = dataOf(await agent.call('get_page_text', { handle }))
    expect(text.pages).toHaveLength(5)
    const all = JSON.stringify(text.pages)
    expect(all).not.toContain('@example.com')
    expect(all).toContain('quick brown fox')
    expect(dataOf(await agent.call('list_annotations', { handle, types: ['Redact'] })).count).toBe(0)
    await expect.poll(() => undoLabel(page)).toBe(applied.undoLabel)
    // Nothing was written to disk.
    expect(readFileSync(source)).toEqual(readFileSync(fixturePath('text.pdf')))

    const lines = await expectAudit(s.userData, agent.calls, ['billing0@example.com'])
    expect(lines.filter((l) => l.tool === 'apply_redactions').map((l) => l.outcome)).toEqual(['declined', 'done'])
  } finally {
    await s.close()
  }
})

test('save_document: a new path saves without asking, overwriting asks first', async () => {
  const dir = workDir()
  const source = join(dir, 'report.pdf')
  const copy = join(dir, 'report copy.pdf')
  copyFileSync(fixturePath('text.pdf'), source)
  const s = await startSession()
  try {
    const { agent, page } = s
    const { handle } = dataOf(await agent.call('open_document', { path: source }))
    await waitForRender(page)
    dataOf(await agent.call('set_metadata', { handle, title: 'Quarterly report' }))
    expect((await activeDocState(page))?.dirty).toBe(true)

    // Save as a new file: no dialog, the tab now shows that file.
    const saved = dataOf(await agent.call('save_document', { handle, path: copy }))
    expect(saved).toMatchObject({ handle, saved: copy, title: 'report copy.pdf', path: copy, unsavedChanges: false })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(existsSync(copy)).toBe(true)
    expect(readFileSync(copy).subarray(0, 5).toString()).toBe('%PDF-')
    expect(new mupdf.PDFDocument(new Uint8Array(readFileSync(copy))).getMetaData('info:Title')).toBe('Quarterly report')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('report copy.pdf')
    expect(await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.filePath)).toBe(copy)
    await expect(page.locator('.shell-tab', { hasText: 'report copy.pdf' })).toBeVisible()
    // The original is untouched.
    expect(readFileSync(source)).toEqual(readFileSync(fixturePath('text.pdf')))

    // Save over the file: the person is asked; Decline keeps the file as it was.
    dataOf(await agent.call('add_annotations', { handle, items: [{ type: 'note', page: 1, rect: [72, 72, 92, 92], text: 'Checked' }] }))
    const before = readFileSync(copy)
    const declined = agent.start('save_document', { handle })
    const dialog = await confirmation(page, 'Save over the file?')
    await expect(dialog).toContainText(copy)
    await shot(page, 'confirm-save')
    // Enter takes the default button: Decline.
    await page.keyboard.press('Enter')
    expect(errorOf(await declined)).toContain('[declined]')
    expect(readFileSync(copy)).toEqual(before)
    expect((await activeDocState(page))?.dirty).toBe(true)

    // Allowed: saved over the file.
    const saving = agent.start('save_document', { handle })
    const again = await confirmation(page, 'Save over the file?')
    await again.getByRole('button', { name: 'Save', exact: true }).click()
    expect(dataOf(await saving)).toMatchObject({ saved: copy, unsavedChanges: false })
    expect(readFileSync(copy)).not.toEqual(before)
    expect((await activeDocState(page))?.dirty).toBe(false)

    const lines = await expectAudit(s.userData, agent.calls, ['Quarterly report', 'Checked'])
    expect(lines.filter((l) => l.tool === 'save_document').map((l) => [l.outcome, l.args.path ?? null])).toEqual([
      ['done', copy],
      ['declined', null],
      ['done', null]
    ])
  } finally {
    await s.close()
  }
})

test('open_document on a protected file waits for the person to type the password, which the agent never sees', async () => {
  const PASSWORD = 'secret'
  const s = await startSession()
  try {
    const { agent, page } = s
    const opening = agent.start('open_document', { path: fixturePath('encrypted.pdf') })
    const prompt = page.getByRole('dialog', { name: 'Password required' })
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('“encrypted.pdf” is protected')
    await shot(page, 'password-prompt')
    await prompt.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await prompt.getByRole('button', { name: 'Open', exact: true }).click()
    const result = await opening
    const opened = dataOf(result)
    expect(opened.handle).toMatch(HANDLE)
    expect(opened).toMatchObject({ title: 'encrypted.pdf', encrypted: true, active: true })
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    await waitForRender(page)

    // The unlocked document is there for the agent like any other.
    const info = dataOf(await agent.call('get_document_info', { handle: opened.handle }))
    expect(info.security.encryption).toBeTruthy()
    expect(JSON.stringify(info)).not.toContain(PASSWORD)

    await expectAudit(s.userData, agent.calls, [PASSWORD])
    expect(agent.stderr()).not.toContain(PASSWORD)
  } finally {
    await s.close()
  }
})

test('a call still waiting for the person answers still_running; wait_for_result returns what the person chose', async () => {
  // Packaged builds ignore FARTCROBAT_AGENT_WAIT_MS and always wait about 45 s.
  test.skip(!!process.env.FARTCROBAT_EXECUTABLE, 'needs the shorter wait of an unpackaged build')
  const dir = workDir()
  const source = join(dir, 'minutes.pdf')
  copyFileSync(fixturePath('text.pdf'), source)
  // The window answers still_running after 2.5 s instead of 45 s (AI apps give up after about 60 s).
  const s = await startSession([source], { FARTCROBAT_AGENT_WAIT_MS: '2500' })
  try {
    const { agent, page } = s
    await waitForRender(page)
    const [{ handle }] = dataOf(await agent.call('list_documents')).documents

    // The person takes longer than the AI app waits: the call answers with a ticket while the
    // confirmation stays open.
    const saving = agent.start('save_document', { handle })
    const dialog = await confirmation(page, 'Save over the file?')
    // Only one question at a time: a second call is told the person is busy.
    expect(errorOf(await agent.call('save_document', { handle }))).toMatch(/^\[busy\] /)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    const answered = dataOf(await saving)
    expect(answered).toEqual({ status: 'still_running', ticket: expect.stringMatching(/^w\d+-t\d+-[a-z0-9]+$/), message: expect.any(String) })
    await expect(dialog).toBeVisible()
    await shot(page, 'still-running')

    // The person answers now; the agent collects the result with the ticket, once.
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    let saved = dataOf(await agent.call('wait_for_result', { ticket: answered.ticket }))
    // As an agent does: ask again while it says still_running (a slow disk).
    for (let i = 0; i < 5 && saved.status === 'still_running'; i++) saved = dataOf(await agent.call('wait_for_result', { ticket: answered.ticket }))
    expect(saved).toMatchObject({ handle, saved: source, unsavedChanges: false })
    expect(errorOf(await agent.call('wait_for_result', { ticket: answered.ticket }))).toMatch(/^\[invalid_args\] /)
    // The activity panel shows the save as done once the person answered, and the refused call.
    await page.getByRole('button', { name: /^Claude connected/ }).click()
    const rows = page.getByRole('list', { name: 'Recent agent activity' }).getByRole('listitem')
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toContainText('minutes.pdf · Failed')
    await expect(rows.nth(1)).toContainText('Save')
    await expect(rows.nth(1).locator('svg[aria-label="Done"]')).toBeVisible()

    // The agent can stop a call it no longer wants: the confirmation closes without saving.
    const before = readFileSync(source)
    const again = agent.start('save_document', { handle })
    const second = await confirmation(page, 'Save over the file?')
    const { ticket } = dataOf(await again)
    expect(errorOf(await agent.call('wait_for_result', { ticket, cancel: true }))).toBe('[aborted] The call was cancelled.')
    await expect(second).toBeHidden()
    expect(readFileSync(source)).toEqual(before)

    const lines = await expectAudit(s.userData, agent.calls)
    // The refused call may be logged before or after the first one answered still_running.
    const busy = lines.filter((l) => l.error === 'busy')
    expect(busy.map((l) => [l.tool, l.outcome])).toEqual([['save_document', 'error']])
    const rest = lines.filter((l) => l.error !== 'busy' && !(l.tool === 'wait_for_result' && l.outcome === 'pending'))
    expect(rest.map((l) => [l.tool, l.outcome, l.summary ?? null])).toEqual([
      ['list_documents', 'done', null],
      ['save_document', 'pending', `still running, ticket ${answered.ticket}`],
      ['wait_for_result', 'done', `save_document: saved to ${source}`],
      ['wait_for_result', 'error', null],
      ['save_document', 'pending', `still running, ticket ${ticket}`],
      ['wait_for_result', 'cancelled', 'save_document']
    ])
    expect(rest[2]).toMatchObject({ args: { ticket: answered.ticket }, document: source })
  } finally {
    await s.close()
  }
})

test('handles from before the window reloaded are stale, even where the same tab number is open again', async () => {
  const s = await startSession()
  try {
    const { agent, page } = s
    const before = dataOf(await agent.call('open_document', { path: fixturePath('text.pdf') }))
    await waitForRender(page)
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!(window as any).__fartcrobat)).toBe(true)
    const after = dataOf(await agent.call('open_document', { path: fixturePath('form.pdf') }))
    expect(after.handle).toMatch(HANDLE)
    expect(after.handle).not.toBe(before.handle)
    // Same window, and the first tab of this load: only the load part tells them apart.
    expect(after.handle.replace(/-[a-z0-9]+-/, '-')).toBe(before.handle.replace(/-[a-z0-9]+-/, '-'))
    expect(errorOf(await agent.call('get_document_info', { handle: before.handle }))).toMatch(/^\[stale_handle\] /)
    expect(dataOf(await agent.call('get_document_info', { handle: after.handle })).title).toBe('form.pdf')
    await expectAudit(s.userData, agent.calls)
  } finally {
    await s.close()
  }
})

test('Disconnect keeps the AI app out until the person allows it again', async () => {
  const s = await startSession()
  try {
    const { agent, page, userData } = s
    expect(dataOf(await agent.call('list_documents'))).toEqual({ documents: [] })
    const indicator = page.getByRole('button', { name: /^Claude connected/ })
    await indicator.click()
    const activity = page.getByRole('dialog', { name: 'Agent activity' })
    await activity.getByRole('list', { name: 'Connected AI apps' }).getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(indicator).toBeHidden()

    // The AI app is told why, and does not get back in on its next call.
    expect(errorOf(await agent.call('list_documents'))).toContain('The person disconnected this AI app in Fartcrobat')
    await expect(indicator).toBeHidden()

    // Preferences lists it, and lets it back in.
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.preferences'))
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await prefs.getByRole('button', { name: 'AI apps', exact: true }).click()
    const blocked = prefs.getByRole('list', { name: 'Disconnected AI apps' })
    await expect(blocked).toContainText('Claude')
    await shot(page, 'preferences-disconnected')
    await blocked.getByRole('button', { name: 'Allow again', exact: true }).click()
    await expect(blocked).toBeHidden()
    expect(dataOf(await agent.call('list_documents'))).toEqual({ documents: [] })
    await expect(prefs.getByRole('list', { name: 'Connected AI apps' })).toContainText('Claude')

    // The refused call never reached a window.
    const lines = await expectAudit(userData, ['list_documents', 'list_documents'])
    expect(lines[0].connection).not.toBe(lines[1].connection)
  } finally {
    await s.close()
  }
})

test('render_page returns a picture; set_form_values fills a field', async () => {
  const NAME = 'Ada Lovelace-Byron'
  const s = await startSession()
  try {
    const { agent, page } = s
    const text = dataOf(await agent.call('open_document', { path: fixturePath('text.pdf') }))
    await waitForRender(page)
    const rendered = await agent.call('render_page', { handle: text.handle, page: 1, dpi: 72 })
    expect(rendered.isError).toBeFalsy()
    const image = rendered.content.find((c) => c.type === 'image')
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
    const png = Buffer.from(image!.data!, 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(612)
    expect(png.readUInt32BE(20)).toBe(792)
    expect(JSON.parse(rendered.content[0].text!)).toMatchObject({ page: 1, width: 612, height: 792, dpi: 72 })

    const form = dataOf(await agent.call('open_document', { path: fixturePath('form.pdf') }))
    await waitForRender(page)
    const before = dataOf(await agent.call('list_form_fields', { handle: form.handle }))
    expect(before.fields.find((f: any) => f.name === 'fullName')).toMatchObject({ type: 'text', value: '' })
    const filled = dataOf(await agent.call('set_form_values', { handle: form.handle, values: [{ name: 'fullName', value: NAME }, { name: 'subscribe', value: true }] }))
    expect(filled.filled).toEqual(['fullName', 'subscribe'])
    expect(filled.undoLabel).toMatch(/^Agent: /)
    const after = dataOf(await agent.call('list_form_fields', { handle: form.handle }))
    expect(after.fields.find((f: any) => f.name === 'fullName')).toMatchObject({ value: NAME })
    expect(after.fields.find((f: any) => f.name === 'subscribe')).toMatchObject({ checked: true })
    await expect.poll(() => undoLabel(page)).toBe(filled.undoLabel)
    await shot(page, 'form-filled')

    await expectAudit(s.userData, agent.calls, [NAME])
  } finally {
    await s.close()
  }
})

test('turning agent access off in Preferences refuses calls and removes the endpoint; turning it on again works', async () => {
  const s = await startSession()
  try {
    const { agent, page, userData } = s
    expect(dataOf(await agent.call('list_documents'))).toEqual({ documents: [] })
    const indicator = page.getByRole('button', { name: /^Claude connected/ })
    await expect(indicator).toBeVisible()

    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.preferences'))
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await prefs.getByRole('button', { name: 'AI apps', exact: true }).click()
    const toggle = prefs.getByRole('switch', { name: 'Allow AI apps to work with your documents' })
    // The switch is drawn over its (invisible) checkbox: the person clicks the switch or its label.
    const flip = () => prefs.getByText('Allow AI apps to work with your documents', { exact: true }).click()
    await expect(toggle).toBeChecked()
    await expect(prefs.getByRole('list', { name: 'Connected AI apps' })).toContainText('Claude')
    await shot(page, 'preferences-on')

    await flip()
    await expect(toggle).not.toBeChecked()
    await expect.poll(() => existsSync(endpointFile(userData))).toBe(false)
    await expect(indicator).toBeHidden()
    await expect(prefs).toContainText('No AI app is connected.')
    await shot(page, 'preferences-off')

    const refused = errorOf(await agent.call('list_documents'))
    expect(refused).toBe('[disabled] Agent access is turned off in Fartcrobat (Preferences > AI apps).')

    await flip()
    await expect(toggle).toBeChecked()
    await expect.poll(() => existsSync(endpointFile(userData))).toBe(true)
    expect(dataOf(await agent.call('list_documents'))).toEqual({ documents: [] })
    await expect(indicator).toBeVisible()
    await expect(prefs.getByRole('list', { name: 'Connected AI apps' })).toContainText('Claude')
    await shot(page, 'preferences-on-again')

    // The refused call never reached the app, so it has no audit line. (With no endpoint, the shim
    // read app.json, saw agent access marked off, and answered without starting the app.)
    const lines = await expectAudit(userData, ['list_documents', 'list_documents'])
    expect(lines.map((l) => [l.client, l.outcome])).toEqual([
      ['claude-ai', 'done'],
      ['claude-ai', 'done']
    ])
    expect(lines[0].connection).not.toBe(lines[1].connection)
  } finally {
    await s.close()
  }
})
