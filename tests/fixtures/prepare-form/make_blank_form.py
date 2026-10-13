"""Generates blank-form.pdf: a printed form without interactive fields, used to test
"Detect form fields automatically" (Prepare a form).

Run: python3 tests/fixtures/prepare-form/make_blank_form.py
"""
import os

from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(TTFont('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))

OUT = os.path.join(os.path.dirname(__file__), 'blank-form.pdf')


def main():
    c = canvas.Canvas(OUT, pagesize=letter)
    c.setTitle('Membership Application')
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 730, 'Membership Application')
    c.setLineWidth(1)
    c.line(72, 722, 540, 722)  # decorative rule under the heading (no label: not a field)

    c.setFont('Helvetica', 11)
    # labels followed by underscores
    c.drawString(72, 690, 'Full name: ______________________________')
    c.drawString(72, 665, 'Email: ____________________   Phone: ______________')
    c.drawString(72, 640, 'Date of birth: ____________')

    # labels followed by drawn lines
    c.drawString(72, 610, 'Street address:')
    c.line(160, 608, 400, 608)
    c.drawString(72, 585, 'City:')
    c.line(105, 583, 260, 583)
    c.drawString(280, 585, 'Postcode:')
    c.line(335, 583, 420, 583)

    # check boxes: drawn squares with labels on the right
    c.drawString(72, 550, 'Membership type:')
    for i, label in enumerate(['Student', 'Individual', 'Family']):
        x = 180 + i * 110
        c.rect(x, 548, 10, 10, stroke=1, fill=0)
        c.drawString(x + 16, 549, label)

    # a ballot box character (as produced by word processors)
    c.setFont('DejaVuSans', 11)
    c.drawString(72, 520, '\u2610 I agree to the club rules')
    c.setFont('Helvetica', 11)

    # bracket check box
    c.drawString(72, 495, '[   ] Send me the newsletter')

    # a box for comments with a label above
    c.drawString(72, 465, 'Comments')
    c.rect(72, 395, 400, 64, stroke=1, fill=0)

    # signature and date lines with labels underneath
    c.line(72, 330, 272, 330)
    c.setFont('Helvetica', 9)
    c.drawString(72, 318, 'Signature')
    c.line(320, 330, 450, 330)
    c.drawString(320, 318, 'Date')

    c.setFont('Helvetica', 8)
    c.drawString(72, 60, 'Please return this form to the club secretary.')
    c.showPage()
    c.save()


if __name__ == '__main__':
    main()
