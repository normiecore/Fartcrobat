import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

async function docCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.length)
}

/** Runs a few read-only engine calls on the active document (each returns a ChangeSet). */
async function queryEngine(page: Page) {
  await page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    await d.core.text.plain(0)
    await d.core.doc.info()
    await d.core.render.page(0, { scale: 0.2 })
  })
}

test('new and replaced documents stay unsaved and ask to be saved on close', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)

    // A new untitled document (Combine, Create, Extract to new file...)
    await page.evaluate(async () => {
      const api = (window as any).__fartcrobat
      const bytes = await api.getActiveDoc().core.doc.save({})
      await api.openNewDocument(bytes, 'Binder1')
    })
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('Binder1.pdf')
    await waitForRender(page)
    await queryEngine(page)
    await page.waitForTimeout(300)
    expect((await activeDocState(page))?.dirty).toBe(true)
    await page.screenshot({ path: 'test-results/core-dirty-new.png' })

    await runCommand(page, 'file.close')
    await expect(page.getByText('Save changes?')).toBeVisible()
    await page.getByRole('button', { name: "Don't Save" }).click()
    await expect.poll(() => docCount(page)).toBe(1)

    // Content replaced in memory only (e.g. optimised without writing the file)
    await page.evaluate(async () => {
      const api = (window as any).__fartcrobat
      const d = api.getActiveDoc()
      const bytes = await d.core.doc.save({})
      await api.replaceDocumentBytes(d, bytes, null)
    })
    await queryEngine(page)
    await page.waitForTimeout(300)
    expect((await activeDocState(page))?.dirty).toBe(true)
    await runCommand(page, 'file.close')
    await expect(page.getByText('Save changes?')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Save changes?')).toBeHidden()
    expect(await docCount(page)).toBe(1)
  } finally {
    await app.close()
  }
})

test('document properties shown in the UI follow document-level changes', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      await d.core.doc.setMetadata({ title: 'Renamed Title' })
      await d.core.doc.setLanguage('fr-CA')
    })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const info = (window as any).__fartcrobat.getActiveDoc().state.info
          return `${info.metadata.title}|${info.language}`
        })
      )
      .toBe('Renamed Title|fr-CA')
    expect((await activeDocState(page))?.dirty).toBe(true)
    expect((await activeDocState(page))?.pageCount).toBe(5)
  } finally {
    await app.close()
  }
})
