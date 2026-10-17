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
   Otherwise Fartcrobat shows the before/after text and pages. Decline is the default; Escape or
   cancelling the MCP call declines. Apply changes makes one Agent-labelled undo step.
6. The agent inspects the resulting pages with render_page. save_document can save a new local
   PDF; editing never silently writes over the source file. Reinstall the bundled Claude Desktop
   extension after updating the app so it advertises the new tools.

## Integrity and bounds

- Revisions are engine edit counters, including undo/redo/reload. The engine rechecks revision,
  exact source text and layout after the person accepts, so concurrent edits cannot be overwritten.
- Previews run on a private in-memory copy including unsaved changes. They never edit/undo the
  live document or emit an unprotected PDF. Apply uses the existing journal and save pipeline,
  including password and certificate protection.
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
- tools/text.tsx: MCP handlers and the before/after review in the existing confirmation UI.
- src/features/edit-text/engine.ts: createTextComposer shares the interactive editor's native
  shaping/writing with flows. No parallel text renderer.
- tests/engine/agent-text.test.ts, agent-reflow.test.ts and agent-tools-handlers.test.ts cover
  previews, undo/redo, round trips, styles, artwork, embedded fonts, column/page continuation,
  layout failures, cancellation and stale proposals.
- tests/e2e/agent-text.spec.ts drives the actual built MCP shim and app.

This does not promise lossless semantic reconstruction of every PDF. The model gets the evidence
needed to preserve a design, the engine handles explicit layout operations, and the person reviews
actual rendered pages before accepting changes. Complex scans, missing fonts, dynamic forms and
ambiguous tables require an explicit decision rather than a silent redesign.
