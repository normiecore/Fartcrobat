import * as mupdf from 'mupdf'
import { describe, expect, it } from 'vitest'
import { defineOps, mutation } from '@engine/define'
import { Dispatcher } from '@engine/dispatcher'
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import { collectOpModules } from '@engine/registry'
import { Session } from '@engine/session'
import { fixture } from './helpers'

// Feature-style ops that change annotations through MuPDF's C API and then call s.touch(page).
const featureOps = defineOps('cachetest', {
  applyRedactions: mutation('Apply Redactions', (s, page: number) => {
    s.page(page).applyRedactions(true)
    s.touch(page)
  }),
  addTextField: mutation('Add Field', (s, page: number) => {
    const w = s.page(page).createAnnotation('Widget')
    w.setRect([300, 300, 400, 320])
    w.getObject().put('FT', s.pdf.newName('Tx'))
    w.getObject().put('T', s.pdf.newString('added'))
    const acro = s.pdf.getTrailer().get('Root', 'AcroForm')
    acro.get('Fields').push(w.getObject())
    s.touch(page)
  })
})

async function engineWithFeature(name: string) {
  mupdf.setLog({ warning: () => {}, error: () => {} })
  const session = new Session(mupdf)
  const dispatcher = new Dispatcher(session, [...collectOpModules(), featureOps])
  const call = async <T>(method: string, ...args: unknown[]) =>
    (await dispatcher.call(method, args)).result as T
  const ops = <M>(ns: string) =>
    new Proxy({} as any, {
      get:
        (_t, m) =>
        (...args: unknown[]) =>
          call(`${ns}.${String(m)}`, ...args)
    }) as M
  await call('doc.open', fixture(name), { fileName: name })
  return { session, call, ops }
}

describe('page cache after C-level annotation changes', () => {
  it('lists annotations correctly after redactions are applied on a cached page', async () => {
    const e = await engineWithFeature('text.pdf')
    const annots = e.ops<{ [K in keyof typeof annotOps.ops]: (...a: any[]) => Promise<any> }>('annots')
    await annots.create(0, { type: 'Square', rect: [300, 300, 350, 350] })
    await annots.create(0, { type: 'Redact', rect: [60, 60, 300, 120] })
    expect((await annots.list(0)).map((a: any) => a.type)).toContain('Redact')
    await e.call('cachetest.applyRedactions', 0)
    const after = await annots.list(0)
    expect(after.map((a: any) => a.type)).toEqual(['Square'])
    expect((await annots.listAll()).length).toBe(1)
  })

  it('lists a form field created through the C API', async () => {
    const e = await engineWithFeature('form.pdf')
    const forms = e.ops<{ [K in keyof typeof formOps.ops]: (...a: any[]) => Promise<any> }>('forms')
    const before = (await forms.list(0)).length
    await e.call('cachetest.addTextField', 0)
    const after = await forms.list(0)
    expect(after.length).toBe(before + 1)
    expect(after.some((f: any) => f.name === 'added')).toBe(true)
  })
})
