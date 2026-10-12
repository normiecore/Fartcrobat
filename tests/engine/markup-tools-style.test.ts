import { describe, expect, it } from 'vitest'
import { builtinStyle, defaultsApply, fromAnnotDefaults, sanitize, styleSpec } from '@features/markup-tools/styleModel'
import { CYCLES, TOOL_BY_ID, TOOLS } from '@features/markup-tools/tools'

const tool = (id: string) => TOOL_BY_ID.get(id)!

describe('markup-tools tool definitions', () => {
  it('registers every tool id from the cross-feature contract', () => {
    const ids = TOOLS.map((t) => t.id)
    const contract = [
        'comment.note',
        'comment.highlight',
        'comment.underline',
        'comment.strikeout',
        'comment.squiggly',
        'comment.insertText',
        'comment.replaceText',
        'comment.typewriter',
        'comment.textbox',
        'comment.callout',
        'comment.pencil',
        'comment.eraser',
        'comment.rectangle',
        'comment.oval',
        'comment.line',
        'comment.arrow',
        'comment.polygon',
        'comment.polyline',
        'comment.cloud',
        'comment.areaHighlight'
      ]
    for (const id of contract) expect(ids).toContain(id)
    // plus Acrobat's "Attach file" comment tool
    expect(ids).toContain('comment.attachFile')
    expect(new Set(ids).size).toBe(TOOLS.length)
    expect(new Set(TOOLS.map((t) => t.key)).size).toBe(TOOLS.length)
  })

  it("uses Acrobat's single-key shortcuts", () => {
    expect(tool('comment.note').shortcut).toBe('S')
    expect(tool('comment.highlight').shortcut).toBe('U')
    expect(tool('comment.pencil').shortcut).toBe('D')
    expect(tool('comment.textbox').shortcut).toBe('X')
    expect(tool('comment.cloud').shortcut).toBe('Q')
    expect(tool('comment.note').moreShortcuts).toEqual(['Mod+6'])
    expect(CYCLES.map((c) => c.shortcut)).toEqual(['Shift+U', 'Shift+D', 'Shift+X'])
    // single keys are unique among the tools
    const keys = TOOLS.map((t) => t.shortcut).filter(Boolean)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of CYCLES) for (const id of c.tools) expect(TOOL_BY_ID.has(id)).toBe(true)
  })
})

describe('markup-tools styles', () => {
  it('maps tool settings to annotation properties', () => {
    expect(styleSpec(tool('comment.highlight'), builtinStyle('highlight'))).toEqual({ color: '#FFEB3B', opacity: 1 })
    expect(styleSpec(tool('comment.note'), builtinStyle('note'))).toMatchObject({ icon: 'Comment', color: '#FFEB3B' })
    expect(styleSpec(tool('comment.attachFile'), builtinStyle('attachFile'))).toMatchObject({ icon: 'PushPin' })

    const tw = styleSpec(tool('comment.typewriter'), { ...builtinStyle('typewriter'), fontSize: 16, fontColor: '#0000FF', font: 'Cour' })
    expect(tw).toMatchObject({ intent: 'FreeTextTypeWriter', borderWidth: 0, color: null, fontSize: 16, textColor: '#0000FF', fontName: 'Cour' })

    const box = styleSpec(tool('comment.textbox'), { ...builtinStyle('textbox'), fill: '#FFFFCC', lineStyle: 'dashed', width: 2 })
    expect(box).toMatchObject({ color: '#FFFFCC', borderWidth: 2, borderStyle: 'Dashed' })
    expect(box.intent).toBeUndefined()
    expect(styleSpec(tool('comment.callout'), builtinStyle('callout')).intent).toBe('FreeTextCallout')

    const rect = styleSpec(tool('comment.rectangle'), { ...builtinStyle('rectangle'), lineStyle: 'cloudy', fill: '#00FF00' })
    expect(rect).toMatchObject({ cloudy: true, interiorColor: '#00FF00', dashes: [] })
    const dashed = styleSpec(tool('comment.oval'), { ...builtinStyle('oval'), lineStyle: 'dashed', width: 2 })
    expect(dashed).toMatchObject({ cloudy: false, borderStyle: 'Dashed', dashes: [5, 5] })

    const arrow = styleSpec(tool('comment.arrow'), builtinStyle('arrow'))
    expect(arrow).toMatchObject({ intent: 'LineArrow', lineEndings: { start: 'None', end: 'OpenArrow' } })
    expect(styleSpec(tool('comment.line'), builtinStyle('line')).intent).toBeUndefined()
    // lines never get a cloudy border
    expect(styleSpec(tool('comment.line'), { ...builtinStyle('line'), lineStyle: 'cloudy' })).not.toHaveProperty('cloudy')

    expect(styleSpec(tool('comment.cloud'), builtinStyle('cloud'))).toMatchObject({ cloudy: true, intent: 'PolygonCloud' })
    expect(styleSpec(tool('comment.polyline'), builtinStyle('polyline'))).toHaveProperty('lineEndings')
    expect(styleSpec(tool('comment.pencil'), builtinStyle('pencil'))).toEqual({ color: '#2196F3', borderWidth: 2, opacity: 1 })
  })

  it('reads defaults saved by the comments feature', () => {
    expect(fromAnnotDefaults(tool('comment.rectangle'), { color: '#4caf50', interiorColor: null, borderWidth: 3, dashes: [3, 3], opacity: 0.5 })).toEqual({
      color: '#4CAF50',
      fill: null,
      width: 3,
      lineStyle: 'dashed',
      opacity: 0.5
    })
    // FreeText: /C is the background, the text colour comes from the appearance
    expect(fromAnnotDefaults(tool('comment.textbox'), { color: '#ffffff', textColor: '#ff0000', fontSize: 14, fontName: 'TiRo' })).toEqual({
      fill: '#FFFFFF',
      fontColor: '#FF0000',
      fontSize: 14,
      font: 'TiRo'
    })
    expect(fromAnnotDefaults(tool('comment.arrow'), { lineEndings: { start: 'Circle', end: 'ClosedArrow' } })).toEqual({ startEnd: 'Circle', endEnd: 'ClosedArrow' })
    expect(fromAnnotDefaults(tool('comment.callout'), { lineEndings: { start: 'ClosedArrow', end: 'None' } })).toEqual({ endEnd: 'ClosedArrow' })
    expect(fromAnnotDefaults(tool('comment.cloud'), { cloudy: true })).toEqual({ lineStyle: 'cloudy' })
    expect(fromAnnotDefaults(tool('comment.note'), 'nonsense')).toEqual({})
    expect(fromAnnotDefaults(tool('comment.note'), { color: 'red', icon: 'Key' })).toEqual({ icon: 'Key' })
  })

  it('applies an intent-specific default only to the matching tool', () => {
    const arrowDefault = { color: '#000000', intent: 'LineArrow' }
    expect(defaultsApply(tool('comment.arrow'), arrowDefault)).toBe(true)
    expect(defaultsApply(tool('comment.line'), arrowDefault)).toBe(false)
    expect(defaultsApply(tool('comment.line'), { color: '#000000', intent: null })).toBe(true)
    expect(defaultsApply(tool('comment.callout'), { intent: 'FreeTextCallout' })).toBe(true)
    expect(defaultsApply(tool('comment.textbox'), { intent: 'FreeTextCallout' })).toBe(false)
    expect(defaultsApply(tool('comment.cloud'), { intent: 'PolygonCloud' })).toBe(true)
    expect(defaultsApply(tool('comment.polygon'), { intent: 'PolygonCloud' })).toBe(false)
    // no intent recorded: every tool of the type
    expect(defaultsApply(tool('comment.line'), { color: '#000000' })).toBe(true)
    expect(defaultsApply(tool('comment.highlight'), { color: '#000000', intent: 'Whatever' })).toBe(true)
    expect(defaultsApply(tool('comment.highlight'), null)).toBe(false)
  })

  it('sanitizes stored settings', () => {
    expect(sanitize({ color: '#123456', opacity: 3, width: -1, lineStyle: 'wavy', font: 'Comic', fontSize: 12, eraserSize: 8, fill: null })).toEqual({
      color: '#123456',
      fontSize: 12,
      eraserSize: 8,
      fill: null
    })
    expect(sanitize(null)).toEqual({})
  })
})
