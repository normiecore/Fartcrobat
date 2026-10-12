import { it } from 'vitest'
import { writeFileSync } from 'node:fs'
import type pfOps from '@features/prepare-form/engine'
import type renderOps from '@engine/ops/render'
import { openFixture } from './helpers'

const OUT = '/tmp/claude-0/-home-user-Fartcrobat/6e184722-e9e0-52a3-af71-91f5e11f80b2/scratchpad/pf'

it('debug detect', async () => {
  const e = await openFixture('prepare-form/blank-form.pdf')
  const pf = e.ops<typeof pfOps>('prepare-form')
  const found = await pf.detect()
  for (const f of found) console.log(f.type.padEnd(10), f.source.padEnd(12), JSON.stringify(f.name), f.rect.map((v) => Math.round(v)).join(','))
  await pf.createMany(found.map((f) => ({ type: f.type, page: f.page, rect: f.rect, name: f.name })), 'Detect Form Fields')
  const png = await e.ops<typeof renderOps>('render').image(0, { dpi: 72, format: 'png' })
  writeFileSync(OUT + '/detect.png', png)
  const t = await openFixture('text.pdf')
  const f2 = await t.ops<typeof pfOps>('prepare-form').detect()
  console.log('text.pdf', f2.length, JSON.stringify(f2.map((f) => [f.type, f.name, f.source])))
})
