"""Generates the fixtures for the edit-images-links feature (requires reportlab, Pillow and pypdf).

Run: python3 tests/fixtures/edit-images-links/make_fixture.py   (outputs are committed next to this file)

images.pdf
  page 1: heading, body text with web addresses and an e-mail address, two images
          (a PNG "chart" on the left, a JPEG "photo" on the right) and a caption.
  page 2: text, an inline image (BI/ID/EI), an existing web link and a link back to page 1.
  page 3: a page rotated by 90 degrees holding an image that is cropped by a clipping path.
replacement.png  a 120x60 px image used to test "Replace Image".
stamp.jpg        a 64x64 px JPEG used to test "Add Image".
"""
import io
import os

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def chart_png():
    im = Image.new('RGB', (300, 180), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 299, 179], outline=(40, 40, 40), width=3)
    for x, top, col in [(30, 120, (231, 76, 60)), (90, 60, (46, 204, 113)), (150, 100, (52, 152, 219)), (210, 30, (241, 196, 15))]:
        d.rectangle([x, top, x + 40, 165], fill=col)
    return png_bytes(im)


def photo_jpg():
    im = Image.new('RGB', (200, 200))
    px = im.load()
    for y in range(200):
        for x in range(200):
            px[x, y] = (int(255 * x / 199), int(255 * y / 199), 160)
    d = ImageDraw.Draw(im)
    d.ellipse([50, 50, 150, 150], fill=(250, 250, 250), outline=(20, 20, 20), width=4)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=90)
    return buf.getvalue()


def small_png():
    im = Image.new('RGB', (40, 24), (155, 89, 182))
    ImageDraw.Draw(im).rectangle([8, 6, 31, 17], fill=(255, 255, 255))
    return png_bytes(im)


def logo_png():
    im = Image.new('RGBA', (90, 60), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([5, 5, 85, 55], fill=(52, 152, 219, 200))
    d.rectangle([35, 20, 55, 40], fill=(255, 255, 255, 255))
    return png_bytes(im)


def replacement_png():
    im = Image.new('RGB', (120, 60), (39, 174, 96))
    d = ImageDraw.Draw(im)
    d.rectangle([10, 10, 109, 49], fill=(255, 255, 255))
    d.rectangle([20, 20, 99, 39], fill=(39, 174, 96))
    return png_bytes(im)


def stamp_jpg():
    im = Image.new('RGB', (64, 64), (230, 126, 34))
    ImageDraw.Draw(im).ellipse([12, 12, 52, 52], fill=(44, 62, 80))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=92)
    return buf.getvalue()


def images_pdf():
    path = os.path.join(HERE, 'images.pdf')
    c = canvas.Canvas(path, pagesize=letter)
    c.setTitle('Images and links fixture')
    c.setAuthor('Fartcrobat Tests')

    # ---- page 1: two images and text
    c.setFont('Helvetica-Bold', 22)
    c.drawString(72, 720, 'Quarterly report')
    c.bookmarkPage('p1')
    c.setFont('Helvetica', 12)
    c.drawString(72, 690, 'Read the documentation at https://example.com/docs before you start.')
    c.drawString(72, 672, 'Questions? Write to support@example.org or visit www.fartcrobat.org today.')
    c.drawImage(ImageReader(io.BytesIO(chart_png())), 72, 450, width=200, height=120)
    c.drawImage(ImageReader(io.BytesIO(photo_jpg())), 340, 430, width=160, height=160)
    c.setFont('Times-Italic', 11)
    c.drawString(72, 430, 'Figure 1. Sales by region.')
    c.setFont('Helvetica', 11)
    c.drawString(72, 380, 'The text below the figures must survive every image edit unchanged.')
    c.setFillColor(colors.HexColor('#1473E6'))
    c.rect(72, 300, 120, 40, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.showPage()

    # ---- page 2: inline image and existing links
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 720, 'Second page')
    c.bookmarkPage('p2')
    c.setFont('Helvetica', 12)
    c.drawString(72, 690, 'An inline image follows.')
    c.drawInlineImage(Image.open(io.BytesIO(small_png())), 72, 600, width=80, height=48)
    # a semi-transparent logo (image XObject with an /SMask)
    c.drawImage(ImageReader(io.BytesIO(logo_png())), 300, 590, width=90, height=60, mask='auto')
    c.drawString(72, 560, 'Existing web link: https://existing.example.net')
    c.linkURL('https://existing.example.net', (72, 555, 340, 572), relative=0, thickness=1, color=colors.blue)
    c.drawString(72, 530, 'Back to the first page')
    c.linkAbsolute('Back', 'p1', (72, 525, 220, 542))
    c.showPage()

    # ---- page 3: (rotated) page with a clipped image
    c.setFont('Helvetica', 12)
    c.drawString(72, 720, 'Rotated page with a cropped image')
    c.saveState()
    p = c.beginPath()
    p.rect(100, 400, 150, 100)
    c.clipPath(p, stroke=0, fill=0)
    c.drawImage(ImageReader(io.BytesIO(photo_jpg())), 80, 380, width=200, height=140)
    c.restoreState()
    c.showPage()

    # ---- page 4: an image sharing a clipped group with text, and a reusable form XObject
    c.beginForm('logo', 0, 0, 100, 100)
    c.drawImage(ImageReader(io.BytesIO(stamp_jpg())), 10, 10, width=80, height=80)
    c.endForm()
    c.setFont('Helvetica', 12)
    c.drawString(72, 720, 'Page with a shared clipping group and a form XObject')
    c.saveState()
    p = c.beginPath()
    p.rect(60, 400, 300, 200)
    c.clipPath(p, stroke=0, fill=0)
    c.drawImage(ImageReader(io.BytesIO(chart_png())), 80, 420, width=150, height=90)
    c.drawString(80, 560, 'Text inside the same clipped group')
    c.restoreState()
    c.saveState()
    c.translate(400, 100)
    c.doForm('logo')
    c.restoreState()
    c.showPage()

    # ---- page 5: the same form XObject again (shared between pages)
    c.setFont('Helvetica', 12)
    c.drawString(72, 720, 'The logo form is shared with page 4')
    c.saveState()
    c.translate(400, 100)
    c.doForm('logo')
    c.restoreState()
    c.showPage()
    c.save()

    # reportlab cannot rotate a single page; do it with pypdf
    r = PdfReader(path)
    w = PdfWriter(clone_from=r)
    w.pages[2].rotate(90)
    with open(path, 'wb') as f:
        w.write(f)


def main():
    images_pdf()
    with open(os.path.join(HERE, 'replacement.png'), 'wb') as f:
        f.write(replacement_png())
    with open(os.path.join(HERE, 'stamp.jpg'), 'wb') as f:
        f.write(stamp_jpg())


if __name__ == '__main__':
    main()
