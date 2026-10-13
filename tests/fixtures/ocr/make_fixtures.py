"""Fixtures for the OCR feature. Run: python3 tests/fixtures/ocr/make_fixtures.py

scanned-pages.pdf (Letter, 4 pages):
  1. a scan (image only)                 "Quarterly Report" ...
  2. a scan on a page with /Rotate 90    "Rotated Page" ... (shown upright)
  3. a page with real text (Helvetica)   "This page already has real text."
  4. a scan of a slightly skewed sheet   "Skewed Scan" ...

Word positions in the images are written to scanned-pages.json (page points, page space: origin
at the top-left of the page as displayed) so tests can check where recognized text lands.
"""
import io
import json
import os

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
DPI = 150
W, H = int(8.5 * DPI), int(11 * DPI)  # 1275 x 1650
PT = 72 / DPI


def text_image(lines, words_out):
    """A white 150 dpi Letter image with the lines of text; records word boxes (page points)."""
    img = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 40)
    y = 150
    for line in lines:
        x = 150
        for i, word in enumerate(line.split(' ')):
            box = d.textbbox((x, y), word, font=font)
            d.text((x, y), word, fill=0, font=font)
            words_out.append({'text': word, 'rect': [box[0] * PT, box[1] * PT, box[2] * PT, box[3] * PT]})
            x = box[2] + d.textlength(' ', font=font)
        y += 80
    return img


def png(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return ImageReader(buf)


def main():
    words = {}
    path = os.path.join(OUT, 'scanned-pages.pdf')
    c = canvas.Canvas(path, pagesize=letter)

    # 1. plain scan
    w1 = []
    img1 = text_image(['Quarterly Report', 'Revenue grew in every region.', 'Prepared by the finance team.'], w1)
    words[0] = w1
    c.drawImage(png(img1), 0, 0, width=612, height=792)
    c.showPage()

    # 2. /Rotate 90: the content is the upright image turned a quarter turn counterclockwise on a
    #    landscape page; the viewer turns it back clockwise.
    w2 = []
    img2 = text_image(['Rotated Page', 'Scanners often store pages sideways.', 'The viewer turns them upright.'], w2)
    words[1] = w2
    c.setPageSize((792, 612))
    c.drawImage(png(img2.rotate(90, expand=True)), 0, 0, width=792, height=612)
    c.showPage()

    # 3. real text
    c.setPageSize(letter)
    c.setFont('Helvetica', 20)
    c.drawString(72, 700, 'This page already has real text.')
    c.drawString(72, 670, 'It does not need text recognition.')
    c.showPage()

    # 4. skewed scan (rotated 2 degrees counterclockwise about the centre)
    w4 = []
    img4 = text_image(['Skewed Scan', 'Paper is rarely fed perfectly straight.'], w4)
    words[3] = w4
    c.drawImage(png(img4.rotate(2, resample=Image.BICUBIC, fillcolor=255)), 0, 0, width=612, height=792)
    c.showPage()
    c.save()

    # Mark page 2 as rotated (reportlab cannot set /Rotate on a page directly).
    from pypdf import PdfReader, PdfWriter
    r = PdfReader(path)
    wr = PdfWriter()
    for i, p in enumerate(r.pages):
        if i == 1:
            p.rotate(90)
        wr.add_page(p)
    with open(path, 'wb') as f:
        wr.write(f)

    with open(os.path.join(OUT, 'scanned-pages.json'), 'w') as f:
        json.dump({'note': 'unskewed word rectangles, page points (page 4 is skewed by 2 degrees)', 'words': words}, f, indent=1)


if __name__ == '__main__':
    main()
