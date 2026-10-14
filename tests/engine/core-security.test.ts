import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type textOps from '@engine/ops/text'
import type { SaveOptions } from '@shared/types'
import { openBytes } from './core-docs'
import { fixture, openFixture } from './helpers'

const TEXT = 'protected with the password'

async function textOf(bytes: Uint8Array, password?: string): Promise<string> {
  const e = await openBytes(bytes, 'out.pdf', password)
  return e.ops<typeof textOps>('text').plain(0)
}

describe('saving password-protected documents', () => {
  const variants: [string, SaveOptions, string | undefined][] = [
    ['compact and remove security', { garbage: 'compact', decrypt: true }, undefined],
    [
      'compact with new security',
      {
        garbage: 'compact',
        encrypt: { method: 'aes-256', userPassword: 'new', ownerPassword: 'own', permissions: {} }
      },
      'new'
    ],
    ['clean, keeping the security', { clean: true }, 'secret'],
    [
      'optimise images and fonts, keeping the security',
      { garbage: 'deduplicate', compressImages: true, compressFonts: true },
      'secret'
    ]
  ]
  for (const [label, opts, password] of variants) {
    it(label, async () => {
      const e = await openFixture('encrypted.pdf', 'secret')
      const bytes = await e.doc.save(opts)
      expect(await textOf(bytes, password)).toContain(TEXT)
      if (password === undefined) await expect(openBytes(bytes, 'x.pdf')).resolves.toBeTruthy()
      else await expect(openBytes(bytes, 'x.pdf')).rejects.toThrow(/password/)
    })
  }

  it('changing security never alters the live document', async () => {
    const e = await openFixture('encrypted.pdf', 'secret')
    await e.doc.save({ decrypt: true })
    await e.doc.save({
      encrypt: { method: 'aes-128', userPassword: 'x', ownerPassword: 'y', permissions: {} }
    })
    // a plain save afterwards still has the original security and readable content
    const plain = await e.doc.save({})
    expect(await textOf(plain, 'secret')).toContain(TEXT)
  })

  it('reloads a saved password-protected document with the password it was opened with', async () => {
    const e = await openFixture('encrypted.pdf', 'secret')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    const bytes = await e.doc.save({ mode: 'incremental' })
    const res = await e.doc.reload(bytes, {})
    expect(res.ok).toBe(true)
    expect((await e.ops<typeof annotOps>('annots').list(0)).some((a) => a.type === 'Square')).toBe(true)
  })

  it('leaves the open document untouched when the new bytes need another password', async () => {
    const e = await openFixture('text.pdf')
    const locked = await e.doc.save({
      encrypt: { method: 'aes-256', userPassword: 'other', ownerPassword: 'own', permissions: {} }
    })
    const res = await e.doc.reload(locked, {})
    expect(res).toEqual({ ok: false, needsPassword: true, wrongPassword: false, lock: expect.objectContaining({ handler: 'Standard' }) })
    expect(e.session.pending).toBeNull()
    expect(e.session.fileName).toBe('text.pdf')
    expect((await e.doc.info()).pageCount).toBe(5)
    const wrong = await e.doc.reload(locked, { password: 'nope' })
    expect(wrong).toEqual({ ok: false, needsPassword: true, wrongPassword: true, lock: res.ok ? null : res.lock })
    const ok = await e.doc.reload(locked, { password: 'other' })
    expect(ok.ok).toBe(true)
    expect(e.session.fileName).toBe('text.pdf')
  })

  it('incremental saves of an encrypted document chain correctly', async () => {
    const e = await openBytes(fixture('encrypted.pdf'), 'enc.pdf', 'secret')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    await e.doc.save({ mode: 'incremental' })
    await annots.create(0, { type: 'Circle', rect: [60, 60, 90, 90] })
    const second = await e.doc.save({ mode: 'incremental' })
    const again = await openBytes(second, 'x.pdf', 'secret')
    expect(again.info.wasRepaired).toBe(false)
    const types = (await again.ops<typeof annotOps>('annots').list(0)).map((a) => a.type)
    expect(types).toEqual(expect.arrayContaining(['Square', 'Circle']))
  })
})
