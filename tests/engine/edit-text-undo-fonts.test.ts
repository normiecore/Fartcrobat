import { describe, expect, it } from 'vitest'
import type agentText from '@features/agent-access/engine'
import type { TextChange } from '@features/agent-access/textEdits'
import type annotOps from '@engine/ops/annots'
import type textOps from '@engine/ops/text'
import type ops from '@features/edit-text/engine'
import type { Run, TextBlockInfo, TextEdit } from '@features/edit-text/model'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

// MuPDF keeps a per-document cache of the font objects addSimpleFont, addFont and addCJKFont
// made, and the cache is not part of the undo journal. After an undo it would hand back a
// reference to the object the undo removed.

const edit = (e: OpenedEngine) => e.ops<typeof ops>('edit-text')
const pageText = async (e: OpenedEngine, page = 0) => (await e.ops<typeof textOps>('text').page(page)).text

function editOf(b: TextBlockInfo, runs: Run[] | string): TextEdit {
  return {
    source: { start: b.start, end: b.end, check: b.text },
    frame: b.frame,
    runs: typeof runs === 'string' ? [{ ...b.runs[0], text: runs }] : runs,
    align: b.align,
    lineSpacing: b.lineSpacing,
    wrap: b.wrap,
    ascent: b.ascent
  }
}

async function block(e: OpenedEngine, startsWith: string): Promise<TextBlockInfo> {
  const b = (await edit(e).analyze(0)).find((x) => x.text.startsWith(startsWith))
  if (!b) throw new Error(`no block starting with ${startsWith}`)
  return b
}

/** Font of the span that holds `needle` on page 1. */
async function fontAt(e: OpenedEngine, needle: string): Promise<string> {
  const t = await e.ops<typeof textOps>('text').page(0)
  const at = t.text.indexOf(needle)
  expect(at, `"${needle}" on the page`).toBeGreaterThanOrEqual(0)
  return t.spans.find((s) => s.start <= at && s.end > at)!.font
}

/** Commits `to` over the block starting with `from`, undoes it, and commits it again. */
async function commitUndoCommit(e: OpenedEngine, from: string, to: string, redo = false) {
  const original = await pageText(e)
  await edit(e).commit(0, editOf(await block(e, from), to))
  expect(await pageText(e)).toContain(to)
  await e.doc.undo()
  expect(await pageText(e)).toBe(original)
  if (redo) {
    await e.doc.redo()
    expect(await pageText(e)).toContain(to)
    await e.doc.undo()
    expect(await pageText(e)).toBe(original)
  }
  await edit(e).commit(0, editOf(await block(e, from), to))
  expect(await pageText(e)).toContain(to)
}

/** Saves, reopens and checks the text is there and still editable. */
async function survivesSave(e: OpenedEngine, text: string, font: RegExp) {
  const again = await roundTrip(e)
  expect(await pageText(again)).toContain(text)
  const t = await again.ops<typeof textOps>('text').page(0)
  const at = t.text.indexOf(text)
  expect(t.spans.find((s) => s.start <= at && s.end > at)!.font).toMatch(font)
  expect((await edit(again).analyze(0)).some((b) => b.text.includes(text))).toBe(true)
  again.session.closeDocument()
}

describe('edit-text: fonts after undo', () => {
  it('commits again after undo with a standard font', async () => {
    const e = await openFixture('text.pdf')
    await commitUndoCommit(e, 'Hello Fartcrobat page 1', 'Goodbye again')
    expect(await fontAt(e, 'Goodbye again')).toBe('Helvetica')
    await survivesSave(e, 'Goodbye again', /Helvetica/)
  })

  it('commits again after undo and redo', async () => {
    const e = await openFixture('text.pdf')
    await commitUndoCommit(e, 'Hello Fartcrobat page 1', 'Goodbye again', true)
    await survivesSave(e, 'Goodbye again', /Helvetica/)
  })

  it('commits again after undo with a standard font as a CID font and a CJK font', async () => {
    const e = await openFixture('text.pdf')
    // Ā is not in WinAnsi (the standard font is embedded as a CID font), 漢 needs a CJK font
    await commitUndoCommit(e, 'Hello Fartcrobat page 1', 'Ā 漢字 again')
    const t = await pageText(e)
    expect(t).toContain('Ā 漢字 again')
    const again = await roundTrip(e)
    expect(await pageText(again)).toContain('Ā 漢字 again')
    again.session.closeDocument()
  })

  it('commits again after undo with an embedded subset font', async () => {
    const e = await openFixture('edit-text/subset-font.pdf')
    await commitUndoCommit(e, 'Embedded subset', 'Embedded font kept')
    expect(await fontAt(e, 'Embedded font kept')).toMatch(/DejaVuSans/)
    await survivesSave(e, 'Embedded font kept', /DejaVuSans/)
  })

  it('commits again after an undo followed by other edits', async () => {
    const e = await openFixture('text.pdf')
    const original = await pageText(e)
    await edit(e).commit(0, editOf(await block(e, 'Hello Fartcrobat page 1'), 'Goodbye again'))
    await e.doc.undo()
    expect(await pageText(e)).toBe(original)
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Text', contents: 'A note', rect: [10, 10, 30, 30] })
    await annots.create(0, { type: 'Text', contents: 'Another note', rect: [40, 10, 60, 30] })
    await edit(e).commit(0, editOf(await block(e, 'Hello Fartcrobat page 1'), 'Goodbye again'))
    expect(await fontAt(e, 'Goodbye again')).toBe('Helvetica')
    const notes = await annots.listAll()
    expect(notes.map((a) => a.contents).sort()).toEqual(['A note', 'Another note'])
    await survivesSave(e, 'Goodbye again', /Helvetica/)
  })

  it('adds the same font once when it is used again without an undo', async () => {
    const e = await openFixture('text.pdf')
    await edit(e).commit(0, editOf(await block(e, 'Hello Fartcrobat page 1'), 'First edit'))
    await edit(e).commit(0, editOf(await block(e, 'Chapter 1'), 'Second edit'))
    await edit(e).commit(
      1,
      editOf(
        (await edit(e).analyze(1)).find((b) => b.text.startsWith('Hello'))!,
        'Page two'
      )
    )
    const doc = e.session.pdf
    let fonts = 0
    for (let n = 1; n < doc.countObjects(); n++) {
      try {
        const o = doc.newIndirect(n).resolve()
        if (o.isDictionary() && o.get('FartcrobatFont').isString()) fonts++
      } catch {}
    }
    // Helvetica-Bold for the heading and Helvetica for the paragraphs
    expect(fonts).toBe(2)
  })
})

describe('native MCP text editing: fonts after undo', () => {
  it('applies the same edit again after undo', async () => {
    const e = await openFixture('text.pdf')
    const agent = e.ops<typeof agentText>('agent-text')
    const propose = async () => {
      const snapshot = await agent.inspect(0)
      const b = snapshot.blocks.find((x) => !x.mark && !x.unreadable && x.text.includes('quick brown fox'))!
      const change: TextChange = {
        page: 0,
        block_id: b.id,
        original_text: b.text,
        text: b.text.replace('quick brown fox', 'swift brown fox')
      }
      return agent.apply(snapshot.revision, [change])
    }
    e.actor = 'Agent'
    expect((await propose()).changed).toBe(1)
    await e.doc.undo()
    expect(await pageText(e)).toContain('quick brown fox')
    expect((await propose()).changed).toBe(1)
    expect(await pageText(e)).toContain('swift brown fox')
    await e.doc.undo()
    await e.doc.redo()
    expect(await pageText(e)).toContain('swift brown fox')
    await survivesSave(e, 'swift brown fox', /Helvetica/)
  })
})
