import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type textOps from '@engine/ops/text'
import { openFixture, roundTrip } from './helpers'

describe('annotations', () => {
  it('creates, lists, updates, moves and deletes annotations with undo', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.setAuthor('Tester')
    const note = await annots.create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'Check this', color: '#ffeb3b' })
    expect(note.type).toBe('Text')
    expect(note.author).toBe('Tester')
    expect(note.contents).toBe('Check this')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Comment')
    expect(e.lastChanges?.pages).toEqual([0])

    const sq = await annots.create(0, {
      type: 'Square',
      rect: [200, 200, 300, 260],
      color: '#ff0000',
      interiorColor: '#0000ff',
      borderWidth: 3,
      opacity: 0.5
    })
    expect(sq.color).toBe('#ff0000')
    expect(sq.interiorColor).toBe('#0000ff')
    expect(sq.borderWidth).toBe(3)
    expect(sq.opacity).toBeCloseTo(0.5)

    const ink = await annots.create(0, { type: 'Ink', ink: [[[10, 10], [50, 60], [90, 20]]], color: '#000000', borderWidth: 2 })
    expect(ink.ink[0].length).toBe(3)

    await annots.move([sq.id], 10, 20)
    const moved = await annots.get(sq.id)
    expect(moved.rect[0]).toBeCloseTo(sq.rect[0] + 10, 0)
    expect(moved.rect[1]).toBeCloseTo(sq.rect[1] + 20, 0)

    await annots.transform([{ id: ink.id, rect: [0, 0, 200, 200] }])
    const scaled = await annots.get(ink.id)
    expect(scaled.ink[0][0][0]).toBeLessThan(scaled.ink[0][2][0])

    await annots.update(note.id, { contents: 'Updated', color: '#00ff00' })
    expect((await annots.get(note.id)).contents).toBe('Updated')

    expect((await annots.list(0)).length).toBe(3)
    await annots.delete([sq.id])
    expect((await annots.list(0)).length).toBe(2)
    await e.doc.undo()
    expect((await annots.list(0)).length).toBe(3)
  })

  it('creates text markup from text quads and survives a save round trip', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    const t = await e.ops<typeof textOps>('text').page(1)
    const i = t.text.indexOf('quick brown fox')
    const q = t.quads
    const first = i * 8
    const last = (i + 'quick brown fox'.length - 1) * 8
    const quad: [number, number, number, number, number, number, number, number] = [
      q[first], q[first + 1], q[last + 2], q[last + 3], q[first + 4], q[first + 5], q[last + 6], q[last + 7]
    ]
    const hl = await annots.create(1, { type: 'Highlight', quads: [quad], color: '#ffeb3b', contents: 'important' })
    expect(hl.quads.length).toBe(1)
    const again = await roundTrip(e)
    const list = await again.ops<typeof annotOps>('annots').list(1)
    expect(list.map((a) => a.type)).toContain('Highlight')
    expect(list.find((a) => a.type === 'Highlight')?.contents).toBe('important')
  })

  it('supports reply threads, review states, free text, stamps and custom data', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    const note = await annots.create(0, { type: 'Text', rect: [50, 50, 70, 70], contents: 'Question?' })
    const reply = await annots.reply(note.id, 'Answer.', 'Bob')
    expect(reply.inReplyTo).toBe(note.id)
    expect(reply.hidden).toBe(true)
    const state = await annots.setState(note.id, 'Accepted', 'Bob')
    expect(state.state).toBe('Accepted')
    expect(state.stateModel).toBe('Review')

    const ft = await annots.create(0, {
      type: 'FreeText',
      rect: [100, 300, 300, 340],
      contents: 'Typed text',
      fontSize: 14,
      textColor: '#ff0000',
      extra: { kind: 'fill-sign-text' }
    })
    expect(ft.fontSize).toBe(14)
    expect(ft.textColor).toBe('#ff0000')
    expect(ft.extra.kind).toBe('fill-sign-text')

    const stamp = await annots.create(0, { type: 'Stamp', rect: [300, 400, 450, 450], icon: 'Approved' })
    expect(stamp.icon).toBe('Approved')

    // deleting the parent removes its replies
    await annots.delete([note.id])
    const all = await annots.list(0)
    expect(all.some((a) => a.inReplyTo === note.id)).toBe(false)
  })

  it('flattens annotations into the page content', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 100, 100], color: '#ff0000' })
    await annots.flatten({})
    expect((await annots.list(0)).length).toBe(0)
  })
})
