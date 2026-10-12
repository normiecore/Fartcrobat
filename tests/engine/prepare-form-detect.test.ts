import { describe, expect, it } from 'vitest'
import type formOps from '@engine/ops/forms'
import type pfOps from '@features/prepare-form/engine'
import { detectFields, nameFromLabel, type DetectLine } from '@features/prepare-form/detect'
import type { Rect } from '@shared/geometry'
import { openFixture } from './helpers'

const round = (r: Rect) => r.map((v) => Math.round(v))

describe('prepare-form: automatic field detection on blank-form.pdf', () => {
  it('finds underscores, lines, boxes, check boxes and signature lines', async () => {
    const e = await openFixture('prepare-form/blank-form.pdf')
    const pf = e.ops<typeof pfOps>('prepare-form')
    const found = await pf.detect()
    const by = Object.fromEntries(found.map((f) => [f.name, f]))
    const expectField = (name: string, type: string, source: string) => {
      expect(by[name], `${name} detected`).toBeDefined()
      expect(by[name].type, `${name} type`).toBe(type)
      expect(by[name].source, `${name} source`).toBe(source)
    }
    // labels followed by underscores
    expectField('Full name', 'text', 'underscores')
    expectField('Email', 'text', 'underscores')
    expectField('Phone', 'text', 'underscores')
    expectField('Date of birth', 'date', 'underscores')
    // labels followed by drawn lines
    expectField('Street address', 'text', 'line')
    expectField('City', 'text', 'line')
    expectField('Postcode', 'text', 'line')
    // drawn squares, a ballot box character and brackets
    expectField('Student', 'checkbox', 'box')
    expectField('Individual', 'checkbox', 'box')
    expectField('Family', 'checkbox', 'box')
    expectField('I agree to the club rules', 'checkbox', 'glyph')
    expectField('Send me the newsletter', 'checkbox', 'brackets')
    // an empty box with a label above it
    expectField('Comments', 'text', 'box')
    // lines with "Signature" and "Date" printed under them
    expectField('Signature', 'signature', 'line')
    expectField('Date', 'date', 'line')
    // the rule under the heading is decoration, not a field
    expect(found.length).toBe(15)

    // geometry: fields sit on their blanks (page space, y down; page is 792 high)
    expect(round(by['Street address'].rect)[0]).toBe(160)
    expect(round(by['Street address'].rect)[2]).toBe(400)
    expect(Math.abs(by['Street address'].rect[3] - (792 - 608))).toBeLessThan(1.5)
    expect(round(by.Student.rect)).toEqual([180, 234, 190, 244])
    expect(round(by.Comments.rect)).toEqual([72, 333, 472, 397])
    expect(by.Signature.rect[3] - by.Signature.rect[1]).toBeGreaterThanOrEqual(24)
    const fn = by['Full name'].rect
    expect(fn[0]).toBeGreaterThan(120)
    expect(fn[2]).toBeGreaterThan(300)
    expect(fn[3] - fn[1]).toBeGreaterThanOrEqual(14)
  })

  it('creates the detected fields in one undoable step and skips existing fields next time', async () => {
    const e = await openFixture('prepare-form/blank-form.pdf')
    const pf = e.ops<typeof pfOps>('prepare-form')
    const forms = e.ops<typeof formOps>('forms')
    const found = await pf.detect()
    await pf.createMany(
      found.map((f) => ({ type: f.type, page: f.page, rect: f.rect, name: f.name })),
      'Detect Form Fields'
    )
    const all = await forms.listAll()
    expect(all.length).toBe(found.length)
    expect(all.find((f) => f.name === 'Date of birth')!.scripts.format).toBe('AFDate_FormatEx("mm/dd/yyyy");')
    expect(all.find((f) => f.name === 'Signature')!.type).toBe('signature')
    expect(all.find((f) => f.name === 'Comments')!.multiline).toBe(true)
    // running detection again finds nothing new
    expect(await pf.detect()).toEqual([])
    await e.doc.undo()
    expect((await forms.listAll()).length).toBe(0)
  })

  it('finds nothing on a page of plain text', async () => {
    const e = await openFixture('text.pdf')
    expect(await e.ops<typeof pfOps>('prepare-form').detect()).toEqual([])
  })

  it('gives new names when the detected label is already a field', async () => {
    const e = await openFixture('prepare-form/blank-form.pdf')
    const pf = e.ops<typeof pfOps>('prepare-form')
    await pf.create({ type: 'text', page: 0, rect: [10, 760, 60, 780], name: 'City' })
    const found = await pf.detect([0])
    expect(found.find((f) => f.source === 'line' && f.rect[0] > 100 && f.rect[0] < 110)!.name).toBe('City_2')
  })
})

describe('prepare-form: detection heuristics', () => {
  const line = (text: string, x: number, y: number, size = 10): DetectLine => {
    const chars = [...text].map((c, i) => ({ c, rect: [x + i * size * 0.5, y, x + (i + 1) * size * 0.5, y + size] as Rect }))
    return { bbox: [x, y, x + text.length * size * 0.5, y + size], chars }
  }

  it('turns labels into field names', () => {
    expect(nameFromLabel('Full name (as on passport):')).toBe('Full name')
    expect(nameFromLabel('Email address*: ')).toBe('Email address')
    expect(nameFromLabel('  City ....... ')).toBe('City')
    expect(nameFromLabel('I confirm that the information I have given is complete and correct')).toBe('I confirm that the information I')
    expect(nameFromLabel('___')).toBe('')
  })

  it('reads labels on the left and under blanks', () => {
    const found = detectFields({
      page: 0,
      width: 612,
      height: 792,
      lines: [line('Name: __________', 50, 100), line('Sign here: ________', 50, 140)],
      shapes: [{ kind: 'hline', rect: [300, 199.5, 450, 200.5] }],
      existing: []
    })
    expect(found.map((f) => [f.name, f.type])).toEqual([
      ['Name', 'text'],
      ['Sign here', 'signature']
    ])
    // a rule without a label is not a field
    const withLabel = detectFields({
      page: 0,
      width: 612,
      height: 792,
      lines: [line('Date', 300, 204)],
      shapes: [{ kind: 'hline', rect: [300, 199.5, 450, 200.5] }],
      existing: []
    })
    expect(withLabel.map((f) => [f.name, f.type])).toEqual([['Date', 'date']])
  })

  it('ignores blanks covered by existing fields', () => {
    const found = detectFields({
      page: 0,
      width: 612,
      height: 792,
      lines: [line('Name: __________', 50, 100)],
      shapes: [],
      existing: [[70, 95, 130, 112]]
    })
    expect(found).toEqual([])
  })
})
