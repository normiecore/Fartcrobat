# Fartcrobat: notes for Claude sessions

Open-source (AGPL) desktop PDF reader, editor and signer for Windows, macOS and Linux. The layout
follows current Adobe Acrobat Pro. Works offline, no built-in AI: its only network request of its
own is the check for a new GitHub release (in-app updates, off in Preferences > Updates or with the
`autoUpdate` machine policy). Optional local "agent access" (on by default) lets AI apps on the
same computer, such as Claude Desktop, work with open documents over MCP. LibreOffice is used for
Office conversion when installed, with a built-in fallback.

## State

- v0.1.0 is released: https://github.com/normiecore/Fartcrobat/releases/tag/v0.1.0 (Windows
  x64/arm64 `.exe`, macOS `.dmg`/`.zip` for Intel and Apple silicon, Linux `.AppImage`, `.deb`,
  `.tar.gz`). It has no updater.
- v0.2.0 (17 Oct 2026) is the first release with the in-app updater and its `latest*.yml` files,
  and with certificate encryption and native MCP editing.
- From 0.2.1 on a release has one file per kind of computer (Windows x64 and arm64 installers, no
  combined one; Mac `.dmg` for arm64 and x64, both named; Ubuntu/Debian `.deb`; AppImage for other
  Linux). `scripts/release-downloads.mjs` holds the table that README.md (Install) and the top of
  the release notes show, and each release build checks its files against it.
- Merged into `main`: #1 (the app), #2 (fixes), #3 (release publishing), #4, #5 and #9 (agent
  access and its review fixes), #6, #8 and #10 (passwordless design, then remembered passwords),
  #12 (in-app updates), #13 (certificate encryption contracts and fixtures), #14 (certificate
  encryption), #15 (native MCP editing and the AI companion), #16 (release 0.2.0), #18 (one installer
  per computer, update rehearsal for every download), #19 (no request to Google for spell-check
  dictionaries). #11 merged main into the old session branch. Open: #17 (0.2.1, companion joining
  and on-document review); merging it publishes 0.2.1.
- 0.2.0 on Linux asks Google (`redirector.gvt1.com`) for a spell-check dictionary at every start:
  turning Chromium's spell checker off does not stop it, an empty language list does. Fixed for
  0.2.1 in `src/main/util/spellcheck.ts`. Windows and macOS use the system checker and asked
  nothing (update rehearsal, 20 Oct 2026); Linux has no spell checking, as before (backlog 21).
- GitHub's default branch is still `claude/open-source-pdf-app-3x8yp0`, so GitHub suggests PRs
  into it and the branch cannot be deleted. The owner should set the default branch to `main`
  (Settings > General). Everything on that branch is already in `main`.
- About 1590 unit tests (vitest) and 172 end-to-end tests (Playwright on Electron).

### Work in progress (handoff, 14 Oct 2026)

- **In-app updates** (`docs/features/updates.md`, merged in #12): checks
  `github.com/normiecore/Fartcrobat/releases/latest` 30 s after start and every 6 hours, shows a
  card in the bottom right (Download with a progress bar, then Restart now or Later), and installs
  silently through electron-updater 6.8.10 after the normal quit flow has asked about unsaved
  documents. Install works for the Windows NSIS installer and the Linux AppImage; macOS (until
  Developer ID signing), .deb and .tar.gz only notify and open the release page. Help > Check for
  Updates..., Preferences > Updates (version, switch, last checked) and the About dialog show the
  version. Machine policy `AutoUpdate` / `autoUpdate`. The AppImage file name has no version any
  more, so updates replace it in place. A review (install safety, security, release pipeline, UI)
  found 15 issues, all fixed in the PR, among them an inherited `APPIMAGE` variable that would
  have made a .deb install replace another app's AppImage.
  - The update rehearsal (`tests/update-rehearsal/README.md`) tries it without publishing, from
    each kind of download: on 20 Oct 2026 the released 0.2.0 AppImage and Windows installer (per
    user and per machine) updated themselves to a test 0.2.1 from a fake GitHub (Restart now,
    Later, a wrong checksum, the policy off), and the released Mac app and `.deb` (with Ubuntu
    24.04's AppArmor setting) offered it and opened its release page.
    `.github/workflows/update-rehearsal.yml` runs all of it, and every release runs it before
    publishing (release.yml); after
    publishing 0.2.1, let an installed 0.2.0 update from the real github.com once per platform,
    and try a Windows per-machine install with UAC on (as an administrator and as a standard
    user): the runners elevate without asking, so the rehearsal cannot show the UAC prompt.
- **Agent access** (`docs/features/agent-access.md`): merged with the review fixes from #9. Known
  gaps are listed in #9 and backlog items 15 and 16. Nothing has been tried on Windows or with a
  real Claude Desktop yet.
- **Passwordless** (`docs/features/passwordless.md`): phases 0 and 1 (remembered passwords with
  safeStorage, also for Digital IDs, silent unlock for agents) are merged (#10). Certificate
  encryption (phases 2 to 6) is built in #14; "Certificate encryption as built" in the note says
  where the code is and where it differs from the plan. It opens V2, V4 and V5 /Adobe.PubSec
  files with a Digital ID (.p12) or the Windows certificate store and smart cards (one
  PowerShell 5.1 helper per app session, so a PIN is asked once per session), saves them back as
  V5 AES-256 with the original seed and envelopes, and creates them (Protect > Encrypt with
  Certificate). Agents open them silently, except that a smart card PIN is typed by the person.
  Three adversarial review rounds (each finding verified independently) are fixed in the PR.
  - Nothing has run on Windows, a smart card or Acrobat. Next: the owner's team runs the manual
    Windows checklist in the note (25 items); the `windows-helper` CI job already runs the helper
    tests against stock PowerShell 5.1 on `windows-latest`.
  - The prototypes in `prototypes/passwordless/` are ported and were removed (git history has
    them).
- The machine policy for all three features is `src/main/policy.ts`: REG_DWORDs `AgentAccess`,
  `RememberPasswords` and `AutoUpdate` under `HKLM\SOFTWARE\Policies\Fartcrobat` on Windows,
  `policy.json` (`agentAccess`, `rememberPasswords`, `autoUpdate`) on macOS and Linux.
- Owner decisions so far are recorded at the top of each feature note.
- Next, once 0.2.1 is published: let an installed 0.2.0 update from the real github.com once per
  platform, try a Windows per-machine update with UAC on, run the Windows certificate checklist,
  and try agent access and the companion with a real Claude Desktop and ChatGPT Desktop (backlog
  16).


### Native MCP editing (16 Oct 2026)

- Branch codex/live-mcp-text-editing adds get_editable_text, edit_text, get_document_layout,
  reflow_text and rebuild_document. See docs/features/agent-text-editing.md.
- Native edits and linked column/page flows happen in the open PDF, with an on-document review,
  revision guards and one undo step. Flow templates keep artwork and unmanaged content; static
  page labels and link/comment anchors need review. A clean new design is a separate tool.
- The MCP client performs semantic/visual interpretation using the exposed structure and renders.
  The app does not contain a model or guarantee perfect reconstruction of arbitrary PDFs.
- Update the installed app AND reinstall its bundled Claude Desktop extension before testing.
- Local Windows UI verification used a cached Electron 40 runtime and a generated-bundle-only
  shim for the existing ClipboardItem import; no compatibility change is in the source. CI
  should validate the actual pinned Electron 44 runtime. Local Linux CI simulation is unavailable.

### Companion follow-up (16 Oct 2026)

- See docs/features/agent-companion.md. Draggable provider sprites, observed activity bubbles,
  compact in-app MCP conversation, and installation-specific ChatGPT Desktop setup are added.
- companion_chat is client-initiated: the person opens the chat (Chat here) and the next successful
  tool call of a conversation hands it the session (0.2.1); it cannot wake an idle AI session. No
  API provider, credentials or automatic model is added.
- Chat history stays in memory. Position only is persisted. MCP now exposes 37 tools.
- The agent e2e specs (`tests/e2e/agent-*.spec.ts`) run in a Claude cloud session like the others
  (Unix sockets work there, checked 20 Oct 2026), also against a packaged build.

## Where things are

- `docs/ARCHITECTURE.md`: how the app is built (engine worker, feature folders, coordinates,
  testing, UX rules). Read it before changing structure.
- `docs/features/<id>.md`: design notes per feature; `docs/features/CONTRACTS.md` for shared APIs.
- `src/features/<id>/`: one folder per feature with `index.tsx` (renderer), `engine.ts` (runs in
  the MuPDF worker) and `main.ts` (Electron main). 20 features: agent-access, comments, compare,
  digital-signatures, edit-images-links, edit-text, export-create, fill-sign, forms-fill,
  markup-tools, navigation, ocr, organize-pages, page-marks, prepare-form, print,
  protect-optimize, redact, stamps-measure, updates.
- `src/engine/`: MuPDF (WASM) operations, one Web Worker per open document.
- `src/renderer/src/`: app shell, viewer, command registry, UI kit.
- Agent access: contracts in `src/shared/agent/` (tool catalogue, pipe protocol, main/window
  messages), the feature in `src/features/agent-access/` (main process pipe server, window runner
  and tool handlers, UI), the MCP shim in `src/agent-shim/` (built to `out/agent/shim.mjs` and the
  Claude Desktop extension `out/agent/fartcrobat.mcpb`, shipped as `<resources>/agent/`).
- Certificate encryption: contracts in `src/shared/certkeys.ts`, the engine side in
  `src/engine/crypt/` (reader, bridge, writer; `index.ts` describes it), key sources and the
  PowerShell helper in `src/main/certkeys/`, the open flow in `src/renderer/src/app/unlock.ts` and
  `certificates.ts`, Encrypt with Certificate in `src/features/protect-optimize/`.
- `tests/engine/*.test.ts` (vitest), `tests/e2e/*.spec.ts` (Playwright), `tests/fixtures/`.

Stack: Electron 44, electron-vite 5, React 19, zustand, TypeScript 6, mupdf 1.28 (WASM),
tesseract.js 7, electron-builder 26. `.npmrc` sets `legacy-peer-deps=true`.

## Commands

```
npm ci
npm run dev                                   # app with hot reload
npm run typecheck && npm run lint && npm test # run before every commit
npm run build && xvfb-run -a npx playwright test [tests/e2e/<feature>.spec.ts]
npm run build:agent                           # only the MCP shim and the .mcpb (build runs it too)
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
- `sudo env "PATH=$PATH" tests/update-rehearsal/linux.sh` updates the latest released AppImage to a
  build of this checkout from a fake GitHub (root, throwaway machines only; README there).
- Every push to any branch runs CI and failures email the owner. Verify locally first, and put
  `[skip ci]` in intermediate commits that don't need a run. But make sure a PR's head commit runs
  CI before it is merged: #5 was merged with `[skip ci]` on every commit and turned `main` red.

## CI and releases

- `.github/workflows/ci.yml`: ubuntu-24.04, Node 22, installs pypdf (`tests/requirements.txt`),
  poppler-utils and LibreOffice, then typecheck, lint, unit tests, build, e2e under xvfb.
- `.github/workflows/release.yml`: builds installers on Windows, macOS and Linux.
- To release: merge a PR that bumps `version` in `package.json` into `main`, with "Create a merge
  commit" (a squash can carry a `[skip ci]` from one of its commits, and GitHub then skips the
  workflow). That push publishes: the release workflow builds the installers, runs the full CI
  suite (`ci.yml`) and the update rehearsal (`update-rehearsal.yml`) on the same commit, and only
  then creates the tag and the release, with the download table and `docs/releases/v<version>.md`
  as notes. When a job of that run fails, fix the cause and use "Re-run failed jobs" on the same
  run, which keeps the merged commit. A manual run on `main` with the version publishes main's head
  as it is then, so use it only while that head is still the version bump; never run it in
  addition to the merge. A `v*` tag push also publishes (the Claude session git proxy refuses tag
  pushes), and a tag that already names another commit stops the publish.
- In-app updates (`docs/features/updates.md`) download from the latest GitHub release, so every
  release must carry `latest.yml`, `latest-mac.yml`, `latest-linux.yml` and the `.blockmap` files
  (electron-builder writes them; the publish job fails without them). v0.1.0 has no updater: people
  on it install the next version by hand once. To write release notes on GitHub first, save the
  release as a draft and do not publish it until the workflow has attached the installers and
  pointed its tag at the built commit (installed copies offer a published release at once); the
  publish job refuses to add files to a published release. Publishing the draft pushes the tag;
  that run sees the release is out and stops.
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
- The main process must never import `@noble/*` (electron-vite's `__dirname` shim lands inside
  their doc comments and the app does not start), and imports node-forge only with `import()`.
  `tests/engine/main-bundle.test.ts` checks both.
- Certificate-encrypted sessions must never write `s.pdf.saveToBuffer()` output (it holds the
  temporary bridge dictionary); `tests/engine/passwordless-guard.test.ts` allow-lists the calls.
- Tests that use outside tools (pyHanko, pwsh) skip without them; CI sets
  `FARTCROBAT_REQUIRE_PYHANKO=1` so the pyHanko cross-checks cannot skip there.
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
15. Agent access on Windows: the named pipe uses Node's default DACL and accepts remote clients
    (token auth still applies); a native helper could set an owner-only DACL and
    PIPE_REJECT_REMOTE_CLIENTS. The `.mcpb` extension is not signed.
16. Agent access has only been tested on Linux with a scripted MCP client; try it with Claude
    Desktop on Windows (install the `.mcpb` from Preferences > AI apps).
17. Updates on macOS only notify until releases are Developer ID signed (backlog 1); then set
    `MAC_INSTALLS_UPDATES` in `src/features/updates/main/settings.ts` and test Squirrel.Mac.
18. Updates for .deb installs only notify: electron-updater can install them, but only through a
    root password prompt (`pkexec dpkg -i`).
19. Password security leaves a direct `/Info` dictionary (in the trailer, not an object) in clear
    text: MuPDF's writer does not encrypt it. Certificate security already moves it into an
    object first (`src/engine/crypt/pubsecWrite.ts`); the password save path in
    `src/engine/ops/doc.ts` needs the same.
20. Certificate encryption gaps (see "Known limits" in `docs/features/passwordless.md`): saved
    files drop a PDF MAC (ISO/TS 32004), so pyHanko refuses them; no Active Directory lookup of
    recipients; no macOS Keychain or Linux PKCS#11 smart cards; no EC (ECDH) recipients; signing
    certificate-encrypted files needs a PubSec-aware incremental save; Constrained Language Mode
    machines need an Authenticode-signed helper script (backlog 1).
21. Spell check on Linux: Chromium's checker there needs Hunspell dictionaries, which it would
    download from Google, so it is off (`src/main/util/spellcheck.ts`). Bundling
    dictionaries (Electron publishes `hunspell_dictionaries.zip` per release) and pointing
    `setSpellCheckerDictionaryDownloadURL` at a local copy would bring it back offline.

Out of scope by design: XFA dynamic forms, timestamp authorities and OCSP for signatures, web
capture, scanner input.

### 0.2.1 (#17, 20 Oct 2026)

- Companion: opening the chat lets the next conversation that uses Fartcrobat join, without an
  invitation; closing the chat before one joins, End & clear or a disconnect take that back until
  the person allows a new conversation. Shims older than 0.2.1 drop the token, so their calls never
  join (`shimForwardsCompanion`), and the chat and Preferences ask for the extension to be added
  again. Conversation-token isolation, on-document edit review (a save keeps it open, any edit
  ends it) and three working poses. See the agent-companion and agent-text-editing notes.
- Connect ChatGPT Desktop works in installed builds: `shim.mjs` ships next to app.asar and the
  setup points at a copy in `<userData>/agent-helper/`, refreshed at each start.
- Merging #17 publishes 0.2.1 (see "To release"). Merge it with "Create a merge commit": one of its
  commit messages names the skip marker, which a squash would carry into main's head commit.
