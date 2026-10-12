import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type pageOps from '@engine/ops/pages'
import type sigOps from '@features/digital-signatures/engine'
import { createSelfSignedId } from '@features/digital-signatures/lib/digitalId'
import { parseDigitalId } from '@features/digital-signatures/lib/pkcs12'
import { fixture } from './helpers'

const OUT = '/tmp/claude-0/-home-user-Fartcrobat/6e184722-e9e0-52a3-af71-91f5e11f80b2/scratchpad/digisig'

it('debug', async () => {
  const created = await createSelfSignedId({ name: 'Иван Петров', keyType: 'RSA', years: 5, password: 'secret1' })
  const id = parseDigitalId(created.p12, 'secret1')
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  await doc.open(fixture('text.pdf'), { fileName: 'text.pdf' })
  await engine.ops<typeof pageOps>('pages').rotate([1], 90)
  const info = await doc.info()
  const sig = engine.ops<typeof sigOps>('digital-signatures')
  const res = await sig.sign({
    mode: 'sign',
    target: { kind: 'new', page: 1, rect: [100, 100, 400, 200] },
    key: { pkcs8: id.pkcs8, alg: id.keyAlg },
    chain: id.chain,
    appearance: {
      name: 'Иван Петров',
      time: Date.now(),
      reason: 'Approved',
      location: 'Москва',
      options: { graphic: 'name', showName: true, showDate: true, showReason: true, showLocation: true, showLabels: true, showDistinguishedName: false }
    }
  })
  writeFileSync(`${OUT}/rot.pdf`, res.bytes)
  writeFileSync(`${OUT}/rot.txt`, JSON.stringify(info.pages[1]))
})
