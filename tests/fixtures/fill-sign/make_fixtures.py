"""Generates the Fill & Sign test fixtures.

Run: python3 tests/fixtures/fill-sign/make_fixtures.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent


def signature_png():
    """A transparent PNG with a dark scribble, like a cleaned-up signature."""
    im = Image.new("RGBA", (420, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    points = [(14, 92), (60, 22), (98, 96), (150, 30), (206, 88), (270, 40), (330, 84), (404, 50)]
    d.line(points, fill=(10, 20, 60, 255), width=9, joint="curve")
    im.save(HERE / "signature.png")


def signature_photo():
    """A 'photo' of a signature: dark ink on slightly grey paper (for the image import)."""
    im = Image.new("RGB", (600, 220), (232, 230, 226))
    d = ImageDraw.Draw(im)
    points = [(40, 160), (120, 50), (180, 170), (260, 60), (330, 150), (420, 70), (560, 120)]
    d.line(points, fill=(25, 25, 35), width=10, joint="curve")
    im.save(HERE / "signature-photo.jpg", quality=90)


def half_png():
    """Left half solid, right half transparent: shows whether an image is placed upright."""
    im = Image.new("RGBA", (200, 50), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle([0, 0, 99, 49], fill=(0, 0, 0, 255))
    im.save(HERE / "half.png")


if __name__ == "__main__":
    signature_png()
    signature_photo()
    half_png()
