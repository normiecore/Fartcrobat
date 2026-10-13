"""Generates the multi-page fixtures for the Compare Files feature (requires reportlab and Pillow).

    python3 tests/fixtures/compare/make_fixtures.py [contract] [long]   (outputs are committed next to this file)

contract-old.pdf (5 pages): Introduction, Terms, Appendix A, Appendix B, Obsolete notes
contract-new.pdf (5 pages): Introduction (edited), Terms, Schedule C (added), Appendix B,
                            Appendix A (moved to the end); Obsolete notes removed.

Changes on page 1: "Beta" -> "Gamma" (replaced), "of the invoice date" (inserted),
"Late payments incur a fee of 2%." (deleted), "total fee" in bold (formatting), the logo
image changes colour (image) and the blue bar becomes green (graphics).

long-old.pdf (150 pages) and long-new.pdf (150 pages), for the long-document test (progress,
cancel, page ranges): every page is "Section i" with 30 paragraphs. In the new one paragraph 3
of every 10th section says "version 2" instead of "version 1", section 40 is gone and a page
"Additional terms" follows section 100. Written with invariant=1 so the bytes are reproducible.
"""
import io
import os
import sys

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))

LOREM = (
    'Each party shall keep the other party informed of any change that may affect the services. '
    'Notices must be given in writing and delivered by hand, by post or by email to the address '
    'stated in this agreement. A notice is received when it is delivered.'
)


def logo(color):
    img = Image.new('RGB', (120, 120), 'white')
    d = ImageDraw.Draw(img)
    d.ellipse((10, 10, 110, 110), fill=color)
    d.rectangle((45, 30, 75, 90), fill='white')
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    buf.seek(0)
    return ImageReader(buf)


def wrap(c, text, x, y, width=460, font='Helvetica', size=11, leading=15):
    words = text.split()
    line = ''
    for w in words:
        trial = (line + ' ' + w).strip()
        if c.stringWidth(trial, font, size) > width:
            c.setFont(font, size)
            c.drawString(x, y, line)
            y -= leading
            line = w
        else:
            line = trial
    if line:
        c.setFont(font, size)
        c.drawString(x, y, line)
        y -= leading
    return y


def heading(c, text):
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 720, text)


def intro(c, new):
    heading(c, 'Service Agreement')
    c.drawImage(logo('#1f6feb' if new else '#d1242f'), 470, 690, width=60, height=60)
    c.setFillColor('#2da44e' if new else '#0969da')
    c.rect(72, 670, 200, 8, stroke=0, fill=1)
    c.setFillColor('black')
    y = 640
    party = 'Gamma LLC' if new else 'Beta LLC'
    c.setFont('Helvetica', 11)
    c.drawString(72, y, f'This agreement is made between Alpha Corp and {party}.')
    y -= 15
    # "total fee" is bold in the new version (formatting change)
    c.setFont('Helvetica', 11)
    c.drawString(72, y, 'The')
    x = 72 + c.stringWidth('The ', 'Helvetica', 11)
    c.setFont('Helvetica-Bold' if new else 'Helvetica', 11)
    c.drawString(x, y, 'total fee')
    x += c.stringWidth('total fee ', 'Helvetica-Bold' if new else 'Helvetica', 11)
    c.setFont('Helvetica', 11)
    c.drawString(x, y, 'is $1,000 per month.')
    y -= 15
    if new:
        c.drawString(72, y, 'Payment is due within 30 days of the invoice date.')
        y -= 15
    else:
        c.drawString(72, y, 'Payment is due within 30 days.')
        y -= 15
        c.drawString(72, y, 'Late payments incur a fee of 2%.')
        y -= 15
    y -= 10
    wrap(c, LOREM, 72, y)


def body_page(c, title, text, repeat):
    heading(c, title)
    y = 680
    for k in range(repeat):
        y = wrap(c, f'{k + 1}. {text}', 72, y) - 8


PAGES = {
    'terms': ('Terms', 'The supplier provides the services described in Schedule A with reasonable care and skill.', 6),
    'appA': ('Appendix A: Contacts', 'Questions about invoices go to the accounts team at the head office in Leeds.', 4),
    'appB': ('Appendix B: Service levels', 'Support requests are answered within one working day of being received.', 5),
    'obsolete': ('Obsolete notes', 'These notes describe the old ordering process, which no longer applies.', 3),
    'schedC': ('Schedule C: Pricing', 'Prices are reviewed every year in January and change by no more than five percent.', 4),
}


def make(name, new):
    c = canvas.Canvas(os.path.join(OUT, name), pagesize=letter)
    c.setTitle(name)
    order = ['intro', 'terms', 'schedC', 'appB', 'appA'] if new else ['intro', 'terms', 'appA', 'appB', 'obsolete']
    for key in order:
        if key == 'intro':
            intro(c, new)
        else:
            body_page(c, *PAGES[key])
        c.showPage()
    c.save()


def make_long(name, new):
    c = canvas.Canvas(os.path.join(OUT, name), pagesize=letter, invariant=1)
    for i in range(1, 151):
        if new and i == 40:
            continue
        c.setFont('Helvetica-Bold', 16)
        c.drawString(72, 720, f'Section {i}')
        c.setFont('Helvetica', 11)
        for k in range(30):
            v = 2 if (new and i % 10 == 0 and k == 3) else 1
            c.drawString(72, 690 - k * 18, f'Paragraph {k} of section {i} describes clause {i * 31 + k} in version {v}.')
        c.showPage()
        if new and i == 100:
            c.setFont('Helvetica-Bold', 16)
            c.drawString(72, 720, 'Additional terms')
            c.setFont('Helvetica', 11)
            c.drawString(72, 690, 'These terms were added in the new edition of the contract.')
            c.showPage()
    c.save()


if __name__ == '__main__':
    which = set(sys.argv[1:]) or {'contract', 'long'}
    if 'contract' in which:
        make('contract-old.pdf', False)
        make('contract-new.pdf', True)
    if 'long' in which:
        make_long('long-old.pdf', False)
        make_long('long-new.pdf', True)
    print('written to', OUT)
