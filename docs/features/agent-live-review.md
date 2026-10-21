# Live edit review (0.3)

Owner request (20 Oct 2026, after trying 0.2.2 with Claude Desktop on Windows): the AI's edits should
appear on the page one by one, with markup (old text struck out, new text written in, margins and
fonts visibly changing), each accepted or rejected on its own in the right panel and circled on the
page when hovered or selected. It should feel like a document being worked on. The proposal must
be sharp at every zoom, the companion avatar must be draggable anywhere, and the whole thing should
be snappier with a lower footprint.

## What changes for the person

- A proposal opens the Review edits panel as before, but its changes then arrive one after another
  in reading order (about 0.4 s each, at most about 6 s in all; at once with reduced motion; "Show
  all" skips ahead). The page scrolls to each new change unless the person is reading elsewhere.
- Each arriving edit: the old lines get a red strike-through, then the new text wipes in over them.
  It stays outlined (dashed amber while pending) with its number. Font, size or colour changes get a
  small chip ("Aa Calibri 10 → Inter 11 pt"); a page whose text area moved gets old and new margin
  guides while one of its changes is hovered or selected.
- The panel lists every change as a card: number, what it is, the old text struck and the new text,
  style notes, and Accept edit / Reject edit. Hovering a card circles the change on the page (a ring
  that does not scroll the page); clicking selects it and scrolls it into view; clicking a mark on
  the page selects its card. Up/Down move between cards, A accepts, R rejects.
- Accepted: green outline and a tick. Rejected: the original shows again at that spot, with a grey
  outline and a cross. A decision can be changed while others are pending. When nothing is pending,
  the accepted changes are applied as one undo step, as before.
- reflow_text: one card per paragraph. Reject keeps that paragraph's original wording (it is still
  flowed). rebuild_document: one card per section, plus the title (always kept) and a page design
  card (informational). Reject leaves that section out of the new design. Both update the preview.
- The proposal is drawn by the viewer's own renderer from a copy held in the worker: sharp at any
  zoom, with detail tiles at high zoom. "Show original" hides it. The page underneath keeps text
  selection and links; only the marks take clicks.
- The companion can be dragged by any part of it that is not text to read or type. A click still
  opens the chat. It moves aside while the review panel would be covered, without saving that move.

## Engine (`src/features/agent-access/engine.ts`)

One proposal per document worker, held for the whole review:

- `propose(revision, changes)`, `proposeFlow(revision, spec)`, `proposeReflow(revision, spec)`:
  build the copy as today, keep it, and return a `TextPreview` with `proposal: {id, version}`,
  `previews: []` (no PNGs) and rich `changes` (below). A new proposal disposes the held one.
- `renderProposal(id, version, page, opts: RenderOptions)`: `renderToPixmap` on the held copy, then
  the same transfer as `render.page` (export `toResult` from `src/engine/ops/render.ts`). A wrong id
  or version throws code `STALE_PROPOSAL`, which the render queue drops quietly.
- `checkProposal(id, indices)`: validates an edit_text subset without images (the same checks
  as `apply`); used once before the review finishes, and early when a reject touches a kept change.
- `reviseProposal(id, rejected)`: flow and rebuild only. Rebuilds the held copy with the rejected
  items reverted (flow: `text := original_text`, style overrides dropped) or left out (rebuild),
  bumps `version`, and returns the new report.
- `closeProposal(id)`: disposes the copy. Also disposed when the edit version moves on.
- `preview*` stay for `preview_only`: they return only the `after` PNG (`before` is empty).
- Cheaper: reuse the analysis `plans()` already did instead of analysing pages twice; transfer
  PNG buffers instead of cloning them.

Each change:

```ts
interface ReviewChange {
  index: number                 // stable: the call's edit, the flow paragraph, or the rebuild item
  kind: 'edit' | 'paragraph' | 'section' | 'title' | 'design'
  label: string                 // 'Change 3', a section heading, ...
  page: number                  // 1-based page of the first after-fragment
  before: string; after: string // as today (old/new text)
  bbox: Rect | null             // as today: the after box
  fallbackFonts: string[]
  beforeBox: Rect | null        // live page, original block
  beforeLines: Rect[]           // live page, one per original line (strike-through)
  fragments: { page: number; rect: Rect }[]  // proposal pages, every placement of the new text
  styleBefore?: Style; styleAfter?: Style     // {font, size, color, bold, italic} of the first run
  notes: string[]               // 'Font Calibri 10 → Inter 11 pt', 'Text area 54 → 40 pt', ...
  rejectable: boolean           // false for the title and the design card
}
```

`TextPreview` also gets `pages: {page, width, height, live}` (proposal page sizes; `live` when the
proposal page replaces a live page of the same size) and `margins: {page, before, after}` (content
boxes). Rebuild sections are located on the proposal pages by walking the structured text in order
and matching the title, subtitle and section headings.

## Renderer

- `renderQueue.request(key, page, opts, priority, render?)`: an optional render function (default
  `doc.core.render.page`) and `dropPrefix(prefix)`. Proposal keys start with `rv<id>.<version>:`.
- `PageCanvas` takes an optional `source: {key, render}` and otherwise works as today (base bitmap,
  detail tile, cache, cancellation). `PageLayerProps` gains `visibleRect` so a layer can ask for
  detail tiles.
- `InlineReviewLayer` per page: a proposal `PageCanvas` wrapped in a `clip-path` of the revealed,
  non-rejected regions (edit: union of before and after box, padded; flow and rebuild: their
  fragments, revealed in order), plus an SVG of the marks. Each layer selects only its own page's
  data. A proposal page whose size differs from the live page is drawn fitted into it.

## Protocol

reflow_text and rebuild_document: one call proposes, the person decides, and the call returns
`acceptedItems`/`rejectedItems` with labels. Rejecting everything is `declined`.

### Live review across calls (0.3.1)

Owner report after trying 0.3.0 (21 Oct 2026): nothing appeared while Claude worked. Claude planned
every move for minutes ("Shifting later blocks upward to close the new gap") and sent one large
edit_text call at the end, so the reveal only started then. Edits must reach the page as Claude
decides them.

- **edit_text answers at once.** As soon as its edits are proposed and on the page, the call answers
  `{status: 'still_running', ticket, message, review: {edits, pending}}` through the runner's
  ticket path (`ctx.detach`), instead of blocking until the person has decided. The message tells
  the AI to send each further edit with its own edit_text call as soon as it has decided it, and to
  call wait_for_result with every ticket when it has sent everything. No new arguments, so a Claude
  extension added from 0.3.0 works; its tool text only learns this once added again.
- **Later calls join the open review.** An edit_text from the same connection, for the same document
  and at the same revision, adds its edits to the open review (the document does not change until
  the review is applied, so the revision stays valid). The engine proposes the combined set again;
  if the combined set has a blocking issue (an overlap with an earlier edit), only the new call is
  refused and the review keeps the previous proposal. An edit of a block that has a pending edit
  replaces it in place (its card goes back to pending; the earlier call reports it in
  `replacedEdits`); an edit of a block already accepted or rejected is refused. Another connection,
  another document, preview_only and reflow/rebuild get `busy` as before.
- **Limits:** a call still takes at most 50 edits on 5 pages; a review at most 100 edits on 10 pages.
- **Finishing:** decisions stay provisional. The review is applied, accepted edits of every call as
  one undo step, when nothing is pending and either the AI is waiting in wait_for_result on one of
  the review's tickets, or the person clicks "Apply accepted changes". Then every ticket returns its
  own call's result: `acceptedEdits`, `rejectedEdits` (and `replacedEdits`), numbered from 1 in that
  call, the shared `undoLabel`, `applied` and `saved: false`. A call none of whose edits was accepted
  gets `declined`. Discard batch, a change by the person, or closing the tab ends every call as today.
- **Withdrawing:** cancelling a call (wait_for_result with cancel, or the AI app going away) takes
  back its edits that are still pending; decided ones stay for the person to apply.
- **The panel** says whether the AI is still sending edits or waiting for the person, and numbers
  cards across the whole review. New cards join the reveal as they arrive.

## Performance

- No PNGs during a review, no per-decision copies for edit_text (reject only clips the overlay), no
  base64 in render, proposal bitmaps in the viewer's bounded caches and dropped at the end.
- Companion: narrow store selectors, memoised avatar and message list, drag through a transform
  without re-rendering, one debounced save. Activity rows memoised, one shared time formatter. The
  indicator pulse animates transform and opacity instead of box-shadow.
- `DocumentModel.applyChanges` skips the state update when a reply changed nothing, so render
  replies no longer re-render journal subscribers.
