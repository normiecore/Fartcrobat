# Fartcrobat

A free, open-source PDF reader, editor and signer for Windows, macOS and Linux. The layout follows
current Adobe Acrobat Pro (All tools on the left, panels on the right rail), so people switching
over can find things where they expect them. Everything works offline: the only network request
the app makes by itself is a check for a new release on GitHub (see Updates below).

## What it does

**Read and navigate**
- Tabs, single page / two-page / scrolling layouts, zoom, rotate view, Read Mode, Full Screen
- Find (Ctrl+F) and Advanced Search with results grouped by page
- Page thumbnails, bookmarks (add, rename, nest by drag), attachments, layers
- Read Out Loud using the system voices
- Document properties: description, fonts, security, initial view, custom metadata
- Light, dark and high-contrast page colours

**Comment and mark up**
- Sticky notes, highlight, underline, strikethrough, text boxes, callouts, pencil, shapes, arrows
- Pop-up notes with replies and review status; Comments panel with filter, sort and a printable summary
- Import and export comments as XFDF or FDF
- Stamps (standard, dynamic date stamps, your own images) and measuring tools for distance,
  perimeter and area to scale

**Fill, sign and forms**
- Fill interactive forms, with form scripts for formatting, validation and calculation
- Fill & Sign for flat forms: type anywhere, checkmarks, your saved signature and initials
- Prepare a form: detect fields automatically or add text fields, checkboxes, radio buttons,
  lists, dropdowns, buttons and signature fields
- Request e-signatures: place signature fields per signer
- Certificate signatures: sign and certify with a PKCS#12 digital ID or create a self-signed one,
  validate existing signatures and see what changed after signing

**Organize and edit**
- Organize Pages: reorder, rotate, delete, insert (from file, blank, clipboard), extract,
  split, replace; drag pages between tabs
- Combine files (PDFs, images and Office files) into one PDF
- Edit text and images on the page, add links
- Headers and footers, watermarks, backgrounds, Bates numbering, crop and page boxes
- Redact text, patterns (emails, phone numbers and more) and areas; remove hidden information
- Protect with passwords and permissions; compress to reduce file size
- Compare two versions of a document side by side or as an overlay
- Scan & OCR to make scanned pages searchable (English bundled)

**Export and create**
- Export to Word, Excel, PowerPoint, HTML, plain text and images
- Create PDFs from images, HTML files, the clipboard, blank pages and Word, Excel or PowerPoint
  files (best layout with LibreOffice installed; a built-in converter is used otherwise)

**Print**
- Print dialog with live preview, page scaling, several pages per sheet, booklets and posters

## Coming from Acrobat

| In Acrobat | In Fartcrobat |
| --- | --- |
| All tools pane on the left | Same place. Every tool is also a tile on Home |
| Right-hand panels (Bookmarks, Comments, Thumbnails...) | Right rail |
| Hamburger menu (File, Edit, View...) | Same menu. On macOS it is also the system menu bar |
| Search for a tool | Find text or tools (Ctrl+Shift+K) searches commands and the document |
| Keyboard shortcuts | Acrobat's, including single-key tool keys (V, H, Z, U, S...) |
| Preferences (Ctrl+K) | Menu > File > Preferences, Ctrl+K (Fartcrobat > Preferences, Cmd+, on macOS) |
| Set as default PDF app | Home page banner, or Help > Make Fartcrobat the Default PDF App |

## Install

Each [release](https://github.com/normiecore/Fartcrobat/releases/latest) has one file per kind of
computer. Download the one for yours and open it:

| Your computer | File |
| --- | --- |
| Windows (most PCs) | `Fartcrobat-Setup-<version>-x64.exe` |
| Windows on Arm (Snapdragon, Surface Pro X) | `Fartcrobat-Setup-<version>-arm64.exe` |
| Mac with Apple silicon (M1 or later) | `Fartcrobat-<version>-arm64.dmg` |
| Mac with an Intel processor | `Fartcrobat-<version>-x64.dmg` |
| Ubuntu, Debian, Linux Mint, Pop!_OS | `fartcrobat_<version>_amd64.deb` |
| Other Linux (Fedora, Arch, openSUSE...) | `Fartcrobat-x86_64.AppImage` |

- Not sure which? On Windows, Settings > System > About says "x64-based processor" or "ARM-based
  processor". On a Mac, Apple menu > About This Mac says "Chip Apple M..." or "Processor ... Intel".
- Windows: open the `.exe`. The installers are not code signed yet: if the browser says the file
  isn't commonly downloaded, choose Keep; if Windows says "Windows protected your PC", choose More
  info, then Run anyway. The arm64 installer stops on an x64 PC and says which file to get.
- Mac: open the `.dmg` and drag Fartcrobat to Applications. If macOS says it could not verify
  Fartcrobat, open System Settings > Privacy & Security and choose Open Anyway.
- Ubuntu: open the `.deb` with App Center (Debian, Mint, Pop!_OS: with your software installer), or
  run `sudo apt install ./<file>` in the folder you downloaded it to. Take the `.deb` on Ubuntu:
  on 24.04 the AppImage starts without Chromium's sandbox (Ubuntu limits the user namespaces it
  needs, and the `.deb` installs the AppArmor profile that allows them).
- AppImage: make it executable first (right-click > Properties > Executable as Program, or
  `chmod +x Fartcrobat-x86_64.AppImage`), then open it. It updates itself, and it needs FUSE 2:
  `sudo apt install libfuse2t64` on Ubuntu 24.04 and later, `libfuse2` on 22.04.
- 0.2.0, the release before this table, names its Intel Mac file `Fartcrobat-0.2.0.dmg` and also
  has `Fartcrobat-Setup-0.2.0.exe`, one Windows installer for both processors.
- The other files of a release are for in-app updates (`.zip`, `.blockmap`, `latest*.yml`) and for
  unpacking by hand (`.tar.gz`).

Every install registers Fartcrobat as a handler for `.pdf` files. The table is kept in
`scripts/release-downloads.mjs`, which checks each release build against it and puts it at the top
of the release notes.

## Updates

Fartcrobat checks GitHub for a new release 30 seconds after it starts and then every 6 hours, and
shows a notification when there is one. The check is one HTTPS request for the latest release
page; nothing about you or your documents is sent. On Windows and with the AppImage, Download
installs the update when you restart Fartcrobat (or the next time you quit). On a Mac (until the
app is signed) and with the `.deb`, Download opens the release page: download the new file for your
computer from the table above and open it, as for the first install. Help > Check for Updates...
checks at once.

To turn automatic checks off, use Preferences > Updates. Organizations can turn checks off (or
on) for a computer: the `AutoUpdate` REG_DWORD under `HKLM\SOFTWARE\Policies\Fartcrobat` on
Windows (0 off, 1 on), or `{"autoUpdate":{"enabled":false}}` in
`/Library/Application Support/Fartcrobat/policy.json` (macOS) or `/etc/fartcrobat/policy.json`
(Linux).
See [docs/features/updates.md](docs/features/updates.md).


## AI apps and live editing

Preferences > AI apps > Add to Claude Desktop installs the bundled local MCP extension. With
agent access enabled, Claude can inspect open PDFs, edit real page text, and show proposed changes
in Fartcrobat before you apply them. Changes appear in the open document and can be undone.

For larger rewrites, Claude can inspect fonts, headings, tables, artwork and margins, then flow
text through connected columns and continuation pages while keeping the existing design. A new
design is a separate, explicitly reviewed option. Complex scans, missing font glyphs and ambiguous
tables have limits: the preview shows the result, and the app reports unsupported operations.

Save a new local PDF with the agent's save_document tool or the normal Save As command. The AI
service receives the document text/images its tools read. Reinstall the extension after updating
the app to pick up new tools. See [the editing guide](docs/features/agent-text-editing.md).

## Development

```
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests (engine and features)
npm run e2e        # build and run end-to-end tests (Linux: prefix with xvfb-run -a)
npm run dist       # build installers for the current platform
```

Some tests also check Fartcrobat's output with independent tools: `pip install -r
tests/requirements.txt`, poppler-utils (`pdfsig`) and LibreOffice. Without them those checks are
skipped; CI installs all of them.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the app is built and
[docs/features](docs/features) for each feature's design notes.

## License

Fartcrobat is licensed under the GNU Affero General Public License v3.0 or later. It uses
[MuPDF](https://mupdf.com) by Artifex Software, also under the AGPL, and
[Tesseract](https://github.com/tesseract-ocr/tesseract) for OCR under the Apache License 2.0.
