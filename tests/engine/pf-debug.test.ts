import { it } from 'vitest'
import type pfOps from '@features/prepare-form/engine'
import { openFixture } from './helpers'

it('debug listAll', async () => {
  const e = await openFixture('text.pdf')
  const r = await e.ops<typeof pfOps>('prepare-form').listAll()
  console.log(JSON.stringify(r.tabs), r.fields.length)
})
