"""Generates the PDF fixtures used by unit and end-to-end tests (requires reportlab + Pillow).

Run: python3 scripts/make_fixtures.py   (outputs are committed in tests/fixtures/)
"""
import io
import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures')
os.makedirs(OUT, exist_ok=True)

LOREM = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt "
         "ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation.")


def text_doc():
    c = canvas.Canvas(os.path.join(OUT, 'text.pdf'), pagesize=letter)
    c.setTitle('Fixture Text Document')
    c.setAuthor('Fartcrobat Tests')
    c.setSubject('Plain text pages')
    for i in range(5):
        c.setFont('Helvetica-Bold', 24)
        c.drawString(72, 700, f'Chapter {i + 1}')
        c.bookmarkPage(f'ch{i + 1}')
        c.addOutlineEntry(f'Chapter {i + 1}', f'ch{i + 1}', level=0)
        c.setFont('Helvetica', 12)
        c.drawString(72, 660, f'Hello Fartcrobat page {i + 1}. The quick brown fox jumps over the lazy dog.')
        c.setFont('Times-Roman', 11)
        y = 630
        for line in range(6):
            c.drawString(72, y, LOREM[:95])
            y -= 16
        c.setFont('Courier', 10)
        c.drawString(72, 500, f'Invoice #{1000 + i}   Total: $1,234.5{i}   Email: billing{i}@example.com')
        c.drawString(72, 485, f'Phone: (555) 010-00{i}{i}   SSN: 123-45-678{i}')
        c.setFillColor(colors.HexColor('#1473E6'))
        c.rect(72, 380, 200, 80, fill=1, stroke=0)
        c.setFillColor(colors.black)
        if i == 0:
            c.linkURL('https://example.com', (72, 340, 250, 360), relative=0)
            c.drawString(72, 345, 'Visit https://example.com')
            c.linkAbsolute('Go to chapter 3', 'ch3', (300, 340, 450, 360))
            c.drawString(300, 345, 'Jump to chapter 3')
        c.setFont('Helvetica', 9)
        c.drawCentredString(306, 30, f'Page {i + 1} of 5')
        c.showPage()
    c.save()


def form_doc():
    c = canvas.Canvas(os.path.join(OUT, 'form.pdf'), pagesize=letter)
    c.setTitle('Fixture Form')
    form = c.acroForm
    c.setFont('Helvetica-Bold', 16)
    c.drawString(72, 720, 'Application Form')
    c.setFont('Helvetica', 11)
    c.drawString(72, 680, 'Full name:')
    form.textfield(name='fullName', tooltip='Full name', x=160, y=672, width=300, height=20, borderStyle='inset')
    c.drawString(72, 645, 'Email:')
    form.textfield(name='email', tooltip='Email', x=160, y=637, width=300, height=20)
    c.drawString(72, 610, 'Quantity:')
    form.textfield(name='qty', x=160, y=602, width=80, height=20, value='2')
    c.drawString(250, 610, 'Price:')
    form.textfield(name='price', x=300, y=602, width=80, height=20, value='10')
    c.drawString(72, 575, 'Subscribe:')
    form.checkbox(name='subscribe', x=160, y=570, size=16, checked=False)
    c.drawString(72, 540, 'Plan:')
    form.radio(name='plan', value='basic', selected=True, x=160, y=535, size=16)
    c.drawString(180, 540, 'Basic')
    form.radio(name='plan', value='pro', selected=False, x=240, y=535, size=16)
    c.drawString(260, 540, 'Pro')
    c.drawString(72, 505, 'Country:')
    form.choice(name='country', value='Canada', options=['Australia', 'Canada', 'Germany', 'Japan', 'United States'],
                x=160, y=497, width=200, height=20)
    c.drawString(72, 470, 'Notes:')
    form.textfield(name='notes', x=160, y=400, width=300, height=80, fieldFlags='multiline')
    c.drawString(72, 360, 'Signature: ____________________________     Date: ______________')
    c.showPage()
    c.save()


def encrypted_doc():
    from reportlab.lib import pdfencrypt
    enc = pdfencrypt.StandardEncryption('secret', ownerPassword='owner', canPrint=1, canModify=0, canCopy=0,
                                         canAnnotate=1, strength=128)
    c = canvas.Canvas(os.path.join(OUT, 'encrypted.pdf'), pagesize=letter, encrypt=enc)
    c.setFont('Helvetica', 14)
    c.drawString(72, 700, 'This document is protected with the password "secret".')
    c.showPage()
    c.save()


def scanned_doc():
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('L', (1275, 1650), 255)  # 150 dpi letter
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 40)
    except Exception:
        font = ImageFont.load_default()
    lines = ['Scanned Document', 'This page is an image without a text layer.',
             'Optical character recognition makes it', 'searchable and selectable.']
    y = 150
    for line in lines:
        d.text((150, y), line, fill=0, font=font)
        y += 80
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    c = canvas.Canvas(os.path.join(OUT, 'scanned.pdf'), pagesize=letter)
    c.drawImage(ImageReader(buf), 0, 0, width=612, height=792)
    c.showPage()
    c.save()
    img.save(os.path.join(OUT, 'scan.png'))


def a4_landscape_doc():
    c = canvas.Canvas(os.path.join(OUT, 'mixed-sizes.pdf'), pagesize=A4)
    c.setFont('Helvetica', 14)
    c.drawString(72, 760, 'A4 portrait page')
    c.showPage()
    c.setPageSize((842, 595))
    c.drawString(72, 520, 'A4 landscape page')
    c.showPage()
    c.setPageSize(letter)
    c.drawString(72, 700, 'Letter page with rotate 90')
    c.setPageRotation(90)
    c.showPage()
    c.save()


def two_versions():
    for name, total in (('compare-a.pdf', '$1,234.56'), ('compare-b.pdf', '$9,876.54')):
        c = canvas.Canvas(os.path.join(OUT, name), pagesize=letter)
        c.setFont('Helvetica', 12)
        c.drawString(72, 700, 'Quarterly report')
        c.drawString(72, 680, f'Total revenue: {total}')
        c.drawString(72, 660, 'Prepared by the finance team.' if name == 'compare-a.pdf' else 'Prepared by the audit team.')
        c.showPage()
        c.save()


if __name__ == '__main__':
    text_doc()
    form_doc()
    encrypted_doc()
    scanned_doc()
    a4_landscape_doc()
    two_versions()
    print('fixtures written to', os.path.abspath(OUT))
