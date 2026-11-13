# Feature: navigation

Navigation panels, document properties, advanced search, Read Out Loud.

- Right panel 'thumbnails' (Page Thumbnails): virtualised list of page thumbnails (use renderQueueFor(doc) / doc.core.render with small scales; cache), page label under each, current page highlighted and auto-scrolled into view, click to go to page, thumbnail size slider (small/medium/large), keyboard up/down. Context menu on a thumbnail: Rotate clockwise / counterclockwise, Delete page, Insert blank page after, Extract page… (save via saveBytesAs) — use the core 'pages' ops directly. Drag a thumbnail to reorder pages (core pages.move), with a drop indicator.
- Right panel 'bookmarks': outline tree (expand/collapse with chevrons, remember expanded state), click navigates to the destination (x/y), current section highlighted. Edit: New bookmark (Mod+B, command nav.addBookmark) at the current page/view, named from selected text if any else 'Untitled'; rename (double-click or F2, inline edit); delete; drag & drop to reorder and to nest/un-nest; 'Expand all / Collapse all'. Engine ops in namespace 'navigation' editing the outline (MuPDF OutlineIterator insert/update/delete/down/up, or by rewriting the /Outlines tree with low-level objects — whichever is reliable; write tests). All edits undoable and mark the doc dirty; panel refreshes on docVersion.
- Right panel 'attachments': list embedded files (name, size, modified, description), Open (write to temp via invoke('file:tempPath') + 'file:write', then invoke('shell:openPath')), Save as…, Add file… (file dialog, embed via engine), Delete. Also list FileAttachment annotations' files (core annots.attachment) with page numbers.
- Right panel 'layers': optional content groups with eye toggles (doc.countLayers/isLayerVisible/setLayerVisible via engine, touchAll so pages re-render), 'Reset to initial visibility'. Empty state when none.
- Right panel 'search' + command search.advanced (Mod+Shift+F): Acrobat's Advanced Search pane: query box, whole words / case-sensitive options, results grouped by page with highlighted context (hitContext), count, progress while searching, click result -> doc.revealHit(index). Uses doc.search / doc.state.search.
- Document Properties dialog (command file.properties, Mod+D, File menu group 'properties'): tabs Description (editable Title, Author, Subject, Keywords — saved via doc.core.doc.setMetadata, undoable; read-only Created, Modified, Application/Creator, Producer, PDF version, File location, File size, Page size of current page in the user's units, Number of pages, Tagged?, Fast web view: No), Security (method, permissions list as Allowed/Not allowed), Fonts (fonts used per page: name, type, embedded/subset — engine op scanning page /Resources /Font dictionaries; scan lazily with progress for big docs), Initial View (Navigation tab / page layout / magnification / open to page, stored in catalog /PageMode /PageLayout /OpenAction — read and write; honour them when a document opens: onDocumentOpen sets zoom/layout/page and opens bookmarks panel if /PageMode /UseOutlines), Custom (custom Info dictionary keys add/edit/remove).
- Read Out Loud (View menu submenu 'Read Out Loud'): Activate/Deactivate, Read This Page Only (Mod+Shift+V), Read To End Of Document (Mod+Shift+B), Pause/Resume (Mod+Shift+C), Stop (Mod+Shift+E) using window.speechSynthesis with doc.core.text.plain(page); highlight nothing, but advance pages when reading to end; voice/rate settings section 'Reading' in Preferences. Gracefully tell the user if no voices are available.
- View menu 'Show/Hide' submenu entries for the panels (open the right panel), and Navigation Panes.
e2e: open text.pdf, open thumbnails panel, click page 3 thumbnail -> current page 3; bookmarks panel shows 5 chapters, click 'Chapter 4' navigates; add a bookmark via Mod+B and rename it; properties dialog shows title and edits author (undo works); advanced search finds 'quick brown fox' 5 times.

## Bookmark zoom and outsized pages (Nov 2026, after feedback on 0.4.1)

Combined court briefs make every bookmark a `/Fit` destination and often hold phone photos merged
in at their pixel size (8160 x 6120 pt). In 0.4.1 a bookmark click switched the document to Fit Page,
and Fit Page / Fit Width in the scrolling layouts fitted the largest page, so an A4 brief dropped to
the 8% floor on open and on every bookmark click.

- **Bookmarks keep the reader's zoom (owner decision):** `goToDest` (`actions.ts`) applies only an
  explicit XYZ zoom (a bookmark saved at 150% still opens at 150%). Fit, FitB, FitH, FitBH, FitV and
  FitR destinations go to the page at the current zoom and zoom mode, like in-page links (LinkLayer).
- **Fit zooms ignore outsized pages:** in Single Page Continuous and Two Page Scrolling, `fitZoom`
  (`viewer/layout.ts`, `documentFit`) leaves out rows that need less than `OUTSIZED_ROW_RATIO` (0.6)
  of the median row's zoom. Landscape A4 among A4 pages still counts. Only rows outsized in width
  may end up wider than the viewport (every other row caps the zoom at its own width). When there
  are any, Fit Page leaves room for the horizontal scrollbar (`H_SCROLLBAR`), and the viewer passes
  the viewport height without that scrollbar (`heightWithoutHScrollbar`), so the scrollbar
  appearing cannot change the fit zoom and make it flip back and forth. Rows outsized only in
  height are left out of Fit Page's height fit and scroll down. The zoom still does not depend on
  the scroll position.
- **The reading row stays in view horizontally:** the content is as wide as the widest page, with
  rows centred in it. Going to a page reveals its row (`revealRowLeft` in `viewer/Viewer.tsx`: a row
  fully in view, or wider than the viewport and partly in view, keeps the position; one that fits is
  centred). After open, a resize or a zoom (not a zoom at the cursor), and while scrolling, the
  current page's row is brought into view when no row that is in view vertically has any part in
  view horizontally (`rowToReveal`), so a document does not open on empty space beside an outsized
  page, and panning across a wide page that is in view is never undone. An x position from a
  destination is compared in content coordinates.
- Fixture `tests/fixtures/navigation/outsized-page.pdf` (A4 pages, one 8160 x 6120 pt page, /Fit
  bookmarks and one /XYZ bookmark with a left position); e2e in `tests/e2e/navigation.spec.ts`
  (also Next Page in a zoomed two-page layout), unit tests in `core-viewer-layout.test.ts`.
