# Fartcrobat: notes for Claude sessions

Open-source (AGPL) desktop PDF reader, editor and signer for Windows, macOS and Linux. The layout
follows current Adobe Acrobat Pro. Fully offline, no AI features. LibreOffice is used for Office
conversion when installed, with a built-in fallback.

## State

- v0.1.0 is released: https://github.com/normiecore/Fartcrobat/releases/tag/v0.1.0 (Windows
  x64/arm64 `.exe`, macOS `.dmg`/`.zip` for Intel and Apple silicon, Linux `.AppImage`, `.deb`,
  `.tar.gz`).
- PRs #1 (the app), #2 (fixes) and #3 (release publishing) are merged into `main`. CI is green.
- About 717 unit tests (vitest) and 122 end-to-end tests (Playwright on Electron).

## Where things are

- `docs/ARCHITECTURE.md`: how the app is built (engine worker, feature folders, coordinates,
  testing, UX rules). Read it before changing structure.
- `docs/features/<id>.md`: design notes per feature; `docs/features/CONTRACTS.md` for shared APIs.
- `src/features/<id>/`: one folder per feature with `index.tsx` (renderer), `engine.ts` (runs in
  the MuPDF worker) and `main.ts` (Electron main). 18 features: comments, compare,
  digital-signatures, edit-images-links, edit-text, export-create, fill-sign, forms-fill,
  markup-tools, navigation, ocr, organize-pages, page-marks, prepare-form, print,
  protect-optimize, redact, stamps-measure.
- `src/engine/`: MuPDF (WASM) operations, one Web Worker per open document.
- `src/renderer/src/`: app shell, viewer, command registry, UI kit.
- `tests/engine/*.test.ts` (vitest), `tests/e2e/*.spec.ts` (Playwright), `tests/fixtures/`.

Stack: Electron 44, electron-vite 5, React 19, zustand, TypeScript 6, mupdf 1.28 (WASM),
tesseract.js 7, electron-builder 26. `.npmrc` sets `legacy-peer-deps=true`.

## Commands

```
npm ci
npm run dev                                   # app with hot reload
npm run typecheck && npm run lint && npm test # run before every commit
npm run build && xvfb-run -a npx playwright test [tests/e2e/<feature>.spec.ts]
npm run dist:linux                            # installers into release/
npm run fixtures                              # regenerate base fixtures (needs reportlab, Pillow)
```

Per-feature fixtures have their own generators in `tests/fixtures/<feature>/make_*.py`. Fixture
outputs are committed; tests never generate them at run time.

## Verifying like CI

- `scripts/ci-sim.sh <command>` runs a command as a bare GitHub runner would see this machine:
  2 CPUs, no pypdf, no pdfsig, no LibreOffice (hidden in a private mount namespace). Use
  `--keep-tools` to only limit CPUs, which matches the CI job after it installs the tools. Run
  both before pushing anything that touches tests: most past CI failures were races that only
  showed up on 2 CPUs, or tool checks that behaved differently when a tool was missing.
- `FARTCROBAT_EXECUTABLE=release/linux-unpacked/fartcrobat` runs e2e specs against a packaged
  build (the release workflow smoke-tests this way).
- Every push to any branch runs CI and failures email the owner. Verify locally first, and put
  `[skip ci]` in intermediate commits that don't need a run.

## CI and releases

- `.github/workflows/ci.yml`: ubuntu-24.04, Node 22, installs pypdf (`tests/requirements.txt`),
  poppler-utils and LibreOffice, then typecheck, lint, unit tests, build, e2e under xvfb.
- `.github/workflows/release.yml`: builds installers on Windows, macOS and Linux.
- To release: bump `version` in `package.json` on `main` (via a PR), then Actions > Release > Run
  workflow on `main` with that version. The publish job checks the version matches, creates the
  tag on the built commit and attaches the installers. Pushing a `v*` tag also works, but the
  Claude session git proxy refuses tag pushes, so use the manual run.
- Windows installers are unsigned and macOS builds are only ad-hoc signed. Signing uses the
  `CSC_LINK` and `CSC_KEY_PASSWORD` repository secrets when they exist.

## Conventions and gotchas

- e2e tests wait on observable state (`expect`, `expect.poll`), never fixed sleeps. To force a
  race in a test, monkeypatch `window.__fartcrobat.getActiveDoc().engine.call` to delay or gate a
  specific call.
- Dialogs are named via `aria-labelledby`, so `getByLabel('Password')` can match the dialog itself.
  Use role-based, `exact`, or dialog-scoped locators. Checkable menu items have role
  `menuitemcheckbox`: use `menuItem()` from `tests/e2e/helpers.ts`.
- Tests that use outside tools (pypdf, pdfsig, LibreOffice, openssl) must skip cleanly when the
  tool is missing. A tool probe must require exit status 0.
- In-place editors (text boxes, form fields) register with `registerActiveEditor({ commit })`
  (`src/renderer/src/app/commands.ts`) so commands commit pending typing first. Commands that
  must not end editing set `keepEditing`.
- Popups close on Escape through `usePopupEscape(open, onClose)` (`src/renderer/src/ui/Menu.tsx`).
- Engine calls on a closed document reject; `isDocumentClosedError`
  (`src/renderer/src/engine/EngineClient.ts`) tells those apart, and `showError` ignores them.
- MuPDF quirks:
  - `Pixmap.clear()` is transparent, `clear(0)` is opaque black.
  - Structured-text `walk` uses `String.fromCharCode` and mangles characters above U+FFFF. Use
    `walkStructuredText` (`src/engine/util/stext.ts`).
  - Saves beyond a plain save (compaction, recompression, security changes) run on a copy so the
    live document keeps its undo history. See `saveDocument` in `src/engine/ops/doc.ts`.
- Worktree-isolated agents have been based on an old commit before. Check the base with
  `git log` before merging their work.
- Git: work on the branch the session names, open a draft PR, and let the owner merge.

## Backlog

Roughly in priority order:

1. Code signing certificates for Windows and macOS (the installers trigger SmartScreen and
   Gatekeeper warnings).
2. OCR only bundles English and runs one language at a time.
3. Old Escape workarounds should move to `usePopupEscape`: `src/features/stamps-measure/escapeGuard.ts`,
   `keyboardTaken` in `src/features/edit-images-links/common.ts`, `src/features/fill-sign/SignMenu.tsx`.
   The markup-tools colour popover and the edit-text formatting popover don't use it either.
4. The fill-sign text editor and prepare-form property editing could use `registerActiveEditor`.
5. Show/Hide Comments also hides Fill & Sign items.
6. Flattening comments bakes in the outlines of Redact marks that haven't been applied.
7. Redaction misses line art in L-shapes that cross crop box corners.
8. Choosing "Don't Save" while a Ctrl+S save is still running drops that save without a message.
9. Edit > Undo is disabled while typing is uncommitted and there is no other history.
10. Decide whether Escape in a submenu closes one level or the whole menu (currently the whole menu).
11. GitHub Actions on Node 20 (`actions/checkout@v4` and others) show deprecation warnings.
12. Windows and macOS installers are not end-to-end tested in CI (only Linux is).
13. Prettier is configured but not applied across the repo.
14. Upstream: mupdf.js `walk` should use `String.fromCodePoint`.

Out of scope by design: XFA dynamic forms, timestamp authorities and OCSP for signatures, web
capture, scanner input.
