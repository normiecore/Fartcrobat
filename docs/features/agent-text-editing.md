# Native document editing through MCP

The agent works in the PDF open in Fartcrobat. There is no embedded model or new network service.
The MCP client supplies the language/vision understanding; Fartcrobat supplies structured layout,
exact native font metrics, page previews, validated edits and an undoable document engine.

## Tools and workflow

1. Inspect get_context, get_document_layout and render_page. Layout inspection includes margins,
   editable blocks with exact font runs, heading/list/table candidates, rules, fills, images,
   artwork, links and comments. Classification and reading order are estimates; the model must
   check the page image, especially for multiple columns or date/description tables.
2. For small edits, get_editable_text returns a page revision and block ids. edit_text replaces,
   deletes, moves, formats or adds real page text. style_runs allows exact styled spans; their
   text must concatenate to the replacement. Otherwise styles outside the changed range are kept.
3. For a substantial rewrite that keeps the design, reflow_text accepts source paragraphs in
   reading order and connected page rectangles (columns). It reuses original fonts and line
   spacing, supports paragraph gaps and keep-with-next, and splits at native line boundaries.
   Content continues to the next region without shrinking. A continuation template can append
   copies of an existing page design with specified column rectangles (up to ten new pages).
   Only the named source text is removed; artwork, images and other text are retained.
4. rebuild_document is a separate, explicit new-design option for a clean CV/report. Plain-text
   sections, entries and bullets are escaped into a local HTML template and paginated by MuPDF.
   It replaces the pages and removes the old images, page annotations/forms and bookmarks.
   Attachments and document security stay. Digitally signed documents are refused.
5. preview_only returns proposed page images and reports without changing the live document.
   Otherwise Fartcrobat shows the proposal on the document with a Review edits panel (see "Live
   review" below). The person accepts or rejects each edit (edit_text), paragraph (reflow_text) or
   section (rebuild_document). Cancelling the MCP call discards it. The accepted changes make one
   Agent-labelled undo step. Since 0.3.1 edit_text answers at once with a ticket once its edits are
   on the page, later edit_text calls of the same conversation join the open review, and
   wait_for_result returns each call's decisions (see "0.3.1: live review across calls").
6. The agent inspects the resulting pages with render_page. save_document can save a new local
   PDF; editing never silently writes over the source file. Reinstall the bundled Claude Desktop
   extension after updating the app so it advertises the new tools.

## Integrity and bounds

- Revisions are engine edit counters, including undo/redo/reload. The engine rechecks revision,
  exact source text and layout after the person accepts, so concurrent edits cannot be overwritten.
- Previews run on a private in-memory copy including unsaved changes. They never edit/undo the
  live document or emit an unprotected PDF. Apply uses the existing journal and save pipeline,
  including password and certificate protection. During a review the copy stays in the worker
  (one per document, released when the review ends or the document changes) so the viewer can
  render it; it is never saved, and a proposal never undoes inside a copy (MuPDF's font cache is
  not journalled), it builds a fresh one.
- Direct text edits refuse new text collisions, page/text-area overflow and unsupported glyphs.
  Font substitutions and growth beyond an old box are reported. No invisible auto-shrinking.
- A flow refuses overlapping regions and regions covering unrelated text. It preserves untouched
  page graphics; intersections with artwork are reported for review. Scans with an OCR layer are
  refused because moving hidden text would leave the old visible scan intact.
- Flows use source font mappings captured before removing text, so embedded subset fonts can be
  reused when they have the required glyphs. Missing glyphs may require a reported substitute.
- Existing link/comment anchors do not follow rewritten text automatically. Flow previews warn
  about them. Static page numbers/labels repeat on continuation templates and must be reviewed.
- Tables and independently aligned date columns are exposed as structure, but automatic semantic
  reconstruction is the model's job. Use separate bounded flows or direct edits rather than
  pouring a whole complex page into one text stream. Rotated/right-to-left flows are refused.
- Limits: direct edit 50 changes / 5 pages / 60000 characters; flow 100 paragraphs / 40 regions /
  90000 characters and 30 document pages; new design 20 pages. These are bounds, not content
  truncation. Unsupported input fails explicitly.

## Files and tests

- src/features/agent-access/engine.ts: inspect, isolated previews, guarded native mutations.
- textEdits.ts: validated text plans; flow.ts: linked regions and repeated design pages.
- reflow.ts and reflowEngine.ts: data-only new-design input, native pagination and page replacement.
- tools/text.tsx: MCP handlers; tools/editReview.ts: edit_text reviews across calls (joining,
  replacing, withdrawing, applying once, per-call results); ui/InlineReview.tsx (page layer and
  panel), ui/reviewState.ts (decisions, reveal timer, checks, revisions and the live review's
  control) and ui/review.css: the on-document review.
- src/features/edit-text/engine.ts: createTextComposer shares the interactive editor's native
  shaping/writing with flows. No parallel text renderer.
- tests/engine/agent-text.test.ts, agent-reflow.test.ts and agent-tools-handlers.test.ts cover
  previews, undo/redo, round trips, styles, artwork, embedded fonts, column/page continuation,
  layout failures, cancellation and stale proposals. agent-proposal.test.ts covers the held
  proposal (render, check, revise, close, stale versions, markup fields, rebuild sections),
  agent-inline-review.test.ts the decisions and the reveal, core-render-queue.test.ts the render
  queue's other sources. agent-live-review.test.ts runs edit_text across calls through the runner
  and wait_for_result; agent-runner-wait.test.ts covers ctx.detach and the ticket wait listener.
- tests/e2e/agent-text.spec.ts drives the actual built MCP shim and app.

This does not promise lossless semantic reconstruction of every PDF. The model gets the evidence
needed to preserve a design, the engine handles explicit layout operations, and the person reviews
actual rendered pages before accepting changes. Complex scans, missing fonts, dynamic forms and
ambiguous tables require an explicit decision rather than a silent redesign.

## 0.2.1: on-document review

Native edits appear as proposed pages in the existing document viewer, with highlighted edit
regions and a Review edits panel in the standard right rail. There is no blocking before/after
modal. Show original toggles the source page for comparison. Per-edit accept/reject, Accept all,
Reject remaining and Discard batch keep the user in control. (In 0.2.1 rejecting an edit
recomputed the preview; since 0.3 it only hides it, see below.) Decisions remain provisional until the batch is complete; only the accepted
subset is then applied as a single native, undoable edit. Saving during review cannot save
unaccepted proposal images or annotations, and does not end the review; any edit of the source
document does. One review is open at a time: a second proposal is refused (`busy`) before it
switches the person's tab (since 0.3.1 an edit_text of the same conversation joins it instead). The review brings Fartcrobat forward, or flashes it on Windows.

The agent is instructed to submit small meaningful batches so proposals arrive progressively;
MCP does not stream unfinished tool arguments or model tokens. In 0.2.1 linked text flow and full
rebuilds were one approval group; since 0.3 they are decided per paragraph or section, and the
preview is laid out again. New continuation pages are previewed in the review panel before they
exist in the document.

## 0.3: live review

The design note is docs/features/agent-live-review.md. What was built:

- Engine (`engine.ts`): `propose`, `proposeFlow` and `proposeReflow` build the proposal as before
  and keep the copy (`{id, version}` in the report, no PNGs). `renderProposal(id, version, page,
  opts)` renders it exactly like `render.page` (it shares `renderToPixmap` and `toResult`), so the
  viewer's base bitmap, detail tiles, caches and cancellation apply; a closed or replaced proposal
  throws `STALE_PROPOSAL`, which the render queue drops without a warning. `checkProposal(id,
  indices)` checks the kept edit_text edits on a temporary copy (issues keep the proposal's
  numbering; the full set reuses the first report). `reviseProposal(id, rejected)` rebuilds a flow
  with the rejected paragraphs in their original words and styles (`reviseFlowSpec`) or a design
  without the rejected sections (`reviseReflowSpec`), with a new version; when that fails the last
  good proposal is rebuilt and the error is shown. `closeProposal(id)` releases it. Analyses from
  planning are reused, preview PNGs are transferred and only `after` PNGs are made.
- Each change carries `index`, `kind`, `label`, `beforeBox`, `beforeLines` (one rect per original
  line), `beforePage`, `fragments` (every placement of the new text), `styleBefore`/`styleAfter`,
  `notes` ("Aa Helvetica 12 → Times New Roman 12 pt", colour, style, alignment, line spacing,
  "Text area top 66 → 20 pt") and `rejectable`. Reports also list proposal `pages` (with `live`
  when a page replaces a live page of the same size) and text-area `margins`. Rebuild sections are
  found on the new pages by walking the text lines in order and matching the title and headings;
  the title and a page design card are listed but cannot be rejected.
- Review (`ui/reviewState.ts`): one timer reveals changes in reading order, about 0.4 s each and at
  most about 6 s in all, at once with reduced motion or Show all. The page follows each new change
  unless the person scrolled, clicked or hovered a change in the last 3 s. edit_text: Accept never
  asks the worker; Reject only removes the change from the overlay, unless its area touches a kept
  change on the same page, which is checked at once; the kept set is checked once before the
  review ends (a blocking issue keeps it open and the last decision is not recorded). reflow_text
  and rebuild_document: rejections within 300 ms make one new preview ("Updating preview..."), and
  the review ends only once the preview shows what was decided. Rejecting every item declines.
- Page layer (`ui/InlineReview.tsx`): per page, a `PageCanvas` with a proposal `source` (key
  `rv<id>.<version>`) clipped with `clip-path: path()` to the revealed regions (edit: old and new
  box; flow and rebuild: their fragments; a whole new-design page once everything is shown, fitted
  into the live page when its size differs). New regions grow from zero width after the old lines
  are struck through. Marks are dashed amber with a number while pending, green with a tick when
  accepted, grey with a cross when rejected, ringed on hover or selection, with a style chip; the
  hovered or selected change's page gets old and new text-area guides. The layer itself takes no
  pointer events, so text selection and links keep working. Each layer selects only its page's
  state, so a decision does not re-render every page. New continuation or design pages without a
  place in the viewer are drawn in the panel at its width, by the same renderer.
- Panel: one card per change with Accept edit / Reject edit, counts, Accept all, Reject remaining,
  Discard batch, Show original / Show proposed and Show all; Up and Down move between cards, A and
  R decide, while the list has focus. The panel root keeps the class
  `fc-agent-access-inline-panel` (the companion moves aside from it).
- Results: edit_text is unchanged; reflow_text and rebuild_document add `acceptedItems` and
  `rejectedItems` (`{item, label}`, item = paragraph or section number from 1).

## 0.3.1: live review across calls

The design is "Live review across calls (0.3.1)" in docs/features/agent-live-review.md; what was
built and where it chose where the note is silent is in its "As built" list. In short: edit_text
(not preview_only) answers `{status: 'still_running', ticket, message, review: {edits, pending}}`
as soon as its edits are on the page (`ctx.detach` in runner.ts), later calls of the same
connection, document and revision join the review (combined proposal, cards numbered across the
review), and the review is applied once, as one undo step, when nothing is pending and either the
AI app waits in wait_for_result or the person clicks Apply accepted changes. Each ticket returns
that call's `acceptedEdits`, `rejectedEdits` and `replacedEdits`.
