# Fartcrobat

A free, open-source PDF reader, editor and signer for Windows, macOS and Linux. The layout follows
current Adobe Acrobat Pro (All tools on the left, panels on the right rail), so people switching
over can find things where they expect them. Everything runs offline.

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

Installers are built by GitHub Actions for each tagged release: `.exe` (Windows, x64 and arm64),
`.dmg` and `.zip` (macOS), `.AppImage`, `.deb` and `.tar.gz` (Linux). Each registers Fartcrobat
as a handler for `.pdf` files.

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
