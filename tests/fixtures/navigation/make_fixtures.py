"""Generates the fixtures used by the navigation feature tests (requires reportlab and pypdf).

Run: python3 tests/fixtures/navigation/make_fixtures.py   (outputs are committed next to this script)

- layers.pdf        two pages with three optional content groups (one hidden by default)
- attachments.pdf   an embedded file with a description plus a FileAttachment annotation on page 2
- initial-view.pdf  nested bookmarks and an initial view (/PageMode /UseOutlines, two-up layout,
                    opens on page 3 at 150%)
- fonts.pdf         an embedded subset TrueType font, a non-embedded base font and a font used
                    only inside a form XObject
"""
import io
import os

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NullObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))


def write_raw_pdf(path, objects, root=1):
    """Writes numbered objects (1-based, bytes bodies) as a classic PDF with an xref table."""
    out = io.BytesIO()
    out.write(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f'{i} 0 obj\n'.encode() + body + b'\nendobj\n')
    xref = out.tell()
    out.write(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
    for off in offsets:
        out.write(f'{off:010d} 00000 n \n'.encode())
    out.write(f'trailer\n<< /Size {len(objects) + 1} /Root {root} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    with open(path, 'wb') as f:
        f.write(out.getvalue())


def stream(content: bytes, extra: bytes = b'') -> bytes:
    return b'<< /Length ' + str(len(content)).encode() + extra + b' >>\nstream\n' + content + b'\nendstream'


def layers_doc():
    page1 = (
        b'BT /F1 24 Tf 72 700 Td (Layers fixture) Tj ET\n'
        b'/OC /L1 BDC 0 0 1 rg 72 500 200 100 re f EMC\n'
        b'/OC /L2 BDC 1 0 0 rg 320 500 200 100 re f BT /F1 14 Tf 0 g 72 460 Td (Reviewer notes layer) Tj ET EMC\n'
        b'/OC /L3 BDC 0.8 0.8 0.8 rg BT /F1 60 Tf 120 300 Td (DRAFT) Tj ET EMC\n'
    )
    page2 = b'BT /F1 18 Tf 72 700 Td (Second page) Tj ET\n/OC /L1 BDC 0 0.6 0 rg 72 500 200 100 re f EMC\n'
    objects = [
        # 1 catalog
        b'<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R 7 0 R] '
        b'/D << /Name (Default) /Order [5 0 R 6 0 R 7 0 R] /ON [5 0 R 7 0 R] /OFF [6 0 R] >> >> >>',
        # 2 pages
        b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        # 3, 4 page objects
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R '
        b'/Resources << /Font << /F1 8 0 R >> /Properties << /L1 5 0 R /L2 6 0 R /L3 7 0 R >> >> >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 10 0 R '
        b'/Resources << /Font << /F1 8 0 R >> /Properties << /L1 5 0 R >> >> >>',
        # 5-7 OCGs
        b'<< /Type /OCG /Name (Shapes) >>',
        b'<< /Type /OCG /Name (Reviewer notes) >>',
        b'<< /Type /OCG /Name (Draft watermark) >>',
        # 8 font
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        # 9, 10 contents
        stream(page1),
        stream(page2),
    ]
    write_raw_pdf(os.path.join(OUT, 'layers.pdf'), objects)


def attachments_doc():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle('Attachments fixture')
    for i in range(2):
        c.setFont('Helvetica', 18)
        c.drawString(72, 700, f'Attachments fixture page {i + 1}')
        c.showPage()
    c.save()
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    writer.add_attachment('data.csv', b'name,amount\nalpha,1\nbeta,2\n')
    # Description and modification date on the embedded file.
    names = writer._root_object['/Names']['/EmbeddedFiles']['/Names']
    spec = names[1].get_object()
    spec[NameObject('/Desc')] = TextStringObject('Quarterly figures')
    ef = spec['/EF']['/F'].get_object()
    params = DictionaryObject()
    params[NameObject('/Size')] = NumberObject(29)
    params[NameObject('/ModDate')] = TextStringObject("D:20240305101500+00'00'")
    ef[NameObject('/Params')] = params
    ef[NameObject('/Subtype')] = NameObject('/text/csv')
    # A FileAttachment annotation on page 2.
    file_stream = DecodedStreamObject()
    file_stream.set_data(b'Remember to check the totals.\n')
    file_stream[NameObject('/Type')] = NameObject('/EmbeddedFile')
    file_ref = writer._add_object(file_stream)
    fs = DictionaryObject()
    fs[NameObject('/Type')] = NameObject('/Filespec')
    fs[NameObject('/F')] = TextStringObject('notes.txt')
    fs[NameObject('/UF')] = TextStringObject('notes.txt')
    ef_dict = DictionaryObject()
    ef_dict[NameObject('/F')] = file_ref
    fs[NameObject('/EF')] = ef_dict
    annot = DictionaryObject()
    annot[NameObject('/Type')] = NameObject('/Annot')
    annot[NameObject('/Subtype')] = NameObject('/FileAttachment')
    annot[NameObject('/Rect')] = ArrayObject([FloatObject(72), FloatObject(600), FloatObject(92), FloatObject(624)])
    annot[NameObject('/FS')] = writer._add_object(fs)
    annot[NameObject('/Contents')] = TextStringObject('notes.txt')
    annot[NameObject('/Name')] = NameObject('/PushPin')
    page = writer.pages[1]
    page[NameObject('/Annots')] = ArrayObject([writer._add_object(annot)])
    with open(os.path.join(OUT, 'attachments.pdf'), 'wb') as f:
        writer.write(f)


def initial_view_doc():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle('Initial view fixture')
    sections = [('Part One', ['Introduction', 'Background']), ('Part Two', ['Methods', 'Results']), ('Appendix', [])]
    n = 0
    for part, subs in sections:
        c.setFont('Helvetica-Bold', 24)
        c.drawString(72, 700, part)
        key = f'p{n}'
        c.bookmarkPage(key)
        c.addOutlineEntry(part, key, level=0, closed=False)
        c.setFont('Helvetica', 12)
        c.drawString(72, 660, f'Page {n + 1}')
        c.showPage()
        n += 1
        for sub in subs:
            c.setFont('Helvetica-Bold', 18)
            c.drawString(72, 700, sub)
            key = f'p{n}'
            c.bookmarkPage(key)
            c.addOutlineEntry(sub, key, level=1)
            c.setFont('Helvetica', 12)
            c.drawString(72, 660, f'Page {n + 1}')
            c.showPage()
            n += 1
    c.save()
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    root = writer._root_object
    root[NameObject('/PageMode')] = NameObject('/UseOutlines')
    root[NameObject('/PageLayout')] = NameObject('/TwoColumnLeft')
    third = writer.pages[2].indirect_reference
    root[NameObject('/OpenAction')] = ArrayObject([third, NameObject('/XYZ'), NullObject(), NullObject(), FloatObject(1.5)])
    with open(os.path.join(OUT, 'initial-view.pdf'), 'wb') as f:
        writer.write(f)


def fonts_doc():
    pdfmetrics.registerFont(TTFont('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
    c = canvas.Canvas(os.path.join(OUT, 'fonts.pdf'), pagesize=letter)
    c.setTitle('Fonts fixture')
    c.setFont('DejaVuSans', 16)
    c.drawString(72, 700, 'Embedded subset TrueType font: DejaVu Sans')
    c.setFont('Helvetica', 12)
    c.drawString(72, 670, 'Standard font that is not embedded: Helvetica')
    c.beginForm('stamp')
    c.setFont('Times-Roman', 14)
    c.drawString(72, 600, 'Text drawn inside a form XObject (Times Roman)')
    c.endForm()
    c.doForm('stamp')
    c.showPage()
    c.setFont('Courier', 12)
    c.drawString(72, 700, 'Second page uses Courier')
    c.showPage()
    c.save()


if __name__ == '__main__':
    layers_doc()
    attachments_doc()
    initial_view_doc()
    fonts_doc()
    print('navigation fixtures written to', OUT)
