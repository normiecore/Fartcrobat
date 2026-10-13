import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, waitForRender } from './helpers'

// Regression tests for text selection with the mouse: double/triple-click, Shift+click and drags
// that outlive the page they started on.

async function selection(page: Page) {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    return { sel: d.state.selection, text: (await d.selectedText()) as string }
  })
}

/** Client coordinates of characters of the first occurrence of `word` on page 0. */
async function wordGeometry(page: Page, word: string) {
  return page.evaluate(async (w) => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const t = await d.pageText(0)
    const i = t.text.indexOf(w)
    const pg = document.querySelector('.viewer-page[data-page-index="0"]')!.getBoundingClientRect()
    const scale = (d.state.zoom * 96) / 72
    const charBox = (k: number) => {
      const q = t.quads
      const x0 = Math.min(q[k * 8], q[k * 8 + 4])
      const x1 = Math.max(q[k * 8 + 2], q[k * 8 + 6])
      const y0 = Math.min(q[k * 8 + 1], q[k * 8 + 3])
      const y1 = Math.max(q[k * 8 + 5], q[k * 8 + 7])
      return { left: pg.left + x0 * scale, right: pg.left + x1 * scale, top: pg.top + y0 * scale, bottom: pg.top + y1 * scale }
    }
    return { index: i, chars: Array.from({ length: w.length }, (_, k) => charBox(i + k)) }
  }, word)
}

async function openAt100() {
  const a = await launch()
  await openFile(a.page, fixturePath('text.pdf'))
  await waitForRender(a.page)
  await a.page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1))
  await a.page.waitForTimeout(600)
  return a
}

test('double-click selects the word under the pointer and triple-click its line', async () => {
  const { app, page } = await openAt100()
  try {
    const g = await wordGeometry(page, 'quick')
    const mid = g.chars[2]
    const cy = (mid.top + mid.bottom) / 2
    await page.mouse.move((mid.left + mid.right) / 2, cy)
    await page.waitForTimeout(300)
    await page.mouse.dblclick((mid.left + mid.right) / 2, cy)
    await expect.poll(async () => (await selection(page)).text).toBe('quick')

    // the right half of the word's last letter still selects the word, not what follows it
    await page.mouse.click(mid.left, cy + 300)
    await expect.poll(async () => (await selection(page)).sel.kind).toBe('none')
    const k = g.chars[4]
    await page.mouse.dblclick(k.left + (k.right - k.left) * 0.8, cy)
    await expect.poll(async () => (await selection(page)).text).toBe('quick')

    await page.mouse.click(mid.left, cy + 300)
    await page.waitForTimeout(400)
    await page.mouse.click((mid.left + mid.right) / 2, cy, { clickCount: 3 })
    await expect.poll(async () => (await selection(page)).text).toBe('Hello Fartcrobat page 1. The quick brown fox jumps over the lazy dog.')
    await page.screenshot({ path: 'test-results/core-text-selection-line.png' })
  } finally {
    await app.close()
  }
})

test('Shift+click extends the selection from where it started', async () => {
  const { app, page } = await openAt100()
  try {
    const g = await wordGeometry(page, 'quick')
    const mid = g.chars[2]
    const mx = (mid.left + mid.right) / 2
    const my = (mid.top + mid.bottom) / 2
    await page.mouse.move(mx, my)
    await page.waitForTimeout(300)
    // drag backwards: the anchor is the right end
    await page.mouse.down()
    await page.mouse.move(mx - 30, my, { steps: 3 })
    await page.mouse.move(mx - 60, my, { steps: 3 })
    await page.mouse.up()
    const dragged = await selection(page)
    expect(dragged.sel.kind).toBe('text')
    const anchor = dragged.sel.ranges[0].end
    expect(anchor).toBeGreaterThan(g.index)
    expect(anchor).toBeLessThan(g.index + 5)
    await page.waitForTimeout(300)
    await page.keyboard.down('Shift')
    await page.mouse.click(mx + 120, my)
    await page.keyboard.up('Shift')
    await expect.poll(async () => (await selection(page)).sel.ranges?.[0]?.start).toBe(anchor)
    const extended = await selection(page)
    expect(extended.text).toContain('brown')
    expect(extended.sel.ranges[0].end).toBeGreaterThan(anchor + 10)
  } finally {
    await app.close()
  }
})

test('a text drag ends when the button is released, even after its first page was unmounted', async () => {
  const { app, page } = await openAt100()
  try {
    const p0 = await page.evaluate(() => {
      const r = document.querySelector('.viewer-page[data-page-index="0"]')!.getBoundingClientRect()
      return [r.left, r.top]
    })
    const sx = p0[0] + 100
    const sy = p0[1] + 140
    await page.mouse.move(sx, sy)
    await page.waitForTimeout(300)
    await page.mouse.down()
    await page.mouse.move(sx + 40, sy + 5, { steps: 4 })
    // scroll while holding the button until page 1 is virtualised away
    await page.evaluate(() => (document.querySelector<HTMLElement>('.viewer-scroll')!.scrollTop = 3300))
    await expect.poll(() => page.evaluate(() => !!document.querySelector('.viewer-page[data-page-index="0"]'))).toBe(false)
    // release over the grey gap beside the pages
    const gap = await page.evaluate(() => {
      const r = document.querySelector('.viewer-scroll')!.getBoundingClientRect()
      const pg = document.querySelector('.viewer-page')!.getBoundingClientRect()
      return [r.left + Math.max(5, (pg.left - r.left) / 2), r.top + 300]
    })
    await page.mouse.move(gap[0], gap[1], { steps: 3 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const released = JSON.stringify((await activeDocState(page))!.selection)
    // hovering over text with no button pressed must not change the selection
    const pv = await page.evaluate(() => {
      const vp = document.querySelector('.viewer-scroll')!.getBoundingClientRect()
      const y = vp.top + vp.height / 3
      const els = [...document.querySelectorAll<HTMLElement>('.viewer-page')]
      const e = els.find((el) => {
        const r = el.getBoundingClientRect()
        return r.top <= y && r.bottom >= y + 100
      })!
      return [e.getBoundingClientRect().left + 150, y]
    })
    await page.mouse.move(pv[0], pv[1], { steps: 5 })
    await page.mouse.move(pv[0] + 200, pv[1] + 100, { steps: 5 })
    await page.waitForTimeout(200)
    expect(JSON.stringify((await activeDocState(page))!.selection)).toBe(released)
  } finally {
    await app.close()
  }
})
