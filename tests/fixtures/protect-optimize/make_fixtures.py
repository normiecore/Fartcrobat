"""Generates the fixtures used by the protect-optimize tests (requires reportlab, Pillow and numpy).

Run: python3 tests/fixtures/protect-optimize/make_fixtures.py   (outputs are committed next to this file)

big-image.pdf    one page with text and a 3000 x 3000 photo-like JPEG placed at 2 x 2 inches (1500 ppi)
mixed-images.pdf two pages: an RGBA logo (soft mask), a grayscale picture, a 1-bit scan, a small low
                 resolution image, one photo drawn twice at different sizes, a bookmark and a comment
"""
import io
import os

import numpy as np
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))
INCH = 72


def photo(size, seed=1):
    """A smooth, photo-like RGB image (gradients, soft blobs and a little grain)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    r = 0.55 + 0.35 * np.sin(x * 5.0 + 1.3) * np.cos(y * 3.0)
    g = 0.45 + 0.35 * np.sin(y * 4.0 + 0.4) * np.cos(x * 2.0 + 0.7)
    b = 0.50 + 0.30 * np.cos((x + y) * 3.5)
    for _ in range(12):
        cx, cy, rad = rng.random(), rng.random(), 0.05 + rng.random() * 0.2
        blob = np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * rad * rad))
        col = rng.random(3) - 0.5
        r += blob * col[0]
        g += blob * col[1]
        b += blob * col[2]
    img = np.stack([r, g, b], axis=-1)
    img += rng.normal(0, 0.012, img.shape).astype(np.float32)
    img = np.clip(img * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(img, 'RGB')


def jpeg_reader(img, quality=92):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=quality)
    buf.seek(0)
    return ImageReader(buf)


def big_image_doc():
    c = canvas.Canvas(os.path.join(OUT, 'big-image.pdf'), pagesize=letter)
    c.setTitle('Big Image Fixture')
    c.setAuthor('Fartcrobat Tests')
    c.setFont('Helvetica-Bold', 22)
    c.drawString(72, 720, 'Quarterly Report 2026')
    c.setFont('Helvetica', 12)
    c.drawString(72, 696, 'The photo below is 3000 by 3000 pixels but only two inches wide.')
    c.drawString(72, 680, 'Compressing this file should downsample it without touching this text.')
    c.drawImage(jpeg_reader(photo(3000)), 72, 440, width=2 * INCH, height=2 * INCH)
    c.setFont('Helvetica', 9)
    c.drawString(72, 420, 'Figure 1. A very large photo.')
    c.showPage()
    c.save()


def mixed_images_doc():
    c = canvas.Canvas(os.path.join(OUT, 'mixed-images.pdf'), pagesize=letter)
    c.setTitle('Mixed Images Fixture')
    c.setAuthor('Fartcrobat Tests')
    c.bookmarkPage('p1')
    c.addOutlineEntry('Images', 'p1', level=0)
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 730, 'Mixed images')

    # RGBA logo with transparency: 1200 x 1200 drawn at 1.5 in (800 ppi) -> soft mask
    size = 1200
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    alpha = (np.hypot(xx - 0.5, yy - 0.5) < 0.45).astype(np.float32)
    rgba = np.zeros((size, size, 4), np.uint8)
    rgba[..., 0] = (20 + 200 * xx).astype(np.uint8)
    rgba[..., 1] = (115 * (1 - yy)).astype(np.uint8)
    rgba[..., 2] = 230
    rgba[..., 3] = (alpha * 255).astype(np.uint8)
    c.drawImage(ImageReader(Image.fromarray(rgba, 'RGBA')), 72, 520, width=1.5 * INCH, height=1.5 * INCH, mask='auto')

    # grayscale picture: 1600 x 1200 drawn at 2 x 1.5 in (800 ppi)
    gray = photo(1600, seed=5).convert('L').resize((1600, 1200))
    c.drawImage(jpeg_reader(gray), 220, 520, width=2 * INCH, height=1.5 * INCH)

    # small low resolution image: 100 x 100 at 2 in (50 ppi) -> must be left alone
    c.drawImage(jpeg_reader(photo(100, seed=9)), 400, 520, width=2 * INCH, height=2 * INCH)

    # 1-bit "scan": 2400 x 1200 drawn at 4 x 2 in (600 ppi)
    scan = np.full((1200, 2400), 255, np.uint8)
    for row in range(60, 1150, 70):
        scan[row:row + 24, 100:2300] = 0
    c.drawImage(ImageReader(Image.fromarray(scan, 'L').convert('1')), 72, 300, width=4 * INCH, height=2 * INCH)

    c.setFont('Helvetica', 11)
    c.drawString(72, 280, 'Shared photo appears twice: small here and large on page 2.')
    c.showPage()

    # page 2: the same JPEG drawn twice (reportlab reuses one XObject), largest at 4 in
    shared = photo(2000, seed=3)
    buf = io.BytesIO()
    shared.save(buf, 'JPEG', quality=90)
    path = os.path.join(OUT, '_shared.jpg')
    with open(path, 'wb') as f:
        f.write(buf.getvalue())
    c.drawImage(path, 72, 400, width=4 * INCH, height=4 * INCH)
    c.drawImage(path, 400, 600, width=1 * INCH, height=1 * INCH)
    c.setFont('Helvetica', 11)
    c.drawString(72, 380, 'Page two text stays searchable.')
    c.showPage()
    c.save()
    os.remove(path)


if __name__ == '__main__':
    big_image_doc()
    mixed_images_doc()
