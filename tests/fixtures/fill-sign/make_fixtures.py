"""Generates the Fill & Sign test fixtures.

Run: python3 tests/fixtures/fill-sign/make_fixtures.py

signature.png        a transparent scribble (a cleaned-up signature)
signature-photo.jpg  a "photo" of a signature on grey paper (image import)
half.png             left half solid, right half transparent (upright placement checks)
agreement.pdf        a printed (non-interactive) form with blanks and boxes to fill in, plus one
                     unsigned interactive signature field
"""
import io
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

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


def agreement_pdf():
    """A flat volunteer agreement: blanks and boxes drawn on the page, and a signature field."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle("Volunteer agreement")
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 720, "Volunteer agreement")
    c.setFont("Helvetica", 11)
    c.drawString(72, 690, "Please fill in this form, sign it and hand it in at the front desk.")
    c.setLineWidth(0.8)
    c.drawString(72, 640, "Full name:")
    c.line(140, 637, 400, 637)
    c.drawString(72, 610, "Date:")
    c.line(140, 607, 260, 607)
    c.drawString(72, 570, "Available on:")
    for i, day in enumerate(["Monday", "Wednesday", "Saturday"]):
        x = 160 + i * 110
        c.rect(x, 567, 11, 11)
        c.drawString(x + 18, 569, day)
    c.drawString(72, 520, "I have read and agree to the volunteer rules.")
    c.rect(340, 517, 11, 11)
    c.drawString(72, 430, "Signature:")
    c.drawString(72, 360, "Initials:")
    c.line(140, 357, 220, 357)
    c.showPage()
    c.save()

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    page = writer.pages[0]
    sig = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Widget"),
        NameObject("/FT"): NameObject("/Sig"),
        NameObject("/T"): TextStringObject("Signature"),
        NameObject("/TU"): TextStringObject("Sign here"),
        NameObject("/F"): NumberObject(4),
        NameObject("/Rect"): ArrayObject([FloatObject(140), FloatObject(410), FloatObject(380), FloatObject(460)]),
        NameObject("/MK"): DictionaryObject({NameObject("/BC"): ArrayObject([FloatObject(0.5), FloatObject(0.5), FloatObject(0.5)])}),
        NameObject("/P"): page.indirect_reference,
    })
    ref = writer._add_object(sig)
    page[NameObject("/Annots")] = ArrayObject([ref])
    writer._root_object[NameObject("/AcroForm")] = DictionaryObject({NameObject("/Fields"): ArrayObject([ref])})
    with open(HERE / "agreement.pdf", "wb") as f:
        writer.write(f)


if __name__ == "__main__":
    signature_png()
    signature_photo()
    half_png()
    agreement_pdf()
