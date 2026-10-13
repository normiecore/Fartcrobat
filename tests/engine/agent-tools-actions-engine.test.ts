import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import type pageOps from '@engine/ops/pages'
import type fillOps from '@features/forms-fill/engine'
import { FormRuntime } from '@features/forms-fill/js/runtime'
import type markupOps from '@features/markup-tools/engine'
import { builtinStyle } from '@features/markup-tools/styleModel'
import type navigationOps from '@features/navigation/engine'
import type organizeOps from '@features/organize-pages/engine'
import type redactOps from '@features/redact/engine'
import { DEFAULT_PROPS } from '@features/redact/shared'
import { agentAuthor, buildAnnotation, buildUpdate, type BuildContext } from '@features/agent-access/tools/act-annots'
import { formFields, planFill, resolveValues } from '@features/agent-access/tools/act-forms'
import { duplicatedIndices, insertedIndices, planOrganize } from '@features/agent-access/tools/act-pages'
import { markProps, markSpecsFromItems } from '@features/agent-access/tools/act-redact'
import { openFixture, type OpenedEngine } from './helpers'

/** AGENT_ACTOR in tools/common.tsx (which needs the app, so it is not imported here). */
const AGENT = 'Agent'

function buildContext(e: OpenedEngine): BuildContext {
  return {
    pageCount: e.info.pageCount,
    pageSize: (p) => e.info.pages[p],
    style: builtinStyle,
    author: agentAuthor('Claude')
  }
}

describe('agent tools through the engine', () => {
  it('labels the undo steps of an agent\'s comments "Agent: ..." and signs them as the agent', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.setAuthor('Pat')
    e.actor = AGENT
    const hl = buildAnnotation({ type: 'highlight', page: 1, rects: [[72, 72, 200, 86]], text: 'Look' }, 0, buildContext(e))
    const [created] = await e.ops<typeof markupOps>('markup-tools').create([{ page: hl.page, spec: hl.spec }], hl.tool.undoLabel)
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Add Highlight')
    expect(created).toMatchObject({ type: 'Highlight', author: 'Agent (Claude)', contents: 'Look', color: builtinStyle('highlight').color.toLowerCase() })
    expect(created.quads).toHaveLength(1)

    const note = buildAnnotation({ type: 'note', page: 2, rect: [100, 100, 300, 300] }, 0, buildContext(e))
    const plain = await annots.create(note.page, note.spec)
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Add Comment')
    expect(plain.rect).toEqual([100, 100, 120, 120])
    expect(plain.author).toBe('Agent (Claude)')

    // The person's own steps keep their plain labels.
    e.actor = null
    await annots.create(0, { type: 'Square', rect: [10, 10, 40, 40] })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Square')
    expect((await annots.get((await annots.list(0)).find((a) => a.type === 'Square')!.id)).author).toBe('Pat')
    await e.doc.undo()
    expect((await e.doc.journal()).undoLabel).toBe('Agent: Add Comment')
  })

  it('updates, moves, replies to and deletes comments as the agent', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    const box = await annots.create(0, buildAnnotation({ type: 'textbox', page: 1, rect: [72, 72, 272, 120], text: 'Hi' }, 0, buildContext(e)).spec)
    e.actor = AGENT
    const u = buildUpdate({ id: box.id, text: 'Hello', color: '#0000ff', rect: [100, 100, 300, 150] }, 0, () => box.type)
    await annots.update(u.id, u.spec, 0)
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Edit Annotation')
    await annots.transform([{ id: u.id, rect: u.rect! }], 0)
    const after = await annots.get(box.id)
    expect(after).toMatchObject({ contents: 'Hello', textColor: '#0000ff' })
    expect(after.rect.map(Math.round)).toEqual([100, 100, 300, 150])

    const reply = await annots.reply(box.id, 'Done', agentAuthor('Claude'))
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Reply to Comment')
    expect(reply).toMatchObject({ inReplyTo: box.id, author: 'Agent (Claude)', contents: 'Done' })
    await annots.setState(box.id, 'Completed', agentAuthor('Claude'))
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Set Comment Status')

    await annots.delete([box.id])
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Delete Annotation')
    expect(await annots.listAll()).toEqual([])
  })

  it('organizes pages where the plan says they go', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pageOps>('pages')
    const ids = e.info.pages.map((p) => p.id)
    e.actor = AGENT

    const move = planOrganize({ operation: 'move', before: 5 }, [0, 1], ids.length)
    if (move.op !== 'move') throw new Error('expected a move')
    await pages.move(move.pages, move.gap)
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Move Pages')
    let order = (await e.doc.info()).pages.map((p) => p.id)
    expect(move.after.map((i) => order[i])).toEqual([ids[0], ids[1]])
    expect(order).toEqual([ids[2], ids[3], ids[0], ids[1], ids[4]])

    const blank = planOrganize({ operation: 'insert_blank', before: 2, count: 2 }, null, order.length)
    if (blank.op !== 'insert_blank') throw new Error('expected insert_blank')
    await pages.insertBlank(blank.gap, { count: blank.count })
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Insert Pages')
    order = (await e.doc.info()).pages.map((p) => p.id)
    expect(order).toHaveLength(7)
    expect(insertedIndices(blank.gap, blank.count).every((i) => !ids.includes(order[i]))).toBe(true)

    const dup = planOrganize({ operation: 'duplicate' }, [0, 2], order.length)
    if (dup.op !== 'duplicate') throw new Error('expected duplicate')
    const created = await e.ops<typeof organizeOps>('organize-pages').duplicate(dup.pages)
    expect(created).toEqual(duplicatedIndices(dup.pages))
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Duplicate Pages')

    const rot = planOrganize({ operation: 'rotate', angle: -90 }, [0], 9)
    if (rot.op !== 'rotate') throw new Error('expected rotate')
    await pages.rotate(rot.pages, rot.degrees)
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Rotate Page')
    expect((await e.doc.info()).pages[0].rotation).toBe(270)
  })

  it('fills a form with its own formatting and calculations in one undo step', async () => {
    const e = await openFixture('forms-fill/calc.pdf')
    const fill = e.ops<typeof fillOps>('forms-fill')
    const snap = await fill.snapshot()
    const rt = new FormRuntime(snap)
    const entries = resolveValues(
      [
        { name: 'amount1', value: '1000' },
        { name: 'amount2', value: '234.5' }
      ],
      formFields(snap.fields)
    )
    const plan = planFill(rt, entries, { calculate: true })
    expect(plan.changes.find((c) => c.name === 'total')).toMatchObject({ value: '1234.5', display: '$1,234.50' })
    e.actor = AGENT
    await fill.fill(plan.changes, 'Fill Form')
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Fill Form')
    const values = Object.fromEntries((await e.ops<typeof formOps>('forms').listAll()).map((f) => [f.name, f.value]))
    expect(values).toMatchObject({ amount1: '1000', amount2: '234.5', total: '1234.5' })
    // the calculated field is read-only for the agent, as for the person
    expect(() => resolveValues([{ name: 'total', value: '1' }], formFields(snap.fields))).toThrow(/read-only/)
  })

  it('marks and applies redactions as the agent', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<typeof redactOps>('redact')
    e.actor = AGENT
    const specs = markSpecsFromItems([{ page: 1, rect: [72, 72, 300, 120] }, { page: 2 }], e.info.pageCount, (p) => e.info.pages[p])
    const marks = await redact.mark(specs, markProps(DEFAULT_PROPS, 'REDACTED'))
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Mark for Redaction')
    expect(marks.map((m) => [m.page, m.kind])).toEqual([
      [0, 'area'],
      [1, 'page']
    ])
    expect(marks[0].props).toMatchObject({ overlay: 'custom', customText: 'REDACTED' })
    const report = await redact.apply([marks[0].id])
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Apply Redactions')
    expect(report).toMatchObject({ marks: 1, pages: [0] })
    expect((await redact.list()).map((m) => m.id)).toEqual([marks[1].id])
  })

  it('changes document properties with the Document Properties op', async () => {
    const e = await openFixture('text.pdf')
    e.actor = AGENT
    await e.ops<typeof navigationOps>('navigation').setProperties({ metadata: { title: 'Quarterly report', keywords: 'q3, finance' } })
    expect(e.lastChanges?.journal.undoLabel).toBe('Agent: Change Document Properties')
    expect((await e.doc.info()).metadata).toMatchObject({ title: 'Quarterly report', keywords: 'q3, finance' })
  })
})
