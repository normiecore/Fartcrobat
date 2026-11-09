# Feature: organize-pages

Acrobat 'Organize pages' (tool group 'organize') and 'Combine files' (tool group 'combine').

## Owner request, 9 Nov 2026: zoom while organizing

"Page Organization Zoom: Adjust the zoom functionality when organizing pages, as the current view
makes it difficult to see whole pages when reading and matching documents." Thumbnails stopped at
360 px, too small to read a page. Ships in 0.4.0.

How it behaves:

- **Size range.** The slider at the bottom right (and Ctrl+mouse wheel, Ctrl+= and Ctrl+-, the
  zoom buttons) goes from 80 px up to one page filling the grid's width. The slider is on a log
  scale, so small sizes stay fine-grained; the buttons and Ctrl+=/- step by 20 %. The arrow keys
  on the slider step the size by 10 px or 5 %, whichever is more (`sliderKeyStep`), rather than
  one slider position: at small sizes several positions round to the same pixel size, so a native
  arrow step would snap back. Page Up/Down, Home and End move the slider as usual. The chosen size
  is remembered (`organize-pages:thumbSize`) and shown limited to what the window allows: a
  narrower window shows less, and the size comes back when the window is wider again.
- **Fit presets** next to the slider: **Fit width** (one page per row, as wide as the view),
  **2 per row** (two pages side by side, for matching documents) and **Fit page** (a whole page,
  with its number, in the view's height; also Ctrl+0 in the grid). Each is a toggle button with a
  tooltip and keyboard focus; the chosen one stays pressed and keeps fitting when the window is
  resized, until a size is chosen another way. It is remembered too (`organize-pages:fit`). In a
  narrow window they show icons only, with their names kept as tooltips and accessible names.
- **Page boxes follow the document's shape.** Each thumbnail sits in a box that fits every page of
  the document: narrow boxes for all-portrait documents, wide ones for all-landscape documents,
  square ones for mixed documents (as before). So Fit width really fills the width with a
  portrait page, and portrait documents get more columns at the same size. Rotating one page of a
  portrait document to landscape makes all boxes square.
- **Zoom keeps your place.** After the size or the window changes, the page under the pointer
  (Ctrl+wheel) stays under the pointer; otherwise the focused page stays where it was and, when it
  fits, is brought fully into view (a page taller than the view shows its top); otherwise the
  page in the middle of the view stays there. `zoom.ts` (`anchorAtPoint`, `anchorForPage`,
  `scrollForAnchor`) does the maths, the layout effect in `OrganizeView.tsx` applies it. The grid
  keeps a stable scrollbar gutter, so the width (and a fit preset) does not change when the
  scrollbar appears.
- **Sharp and fast at large sizes.** Thumbnails render at the displayed size times the screen's
  pixel ratio, rounded up to steps (40 px up to 400 px, then about 10 %) so small zoom changes
  reuse bitmaps, and capped at 3072 device pixels on the long side (`renderLongSide`); text is
  readable at Fit width. Pages in view render first (nearest the middle soonest), then the
  mounted rows outside it; rows that leave the mounted range cancel their queued renders. Large
  rows mount one extra row above and below instead of two. A 640-page document at Fit width
  keeps only a few cells in the page.
- **One page per row.** Insertion points and drop indicators go between rows: the '+' sits in the
  space above each page (and below the last) and the drop line runs across. With one column, the
  drop position follows the pointer's height only (`gapAt`). Rubber-band selection starts in the
  margins beside or between pages.
- **Quick look.** Double-click a page, or press Space on the focused page, to see it as large as
  the window (`QuickLook.tsx`). Left/Right (also Up/Down, Page Up/Down, Home, End) and the arrow
  buttons go through the pages; Escape (through `usePopupEscape`), Space, the close button or a
  click beside the page closes it; Enter or **Open in document** opens that page in the normal
  view. The grid's focus follows the page shown, so closing leaves you there; the selection is
  not changed. The preview is opened with `openDialog` and is modal: Tab and Shift+Tab cycle
  through its own buttons (`trapTab`, shared with `ui/Dialog.tsx`), so the focus never reaches the
  shell or the Organize toolbar, whose buttons would otherwise act on the grid (an Enter on Delete
  deleted the page shown). Shortcuts and menu commands do not act on the grid underneath either; leaving Organize Pages or closing the document closes it.
  The next page is rendered ahead.
- **Shortcut changes.** Double-click used to open the page in the normal view; that is now
  Enter, the context menu's Open Page, or Open in document in the preview. Space still selects
  the focused page (when it was not selected) and now also opens the preview; Ctrl+Space still
  toggles the page in the selection without opening anything.

Known limits: Fit page sizes pages by the tallest box, so in a mixed document a landscape page
is smaller than the view's height. The preview has no zoom of its own (it fits the window) and
no text selection. Thumbnails larger than 3072 device pixels (very large windows at 2x) are
slightly upscaled.

- Organize pages uses toolGroups[].documentView: a full-area grid of page thumbnails (render via renderQueueFor(doc) or doc.core.render at thumbnail scale; virtualise for 500+ pages) with page numbers/labels, a zoom slider for thumbnail size, and a top toolbar: Select (All / Even / Odd / Portrait / Landscape / page range…), Rotate left, Rotate right, Delete, Insert ▸ (Blank page…, From file…, From clipboard, Insert pages), Extract…, Split…, Replace…, Duplicate, Page labels… (core pages.setLabels), Undo/Redo, Close. Hovering a thumbnail shows quick buttons (rotate left/right, delete, insert after); a '+' insertion point between thumbnails.
- Selection: click, Shift+click range, Mod+click toggle, Mod+A, rubber-band drag on empty space; keyboard arrows move focus, Delete deletes selected (command organize.delete ['Delete','Backspace'], enabled only when the organize view is open with a selection), Mod+Shift+R rotate, etc. Commands: organize.open (Document menu 'Organize Pages'), organize.rotateLeft/Right ('Rotate Pages…' dialog: pages range + direction + even/odd/portrait/landscape filter, Mod+Shift+R, works outside the grid too), organize.delete ('Delete Pages…' dialog from Document menu, Mod+Shift+D), organize.insertFromFile (Mod+Shift+I), organize.extract, organize.split, organize.replace, organize.insertBlank.
- Drag & drop: reorder selected pages by dragging (drop indicator, auto-scroll), drop PDF/image files from the OS onto the grid at the indicated position (use pathForFile + readFile + core pages.insertFrom; call e.preventDefault() so the app doesn't open them as tabs). Dragging between two open documents is optional.
- Dialogs: Insert blank (size: same as current/Letter/A4/Legal/custom, orientation, count, before/after page N), Insert from file (pick file; for multi-page source choose pages; before/after page N; password prompt if needed), Extract (pages; 'Delete pages after extracting'; 'Extract pages as separate files' -> choose folder with file:openDialog {directory:true}; otherwise open as a new tab via openNewDocument), Split (by number of pages / by file size (approx) / by top-level bookmarks (doc.core.nav.outline), output folder, file name pattern '<name> Part 1.pdf'; progress), Replace (pages range in this doc, source file + pages).
- Combine files (Home tile and tool group 'combine', run without needing an open document: requiresDocument false and panel/documentView or a big dialog): add files (PDF and anything the engine opens: images, Office via registered fileConverters if present — check registry.fileConverters), add open documents, drag to reorder, remove, expand a file to choose page ranges, sort by name/date, then 'Combine' -> new untitled tab (openNewDocument) with one top-level bookmark per source file (engine op writing /Outlines in the new document) — progress bar. Engine namespace 'organize-pages' with a combine op that takes [{data, fileName, pages?, password?}] and returns bytes (graft pages like core pages.insertFrom; preserve each source's outline under its file bookmark if feasible).
- Unit tests for the engine ops (combine with bookmarks, split helpers, range parsing) and page-order logic.
e2e: open text.pdf, open Organize pages, select pages 2-3 with Shift+click, rotate right, drag page 5 to the front, delete page 2 via keyboard, insert blank page, extract page 1 to a new tab; undo several times; check page order via doc.core.text.plain; Combine files: stub file:openDialog to return [compare-a.pdf, compare-b.pdf, scan.png] and combine -> new tab with 3 pages and 3 bookmarks. Screenshots of the grid.

## Protected sources

Files made from a password-protected or restricted document keep its protection: Extract (new tab or separate files), Split, Combine, and Extract Pages in the page thumbnails. The new file gets the source's encryption dictionary and file ID (`src/engine/util/protection.ts`), so it has the same method (AES-256, AES-128, RC4), permission flags, open password and permissions password. Only the password the document was opened with is needed: this works when just the permissions password was typed, and restrictions stay behind the original permissions password even when nobody in the session knows it. Combine takes the protection of the first file whose pages it uses and names that file in its result message (`combineWithProtection`). A protected new tab opens with the source's password (`openExtractedPages`, `openNewDocument(bytes, name, { password })`) and keeps it for later saves and reloads, so the person is not asked again. Unprotected sources give unprotected files as before. Pages dragged into another open document or inserted from a file take that document's security. There are no new refusals: permissions such as "assemble" are not enforced on Extract or Split.
