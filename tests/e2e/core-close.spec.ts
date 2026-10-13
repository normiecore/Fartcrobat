import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixturePath, launch } from './helpers'

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function openAndClose(page: Page, path: string, between: string) {
  await page.evaluate(
    async ({ path, between }) => {
      const f = (window as any).__fartcrobat
      await f.openPaths([path])
      const doc = f.getActiveDoc()
      if (between === 'hover') {
        const el = document.querySelector('.viewer-page .viewer-text-layer')
        el?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
        el?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      }
      if (between === 'search') void doc.search('the')
      if (between === 'save') await f.runCommand('file.save')
      if (between === 'save-nowait') void f.runCommand('file.save')
      if (between === 'save-tick') {
        void f.runCommand('file.save')
        await new Promise((r) => setTimeout(r, 30))
      }
      await f.runCommand('file.close')
      while (f.useApp.getState().docs.length) await new Promise((r) => setTimeout(r, 5))
    },
    { path, between }
  )
}

test('repro', async () => {
  const { app, page } = await launch()
  const errors = collectErrors(page)
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fc-close-'))
    const file = join(dir, 'text.pdf')
    copyFileSync(fixturePath('text.pdf'), file)
    for (let i = 0; i < 3; i++) {
      for (const between of ['none', 'hover', 'search', 'save', 'save-nowait', 'save-tick']) {
        const before = errors.length
        await openAndClose(page, file, between)
        await page.waitForTimeout(400)
        for (const e of errors.slice(before)) console.log(between, '->', e)
      }
    }
    await page.waitForTimeout(1500)
    console.log(errors.join('\n'))
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
