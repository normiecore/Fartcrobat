# Windows and tabs (several windows, tabs that move between them)

## Owner request, 9 Nov 2026

"Multiple Instances & Detachable Tabs: Allow multiple instances of the app to be open, and enable
dragging a PDF tab out into a separate window to view documents alongside stacked bundles."

What the person gets (ships in 0.4.0):

- **Drag a tab out of the tab strip** and let go outside the window: a new window opens where it
  was let go, with that document, and the tab leaves the window it came from. Let go on another
  Inkmoor window's tab strip: the tab moves into that window, at the place it was dropped. Dragging
  a tab along its own strip reorders the tabs. A window whose last tab was dragged out closes, as in
  a browser.
- **Right-click a tab:** Move to New Window, Move to "&lt;document&gt;" window (one entry per other
  window, named after the document it shows; "Inkmoor window (Home)" for one on Home), and Close.
  The same is reachable from the keyboard and the menu bar: **Window > Move to New Window** and
  **Window > Move to Another Window…** (which asks where), also in Find text or tools
  (Ctrl+Shift+K). A move from a menu leaves its window open, showing Home when it was the last tab.
- **What moves with the document:** its file (Save still writes the same path), its unsaved changes
  (it stays marked unsaved), the password or certificate it was opened with (nothing is asked
  again, also not a smart card PIN), and its page, zoom and page layout. **Undo history does not
  move**: when there was some, the new window says so in a note ("Its undo history stayed behind").
  Nothing unsaved is lost: the tab only closes in the first window once the other window has
  opened the document.
- **Moves are refused, with a message,** while the document is saving or otherwise busy, while a
  dialog or progress bar is open in its window (signing, a password prompt...), and while an AI
  app's edits to it wait for Accept or Reject. Typing in a text box or form field is committed
  first, as for any command. A document already open in the target window is not opened there a
  second time.
- **Files from other apps** (double-clicking a PDF while Inkmoor runs, Open With, the Dock):
  Preferences > General > **Open files from other apps in**: "The current window" (default, as
  before) or "A new window". Either way a file that is already open is shown in the window that has
  it instead of being opened again.
- **New Window** now has a shortcut: **Ctrl+Alt+N** (Cmd+Option+N on a Mac). Acrobat has none, and
  Ctrl+Shift+N is Go to Page; Ctrl+Alt+N was free. Windows reports AltGr as Ctrl+Alt, so a key
  pressed with AltGr is never a shortcut (Polish AltGr+N types "ń" and opens nothing), and in a
  text field a Ctrl+Alt key that types a non-Latin letter is typed too (`typesCharacter` in
  `src/renderer/src/app/commands.ts`).
- **AI apps** (agent access) keep reaching a document after it moved: the handle they had still
  works, and list_documents shows its new one.

### Why "multiple instances" is several windows of one app

Inkmoor stays one app process with any number of windows, each with its own tabs (File > New
Window, Ctrl+Alt+N). Separate app processes would each read and write the same settings file,
recent list, remembered passwords and Digital IDs and overwrite each other's changes; they would
compete for the one agent-access endpoint that AI apps connect to; and the single-instance lock is
what makes a double-clicked PDF open in the running app instead of starting a second copy (file
associations, the update installer and "Make default" rely on it). Separate windows give the same
side-by-side viewing without any of that. (`INKMOOR_MULTI_INSTANCE` still exists for tests only.)

## How it works

Contracts: `src/shared/tabMoves.ts` (the hand-off message, the drop and window choices, the checks,
all pure and unit-tested in `tests/engine/windows-tabs.test.ts`), channels `window:id`, `window:list`,
`window:moveDocument`, `window:takeMovedDocuments`, `window:moveSettled`, `window:requestTabMove`,
`window:tabDropDestination` and events `window:incomingDocument`, `window:moveOut` in
`src/shared/ipc.ts`, the preference `openFilesFromOtherApps`.

1. **The window that has the document** (`moveDocument` in `src/renderer/src/app/tabMoves.ts`)
   commits active editors, asks `moveRefusal` (busy label, open dialog/palette/progress, feature
   guards: `moveGuard` in a feature definition, used by agent-access for an open review), then,
   with the tab marked busy, asks the engine for `doc.handOff()`: the bytes a Save would write, or
   the exact bytes the file was opened from while the document has no edits and no undo steps (so
   signatures validate exactly as before), the open password, and the certificate key. Building
   the bytes leaves the document as it was (`handOffBytes` in `src/engine/ops/doc.ts`): a signed
   document's incremental save is not rebased the way a real Save is (that would clear the undo
   history and replace the file bytes), and a certificate save is not kept as the file to adopt.
   So a move that is refused or fails later leaves the tab with its undo history.
2. **The main process** (`src/main/tabMoves.ts`) picks the target: an existing app window, or a
   new one (`createWindow({ bounds })`, sized like the source and placed with its tab strip under
   the pointer). It keeps the hand-off in memory only, sends it to the target once the target's
   renderer has booted (`window:incomingDocument`, or `window:takeMovedDocuments` at boot), and
   waits for the target's `window:moveSettled`. A target that closes or crashes first fails the
   move; a window opened for a failed move is closed again.
3. **The target window** opens the bytes as a new tab with `openBytes(..., { moved })`: the
   password is tried first, a certificate-encrypted file opens with the transferred key as a
   "known" key (so no prompt), and the tab keeps the `DocUnlock` it had (how it was unlocked, the
   saved-password ref, the key's source for the Protect panel and audit log). The view and the
   insertion index come along; Preferences' "reopen where I left off" is not applied to a moved tab.
4. **Back in the first window**, on success the tab is removed without asking (its content is now
   in the other window). If the document changed while it was on its way (an AI app's edit), the
   first window keeps its tab too and says so, rather than drop the newer change.

**Dragging** (`src/renderer/src/shell/TopBar.tsx`): tabs are HTML5-draggable with the MIME type
`application/x-inkmoor-tab` (window id, window boot, document id). The strip accepts only that
type, so dropping files from the OS onto the window works as before (AppShell only takes `Files`).
A drop on a strip of the same window reorders; on another window's strip that window asks main
(`window:requestTabMove`), which tells the first window to move the document there (`window:moveOut`).
When a drag ends with no drop (`dropEffect === 'none'`), the first window asks main where the
pointer is (`window:tabDropDestination`, `screen.getCursorScreenPoint()` against the windows'
bounds, `dropDestination`): over itself nothing happens, over another window's top 80 px (its tab
strip) the tab moves there, anywhere else a new window opens at that point.

**Agent access:** handles are `w<webContents id>-<window boot>-doc-<n>`. After a move, main emits
`onDocumentMoved` (`src/main/tabMoves.ts`); agent-access records old handle -> new handle in the
router (`AgentRouter.documentMoved`, at most 500 entries), which rewrites the `handle` argument of
later calls, following chains of moves. The window boot moved to `src/renderer/src/app/boot.ts` so
the core and agent-access use the same value.

## Known limits

- The cross-window drop and the drag-out decision depend on the platform's drag and drop, and have
  not been tried by hand with real windows on Windows, macOS or a Linux desktop yet (the tests run
  under xvfb). Where a drag between windows does not arrive, the tab menu and the Window menu do
  the same. `dropDestination` cannot
  see which window is in front where windows overlap (Electron has no z-order); it prefers the
  focused one. The e2e tests drive the strip drop with synthetic drag events and the drag-out with
  `moveDocument` directly: Playwright cannot drag across windows or onto the desktop.
- Undo history, the open tool or tool panel, search results, the selection and "invalidate
  signatures?" consent stay behind. A moved certificate-encrypted document with signatures and
  unsaved changes is rewritten on the way (as a save would), so its signatures show as changed in
  the new window, as they would after saving.
- Moving a document while an AI app's call on it is still running is not refused (only an open
  review is); an edit that lands during the move is caught by the version check above.
- A tab cannot be dragged out of a window in Read Mode or Full Screen (no tab strip there); use the
  Window menu.
