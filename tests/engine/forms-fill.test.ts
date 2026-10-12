import { describe, expect, it } from 'vitest'
import type formOps from '@engine/ops/forms'
import type fillOps from '@features/forms-fill/engine'
import { daWithColor } from '@features/forms-fill/engine'
import { signerCommonName } from '@features/forms-fill/der'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

function appearanceText(e: OpenedEngine, name: string): string {
  const s = e.session
  for (let p = 0; p < s.pageCount(); p++) {
    for (const w of s.page(p).getWidgets()) {
      if (w.getName() !== name) continue
      const n = w.getObject().get('AP').get('N')
      const str = n.isStream() ? n.readStream().asString() : ''
      return (str.match(/\((?:[^()\\]|\\.)*\)\s*Tj|\[[^\]]*\]\s*TJ/g) ?? []).join(' ')
    }
  }
  return ''
}

function appearanceStream(e: OpenedEngine, name: string): string {
  const s = e.session
  for (let p = 0; p < s.pageCount(); p++) {
    for (const w of s.page(p).getWidgets()) {
      if (w.getName() === name) return w.getObject().get('AP').get('N').readStream().asString()
    }
  }
  return ''
}

describe('forms-fill engine', () => {
  it('core setValue shows formatted text while keeping the raw value', async () => {
    const e = await openFixture('forms-fill/calc.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const id = (await forms.listAll()).find((f) => f.name === 'amount1')!.id
    await forms.setValue(id, '1234.5', { display: '$1,234.50' })
    const f = (await forms.listAll()).find((x) => x.name === 'amount1')!
    expect(f.value).toBe('1234.5')
    expect(appearanceText(e, 'amount1')).toContain('$1,234.50')
    const rt = await roundTrip(e)
    expect(appearanceText(rt, 'amount1')).toContain('$1,234.50')
    expect((await rt.ops<typeof formOps>('forms').listAll()).find((x) => x.name === 'amount1')!.value).toBe('1234.5')
  })

  it('snapshot returns fields, values, calculation order, scripts and tab order', async () => {
    const e = await openFixture('forms-fill/calc.pdf')
    const snap = await e.ops<typeof fillOps>('forms-fill').snapshot()
    expect(snap.calcOrder).toEqual(['total', 'net'])
    expect(snap.fields.find((f) => f.name === 'total')!.scripts.calculate).toContain('AFSimple_Calculate')
    expect(snap.values.amount1).toBe('')
    const order = snap.tabOrder.map((id) => snap.fields.find((f) => f.id === id)!.name)
    expect(order).toEqual(['amount1', 'amount2', 'total', 'discount', 'net', 'qty', 'orderDate'])
  })

  it('fills several fields with formatting and colour in one undo step', async () => {
    const e = await openFixture('forms-fill/calc.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    await fill.fill([
      { name: 'amount1', value: '1000', display: '$1,000.00' },
      { name: 'amount2', value: '-234.5', display: '($234.50)', textColor: '#ff0000' },
      { name: 'total', value: '765.5', display: '$765.50' }
    ])
    expect(e.lastChanges?.journal.undoLabel).toBe('Fill Form')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(e.lastChanges?.document).toBe(true)
    expect(appearanceText(e, 'total')).toContain('$765.50')
    expect(appearanceStream(e, 'amount2')).toMatch(/1 0 0 rg/)
    const snap = await fill.snapshot()
    expect(snap.values.total).toBe('765.5')
    expect(snap.fields.find((f) => f.name === 'amount2')!.textColor).toBe('#ff0000')
    await e.doc.undo()
    expect((await fill.snapshot()).values.total).toBe('')
    await e.doc.redo()
    expect((await fill.snapshot()).values.total).toBe('765.5')
  })

  it('writes check boxes, radio buttons, combo boxes with export values and multi-select lists', async () => {
    const e = await openFixture('forms-fill/all-fields.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    await fill.fill([
      { name: 'agree', value: true },
      { name: 'colour', value: 'B' },
      { name: 'languages', value: ['English', 'German'] },
      { name: 'contact', value: 'Post' },
      { name: 'state', value: 'Oregon' },
      { name: 'password', value: 'hunter2' }
    ])
    const values = (await fill.snapshot()).values
    expect(values.agree).toBe('Yes')
    expect(values.colour).toBe('B')
    expect(values.languages).toEqual(['English', 'German'])
    expect(values.contact).toBe('Post')
    expect(values.state).toBe('Oregon')
    expect(values.password).toBe('hunter2')
    // the combo box shows the label, not the export value
    expect(appearanceText(e, 'colour')).toContain('(Blue)')
    // passwords are never written into the appearance
    expect(appearanceText(e, 'password')).not.toContain('hunter2')
    expect(appearanceText(e, 'password')).toContain('*******')
    // list boxes highlight the selection
    expect(appearanceStream(e, 'languages').match(/0\.6 0\.757 0\.855 rg/g)?.length).toBe(2)
    expect(appearanceStream(e, 'contact').match(/0\.6 0\.757 0\.855 rg/g)?.length).toBe(1)
    const extras = await fill.pageExtras(0)
    const forms = await e.ops<typeof formOps>('forms').list(0)
    const langId = forms.find((f) => f.name === 'languages')!.id
    expect(extras.find((x) => x.id === langId)!.selected).toEqual(['English', 'German'])

    const rt = await roundTrip(e)
    const v2 = (await rt.ops<typeof fillOps>('forms-fill').snapshot()).values
    expect(v2.languages).toEqual(['English', 'German'])
    expect(v2.agree).toBe('Yes')

    await fill.fill([{ name: 'agree', value: 'Off' }])
    expect((await fill.snapshot()).values.agree).toBe('Off')
    await fill.fill([{ name: 'agree', value: 'yes' }])
    expect((await fill.snapshot()).values.agree).toBe('Yes')
  })

  it('selects radio buttons by export value', async () => {
    const e = await openFixture('form.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    await fill.fill([{ name: 'plan', value: 'pro' }])
    const fields = await e.ops<typeof formOps>('forms').listAll()
    const plan = fields.filter((f) => f.name === 'plan')
    expect(plan.find((f) => f.onState === 'pro')!.checked).toBe(true)
    expect(plan.find((f) => f.onState === 'basic')!.checked).toBe(false)
    expect((await fill.snapshot()).values.plan).toBe('pro')
    await fill.fill([{ name: 'plan', value: 'Off' }])
    expect((await e.ops<typeof formOps>('forms').listAll()).filter((f) => f.name === 'plan' && f.checked).length).toBe(0)
  })

  it('changes field visibility and flags from scripts', async () => {
    const e = await openFixture('forms-fill/all-fields.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    await fill.fill([{ name: 'lastName', visibility: 1, required: true }, { name: 'firstName', readOnly: true }])
    const fields = await e.ops<typeof formOps>('forms').listAll()
    expect(fields.find((f) => f.name === 'lastName')!.hidden).toBe(true)
    expect(fields.find((f) => f.name === 'lastName')!.required).toBe(true)
    expect(fields.find((f) => f.name === 'firstName')!.readOnly).toBe(true)
    await fill.fill([{ name: 'lastName', visibility: 0 }])
    expect((await e.ops<typeof formOps>('forms').listAll()).find((f) => f.name === 'lastName')!.hidden).toBe(false)
  })

  it('reports button actions, tab order with /Tabs and signature fields', async () => {
    const e = await openFixture('forms-fill/all-fields.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    const fields = await e.ops<typeof formOps>('forms').list(0)
    const extras = await fill.pageExtras(0)
    const byName = (n: string) => extras.find((x) => x.id === fields.find((f) => f.name === n)!.id)!
    expect(byName('resetButton').action).toEqual({ kind: 'reset', fields: [], exclude: false })
    expect(byName('submitButton').action).toEqual({ kind: 'submit', url: 'https://example.com/submit' })
    expect(byName('printButton').action).toEqual({ kind: 'js', script: 'this.print();' })
    expect(byName('signature1').signer).toBeNull()
    const order = [...extras].sort((a, b) => a.tabIndex - b.tabIndex).map((x) => fields.find((f) => f.id === x.id)!.name)
    expect(order.slice(0, 6)).toEqual(['firstName', 'lastName', 'password', 'pin', 'memberId', 'amountRight'])
    expect(order.indexOf('resetButton')).toBeLessThan(order.indexOf('submitButton'))
    expect(order.indexOf('agree')).toBeLessThan(order.indexOf('comments'))

    // whole-document order continues on page 2
    const all = await fill.tabOrder()
    const p2 = await e.ops<typeof formOps>('forms').list(1)
    expect(all.slice(-p2.length)).toEqual([...p2].sort((a, b) => a.rect[1] - b.rect[1]).map((f) => f.id))
  })

  it('follows /Tabs /A, /C and /S orders', async () => {
    const e = await openFixture('forms-fill/calc.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    const s = e.session
    const pageObj = s.page(0).getObject()
    const names = async () => {
      const fields = await e.ops<typeof formOps>('forms').list(0)
      const ex = await fill.pageExtras(0)
      return [...ex].sort((a, b) => a.tabIndex - b.tabIndex).map((x) => fields.find((f) => f.id === x.id)!.name)
    }
    // reverse the /Annots array and ask for annotation order
    const setTabs = (tabs: string, reverse = false) =>
      s.runMutation('test', () => {
        const obj = s.page(0).getObject()
        if (reverse) {
          const annots = obj.get('Annots').resolve()
          const items = []
          for (let i = 0; i < annots.length; i++) items.push(annots.get(i))
          const rev = s.pdf.newArray()
          for (const it of items.reverse()) rev.push(it)
          obj.put('Annots', rev)
        }
        obj.put('Tabs', s.pdf.newName(tabs))
        s.invalidatePages()
      })
    expect(pageObj.get('Tabs').isNull()).toBe(true)
    expect((await names())[0]).toBe('amount1')
    // reverse the /Annots array and ask for annotation order
    setTabs('A', true)
    expect((await names())[0]).toBe('orderDate')
    // structure order without a structure tree falls back to the annotation order
    setTabs('S')
    expect((await names())[0]).toBe('orderDate')
    // column order: all fields are in one column, so top to bottom
    setTabs('C')
    expect((await names())[0]).toBe('amount1')
  })

  it('exports values and parses FDF', async () => {
    const e = await openFixture('form.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    const values = await fill.exportValues()
    expect(values.find((v) => v.name === 'qty')).toEqual({ name: 'qty', type: 'text', value: '2', noExport: false })
    expect(values.find((v) => v.name === 'plan')!.value).toBe('basic')
    expect(values.find((v) => v.name === 'subscribe')!.value).toBe('Off')
    const fdf = new TextEncoder().encode(
      '%FDF-1.2\n1 0 obj\n<< /FDF << /F (form.pdf) /Fields [ << /T (fullName) /V (Ada) >> << /T (subscribe) /V /Yes >> << /T (address) /Kids [ << /T (city) /V (Paris) >> ] >> ] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
    )
    const parsed = await fill.parseFdf(fdf)
    expect(parsed.file).toBe('form.pdf')
    expect(parsed.fields).toEqual([
      { name: 'fullName', value: 'Ada' },
      { name: 'subscribe', value: 'Yes' },
      { name: 'address.city', value: 'Paris' }
    ])
    await expect(fill.parseFdf(new TextEncoder().encode('not a pdf at all'))).rejects.toThrow()
  })

  it('clears the form to default values in one undo step and repairs choice appearances', async () => {
    const e = await openFixture('forms-fill/all-fields.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    await fill.fill([
      { name: 'firstName', value: 'Ada' },
      { name: 'colour', value: 'B' },
      { name: 'languages', value: ['English'] },
      { name: 'agree', value: true },
      { name: 'memberId', value: 'X-1' }
    ])
    const defaults = await fill.defaultValues()
    expect(defaults.find((d) => d.name === 'colour')!.value).toBe('G')
    expect(defaults.find((d) => d.name === 'languages')!.value).toEqual(['French', 'Japanese'])
    expect(defaults.find((d) => d.name === 'agree')!.value).toBe('Off')
    expect(defaults.find((d) => d.name === 'firstName')!.value).toBe('')
    expect(defaults.some((d) => d.name === 'resetButton' || d.name === 'signature1')).toBe(false)

    await fill.reset(undefined, [{ name: 'firstName', value: '', display: undefined }])
    expect(e.lastChanges?.journal.undoLabel).toBe('Clear Form')
    const v = (await fill.snapshot()).values
    expect(v.firstName).toBe('')
    expect(v.colour).toBe('G')
    expect(v.languages).toEqual(['French', 'Japanese'])
    expect(v.agree).toBe('Off')
    expect(v.memberId).toBe('M-0042')
    // the combo box shows its label and the list box its selection, not MuPDF's defaults
    expect(appearanceText(e, 'colour')).toContain('(Green)')
    expect(appearanceStream(e, 'languages').match(/0\.6 0\.757 0\.855 rg/g)?.length).toBe(2)

    await e.doc.undo()
    const back = (await fill.snapshot()).values
    expect(back.firstName).toBe('Ada')
    expect(back.colour).toBe('B')
    expect(back.agree).toBe('Yes')
  })

  it('resets only the named fields (parent names include their children) and writes formatted defaults', async () => {
    const e = await openFixture('forms-fill/calc.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    await fill.fill([
      { name: 'amount1', value: '5', display: '$5.00' },
      { name: 'amount2', value: '7', display: '$7.00' }
    ])
    expect((await fill.defaultValues(['amount1'])).map((d) => d.name)).toEqual(['amount1'])
    await fill.reset(['amount1'], [{ name: 'total', value: '7', display: '$7.00' }])
    const v = (await fill.snapshot()).values
    expect(v.amount1).toBe('')
    expect(v.amount2).toBe('7')
    expect(v.total).toBe('7')
    expect(appearanceText(e, 'total')).toContain('$7.00')
    // undo restores both the cleared field and the recalculated total
    await e.doc.undo()
    const back = (await fill.snapshot()).values
    expect(back.amount1).toBe('5')
    expect(back.total).toBe('')

    const f = await openFixture('forms-fill/all-fields.pdf')
    expect(await f.ops<typeof fillOps>('forms-fill').defaultValues(['nothing'])).toEqual([])
  })

  it('reads radio and check box values from the widget states when the field has no /V', async () => {
    const e = await openFixture('form.pdf')
    const s = e.session
    s.runMutation('test', () => {
      for (const w of s.page(0).getWidgets()) {
        if (w.getName() !== 'plan') continue
        const obj = w.getObject()
        const field = obj.get('T').isNull() ? obj.get('Parent') : obj
        field.delete('V')
      }
    })
    const values = await e.ops<typeof fillOps>('forms-fill').exportValues()
    expect(values.find((x) => x.name === 'plan')!.value).toBe('basic')
  })

  it('replaces the colour in /DA strings', () => {
    expect(daWithColor('/Helv 12 Tf .1 .1 .1 rg', '#ff0000')).toBe('/Helv 12 Tf 1 0 0 rg')
    expect(daWithColor('/Helv 0 Tf 0 g', '#000000')).toBe('/Helv 0 Tf 0 g')
    expect(daWithColor('/Helv 10 Tf 0 0 0 1 k', '#0000ff')).toBe('/Helv 10 Tf 0 0 1 rg')
  })

  it('finds the signer name in a PKCS#7 signature', () => {
    // Minimal PKCS#7 SignedData with one certificate whose subject CN is "Jane Signer".
    const cn = [...new TextEncoder().encode('Jane Signer')]
    const tlv = (tag: number, body: number[]) => {
      const len = body.length
      const l = len < 128 ? [len] : len < 256 ? [0x81, len] : [0x82, len >> 8, len & 0xff]
      return [tag, ...l, ...body]
    }
    const name = tlv(0x30, tlv(0x31, tlv(0x30, [...tlv(0x06, [0x55, 0x04, 0x03]), ...tlv(0x0c, cn)])))
    const serial = tlv(0x02, [0x05])
    const algo = tlv(0x30, tlv(0x06, [0x2a, 0x86, 0x48]))
    const tbs = tlv(0x30, [...tlv(0xa0, tlv(0x02, [2])), ...serial, ...algo, ...name, ...tlv(0x30, []), ...name, ...tlv(0x30, [])])
    const cert = tlv(0x30, [...tbs, ...algo, ...tlv(0x03, [0])])
    const signerInfo = tlv(0x30, [...tlv(0x02, [1]), ...tlv(0x30, [...name, ...serial]), ...algo])
    const signedData = tlv(0x30, [...tlv(0x02, [1]), ...tlv(0x31, algo), ...tlv(0x30, tlv(0x06, [0x2a])), ...tlv(0xa0, cert), ...tlv(0x31, signerInfo)])
    const contentInfo = tlv(0x30, [...tlv(0x06, [0x2a, 0x86]), ...tlv(0xa0, signedData)])
    const padded = new Uint8Array([...contentInfo, 0, 0, 0, 0])
    expect(signerCommonName(padded)).toBe('Jane Signer')
    expect(signerCommonName(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
