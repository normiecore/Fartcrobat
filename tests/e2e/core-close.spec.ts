import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixturePath, launch } from './helpers'

/**
 * Console errors, uncaught errors and unhandled rejections of the page, and warnings about work
 * that ran into a closed document (those are only noise: the user closed it).
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && m.text().includes('Document is closed')))
      errors.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

type Work = 'nothing' | 'hover' | 'search' | 'save' | 'saved'

/**
 * Opens the file, starts some work on it and closes its tab at once, without waiting for that
 * work or the first render. `tool` is a tool group (`group:<id>`) or tool (`tool:<id>`) to open first.
 */
async function openAndClose(page: Page, path: string, work: Work, tool?: string) {
  await page.evaluate(
    async ({ path, work, tool }) => {
      const f = (window as any).__fartcrobat
      await f.openPaths([path])
      const doc = f.getActiveDoc()
      const [kind, id] = tool?.split(':') ?? []
      if (kind === 'group') {
        const group = f.registry.toolGroups.find((g: any) => g.id === id)
        f.useApp.setState({ toolGroupId: id, leftPaneOpen: true, toolId: group.defaultTool ?? 'select' })
      } else if (kind === 'tool') f.useApp.setState({ toolId: id })
      if (work === 'hover') {
        // The pointer entering a page loads its text (for the I-beam cursor and selecting).
        while (!document.querySelector('.viewer-page .viewer-text-layer'))
          await new Promise((r) => setTimeout(r, 5))
        for (const el of document.querySelectorAll('.viewer-page .viewer-text-layer'))
          el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      }
      if (work === 'search') void doc.search('the')
      if (work === 'save') void f.runCommand('file.save')
      if (work === 'saved') await f.runCommand('file.save')
      await f.runCommand('file.close')
    },
    { path, work, tool }
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.length))
    .toBe(0)
  await page.evaluate(() =>
    (window as any).__fartcrobat.useApp.setState({ toolGroupId: null, toolId: 'select' })
  )
}

test('closing a document while work on it is still running logs no error', async () => {
  const { app, page } = await launch()
  const errors = collectErrors(page)
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fc-close-'))
    const file = join(dir, 'text.pdf')
    copyFileSync(fixturePath('text.pdf'), file)
    for (const work of ['nothing', 'hover', 'search', 'save', 'saved'] as const)
      await openAndClose(page, file, work)
    // Tools that read the document as soon as they show (page text, links, measurements, security).
    for (const tool of ['group:redact', 'group:measure', 'group:protect', 'tool:edit.link'])
      await openAndClose(page, file, 'hover', tool)

    // The file still opens and shows normally afterwards.
    await page.evaluate((p) => (window as any).__fartcrobat.openPaths([p]), file)
    await expect(page.locator('.viewer-page canvas').first()).toBeVisible()
    // Work that was queued with a timer before a close (nothing to wait for: it must stay silent).
    await page.waitForTimeout(500)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
