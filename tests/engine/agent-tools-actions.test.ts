import { describe, expect, it } from 'vitest'
import type { FieldInfo } from '@engine/ops/forms'
import { builtinStyle } from '@features/markup-tools/styleModel'
import { FormRuntime } from '@features/forms-fill/js/runtime'
import { DEFAULT_PROPS } from '@features/redact/shared'
import { InvalidArgs, colorArg, idList, optInteger, pageList, pagesPhrase } from '@features/agent-access/tools/act-common'
import {
  exportPath,
  imageExportPaths,
  imageFormatFor,
  isAbsolutePath,
  openErrorCode,
  pathArg,
  pdfPath,
  samePath,
  unsupportedMessage
} from '@features/agent-access/tools/act-files'
import { NOTE_SIZE, agentAuthor, buildAnnotation, buildUpdate, type BuildContext } from '@features/agent-access/tools/act-annots'
import { duplicatedIndices, gapBefore, insertedIndices, planOrganize, rotation } from '@features/agent-access/tools/act-pages'
import { closeNames, formFields, normalizeValue, planFill, resolveValues } from '@features/agent-access/tools/act-forms'
import { markProps, markSpecsFromItems } from '@features/agent-access/tools/act-redact'

const invalid = (fn: () => unknown, message?: RegExp) => {
  expect(fn).toThrow(InvalidArgs)
  if (message) expect(fn).toThrow(message)
}

describe('agent tools: argument helpers', () => {
  it('formats page lists and checks small arguments', () => {
    expect(pageList([0, 1, 2, 4, 6, 7])).toBe('1-3, 5, 7-8')
    expect(pagesPhrase([3])).toBe('page 4')
    expect(pagesPhrase([0, 1])).toBe('pages 1-2')
    expect(colorArg('#ffd400')).toBe('#FFD400')
    expect(colorArg('f00')).toBe('#FF0000')
    expect(colorArg(undefined)).toBeUndefined()
    invalid(() => colorArg('yellow'), /hex colour/)
    expect(idList([3, 3, 7], 'ids')).toEqual([3, 7])
    invalid(() => idList([1.5], 'ids'))
    expect(optInteger(undefined, 'dpi', 36, 600)).toBeUndefined()
    invalid(() => optInteger(20, 'dpi', 36, 600), /from 36 to 600/)
  })
})

describe('agent tools: paths and overwrite decisions', () => {
  it('accepts only absolute paths and normalizes them', () => {
    expect(isAbsolutePath('/home/a.pdf')).toBe(true)
    expect(isAbsolutePath('C:\\Users\\a.pdf')).toBe(true)
    expect(isAbsolutePath('C:/Users/a.pdf')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.pdf')).toBe(true)
    expect(isAbsolutePath('a.pdf')).toBe(false)
    expect(isAbsolutePath('~/a.pdf')).toBe(false)
    expect(pathArg('/home/me/./docs/../a.pdf')).toBe('/home/me/a.pdf')
    expect(pathArg('C:/Users/me/a.pdf')).toBe('C:\\Users\\me\\a.pdf')
    invalid(() => pathArg('docs/a.pdf'), /absolute path/)
    invalid(() => pathArg(''), /absolute path/)
    invalid(() => pathArg('/'), /not a folder/)
  })

  it('adds the right extensions', () => {
    expect(pdfPath('/a/Report')).toBe('/a/Report.pdf')
    expect(pdfPath('/a/Report.PDF')).toBe('/a/Report.PDF')
    expect(exportPath('/a/Report.docx', 'word')).toBe('/a/Report.docx')
    expect(exportPath('/a/Report', 'word')).toBe('/a/Report.docx')
    expect(exportPath('/a/Report.pdf', 'excel')).toBe('/a/Report.pdf.xlsx')
    expect(exportPath('/a/page.htm', 'html')).toBe('/a/page.htm')
    expect(exportPath('/a/scan', 'image', 'tiff')).toBe('/a/scan.tif')
    expect(exportPath('/a/scan.jpeg', 'image', 'jpeg')).toBe('/a/scan.jpeg')
  })

  it('numbers page images next to the first one', () => {
    expect(imageExportPaths('/out/Report.png', [0, 1, 4], 'png')).toEqual(['/out/Report.png', '/out/Report_2.png', '/out/Report_5.png'])
    expect(imageExportPaths('C:\\out\\Report', [2, 3], 'jpeg')).toEqual(['C:\\out\\Report.jpg', 'C:\\out\\Report_4.jpg'])
  })

  it('picks the image format from the argument or the extension', () => {
    expect(imageFormatFor('/a/x.png')).toBe('png')
    expect(imageFormatFor('/a/x.JPG')).toBe('jpeg')
    expect(imageFormatFor('/a/x.tiff')).toBe('tiff')
    expect(imageFormatFor('/a/x')).toBe('png')
    expect(imageFormatFor('/a/x.png', 'jpeg')).toBe('jpeg')
    invalid(() => imageFormatFor('/a/x', 'gif'), /image_format/)
  })

  it('compares paths the way the file system does', () => {
    expect(samePath('C:\\Docs\\A.pdf', 'c:/docs/a.pdf', 'win32')).toBe(true)
    expect(samePath('/Docs/A.pdf', '/docs/a.pdf', 'linux')).toBe(false)
    expect(samePath('/docs/./a.pdf', '/docs/a.pdf', 'linux')).toBe(true)
    expect(samePath(null, '/docs/a.pdf', 'linux')).toBe(false)
  })

  it('tells protection Fartcrobat cannot open from other open errors', () => {
    expect(openErrorCode("This file could not be opened: unknown encryption handler: 'Adobe.PubSec'")).toBe('unsupported')
    expect(openErrorCode("unknown encryption handler: 'MicrosoftIRMServices'")).toBe('unsupported')
    expect(openErrorCode('cannot find startxref')).toBe('file_error')
    expect(unsupportedMessage('a.pdf', "'Adobe.PubSec'")).toMatch(/certificate encryption/)
    expect(unsupportedMessage('a.pdf', "'MicrosoftIRMServices'")).toMatch(/Purview/)
  })
})

describe('agent tools: annotation specs', () => {
  const ctx: BuildContext = {
    pageCount: 3,
    pageSize: () => ({ width: 612, height: 792 }),
    style: builtinStyle,
    author: agentAuthor('Claude')
  }
  const build = (item: Record<string, unknown>) => buildAnnotation(item, 0, ctx)

  it('places sticky notes as a 20 pt icon at the top-left of rect, inside the page', () => {
    const b = build({ type: 'note', page: 2, rect: [100, 200, 300, 400], text: 'Check this' })
    expect(b.page).toBe(1)
    expect(b.spec).toMatchObject({ type: 'Text', rect: [100, 200, 100 + NOTE_SIZE, 200 + NOTE_SIZE], contents: 'Check this', author: 'Agent (Claude)', icon: 'Comment' })
    expect(b.spec.color).toBe(builtinStyle('note').color)
    expect(b.tool.undoLabel).toBe('Add Sticky Note')
    // at the page edge it is pulled back onto the page
    expect(build({ type: 'note', page: 1, rect: [605, 785, 612, 792] }).spec.rect).toEqual([592, 772, 612, 792])
  })

  it('builds text boxes with font size and text colour', () => {
    const b = build({ type: 'textbox', page: 1, rect: [72, 72, 272, 120], text: 'Hello', color: '#0000ff', font_size: 18 })
    expect(b.spec).toMatchObject({ type: 'FreeText', rect: [72, 72, 272, 120], contents: 'Hello', fontSize: 18, textColor: '#0000FF', fontName: 'Helv', color: null })
    invalid(() => build({ type: 'textbox', page: 1, rect: [72, 72, 272, 120] }), /needs text/)
    invalid(() => build({ type: 'textbox', page: 1, rect: [72, 72, 272, 120], text: 'x', font_size: 2 }), /font_size/)
  })

  it('turns text markup rects into quads, one per line', () => {
    const b = build({ type: 'highlight', page: 1, rects: [[10, 20, 110, 32], [10, 34, 60, 46]], text: 'note' })
    expect(b.spec.type).toBe('Highlight')
    expect(b.spec.quads).toEqual([
      [10, 20, 110, 20, 10, 32, 110, 32],
      [10, 34, 60, 34, 10, 46, 60, 46]
    ])
    expect(b.spec.contents).toBe('note')
    expect(b.spec.color).toBe(builtinStyle('highlight').color)
    expect(build({ type: 'strikeout', page: 1, rect: [10, 20, 110, 32] }).spec.type).toBe('StrikeOut')
    expect(build({ type: 'squiggly', page: 1, rect: [10, 20, 110, 32], color: '#00ff00' }).spec).toMatchObject({ type: 'Squiggly', color: '#00FF00' })
    expect(build({ type: 'underline', page: 1, rect: [110, 32, 10, 20] }).spec.quads).toEqual([[10, 20, 110, 20, 10, 32, 110, 32]])
    invalid(() => build({ type: 'highlight', page: 1 }), /needs rects/)
  })

  it('builds shapes, lines and arrows like the drawing tools', () => {
    expect(build({ type: 'rectangle', page: 1, rect: [10, 10, 50, 40] }).spec).toMatchObject({ type: 'Square', rect: [10, 10, 50, 40], borderWidth: 2 })
    expect(build({ type: 'oval', page: 1, rect: [10, 10, 50, 40] }).spec.type).toBe('Circle')
    const line = build({ type: 'line', page: 1, from: [10, 10], to: [200, 50] })
    expect(line.spec).toMatchObject({ type: 'Line', line: [[10, 10], [200, 50]], lineEndings: { start: 'None', end: 'None' } })
    const arrow = build({ type: 'arrow', page: 1, rect: [300, 300, 100, 100] })
    expect(arrow.spec).toMatchObject({ type: 'Line', line: [[100, 100], [300, 300]], lineEndings: { start: 'None', end: 'OpenArrow' }, intent: 'LineArrow' })
    expect(arrow.tool.undoLabel).toBe('Add Arrow')
    invalid(() => build({ type: 'line', page: 1, from: [10, 10] }), /both from and to/)
    invalid(() => build({ type: 'rectangle', page: 1, rect: [10, 10, 10.5, 40] }), /too small/)
  })

  it('rejects bad items with the item index', () => {
    invalid(() => build({ type: 'stamp', page: 1 }), /items\[0\]\.type/)
    invalid(() => build({ type: 'note', page: 4, rect: [1, 1, 2, 2] }), /page 4 does not exist/)
    invalid(() => build({ type: 'note', page: 1 }), /needs rect/)
    invalid(() => build({ type: 'rectangle', page: 1, rect: [700, 10, 800, 40] }), /outside page 1, which is 612 x 792/)
    invalid(() => buildAnnotation('x', 3, ctx), /items\[3\]/)
  })

  it('builds updates and refuses form fields and links', () => {
    const types: Record<number, string> = { 1: 'FreeText', 2: 'Square', 3: 'Widget', 4: 'Link' }
    const typeOf = (id: number) => types[id] ?? null
    expect(buildUpdate({ id: 1, color: '#112233', text: 'New' }, 0, typeOf)).toEqual({ id: 1, spec: { contents: 'New', textColor: '#112233' }, rect: undefined })
    expect(buildUpdate({ id: 2, color: '#112233', rect: [50, 50, 10, 10] }, 0, typeOf)).toEqual({ id: 2, spec: { color: '#112233' }, rect: [10, 10, 50, 50] })
    invalid(() => buildUpdate({ id: 3, text: 'x' }, 0, typeOf), /form field/)
    invalid(() => buildUpdate({ id: 4, text: 'x' }, 0, typeOf), /link/)
    invalid(() => buildUpdate({ id: 9, text: 'x' }, 0, typeOf), /No comment with id 9/)
    invalid(() => buildUpdate({ id: 2 }, 1, typeOf), /updates\[1\] changes nothing/)
  })
})

describe('agent tools: organize pages arithmetic', () => {
  it('turns "before" into a gap and angles into rotations', () => {
    expect(gapBefore(undefined, 5)).toBe(5)
    expect(gapBefore(1, 5)).toBe(0)
    expect(gapBefore(6, 5)).toBe(5)
    invalid(() => gapBefore(7, 5), /from 1 to 6/)
    expect(rotation(-90)).toBe(270)
    expect(rotation(180)).toBe(180)
    invalid(() => rotation(45), /angle/)
  })

  it('plans every operation', () => {
    expect(planOrganize({ operation: 'rotate', angle: 90 }, null, 3)).toEqual({ op: 'rotate', pages: [0, 1, 2], degrees: 90 })
    expect(planOrganize({ operation: 'delete' }, [1], 3)).toEqual({ op: 'delete', pages: [1] })
    // pages 1 and 2 go in front of page 5: the moved pages end up at 3 and 4
    expect(planOrganize({ operation: 'move', before: 5 }, [0, 1], 5)).toEqual({ op: 'move', pages: [0, 1], gap: 4, after: [2, 3] })
    expect(planOrganize({ operation: 'move' }, [0], 3)).toEqual({ op: 'move', pages: [0], gap: 3, after: [2] })
    expect(planOrganize({ operation: 'insert_blank', before: 2, count: 3 }, null, 4)).toEqual({ op: 'insert_blank', gap: 1, count: 3 })
    expect(planOrganize({ operation: 'insert_file', path: '/tmp/x.pdf' }, null, 4)).toEqual({ op: 'insert_file', gap: 4, path: '/tmp/x.pdf' })
    expect(planOrganize({ operation: 'duplicate' }, [2, 0], 4)).toEqual({ op: 'duplicate', pages: [2, 0] })
    expect(insertedIndices(1, 3)).toEqual([1, 2, 3])
    expect(duplicatedIndices([2, 0])).toEqual([3, 4])
  })

  it('refuses what would break the document or change nothing', () => {
    invalid(() => planOrganize({ operation: 'delete' }, [0, 1, 2], 3), /at least one page/)
    invalid(() => planOrganize({ operation: 'delete' }, null, 3), /Give the pages to delete/)
    invalid(() => planOrganize({ operation: 'move', before: 1 }, [0], 3), /already there/)
    invalid(() => planOrganize({ operation: 'move', before: 4 }, [2], 3), /already there/)
    invalid(() => planOrganize({ operation: 'insert_file' }, null, 3), /needs path/)
    invalid(() => planOrganize({ operation: 'insert_file', path: 'x.pdf' }, null, 3), /absolute/)
    invalid(() => planOrganize({ operation: 'rotate' }, null, 3), /angle/)
    invalid(() => planOrganize({ operation: 'shuffle' }, null, 3), /operation must be one of/)
    invalid(() => planOrganize({ operation: 'insert_blank', count: 0 }, null, 3), /count/)
  })
})

let nextId = 1
function widget(name: string, patch: Partial<FieldInfo> = {}): FieldInfo {
  return {
    id: nextId++,
    page: 0,
    name,
    type: 'text',
    rect: [0, 0, 100, 20],
    value: '',
    checked: false,
    onState: null,
    options: [],
    tooltip: '',
    readOnly: false,
    required: false,
    noExport: false,
    multiline: false,
    password: false,
    comb: false,
    maxLen: 0,
    multiSelect: false,
    editable: false,
    doNotSpellCheck: false,
    alignment: 0,
    fontName: 'Helv',
    fontSize: 12,
    textColor: '#000000',
    borderColor: null,
    backgroundColor: null,
    scripts: {},
    hidden: false,
    signed: false,
    ...patch
  }
}

describe('agent tools: form values', () => {
  const widgets = [
    widget('name'),
    widget('agree', { type: 'checkbox', onState: 'Yes' }),
    widget('plan', { type: 'radio', onState: 'basic' }),
    widget('plan', { type: 'radio', onState: 'pro' }),
    widget('colour', { type: 'combo', options: [{ label: 'Red', value: 'R' }, { label: 'Green', value: 'G' }] }),
    widget('state', { type: 'combo', editable: true, options: [{ label: 'Texas', value: 'Texas' }] }),
    widget('languages', { type: 'list', multiSelect: true, options: [{ label: 'English', value: 'en' }, { label: 'French', value: 'fr' }] }),
    widget('memberId', { readOnly: true }),
    widget('signature1', { type: 'signature' }),
    widget('address.city'),
    widget('pin', { password: true })
  ]
  const fields = formFields(widgets)

  it('groups widgets by field name', () => {
    expect(fields.get('plan')!.onStates).toEqual(['basic', 'pro'])
    expect(fields.get('agree')!.onStates).toEqual(['Yes'])
    expect(fields.size).toBe(10)
  })

  it('converts values the way each field stores them', () => {
    const f = (n: string) => fields.get(n)!
    expect(normalizeValue(f('name'), 'Ada')).toBe('Ada')
    invalid(() => normalizeValue(f('name'), true), /text field/)
    expect(normalizeValue(f('agree'), true)).toBe('Yes')
    expect(normalizeValue(f('agree'), false)).toBe('Off')
    expect(normalizeValue(f('agree'), 'yes')).toBe('Yes')
    expect(normalizeValue(f('agree'), 'no')).toBe('Off')
    invalid(() => normalizeValue(f('agree'), 'maybe'), /check box/)
    expect(normalizeValue(f('plan'), 'PRO')).toBe('pro')
    expect(normalizeValue(f('plan'), false)).toBe('Off')
    invalid(() => normalizeValue(f('plan'), 'gold'), /"basic", "pro"/)
    expect(normalizeValue(f('colour'), 'Green')).toBe('G')
    expect(normalizeValue(f('colour'), 'r')).toBe('R')
    invalid(() => normalizeValue(f('colour'), 'Blue'), /"R \(Red\)", "G \(Green\)"/)
    expect(normalizeValue(f('state'), 'Ohio')).toBe('Ohio')
    expect(normalizeValue(f('languages'), 'French')).toEqual(['fr'])
    expect(normalizeValue(f('languages'), '')).toEqual([])
    invalid(() => normalizeValue(f('signature1'), 'x'), /sign_document/)
  })

  it('suggests close field names', () => {
    expect(closeNames('Name', ['name', 'agree', 'plan'])).toEqual(['name'])
    expect(closeNames('city', ['address.city', 'agree'])).toEqual(['address.city'])
    expect(closeNames('colour', ['color', 'plan'])).toEqual(['color'])
    expect(closeNames('zzzzzz', ['name', 'agree'])).toEqual([])
  })

  it('checks every entry before anything is written', () => {
    const entries = resolveValues([{ name: 'name', value: 'Ada' }, { name: 'agree', value: true }, { name: 'name', value: 'Grace' }], fields)
    expect(entries.map((e) => [e.field.name, e.value])).toEqual([['name', 'Grace'], ['agree', 'Yes']])
    invalid(() => resolveValues([{ name: 'nmae', value: 'x' }], fields), /No field named "nmae" \(did you mean "name"\?\)/)
    invalid(() => resolveValues([{ name: 'memberId', value: 'x' }], fields), /read-only/)
    invalid(() => resolveValues([{ name: 'signature1', value: 'x' }], fields), /sign_document/)
    invalid(() => resolveValues([], fields), /values must be/)
    invalid(() => resolveValues([{ value: 'x' }], fields), /values\[0\]/)
    invalid(() => resolveValues([{ name: 'x', value: 'y' }], new Map()), /no form fields/)
  })

  it("runs the form's formatting, validation and calculations like typing", () => {
    const MONEY_F = 'AFNumber_Format(2, 0, 0, 0, "$", true);'
    const MONEY_K = 'AFNumber_Keystroke(2, 0, 0, 0, "$", true);'
    const form = [
      widget('amount1', { scripts: { format: MONEY_F, keystroke: MONEY_K } }),
      widget('amount2', { scripts: { format: MONEY_F, keystroke: MONEY_K } }),
      widget('total', { readOnly: true, scripts: { format: MONEY_F, calculate: 'AFSimple_Calculate("SUM", new Array ("amount1", "amount2"));' } }),
      widget('qty', { scripts: { keystroke: 'AFNumber_Keystroke(0, 1, 0, 0, "", true);', validate: 'AFRange_Validate(true, 0, true, 100);' } }),
      widget('pin', { password: true })
    ]
    const rt = new FormRuntime({ fields: form, values: {}, calcOrder: ['total'] })
    const all = formFields(form)
    const plan = planFill(rt, resolveValues([{ name: 'amount1', value: '1000' }, { name: 'amount2', value: '234.5' }, { name: 'pin', value: '1234' }], all), { calculate: true })
    expect(plan.changes).toEqual([
      { name: 'amount1', value: '1000', display: '$1,000.00' },
      { name: 'amount2', value: '234.5', display: '$234.50' },
      { name: 'pin', value: '1234', display: '****' },
      { name: 'total', value: '1234.5', display: '$1,234.50' }
    ])
    expect(rt.value('total')).toBe('1234.5')
    // a value the form's validation refuses leaves everything as it was
    expect(() => planFill(rt, resolveValues([{ name: 'amount1', value: '5' }, { name: 'qty', value: '150' }], all), { calculate: true })).toThrow(/rejected the value for "qty"/)
    expect(rt.value('amount1')).toBe('1000')
    // without automatic calculation the totals are left alone
    const quiet = planFill(rt, resolveValues([{ name: 'amount1', value: '1' }], all), { calculate: false })
    expect(quiet.changes.map((c) => c.name)).toEqual(['amount1'])
    quiet.restore()
    expect(rt.value('amount1')).toBe('1000')
  })
})

describe('agent tools: redaction marks', () => {
  const size = () => ({ width: 612, height: 792 })

  it('builds text, area and whole-page marks', () => {
    expect(markSpecsFromItems([{ page: 1, rects: [[10, 10, 50, 20]] }, { page: 2, rect: [5, 5, 100, 100] }, { page: 3 }], 3, size)).toEqual([
      { page: 0, kind: 'text', quads: [[10, 10, 50, 10, 10, 20, 50, 20]] },
      { page: 1, kind: 'area', rect: [5, 5, 100, 100] },
      { page: 2, kind: 'page', rect: [0, 0, 612, 792] }
    ])
    expect(markSpecsFromItems(undefined, 3, size)).toEqual([])
    invalid(() => markSpecsFromItems([{ page: 4 }], 3, size), /from 1 to 3/)
    invalid(() => markSpecsFromItems([{ page: 1, rect: [1, 1, 1.2, 1.2] }], 3, size), /too small/)
  })

  it('prints overlay text when asked', () => {
    expect(markProps(DEFAULT_PROPS)).toBe(DEFAULT_PROPS)
    expect(markProps(DEFAULT_PROPS, ' REDACTED ')).toMatchObject({ overlay: 'custom', customText: 'REDACTED', fillColor: '#000000' })
  })
})
