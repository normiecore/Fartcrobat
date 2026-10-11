# Cross-feature contracts

CROSS-FEATURE CONTRACTS (other engineers rely on these exact ids; implement your side exactly, never assume the other side exists — look things up in `registry` at runtime and skip missing ones):

Tool groups ("All tools" entries; order / category / homeTile):
  10 export ('Export a PDF', convert, home) [export-create] · 20 edit ('Edit a PDF', edit, home) [edit-text] ·
  30 create ('Create a PDF', create, home) [export-create] · 40 combine ('Combine files', create, home) [organize-pages] ·
  50 organize ('Organize pages', edit, home) [organize-pages] · 60 comment ('Add comments', review, home) [markup-tools] ·
  70 fillsign ('Fill & Sign', sign, home) [fill-sign] · 80 prepareform ('Prepare a form', sign) [prepare-form] ·
  85 requestsign ('Request e-signatures', sign) [prepare-form] · 90 certificate ('Use a certificate', sign) [digital-signatures] ·
  100 ocr ('Scan & OCR', convert, home) [ocr] · 110 protect ('Protect a PDF', protect, home) [protect-optimize] ·
  120 redact ('Redact a PDF', protect, home) [redact] · 130 compress ('Compress a PDF', protect, home) [protect-optimize] ·
  140 stamp ('Add a stamp', review) [stamps-measure] · 150 measure ('Measure objects', review) [stamps-measure] ·
  160 compare ('Compare files', review, home) [compare] · 170 print ('Print', other) [print] · 175 pagemarks ('Add header, watermark or background', edit) [page-marks]

Right panels (id / order): thumbnails 10, bookmarks 20 [navigation]; comments 30 [comments]; signatures 40 [digital-signatures];
  fields 50 [prepare-form]; attachments 60, layers 70, search 80 [navigation].

Quick tools (left floating bar; order): select 0 (core); comment.note 10, comment.highlight 20, comment.pencil 30 [markup-tools];
  fillsign.text 40 [fill-sign]; command fillsign.signYourself 50 [fill-sign].

Tool ids:
  markup-tools: comment.note, comment.highlight, comment.underline, comment.strikeout, comment.squiggly, comment.insertText,
    comment.replaceText, comment.typewriter, comment.textbox, comment.callout, comment.pencil, comment.eraser, comment.rectangle,
    comment.oval, comment.line, comment.arrow, comment.polygon, comment.polyline, comment.cloud, comment.areaHighlight
  stamps-measure: stamps.stamp, measure.distance, measure.perimeter, measure.area
  fill-sign: fillsign.text, fillsign.check, fillsign.cross, fillsign.dot, fillsign.line, fillsign.box, fillsign.date, fillsign.place (placing a signature/initials)
  edit-text: edit.content ("Edit text & images" mode), edit.addText
  edit-images-links: edit.addImage, edit.link
  page-marks: marks.crop
  redact: redact.mark
  prepare-form: form.select, form.text, form.checkbox, form.radio, form.list, form.dropdown, form.button, form.signature, form.date
  digital-signatures: sign.certificateBox (drag a signature rectangle)

Commands other features call or list (register exactly these ids if you own them):
  comments: comments.toggleVisibility ('Show/Hide Comments'), comments.export, comments.import, comments.summarize, comments.deleteAll, comments.flatten
  page-marks: marks.headerFooter.add, marks.headerFooter.update, marks.headerFooter.remove, marks.watermark.add,
    marks.watermark.update, marks.watermark.remove, marks.background.add, marks.background.update, marks.background.remove,
    marks.bates.add, marks.bates.remove, marks.crop (activates the crop tool)
  fill-sign: fillsign.signYourself (opens the signature/initials menu)
  organize-pages: organize.open (opens Organize pages), combine.open
  print: file.print (Mod+P), file.printPreview? (optional)
  navigation: file.properties (Mod+D), nav.addBookmark (Mod+B), search.advanced (Mod+Shift+F)
  digital-signatures: sign.useCertificate
  export-create: export.word, export.excel, export.powerpoint, export.image, export.text, export.html, create.fromFile, create.blank, create.fromClipboard
  ocr: ocr.recognize
  protect-optimize: protect.encrypt, protect.removeSecurity, compress.open
  redact: redact.apply, redact.findText

Window events (CustomEvent on window, detail shown):
  'fartcrobat:edit-annotation' {docId, id, page} — markup-tools/fill-sign dispatch after creating a sticky note or text box so
     comments opens its popup note / inline editor for it. comments listens.
  'fartcrobat:sign-field' {docId, fieldId, fieldName, page, rect} — forms-fill dispatches when the user clicks an unsigned
     signature field; digital-signatures listens and starts certificate signing for that field.

Selections: comments owns {kind:'annotations', page, ids}. Other features use {kind:'custom', type:'<feature-id>:<what>', page, data}.
Delete/Backspace: each owner registers its own command with shortcut ['Delete','Backspace'] whose `enabled` is true ONLY for its own
  selection/state, so the first enabled one wins.
Annotation data written by features goes in AnnotSpec.extra, e.g. extra: { fartcrobat: 'fillsign' } or { fartcrobat: 'measure', scale: '1 in = 1 ft' }.
Persisted feature data (signatures, custom stamps, digital IDs, tool defaults) uses invoke('store:get' | 'store:set', '<feature-id>:<key>', value).
New fixtures go in tests/fixtures/<feature-id>/ (generate them in a script or in the test itself; python3 with reportlab and Pillow is available).
Engine namespace = your feature id (e.g. defineOps('edit-text', ...)).
