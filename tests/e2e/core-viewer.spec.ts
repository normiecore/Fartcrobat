import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

// Regression tests for the page viewer: fit zooms, page layout, navigation, scroll restoration,
// hit testing and detail tiles.

async function setContentSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), { width, height })
}

async function open(name: string, size = { width: 1400, height: 900 }) {
  const a = await launch()
  await setContentSize(a.app, size.width, size.height)
  await openFile(a.page, fixturePath(name))
  await waitForRender(a.page)
  await a.page.waitForTimeout(300)
  return a
}

const currentPage = async (page: Page) => (await activeDocState(page))!.currentPage
const zoomOf = async (page: Page) => (await activeDocState(page))!.zoom

function goToPage(page: Page, index: number) {
  return page.evaluate((i) => (window as any).__fartcrobat.getActiveDoc().view.goToPage(i), index)
}

function setZoom(page: Page, z: number) {
  return page.evaluate((zz) => (window as any).__fartcrobat.getActiveDoc().view.setZoom(zz), z)
}

function scrollState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.viewer-scroll')!
    const content = document.querySelector<HTMLElement>('.viewer-content')!
    return {
      top: el.scrollTop,
      left: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      contentWidth: parseFloat(content.style.width)
    }
  })
}

function setScrollTop(page: Page, top: number) {
  return page.evaluate((t) => (document.querySelector<HTMLElement>('.viewer-scroll')!.scrollTop = t), top)
}

/** Counts zoom changes from now on (read with zoomChanges). */
function countZoomChanges(page: Page) {
  return page.evaluate(() => {
    const w = window as any
    w.__zoomChanges = 0
    w.__zoomUnsub?.()
    w.__zoomUnsub = w.__fartcrobat.getActiveDoc().store.subscribe((s: any, p: any) => {
      if (s.zoom !== p.zoom) w.__zoomChanges++
    })
  })
}
const zoomChanges = (page: Page) => page.evaluate(() => (window as any).__zoomChanges as number)
const resetZoomChanges = (page: Page) => page.evaluate(() => ((window as any).__zoomChanges = 0))

function pageBox(page: Page, index: number) {
  return page.evaluate((i) => {
    const r = document.querySelector(`.viewer-page[data-page-index="${i}"]`)!.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }, index)
}

test('Fit Width on mixed page sizes: zoom stays put and navigation lands on the requested page', async () => {
  const { app, page } = await open('mixed-sizes.pdf')
  try {
    await countZoomChanges(page)
    for (const target of [1, 2, 0, 2, 1, 0]) {
      await goToPage(page, target)
      await expect.poll(() => currentPage(page)).toBe(target)
      await page.waitForTimeout(250)
      expect(await currentPage(page)).toBe(target)
    }
    await runCommand(page, 'nav.last')
    await expect.poll(() => currentPage(page)).toBe(2)
    await page.waitForTimeout(250)
    expect(await currentPage(page)).toBe(2)
    // Scrolling through the document never changes a fit zoom (it used to flip back and forth).
    const { scrollHeight } = await scrollState(page)
    for (let y = 0; y < scrollHeight; y += 80) {
      await setScrollTop(page, y)
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(500)
    expect(await zoomChanges(page)).toBe(0)
    // the widest page fits: no horizontal scrollbar
    const s = await scrollState(page)
    expect(s.scrollWidth).toBeLessThanOrEqual(s.clientWidth)
    await page.screenshot({ path: 'test-results/core-viewer-mixed.png' })
  } finally {
    await app.close()
  }
})

test('Two Page View with a cover page keeps the cover on screen and the zoom from spread to spread', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await runCommand(page, 'view.layout.twoPage')
    await runCommand(page, 'view.coverPage')
    await page.waitForTimeout(500)
    const z0 = await zoomOf(page)
    const s = await scrollState(page)
    const cover = await pageBox(page, 0)
    const vp = await page.evaluate(() => document.querySelector('.viewer-scroll')!.getBoundingClientRect().toJSON())
    expect(s.scrollWidth).toBeLessThanOrEqual(s.clientWidth)
    expect(cover.left).toBeGreaterThanOrEqual(vp.left + s.clientWidth / 2)
    expect(cover.right).toBeLessThanOrEqual(vp.left + s.clientWidth)
    await page.screenshot({ path: 'test-results/core-viewer-cover.png' })
    await runCommand(page, 'nav.next')
    await expect.poll(() => currentPage(page)).toBe(1)
    await page.waitForTimeout(300)
    expect(await zoomOf(page)).toBeCloseTo(z0, 4)
    // Actual Size: the content is wide enough to hold the cover in the right half
    await runCommand(page, 'nav.first')
    await runCommand(page, 'view.actualSize')
    await page.waitForTimeout(400)
    const a = await scrollState(page)
    const box = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.viewer-page[data-page-index="0"]')!
      return { left: parseFloat(el.style.left), width: parseFloat(el.style.width) }
    })
    expect(box.left + box.width).toBeLessThanOrEqual(a.contentWidth)
    expect(a.scrollWidth).toBeLessThanOrEqual(a.contentWidth + 1)
  } finally {
    await app.close()
  }
})

test('revealing a rect on the right page of a spread is not undone by the layout', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await runCommand(page, 'view.layout.twoPage')
    await setZoom(page, 3)
    await page.waitForTimeout(600)
    await setScrollTop(page, 0)
    await page.waitForTimeout(200)
    expect(await currentPage(page)).toBe(0)
    const at = await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      d.view.scrollToRect(1, [400, 700, 450, 712], { center: true })
      const el = document.querySelector<HTMLElement>('.viewer-scroll')!
      return { top: el.scrollTop, left: el.scrollLeft }
    })
    expect(at.top).toBeGreaterThan(1000)
    await page.waitForTimeout(600)
    const s = await scrollState(page)
    expect(s.top).toBeCloseTo(at.top, 0)
    expect(s.left).toBeCloseTo(at.left, 0)
    expect(await currentPage(page)).toBe(1)
  } finally {
    await app.close()
  }
})

test('Last Page makes the last page current even when it cannot scroll to the top', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await setZoom(page, 0.33)
    await page.waitForTimeout(500)
    await runCommand(page, 'nav.last')
    await expect.poll(() => currentPage(page)).toBe(4)
    await page.waitForTimeout(400)
    expect(await currentPage(page)).toBe(4)
    const nextEnabled = await page.evaluate(() => {
      const fc = (window as any).__fartcrobat
      return fc.registry.commands.get('nav.next')?.enabled?.({ doc: fc.getActiveDoc() })
    })
    expect(nextEnabled).toBe(false)
    await runCommand(page, 'view.layout.twoPageContinuous')
    await runCommand(page, 'view.fitWidth')
    await page.waitForTimeout(400)
    await runCommand(page, 'nav.first')
    await expect.poll(() => currentPage(page)).toBe(0)
    await runCommand(page, 'nav.last')
    await expect.poll(() => currentPage(page)).toBe(4)
    await page.waitForTimeout(400)
    expect(await currentPage(page)).toBe(4)
  } finally {
    await app.close()
  }
})

test('Find in Single Page View scrolls to a hit on another page', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await runCommand(page, 'view.layout.single')
    await setZoom(page, 3)
    await page.waitForTimeout(500)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().search('Invoice #1002'))
    await expect.poll(() => currentPage(page)).toBe(2)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const vp = document.querySelector('.viewer-scroll')!.getBoundingClientRect()
          const hit = document.querySelector('.viewer-search-hit.is-active')?.getBoundingClientRect()
          return !!hit && hit.top >= vp.top && hit.bottom <= vp.bottom && hit.left >= vp.left && hit.right <= vp.right
        })
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})

test('Fit Width does not flicker as the vertical scrollbar comes and goes', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await runCommand(page, 'view.layout.single')
    // The viewport width must not depend on whether the content overflows.
    await setZoom(page, 0.1)
    await page.waitForTimeout(300)
    const small = await scrollState(page)
    expect(small.scrollHeight).toBeLessThanOrEqual(small.clientHeight)
    await setZoom(page, 2)
    await page.waitForTimeout(300)
    const big = await scrollState(page)
    expect(big.scrollHeight).toBeGreaterThan(big.clientHeight)
    expect(big.clientWidth).toBe(small.clientWidth)
    // Window sizes where the page is about as tall as the viewport used to flip forever.
    await runCommand(page, 'view.fitWidth')
    await countZoomChanges(page)
    for (let w = 980; w <= 994; w += 2) {
      await setContentSize(app, w, 900)
      await page.waitForTimeout(250)
      await resetZoomChanges(page)
      await page.waitForTimeout(300)
      expect(await zoomChanges(page), `zoom changes while idle at width ${w}`).toBe(0)
    }
  } finally {
    await app.close()
  }
})

test('a zoom that changes nothing does not pull the view back later', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await setZoom(page, 2)
    await page.waitForTimeout(500)
    await setZoom(page, 2)
    await page.waitForTimeout(300)
    await setScrollTop(page, 5000)
    await page.waitForTimeout(400)
    const before = await currentPage(page)
    expect(before).toBeGreaterThan(0)
    await setContentSize(app, 1300, 900)
    await page.waitForTimeout(800)
    expect(await currentPage(page)).toBe(before)
    expect((await scrollState(page)).top).toBeGreaterThan(4000)
  } finally {
    await app.close()
  }
})

test('in a spread, the pointer beyond the right page hits the right page', async () => {
  const { app, page } = await open('text.pdf')
  try {
    await runCommand(page, 'view.layout.twoPage')
    await setZoom(page, 0.6)
    await page.waitForTimeout(600)
    const p1 = await pageBox(page, 1)
    const hit = await page.evaluate(
      ([x, y]) => (window as any).__fartcrobat.getActiveDoc().view.hitTest(x, y),
      [p1.right + 40, p1.top + 100]
    )
    expect(hit.pageIndex).toBe(1)
    // a real drag from the right page past its right edge selects on the right page
    const sx = p1.left + 50
    const sy = p1.top + 100 * 0.6 * (96 / 72)
    await page.mouse.move(sx, sy)
    await page.waitForTimeout(200)
    await page.mouse.down()
    await page.mouse.move(sx + 50, sy, { steps: 3 })
    await page.mouse.move(p1.right + 40, sy + 2, { steps: 5 })
    await page.mouse.up()
    const sel = (await activeDocState(page))!.selection
    expect(sel.kind).toBe('text')
    expect(sel.ranges.length).toBeGreaterThan(0)
    expect(sel.ranges.every((r: { page: number }) => r.page === 1)).toBe(true)
  } finally {
    await app.close()
  }
})

test('the high-zoom detail tile is hidden as soon as the zoom changes', async () => {
  const { app, page } = await open('text.pdf')
  try {
    const tile = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.viewer-page[data-page-index="0"] canvas.viewer-page-detail')!
        return { display: c.style.display, left: parseFloat(c.style.left) }
      })
    await setZoom(page, 6)
    await expect.poll(async () => (await tile()).display, { timeout: 20000 }).toBe('block')
    const before = await tile()
    // Ctrl+wheel-like zoom steps: the old tile (old scale and position) must not stay up.
    const during = await page.evaluate(
      () =>
        new Promise<{ display: string }[]>((resolve) => {
          const d = (window as any).__fartcrobat.getActiveDoc()
          const vp = document.querySelector('.viewer-scroll')!.getBoundingClientRect()
          const seen: { display: string }[] = []
          let n = 0
          const step = () => {
            d.view.setZoom(d.state.zoom * 1.08, { clientX: vp.left + 300, clientY: vp.top + 300 })
            requestAnimationFrame(() => {
              const c = document.querySelector<HTMLCanvasElement>('.viewer-page[data-page-index="0"] canvas.viewer-page-detail')!
              seen.push({ display: c.style.display })
              if (++n < 6) setTimeout(step, 40)
              else resolve(seen)
            })
          }
          step()
        })
    )
    expect(during.every((s) => s.display === 'none')).toBe(true)
    // the new tile arrives for the new zoom
    await expect.poll(async () => (await tile()).display, { timeout: 20000 }).toBe('block')
    expect((await tile()).left).toBeGreaterThan(before.left)
    await page.screenshot({ path: 'test-results/core-viewer-tile.png' })
  } finally {
    await app.close()
  }
})
