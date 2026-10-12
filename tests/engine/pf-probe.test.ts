import { it } from 'vitest'
import type pfOps from '@features/prepare-form/engine'
import type formOps from '@engine/ops/forms'
import { openFixture } from './helpers'

it('probe autosize', async () => {
  const e = await openFixture('text.pdf')
  const pf = e.ops<typeof pfOps>('prepare-form')
  const forms = e.ops<typeof formOps>('forms')
  for (const h of [14, 22, 30, 50]) {
    const t = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 100 + h] })
    await forms.setValue(t.id, 'Green')
    const c = await pf.create({ type: 'combo', page: 0, rect: [272, 100, 422, 100 + h], props: { options: [{ label: 'Green', value: 'Green' }], defaultSelection: ['Green'] } })
    const ap = (id: number) => e.session.pdf.newIndirect(id).resolve().get('AP').get('N').readStream().asString().replace(/\n/g, ' ')
    console.log(h, ap(t.id).slice(0, 200), '|||', ap(c.id).slice(0, 200))
    const t2 = await pf.create({ type: 'text', page: 0, rect: [72, 100, 122, 100 + h] })
    await forms.setValue(t2.id, 'A very long piece of text here')
    console.log('narrow', ap(t2.id).slice(0, 200))
  }
})
