import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/navigation-${name}.png` })

/** Calls an engine op of the active document. */
async function engine<T = unknown>(page: Page, ns: string, op: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ ns, op, args }) => {
      const ops = (window as any).__fartcrobat.getActiveDoc().ops(ns)
      return ops[op](...args)
    },
    { ns, op, args }
  ) as Promise<T>
}

async function outlineTitles(page: Page): Promise<unknown[]> {
  const tree = await engine<any[]>(page, 'navigation', 'outline')
  const map = (list: any[]): unknown[] =>
    list.map((b) => (b.children.length ? [b.title, map(b.children)] : b.title))
  return map(tree)
}

async function pageTexts(page: Page): Promise<string[]> {
  const n = (await activeDocState(page))!.pageCount
  const out: string[] = []
  for (let i = 0; i < n; i++)
    out.push(((await engine<string>(page, 'text', 'plain', i)) ?? '').split('\n')[0])
  return out
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const { useApp } = (window as any).__fartcrobat
    useApp.setState({ prefs: { ...useApp.getState().prefs, theme: t } })
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

test('page thumbnails: navigate, keyboard, reorder by drag, context menu', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.getByRole('button', { name: 'Page Thumbnails', exact: true }).click()
    const thumbs = page.locator('.fc-navigation-thumb')
    await expect(thumbs.first()).toBeVisible()
    await expect
      .poll(() => page.locator('.fc-navigation-thumb-canvas.is-ready').count())
      .toBeGreaterThanOrEqual(3)
    await shot(page, 'thumbnails')

    // click page 3
    await page.locator('.fc-navigation-thumb[data-page-index="2"]').click()
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(2)
    await expect(page.locator('.fc-navigation-thumb[data-page-index="2"]')).toHaveClass(/is-current/)

    // keyboard up/down
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(3)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(1)

    // thumbnail size
    const before = (await page.locator('.fc-navigation-thumb-canvas').first().boundingBox())!.width
    await page.locator('.fc-navigation-footer input[type=range]').fill('2')
    await expect
      .poll(async () => (await page.locator('.fc-navigation-thumb-canvas').first().boundingBox())!.width)
      .toBeGreaterThan(before + 30)
    await shot(page, 'thumbnails-large')
    await page.locator('.fc-navigation-footer input[type=range]').fill('0')

    // drag page 5 above page 1
    const scroller = page.locator('.fc-navigation-thumbs-scroll')
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
    const from = (await page.locator('.fc-navigation-thumb[data-page-index="4"]').boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 20, { steps: 4 })
    await scroller.evaluate((el) => (el.scrollTop = 0))
    const to = (await page.locator('.fc-navigation-thumb[data-page-index="0"]').boundingBox())!
    await page.mouse.move(to.x + to.width / 2, to.y + 12, { steps: 8 })
    await expect(page.locator('.fc-navigation-drop-line')).toBeVisible()
    await shot(page, 'thumbnails-drag')
    await page.mouse.up()
    await expect
      .poll(() => pageTexts(page))
      .toEqual(['Chapter 5', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4'])
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Move Page')
    // the view follows the moved page
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(0)
    await expect(page.locator('.fc-navigation-thumb[data-page-index="0"]')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.keyboard.press('Control+z')
    await expect
      .poll(() => pageTexts(page))
      .toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5'])

    // context menu: rotate page 2, then insert a blank page after it
    await page.locator('.fc-navigation-thumb[data-page-index="1"]').click({ button: 'right' })
    await shot(page, 'thumbnails-menu')
    await page.getByRole('menuitem', { name: 'Rotate Page Clockwise' }).click()
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.info.pages[1].rotation)
      )
      .toBe(90)
    await page.locator('.fc-navigation-thumb[data-page-index="1"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Insert Blank Page After' }).click()
    await expect.poll(async () => (await activeDocState(page))?.pageCount).toBe(6)
    await expect
      .poll(() => page.locator('.fc-navigation-thumb-canvas.is-ready').count())
      .toBeGreaterThanOrEqual(3)
    await shot(page, 'thumbnails-rotated')

    // delete the blank page with the keyboard, then undo everything
    await page.locator('.fc-navigation-thumb[data-page-index="2"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await activeDocState(page))?.pageCount).toBe(5)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)

    await setTheme(page, 'dark')
    await shot(page, 'thumbnails-dark')
  } finally {
    await app.close()
  }
})

test('bookmarks: navigate, add with Ctrl+B, rename, nest by drag, delete', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.getByRole('button', { name: 'Bookmarks', exact: true }).click()
    const rows = page.locator('.fc-navigation-bm-row')
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(3)).toContainText('Chapter 4')

    await page.getByRole('treeitem', { name: /Chapter 4/ }).click()
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(3)
    await expect(page.getByRole('treeitem', { name: /Chapter 4/ })).toHaveClass(/is-current/)
    await shot(page, 'bookmarks')

    // Ctrl+B adds a bookmark after the selected one and starts renaming it
    await page.keyboard.press('Control+b')
    const input = page.getByLabel('Bookmark name')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('Untitled')
    await shot(page, 'bookmarks-new')
    await input.fill('My notes')
    await input.press('Enter')
    await expect
      .poll(() => outlineTitles(page))
      .toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'My notes', 'Chapter 5'])
    expect((await activeDocState(page))?.dirty).toBe(true)

    // rename with F2
    await expect(page.getByRole('treeitem', { name: /My notes/ })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('F2')
    await page.getByLabel('Bookmark name').fill('Reading notes')
    await page.keyboard.press('Enter')
    await expect.poll(() => outlineTitles(page)).toContain('Reading notes')

    // a bookmark from selected text, at the current zoom
    await runCommand(page, 'nav.first')
    await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      return d.pageText(0).then((t: any) => {
        const s = t.text.indexOf('The quick brown fox')
        d.setSelection({
          kind: 'text',
          ranges: [{ page: 0, start: s, end: s + 'The quick brown fox'.length }]
        })
      })
    })
    await page.keyboard.press('Control+b')
    await expect(page.getByLabel('Bookmark name')).toHaveValue('The quick brown fox')
    await page.keyboard.press('Enter')
    // new bookmarks go in reading order: page 1 → right after Chapter 1
    await expect
      .poll(() => outlineTitles(page))
      .toEqual([
        'Chapter 1',
        'The quick brown fox',
        'Chapter 2',
        'Chapter 3',
        'Chapter 4',
        'Reading notes',
        'Chapter 5'
      ])

    // drag "Reading notes" onto "Chapter 1" to nest it
    const src = page.getByRole('treeitem', { name: /Reading notes/ })
    const dst = page.getByRole('treeitem', { name: /^Chapter 1/ })
    const a = (await src.boundingBox())!
    const b = (await dst.boundingBox())!
    await page.mouse.move(a.x + 60, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + 60, a.y + a.height / 2 - 12, { steps: 3 })
    await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 8 })
    await expect(dst).toHaveClass(/is-drop-inside/)
    await shot(page, 'bookmarks-drag')
    await page.mouse.up()
    await expect
      .poll(() => outlineTitles(page))
      .toEqual([
        ['Chapter 1', ['Reading notes']],
        'The quick brown fox',
        'Chapter 2',
        'Chapter 3',
        'Chapter 4',
        'Chapter 5'
      ])
    await expect(page.getByRole('treeitem', { name: /Reading notes/ })).toHaveAttribute('aria-level', '2')

    // un-nest: drag it above Chapter 2
    const s2 = (await page.getByRole('treeitem', { name: /Reading notes/ }).boundingBox())!
    const t2 = (await page.getByRole('treeitem', { name: /^Chapter 2/ }).boundingBox())!
    await page.mouse.move(s2.x + 80, s2.y + s2.height / 2)
    await page.mouse.down()
    await page.mouse.move(s2.x + 80, s2.y + 30, { steps: 4 })
    await page.mouse.move(t2.x + 60, t2.y + 3, { steps: 6 })
    await expect(page.locator('.fc-navigation-drop-line')).toBeVisible()
    await page.mouse.up()
    await expect
      .poll(() => outlineTitles(page))
      .toEqual([
        'Chapter 1',
        'The quick brown fox',
        'Reading notes',
        'Chapter 2',
        'Chapter 3',
        'Chapter 4',
        'Chapter 5'
      ])

    // delete with the keyboard, then undo
    await page.getByRole('treeitem', { name: /Reading notes/ }).click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await outlineTitles(page)).length).toBe(6)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await outlineTitles(page)).length).toBe(7)

    // a bookmark keeps an explicit zoom and position
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await runCommand(page, 'nav.last')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(4)
    await page.getByRole('button', { name: 'New bookmark' }).click()
    await page.getByLabel('Bookmark name').fill('Zoomed view')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await outlineTitles(page)).slice(-2)).toEqual(['Chapter 5', 'Zoomed view'])
    await runCommand(page, 'view.fitPage')
    await runCommand(page, 'nav.first')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(0)
    await page.getByRole('treeitem', { name: /Zoomed view/ }).click()
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(4)
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1.5, 2)

    // right-click on a page: "Add Bookmark Here"
    await runCommand(page, 'nav.first')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(0)
    const pageBox = (await page.locator('.viewer-page[data-page-index="0"]').boundingBox())!
    await page.mouse.click(pageBox.x + 300, pageBox.y + 560, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Add Bookmark Here' }).click()
    await page.getByLabel('Bookmark name').fill('Invoice block')
    await page.keyboard.press('Enter')
    const tree = await engine<any[]>(page, 'navigation', 'outline')
    const added = tree.find((b) => b.title === 'Invoice block')
    expect(added.dest.page).toBe(0)
    // 150% zoom: 2 CSS px per point, so the click was ~280 pt down the page
    expect(added.dest.y).toBeGreaterThan(220)
    expect(added.dest.y).toBeLessThan(290)
    // ordered by position: after the bookmarks at the top of page 1
    expect(tree.map((b) => b.title).slice(0, 4)).toEqual([
      'Chapter 1',
      'The quick brown fox',
      'Invoice block',
      'Reading notes'
    ])

    // collapse/expand all and context menu
    await page.getByRole('treeitem', { name: /Chapter 3/ }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Set Destination' })).toBeVisible()
    await shot(page, 'bookmarks-menu')
    await page.keyboard.press('Escape')

    await setTheme(page, 'dark')
    // Bookmark Properties: bold + colour
    await page.getByRole('treeitem', { name: /Chapter 2/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Properties…' }).click()
    const props = page.locator('.ui-dialog', { hasText: 'Bookmark Properties' })
    await props.getByLabel('Bold').check()
    await props.locator('.ui-swatch[title="#F44336"]').click()
    await shot(page, 'bookmark-properties-dark')
    await props.getByRole('button', { name: 'OK' }).click()
    await expect(props).toBeHidden()
    await expect
      .poll(async () =>
        (await engine<any[]>(page, 'navigation', 'outline')).find((b) => b.title === 'Chapter 2')
      )
      .toMatchObject({ bold: true, color: '#f44336' })
    await shot(page, 'bookmarks-dark')
  } finally {
    await app.close()
  }
})

test('document properties: description, fonts, security, initial view, custom; undo', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.keyboard.press('Control+d')
    const dialog = page.locator('.fc-navigation-props')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Fixture Text Document')
    await expect(dialog.getByLabel('Author', { exact: true })).toHaveValue('Fartcrobat Tests')
    await expect(dialog).toContainText('Number of Pages')
    await expect(dialog).toContainText('8.50 × 11.00 in')
    await shot(page, 'properties-description')

    await dialog.getByLabel('Author', { exact: true }).fill('Ada Lovelace')
    await dialog.getByRole('tab', { name: 'Fonts' }).click()
    await expect(dialog).toContainText('fonts used in this document')
    await expect(dialog).toContainText('Helvetica')
    await shot(page, 'properties-fonts')
    await dialog.getByRole('tab', { name: 'Security' }).click()
    await expect(dialog).toContainText('No Security')
    await dialog.getByRole('tab', { name: 'Initial View' }).click()
    await dialog.getByLabel('Navigation tab').selectOption('bookmarks')
    await dialog.getByLabel('Open to page').fill('3')
    await shot(page, 'properties-initial-view')
    await dialog.getByRole('tab', { name: 'Custom' }).click()
    await dialog.getByRole('textbox').nth(0).fill('Department')
    await dialog.getByRole('textbox').nth(1).fill('Finance')
    await dialog.getByRole('button', { name: 'Add' }).click()
    await expect(dialog.getByRole('option', { name: /Department/ })).toBeVisible()
    await shot(page, 'properties-custom')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.info.metadata.author))
      .toBe('Ada Lovelace')
    const props = await engine<any>(page, 'navigation', 'properties')
    expect(props.initialView.navigationTab).toBe('bookmarks')
    expect(props.initialView.openToPage).toBe(2)
    expect(props.custom).toEqual([{ key: 'Department', value: 'Finance' }])
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Change Document Properties')

    await page.keyboard.press('Control+z')
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.info.metadata.author))
      .toBe('Fartcrobat Tests')
    expect((await engine<any>(page, 'navigation', 'properties')).custom).toEqual([])

    // encrypted document: the Security tab lists the restrictions
    await setTheme(page, 'dark')
    const opening = page.evaluate(
      (p) => (window as any).__fartcrobat.openPaths([p]),
      fixturePath('encrypted.pdf')
    )
    await page.getByLabel('Password').fill('secret')
    await page.keyboard.press('Enter')
    await opening
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('encrypted.pdf')
    await waitForRender(page)
    await page.keyboard.press('Control+d')
    await dialog.getByRole('tab', { name: 'Security' }).click()
    await expect(dialog).toContainText('Password Security')
    await expect(dialog).toContainText('128-bit RC4')
    await expect(dialog.locator('.fc-navigation-denied').first()).toHaveText('Not Allowed')
    await shot(page, 'properties-security-dark')
    await dialog.getByRole('tab', { name: 'Description' }).click()
    await shot(page, 'properties-description-dark')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  } finally {
    await app.close()
  }
})

test('advanced search finds all results grouped by page', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.keyboard.press('Control+Shift+f')
    const box = page.getByLabel('Search for')
    await expect(box).toBeFocused()
    await box.fill('quick brown fox')
    await box.press('Enter')
    await expect(page.locator('.fc-navigation-search-count')).toHaveText('5 results in 5 pages')
    await expect(page.locator('.fc-navigation-result')).toHaveCount(5)
    await expect(page.locator('.fc-navigation-result').first()).toContainText('Hello Fartcrobat page 1')
    await expect.poll(async () => (await activeDocState(page))?.search.hits).toBe(5)
    await page.locator('.fc-navigation-result').nth(3).click()
    await expect.poll(async () => (await activeDocState(page))?.search.active).toBe(3)
    await expect(
      page.locator('.viewer-page[data-page-index="3"] .viewer-search-hit.is-active')
    ).toBeInViewport()
    await expect(page.locator('.fc-navigation-result').nth(3)).toHaveClass(/is-active/)
    await shot(page, 'search')

    // whole words / case sensitive
    await page.getByLabel('Case-sensitive').check()
    await box.fill('QUICK')
    await box.press('Enter')
    await expect(page.locator('.fc-navigation-search-count')).toHaveText('No results for “QUICK”.')
    await page.getByLabel('Case-sensitive').uncheck()
    await page.getByLabel('Whole words only').check()
    await box.fill('quic')
    await box.press('Enter')
    await expect(page.locator('.fc-navigation-search-count')).toHaveText('No results for “quic”.')
    await setTheme(page, 'dark')
    await page.getByLabel('Whole words only').uncheck()
    await box.fill('page')
    await box.press('Enter')
    await expect(page.locator('.fc-navigation-search-count')).toContainText('results in 5 pages')
    await shot(page, 'search-dark')
  } finally {
    await app.close()
  }
})

test('attachments, layers and the initial view', async () => {
  const { app, page } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fc-nav-'))
  try {
    await openFile(page, fixturePath('navigation/attachments.pdf'))
    await waitForRender(page)
    await page.getByRole('button', { name: 'Attachments', exact: true }).click()
    await expect(page.locator('.fc-navigation-att-row')).toHaveCount(2)
    await expect(page.locator('.fc-navigation-att-row').first()).toContainText('data.csv')
    await expect(page.locator('.fc-navigation-att-row').first()).toContainText('Quarterly figures')
    await expect(page.locator('.fc-navigation-att-row').nth(1)).toContainText('Page 2')

    // Add file… (stub the native dialog)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any
    }, fixturePath('scan.png'))
    await page.getByRole('button', { name: 'Add file…' }).first().click()
    await expect(page.locator('.fc-navigation-att-row')).toHaveCount(3)
    await expect(page.locator('.fc-navigation-att-row', { hasText: 'scan.png' })).toBeVisible()
    await shot(page, 'attachments')

    // Save as… (stub the native dialog)
    const target = join(out, 'saved.csv')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as any
    }, target)
    await page.locator('.fc-navigation-att-row', { hasText: 'data.csv' }).click()
    await page.getByRole('button', { name: 'Save attachment…' }).click()
    await expect.poll(() => existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('name,amount\nalpha,1\nbeta,2\n')

    // Open (stub the OS "open with default app")
    await app.evaluate(({ shell }) => {
      ;(globalThis as any).__opened = null
      shell.openPath = (async (p: string) => {
        ;(globalThis as any).__opened = p
        return ''
      }) as any
    })
    await page.locator('.fc-navigation-att-row', { hasText: 'data.csv' }).dblclick()
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as any).__opened)).toMatch(/data\.csv$/)
    const opened = await app.evaluate(() => (globalThis as any).__opened as string)
    expect(readFileSync(opened, 'utf8')).toBe('name,amount\nalpha,1\nbeta,2\n')

    // delete scan.png, undo
    await page.locator('.fc-navigation-att-row', { hasText: 'scan.png' }).click()
    await page.getByRole('button', { name: 'Delete attachment' }).click()
    await expect(page.locator('.fc-navigation-att-row')).toHaveCount(2)
    await page.keyboard.press('Control+z')
    await expect(page.locator('.fc-navigation-att-row')).toHaveCount(3)
    await setTheme(page, 'dark')
    await shot(page, 'attachments-dark')
    await setTheme(page, 'light')

    // layers
    await openFile(page, fixturePath('navigation/layers.pdf'))
    await waitForRender(page)
    await page.getByRole('button', { name: 'Layers', exact: true }).click()
    await expect(page.locator('.fc-navigation-layer')).toHaveCount(3)
    const notes = page.getByRole('button', { name: 'Show layer Reviewer notes' })
    await expect(notes).toHaveAttribute('aria-pressed', 'false')
    await notes.click()
    await expect(page.getByRole('button', { name: 'Hide layer Reviewer notes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.waitForTimeout(400)
    await shot(page, 'layers')
    expect((await activeDocState(page))?.dirty).toBe(false)
    await page.getByRole('button', { name: 'Reset to initial visibility' }).click()
    await expect(page.getByRole('button', { name: 'Show layer Reviewer notes' })).toBeVisible()
    await runCommand(page, 'view.showHide.layers')
    await expect(page.locator('.fc-navigation-layer')).toHaveCount(0)

    // initial view: bookmarks panel, two-up continuous, page 3 at 150%
    await openFile(page, fixturePath('navigation/initial-view.pdf'))
    await expect(page.locator('.shell-rightpanel', { hasText: 'Bookmarks' })).toBeVisible()
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(2)
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1.5, 2)
    expect(await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.layout)).toBe(
      'two-page-continuous'
    )
    await expect(page.getByRole('treeitem', { name: /Introduction/ })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /Background/ })).toHaveClass(/is-current/)
    await shot(page, 'initial-view')
  } finally {
    await app.close()
  }
})

test('read out loud and the View menu entries', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'view.showHide.bookmarks')
    await expect(page.locator('.shell-rightpanel', { hasText: 'Bookmarks' })).toBeVisible()
    await runCommand(page, 'view.showHide.navigationPanes')
    await expect(page.locator('.shell-rightpanel')).toHaveCount(0)
    await runCommand(page, 'view.showHide.navigationPanes')
    await expect(page.locator('.shell-rightpanel', { hasText: 'Bookmarks' })).toBeVisible()

    const voices = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const s = window.speechSynthesis
          if (s.getVoices().length) return resolve(s.getVoices().length)
          s.addEventListener('voiceschanged', () => resolve(s.getVoices().length))
          setTimeout(() => resolve(s.getVoices().length), 1600)
        })
    )
    await page.keyboard.press('Control+Shift+v')
    if (voices > 0) {
      await expect(page.locator('.fc-navigation-readbar')).toBeVisible()
      await page.keyboard.press('Control+Shift+c')
      await expect(page.locator('.fc-navigation-readbar')).toContainText('Paused')
      await page.keyboard.press('Control+Shift+e')
      await expect(page.locator('.fc-navigation-readbar')).toHaveCount(0)
    } else {
      await expect(page.locator('.toast', { hasText: 'text-to-speech voice' })).toBeVisible()
    }
    await shot(page, 'read-out-loud')

    // Preferences > Reading
    await runCommand(page, 'app.preferences')
    await page.getByRole('button', { name: 'Reading' }).click()
    await expect(page.getByText('Read Out Loud', { exact: true })).toBeVisible()
    if (voices === 0)
      await expect(page.locator('.fc-navigation-reading-prefs .fc-navigation-warn')).toBeVisible()
    else await expect(page.locator('.fc-navigation-reading-prefs select option')).toHaveCount(voices + 1)
    await shot(page, 'reading-prefs')
    await page.getByRole('button', { name: 'Done' }).click()

    // With a (simulated) voice: read to the end, advancing pages; pause, resume and stop.
    await page.evaluate(() => {
      const spoken: string[] = []
      let paused = false
      let pending: (() => void) | null = null
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const current = new Set<SpeechSynthesisUtterance>()
      const fake = {
        getVoices: () => [
          { voiceURI: 'test-voice', name: 'Test Voice', lang: 'en-US', default: true, localService: true }
        ],
        addEventListener: () => {},
        removeEventListener: () => {},
        speak(u: SpeechSynthesisUtterance) {
          spoken.push(u.text)
          current.add(u)
          const t = setTimeout(() => {
            timers.delete(t)
            const end = () => {
              current.delete(u)
              u.onend?.(new Event('end') as SpeechSynthesisEvent)
            }
            if (paused) pending = end
            else end()
          }, 60)
          timers.add(t)
        },
        pause() {
          paused = true
        },
        resume() {
          paused = false
          const p = pending
          pending = null
          p?.()
        },
        cancel() {
          for (const t of timers) clearTimeout(t)
          timers.clear()
          pending = null
          for (const u of current) u.onerror?.({ error: 'canceled' } as SpeechSynthesisErrorEvent)
          current.clear()
        }
      }
      Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true })
      ;(window as any).__spoken = spoken
    })
    await runCommand(page, 'nav.first')
    await page.keyboard.press('Control+Shift+b')
    await expect(page.locator('.fc-navigation-readbar')).toContainText('of 5')
    await shot(page, 'read-out-loud-bar')
    await expect.poll(async () => (await activeDocState(page))?.currentPage, { timeout: 20000 }).toBe(4)
    await expect(page.locator('.fc-navigation-readbar')).toHaveCount(0, { timeout: 20000 })
    const spoken = (await page.evaluate(() => (window as any).__spoken)) as string[]
    const all = spoken.join(' ')
    for (let i = 1; i <= 5; i++) expect(all).toContain(`Chapter ${i}`)
    expect(all.indexOf('Chapter 1')).toBeLessThan(all.indexOf('Chapter 5'))

    // this page only, with pause / resume / stop
    await runCommand(page, 'nav.first')
    await page.evaluate(() => ((window as any).__spoken.length = 0))
    await page.keyboard.press('Control+Shift+v')
    await expect(page.locator('.fc-navigation-readbar')).toContainText('Reading page 1')
    await page.keyboard.press('Control+Shift+c')
    await expect(page.locator('.fc-navigation-readbar')).toContainText('Paused')
    await page.keyboard.press('Control+Shift+c')
    await expect(page.locator('.fc-navigation-readbar')).toContainText('Reading')
    await page.keyboard.press('Control+Shift+e')
    await expect(page.locator('.fc-navigation-readbar')).toHaveCount(0)
    const once = (await page.evaluate(() => (window as any).__spoken)) as string[]
    expect(once.join(' ')).not.toContain('Chapter 2')
    expect((await activeDocState(page))?.currentPage).toBe(0)
  } finally {
    await app.close()
  }
})
