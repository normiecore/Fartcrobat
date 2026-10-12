"""Generates the fixtures for the redact feature tests.

Run: python3 tests/fixtures/redact/make_fixtures.py   (the output is committed next to this script)

hidden-info.pdf is written by hand (raw PDF syntax, uncompressed streams) so it contains every kind of
hidden information that "Remove hidden information" must find and remove:
  - document metadata (Info dictionary and an XMP /Metadata stream), private /PieceInfo data
  - an embedded search index marker (/PieceInfo /SearchIndex)
  - a file attachment (EmbeddedFiles name tree) and a FileAttachment annotation
  - bookmarks (/Outlines)
  - a sticky-note comment with a reply
  - a form field (text field with a value)
  - invisible text (text render mode 3, as written by OCR software)
  - a hidden layer (optional content group switched off) holding text and a filled rectangle
  - document JavaScript (names tree), an /OpenAction script, a page /AA script and a link with a script
  - a link to an external web page and a link to another page (kept)
  - text covered by an opaque black rectangle drawn on top of it (a fake redaction)
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))


def pdf_string(s):
    return '(' + s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ')'


class Writer:
    def __init__(self):
        self.objects = {}

    def obj(self, num, body):
        self.objects[num] = body.encode('latin-1') if isinstance(body, str) else body

    def stream(self, num, data, extra=''):
        if isinstance(data, str):
            data = data.encode('latin-1')
        self.objects[num] = (f'<< /Length {len(data)} {extra} >>\nstream\n').encode('latin-1') + data + b'\nendstream'

    def write(self, path, root, info):
        out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
        offsets = {}
        size = max(self.objects) + 1
        for num in sorted(self.objects):
            offsets[num] = len(out)
            out += f'{num} 0 obj\n'.encode('latin-1') + self.objects[num] + b'\nendobj\n'
        xref = len(out)
        out += f'xref\n0 {size}\n'.encode('latin-1')
        out += b'0000000000 65535 f \n'
        for num in range(1, size):
            if num in offsets:
                out += f'{offsets[num]:010d} 00000 n \n'.encode('latin-1')
            else:
                out += b'0000000000 65535 f \n'
        out += f'trailer\n<< /Size {size} /Root {root} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode('latin-1')
        with open(path, 'wb') as f:
            f.write(out)


def hidden_info():
    w = Writer()
    # 1 catalog, 2 pages, 3 page 1, 4 page 2, 5 font, 6 content p1, 7 content p2
    w.obj(1, '<< /Type /Catalog /Pages 2 0 R /Metadata 20 0 R /Outlines 30 0 R /PageMode /UseOutlines'
             ' /OCProperties << /OCGs [40 0 R 41 0 R] /D << /Name (Default) /ON [40 0 R] /OFF [41 0 R] /Order [40 0 R 41 0 R] >> >>'
             ' /Names << /JavaScript 50 0 R /EmbeddedFiles 60 0 R >>'
             ' /OpenAction 52 0 R /AA << /WC 53 0 R >>'
             ' /PieceInfo << /SearchIndex << /LastModified (D:20240101000000Z) /Private (index-data) >>'
             ' /MyApp << /LastModified (D:20240101000000Z) /Private (private application data) >> >>'
             ' /AcroForm << /Fields [70 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>')
    w.obj(2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>')
    w.obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R'
             ' /Resources << /Font << /F1 5 0 R >> /Properties << /OCvis 40 0 R /OChid 41 0 R >> >>'
             ' /Annots [80 0 R 81 0 R 82 0 R 83 0 R 84 0 R 85 0 R 70 0 R]'
             ' /AA << /O 54 0 R >> >>')
    w.obj(4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
    w.obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    content1 = '\n'.join([
        'BT /F1 18 Tf 72 720 Td (Hidden information test) Tj ET',
        'BT /F1 12 Tf 72 690 Td (Visible paragraph text stays.) Tj ET',
        # invisible OCR-style text
        'BT /F1 12 Tf 3 Tr 72 660 Td (INVISIBLE OCR LAYER) Tj 0 Tr ET',
        # visible layer
        '/OC /OCvis BDC BT /F1 12 Tf 72 630 Td (Visible layer text) Tj ET EMC',
        # hidden layer with text and a rectangle
        '/OC /OChid BDC q 1 0 0 rg 300 600 120 40 re f Q BT /F1 12 Tf 72 600 Td (HIDDEN LAYER SECRET) Tj ET EMC',
        # text covered by a black box drawn on top
        'BT /F1 12 Tf 72 560 Td (COVERED SECRET 4111) Tj ET',
        'q 0 g 66 552 160 22 re f Q',
        'BT /F1 12 Tf 72 520 Td (Visit the website and page two.) Tj ET',
        'BT /F1 12 Tf 72 480 Td (Name:) Tj ET',
    ])
    w.stream(6, content1)
    w.stream(7, 'BT /F1 18 Tf 72 720 Td (Page two) Tj ET\nBT /F1 12 Tf 72 690 Td (Nothing hidden here.) Tj ET')
    # 10: info dictionary
    w.obj(10, '<< /Title (Secret project plan) /Author (Jane Secret) /Subject (Internal) /Keywords (confidential)'
              ' /Creator (Hand written) /Producer (make_fixtures.py) /CreationDate (D:20240101000000Z) >>')
    xmp = ('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
           '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""'
           ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Jane Secret</rdf:li></rdf:Seq>'
           '</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
    w.stream(20, xmp, '/Type /Metadata /Subtype /XML')
    # outlines
    w.obj(30, '<< /Type /Outlines /First 31 0 R /Last 32 0 R /Count 2 >>')
    w.obj(31, '<< /Title (Secret chapter) /Parent 30 0 R /Next 32 0 R /Dest [3 0 R /XYZ 0 792 0] >>')
    w.obj(32, '<< /Title (Run script) /Parent 30 0 R /Prev 31 0 R /A 55 0 R >>')
    # optional content groups
    w.obj(40, '<< /Type /OCG /Name (Visible layer) >>')
    w.obj(41, '<< /Type /OCG /Name (Hidden layer) >>')
    # JavaScript
    w.obj(50, '<< /Names [(init) 51 0 R] >>')
    w.obj(51, '<< /S /JavaScript /JS (app.alert\\("document script"\\);) >>')
    w.obj(52, '<< /S /JavaScript /JS (app.alert\\("open action"\\);) >>')
    w.obj(53, '<< /S /JavaScript /JS (app.alert\\("will close"\\);) >>')
    w.obj(54, '<< /S /JavaScript /JS (app.alert\\("page open"\\);) >>')
    w.obj(55, '<< /S /JavaScript /JS (app.alert\\("bookmark"\\);) >>')
    # embedded file
    w.obj(60, '<< /Names [(notes.txt) 61 0 R] >>')
    w.obj(61, '<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F 62 0 R >> >>')
    w.stream(62, 'attached secret notes', '/Type /EmbeddedFile /Subtype /text#2Fplain')
    w.obj(63, '<< /Type /Filespec /F (photo.txt) /UF (photo.txt) /EF << /F 64 0 R >> >>')
    w.stream(64, 'annotation attachment secret', '/Type /EmbeddedFile')
    # form field (also the widget)
    w.obj(70, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Jane Secret) /Rect [120 474 320 494] /P 3 0 R /F 4'
              ' /DA (/Helv 12 Tf 0 g) /AA << /K 56 0 R >> >>')
    w.obj(56, '<< /S /JavaScript /JS (AFSpecial_Keystroke\\(0\\);) >>')
    # annotations: external link, internal link, JS link, sticky note + reply, file attachment
    w.obj(80, '<< /Type /Annot /Subtype /Link /Rect [72 515 220 535] /Border [0 0 0] /A << /S /URI /URI (https://example.com/secret) >> >>')
    w.obj(81, '<< /Type /Annot /Subtype /Link /Rect [230 515 330 535] /Border [0 0 0] /Dest [4 0 R /XYZ 0 792 0] >>')
    w.obj(82, '<< /Type /Annot /Subtype /Link /Rect [400 515 500 535] /Border [0 0 0] /A 57 0 R >>')
    w.obj(57, '<< /S /JavaScript /JS (app.alert\\("link"\\);) >>')
    w.obj(83, '<< /Type /Annot /Subtype /Text /Rect [450 700 470 720] /Contents (Reviewer note: secret) /T (Reviewer) /F 28 >>')
    w.obj(84, '<< /Type /Annot /Subtype /Text /Rect [450 700 470 720] /Contents (Reply) /T (Author) /IRT 83 0 R /F 30 >>')
    w.obj(85, '<< /Type /Annot /Subtype /FileAttachment /Rect [500 700 520 720] /FS 63 0 R /Contents (photo) /Name /Paperclip >>')
    w.write(os.path.join(OUT, 'hidden-info.pdf'), 1, 10)


def rotated():
    """A page with /Rotate 90 (overlay drawing must follow the page rotation)."""
    w = Writer()
    w.obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    w.obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    w.obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
    w.stream(4, 'BT /F1 14 Tf 72 700 Td (Rotated secret text stays hidden) Tj ET\nBT /F1 14 Tf 72 670 Td (Second line remains) Tj ET')
    w.obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    w.obj(6, '<< /Title (Rotated) >>')
    w.write(os.path.join(OUT, 'rotated.pdf'), 1, 6)


if __name__ == '__main__':
    hidden_info()
    rotated()
    print('fixtures written to', OUT)
