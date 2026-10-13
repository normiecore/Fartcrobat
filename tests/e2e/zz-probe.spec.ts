import { test, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixturePath, launch } from './helpers'

function collect(page: Page): string[] {
  const out: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') out.push(`${m.type()}: ${m.text().split('\n')[0]}`)
  })
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message} ${(e.stack ?? '').split('\n').slice(0, 12).join(' | ')}`))
  return out
}

for (const fixture of ['text.pdf', 'form.pdf']) {
  test(`probe ${fixture}`, async () => {
    test.setTimeout(600_000)
    const { app, page } = await launch()
    const errors = collect(page)
    try {
      const dir = mkdtempSync(join(tmpdir(), 'fc-probe-'))
      const file = join(dir, fixture)
      copyFileSync(fixturePath(fixture), file)
      const setups = await page.evaluate(() => {
        const r = (window as any).__fartcrobat.registry
        return [
          'none',
          ...r.toolGroups.filter((g: any) => g.panel || g.documentView).map((g: any) => `group:${g.id}`),
          ...r.rightPanels.map((p: any) => `right:${p.id}`)
        ]
      })
      for (const delay of [0, 30, 150, 500]) {
        for (const setup of setups) {
          const before = errors.length
          await page.evaluate(
            async ({ file, setup, delay }) => {
              const f = (window as any).__fartcrobat
              const useApp = f.useApp
              await f.openPaths([file])
              const [kind, id] = setup.split(':')
              if (kind === 'group') {
                const g = f.registry.toolGroups.find((x: any) => x.id === id)
                useApp.setState({ toolGroupId: id, leftPaneOpen: true, ...(g.defaultTool ? { toolId: g.defaultTool } : {}) })
              } else if (kind === 'right') useApp.setState({ rightPanelId: id })
              const el = document.querySelector('.viewer-page .viewer-text-layer')
              el?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
              if (delay) await new Promise((r) => setTimeout(r, delay))
              await f.runCommand('file.close')
              const t0 = Date.now()
              while (useApp.getState().docs.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5))
              useApp.setState({ toolGroupId: null, rightPanelId: null, toolId: 'select' })
            },
            { file, setup, delay }
          )
          await page.waitForTimeout(250)
          for (const e of errors.slice(before)) console.log(`PROBE ${fixture} d${delay} ${setup} -> ${e}`)
        }
      }
    } finally {
      await app.close()
    }
  })
}
