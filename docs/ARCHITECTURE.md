# Fartcrobat architecture and feature guide

Fartcrobat is an Electron desktop app. Every PDF operation runs in **MuPDF** (WASM), inside one Web
Worker per open document. The UI is React 19 + TypeScript and copies the layout of current Adobe
Acrobat so people can switch without relearning anything.

```
src/
  shared/         types and helpers used everywhere (geometry, IPC contract, preferences)
  main/           Electron main process: windows, files, menus, printing, default-app setup
  preload/        the contextBridge (window.api) — typed invoke/on, nothing else
  engine/         MuPDF engine: Session, dispatcher, worker, core ops (doc, render, text, nav,
                  annots, forms, pages)
  renderer/src/   UI shell, viewer, UI kit, app state, feature SDK (sdk.ts)
  features/<id>/  one folder per feature (see below)
tests/
  engine/         vitest unit tests (engine runs in Node, no Electron)
  e2e/            Playwright tests driving the built Electron app
  fixtures/       sample PDFs (regenerate with scripts/make_fixtures.py)
```

## Coordinate system

All geometry uses **MuPDF page space**: points (1/72 inch), origin at the top-left of the visible page
box, y grows downwards, page `/Rotate` already applied. `PageInfo.width/height`, annotation rects,
text quads, form widget rects and render clips all use it. Only code that writes raw content streams
needs PDF user space: use `s.pageToUser(page)` / `s.userToPage(page)` in the engine.

In the UI, `PageGeometry` (given to every page layer) converts between page space and CSS pixels:
`geometry.toPage([x, y])`, `geometry.toCss(point)`, `geometry.rectToCss(rect)`,
`geometry.eventToPage(event, element)`. Never assume 1pt = 1px; zoom and view rotation change it.

## A feature folder

```
src/features/<id>/
  index.tsx     default export: defineFeature({...})        (renderer, required)
  engine.ts     default export: defineOps('<namespace>', {...}) (engine worker, optional)
  main.ts       export function register(ctx: MainContext)   (main process, optional)
  *.tsx, *.ts, *.css                                          (anything else the feature needs)
```

All three entry points are discovered automatically with `import.meta.glob`; nothing central needs
editing. Use the feature id as the CSS class prefix (`.fc-<id>-...`) and import your CSS from
`index.tsx`.

### Renderer: `index.tsx`

```tsx
import { Highlighter } from 'lucide-react'
import { defineFeature, useActiveDoc, ToolPanelFrame } from '@renderer/sdk'

export default defineFeature({
  id: 'comments',
  commands: [{ id: 'comment.highlight', label: 'Highlight Text', shortcut: 'U', run: ({ doc }) => ... }],
  menus: [{ menu: 'comment', group: 'markup', command: 'comment.highlight' }],
  tools: [{ id: 'highlight', label: 'Highlight', icon: Highlighter, layer: HighlightLayer, toolbar: Options }],
  toolGroups: [{ id: 'comment', label: 'Add comments', icon: MessageSquare, order: 30, panel: CommentPanel, defaultTool: 'select', homeTile: true, category: 'review' }],
  rightPanels: [{ id: 'comments', label: 'Comments', icon: MessageSquare, order: 10, component: CommentList }],
  pageLayers: [{ id: 'annotations', order: 40, component: AnnotationLayer }],
  textSelectionActions: [{ id: 'highlight', label: 'Highlight', icon: Highlighter, order: 10, run: (doc, sel) => ... }],
  pageContextMenu: [{ id: 'comments', order: 10, items: ({ doc, pageIndex, point }) => [...] }],
  settings: [{ id: 'comments', label: 'Commenting', order: 20, component: CommentingSettings }],
  quickTools: [{ id: 'highlight', order: 20 }],
  fileConverters: [...],          // convert files on open (e.g. Office via LibreOffice)
  globals: [SomeAlwaysMountedComponent],
  onDocumentOpen: (doc) => {}
})
```

Registry concepts (all in `src/renderer/src/app/registry.ts`):

| Concept | Where it shows up |
| --- | --- |
| `commands` | Native menu bar, the hamburger Menu, keyboard shortcuts, "Find text or tools" (Ctrl+Shift+K) |
| `menus` | Places a command in File/Edit/View/Document/Comment/Forms/Tools/Sign/Window/Help, grouped and ordered, optionally inside a `submenu` |
| `toolGroups` | Entries in the left **All tools** pane (and Home tiles with `homeTile`). Opening one shows its `panel` in the left pane (use `ToolPanelFrame` so the back arrow works) and activates `defaultTool`; groups without a panel run `run()` |
| `tools` | Pointer tools. While active, `layer` is mounted on every visible page above everything else and receives pointer events; `toolbar` appears in the contextual bar under the document toolbar. Set `allowDefaultInteractions` to keep text selection/links/annotation selection working underneath |
| `pageLayers` | Always-mounted per-page layers (annotations, form fields...). `order` sets stacking: text selection 10, search 20, links 30. Use `pointer-events: none` on the layer and `auto` only on interactive children so you don't block other layers. `when({toolId, doc})` limits when they mount |
| `toolGroups[].documentView` | Replaces the page viewer while the group is open (Organize Pages grid, Compare report) |
| `rightPanels` | Icons in the right rail; the panel opens to the left of it |
| `quickTools` | The floating vertical toolbar at the left of the document (tool ids or command ids with icons) |
| `textSelectionActions` | Buttons on the mini toolbar above selected text and in its context menu |

Command shortcuts use `Mod` for Ctrl (Cmd on macOS): `'Mod+Shift+S'`. Single keys (`'U'`) only
fire when single-key shortcuts are enabled in Preferences and focus is not in a text field. Match
Acrobat's shortcuts and menu labels wherever Acrobat has them.

### Working with a document from the UI

`useActiveDoc()` (or the `doc` prop) gives a `DocumentModel`:

- `doc.state` / `useDocState(doc, s => s.zoom)`: info, title, filePath, dirty, journal, zoom,
  layout, currentPage, selection, search...
- `doc.ops<typeof import('./engine').default>('mynamespace').someOp(...)` — typed engine calls.
  Core ops: `doc.core.doc / render / text / nav`, and the shared modules
  `doc.ops<typeof import('@engine/ops/annots').default>('annots')`, `'forms'`, `'pages'`.
- Every engine response carries a `ChangeSet`; the model applies it automatically: pages re-render,
  `info` is refreshed after structural changes, the journal (Undo label) and dirty flag update.
  Use `usePageVersion(doc, page)` to refetch per-page data when that page changes and
  `useDocState(doc, s => s.docVersion)` for document-level data (outline, attachments, form,
  signatures).
- `doc.view` controls the viewer: `goToPage`, `scrollToRect`, `setZoom`, `hitTest`, `visiblePages`.
- `doc.pageText(i)` returns a `PageText` (characters, quads, lines, spans with fonts); helpers in
  `textModel.ts` (`rangeQuads`, `rangeRects`, `searchPage`, `caretAt`, `wordAt`).
- `doc.setSelection({ kind: 'annotations', page, ids })` / `{ kind: 'custom', type, page, data }`.
- `setHiddenAnnotations(doc, page, ids)` leaves annotations out of page rendering while you draw
  a live preview (dragging). `doc.set({ showAnnotations: false })` hides all comments
  (View > Show/Hide > Comments).

App-level helpers from `@renderer/sdk`: `openDialog(close => <Dialog .../>)`, `ask`, `confirm`,
`prompt`, `toast`, `showError`, `withProgress(title, report => ...)`, `showContextMenu`,
`openNewDocument(bytes, name)` (new unsaved tab), `saveDocument`, `replaceDocumentBytes`,
`saveBytesAs(bytes, name, filters)`, `invoke('file:openDialog', ...)`, `readFile`, `setTool`,
`openToolGroup`, `openRightPanel`, `runCommand`, `authorName()`, `usePrefs()`, `setPrefs()`.
UI kit: `Button`, `IconButton`, `Dialog`, `Field`, `TextInput`, `NumberInput`, `TextArea`, `Select`,
`Checkbox`, `Radio`, `Slider`, `Segmented`, `ColorPicker`, `ColorButton`, `PanelFrame`,
`ToolPanelFrame`, `ToolRow`, `Section`, `EmptyState`, `MenuList`, `DropdownMenu`.
Icons come from `lucide-react`.

### Engine: `engine.ts`

```ts
import { defineOps, mutation, withTransfer, EngineError } from '@engine/define'

export default defineOps('stamps', {
  // a query: plain function, may be async
  list: (s, page: number) => ...,
  // an undoable change: synchronous, wrapped in a MuPDF journal step labelled "Add Stamp"
  add: mutation('Add Stamp', (s, page: number, rect: Rect) => {
    const p = s.page(page)
    ...
    s.touch(page)          // page content changed -> re-render it
    // s.structureChanged() when pages are added/removed/reordered/resized/rotated
    // s.documentChanged()  when outline, attachments, form, metadata, signatures changed
  })
})
```

- `s.pdf` is the MuPDF `PDFDocument`; `s.page(i)` a cached `PDFPage`; `s.mupdf` the module;
  `s.sourceBytes` the exact bytes the file was opened from (null for converted files).
- Never keep `PDFPage`/`PDFAnnotation` objects across calls; ask the session again.
- Mutations must be synchronous (MuPDF's journal cannot span awaits). Do async work (fetching,
  parsing) in a query op or in the UI, then call a mutation with the result.
- Return big buffers with `withTransfer(bytes, [bytes.buffer])`.
- Report progress of long ops with `s.progress(fraction, message)`; the UI receives it via
  `doc.ops(ns, { onProgress })`.
- Undo/redo, dirty tracking and save are handled by the core. Saving uses MuPDF garbage
  collection without compaction because compaction breaks the live undo history; use
  `saveDocument(s, { garbage: 'deduplicate', ... })` (it writes a separate copy) when you need it.
- Helpers in `src/engine/util/pdf.ts`: `readRect`, `readString`, `walkFields`, `pdfLiteral`, `num`,
  `pdfDate`, `pageBoxes`, `catalog`...
- Low-level PDF objects: `s.pdf.newDictionary()`, `addStream(buffer, dict)`, `obj.get('Key')`,
  `obj.put('Key', value)`. To add page content, append a new stream to the page's `/Contents`
  (wrap existing content with `q ... Q` so the graphics state is clean) and add resources under
  `/Resources`.
- The worker has no DOM (`DOMParser`, `document`, `canvas` are unavailable; `OffscreenCanvas`
  and `createImageBitmap` are). Parse XML or draw text with canvas in the UI and pass data in.

### Main process: `main.ts`

```ts
import type { MainContext } from '@main/context'

declare module '@shared/ipc' {
  interface IpcApi {
    'feature:convert:office': (path: string) => Uint8Array | null
  }
}

export function register(ctx: MainContext) {
  ctx.handle('feature:convert:office', async (_e, path) => ...)
}
```

Channels must be named `feature:<feature-id>:<method>` (letters/digits only in the method); the
preload rejects anything else. Call them from the UI with `invoke('feature:convert:office', path)`.

## Testing

- Engine: `tests/engine/<feature>.test.ts` with vitest. `openFixture('text.pdf')` gives an
  in-process engine (`e.ops<typeof ops>('ns')`, `e.doc`, `e.info`, `e.lastChanges`, `roundTrip(e)`).
  Fixtures: `text.pdf` (5 pages, outline, links), `form.pdf` (AcroForm), `encrypted.pdf`
  (password `secret`), `scanned.pdf` + `scan.png` (image only), `mixed-sizes.pdf`,
  `compare-a.pdf`/`compare-b.pdf`.
- End to end: `tests/e2e/<feature>.spec.ts` with helpers from `tests/e2e/helpers.ts` (`launch`,
  `openFile`, `waitForRender`, `runCommand`, `activeDocState`). Build first, then run under a
  virtual display:

```
npm run build && xvfb-run -a npx playwright test tests/e2e/<feature>.spec.ts
```

  `window.__fartcrobat` exposes `registry`, `useApp`, `getActiveDoc`, `openPaths`, `runCommand`
  for tests. Take screenshots (`page.screenshot({ path: 'test-results/<name>.png' })`) and look at
  them: rendering bugs are easy to miss otherwise.
- Before committing: `npm run typecheck && npm run lint && npm test`.

## UX rules

- Use Acrobat's names for tools, menus and dialogs ("Organize Pages", "Fill & Sign", "Redact",
  "Protect", "Prepare a form", "Comment", "Request e-signatures"...), and its keyboard shortcuts.
- Where Acrobat is clumsy, make it simpler: fewer dialogs, sensible defaults, live previews, undo for
  everything, plain-language messages. Destructive steps (apply redactions, remove security) get a
  clear confirmation.
- Everything works offline. No telemetry, no accounts.
- Every change to a document must be undoable (use `mutation`) and mark the document dirty.
