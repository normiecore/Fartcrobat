import { it } from 'vitest'
import type fillSignOps from '@features/fill-sign/engine'
import type renderOps from '@engine/ops/render'
import { openFixture } from './helpers'

it('probe', async () => {
  const e = await openFixture('text.pdf')
  const fs = e.ops<typeof fillSignOps>('fill-sign')
  const render = e.ops<typeof renderOps>('render')
  const ap = (id: number) => {
    const f = e.session.findAnnotation(id, 1)!
    const s = f.annot.getObject().get('AP').get('N').readStream().asString()
    return (s.match(/Tc/g) ?? []).length + ' Tc; dirty? ' + (f.annot as any).hasChanged?.()
  }
  const item = await fs.addText(1, [72, 500], { text: 'Jane Doe', size: 12, topLeft: true })
  await fs.setSpacing(item.id, 4)
  console.log('after setSpacing', ap(item.id))
  await render.page(1, { scale: 1 })
  console.log('after render', ap(item.id))
  await fs.setText(item.id, 'Jane Doe, Esq.')
  console.log('after setText', ap(item.id))
  await render.page(1, { scale: 1 })
  console.log('after render', ap(item.id))
  await fs.setColor(item.id, '#c4161c')
  console.log('after setColor', ap(item.id))
  await render.page(1, { scale: 1 })
  console.log('after render', ap(item.id))
})
