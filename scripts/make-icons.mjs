// Renders the app icon from build/icon.svg (and build/icon-small.svg below 48 px) into every file the
// installers and the app use: build/icons/<n>x<n>.png (Linux), build/icon.png (macOS, 1024 px),
// build/icon.ico (Windows, PNG entries) and resources/icon.png (window icon, Linux desktop entry).
// Run with `node scripts/make-icons.mjs`; the outputs are committed, builds never run it.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const full = readFileSync(join(root, 'build/icon.svg'), 'utf8')
const small = readFileSync(join(root, 'build/icon-small.svg'), 'utf8')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

// CHROMIUM_PATH: a Chromium to use when Playwright's own download is missing.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await browser.newPage({ deviceScaleFactor: 1 })
const png = {}
for (const n of SIZES) {
  const svg = (n < 48 ? small : full).replace('<svg ', `<svg width="${n}" height="${n}" `)
  await page.setViewportSize({ width: n, height: n })
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`)
  png[n] = await page.locator('svg').screenshot({ omitBackground: true })
}
await browser.close()

mkdirSync(join(root, 'build/icons'), { recursive: true })
for (const n of SIZES) writeFileSync(join(root, `build/icons/${n}x${n}.png`), png[n])
writeFileSync(join(root, 'build/icon.png'), png[1024])
copyFileSync(join(root, 'build/icon.png'), join(root, 'resources/icon.png'))

// ICO with PNG-compressed entries (Windows Vista and later read these at every size).
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(ICO_SIZES.length, 4)
const entries = []
let offset = 6 + 16 * ICO_SIZES.length
for (const n of ICO_SIZES) {
  const e = Buffer.alloc(16)
  e.writeUInt8(n >= 256 ? 0 : n, 0)
  e.writeUInt8(n >= 256 ? 0 : n, 1)
  e.writeUInt16LE(1, 4) // colour planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(png[n].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += png[n].length
  entries.push(e)
}
writeFileSync(join(root, 'build/icon.ico'), Buffer.concat([header, ...entries, ...ICO_SIZES.map((n) => png[n])]))
console.log('icons written')
