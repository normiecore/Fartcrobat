"""Generates the fixtures used by the export-create tests (requires reportlab, Pillow, python-docx).

Run: python3 tests/fixtures/export-create/make_fixtures.py   (outputs are committed next to this file)
"""
import io
import os

from PIL import Image, ImageDraw
from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

OUT = os.path.dirname(os.path.abspath(__file__))

TABLE_HEADER = ['Region', 'Units', 'Revenue', 'Growth']
TABLE_ROWS = [
    ['North', '1,250', '$12,500.00', '5.5%'],
    ['South', '980', '$9,800.50', '-2.1%'],
    ['East', '2,100', '$21,000.75', '12%'],
    ['West', '1,575', '$15,750.25', '(3.4%)'],
]

PLAIN_HEADER = ['Product', 'Code', 'Price', 'Stock']
PLAIN_ROWS = [
    ['Stapler', 'A-100', '7.99', '120'],
    ['Paper clips', 'A-200', '1.25', '3,400'],
    ['Notebook', 'B-310', '4.50', '815'],
    ['Desk lamp', 'C-020', '29.00', '42'],
]


def draw_table(c, x, top, widths, rows, row_h=22, ruled=True, header_bold=True):
    """Draws a table with its top-left corner at (x, top) in PDF user space."""
    total_w = sum(widths)
    if ruled:
        c.setStrokeColor(colors.black)
        c.setLineWidth(0.75)
        for r in range(len(rows) + 1):
            y = top - r * row_h
            c.line(x, y, x + total_w, y)
        cx = x
        for w in widths + [0]:
            c.line(cx, top, cx, top - len(rows) * row_h)
            cx += w
    for r, row in enumerate(rows):
        cx = x
        y = top - r * row_h - 15
        for i, cell in enumerate(row):
            c.setFont('Helvetica-Bold' if (r == 0 and header_bold) else 'Helvetica', 11)
            if i == 0:
                c.drawString(cx + 6, y, cell)
            else:
                c.drawRightString(cx + widths[i] - 6, y, cell)
            cx += widths[i]


def table_doc():
    c = canvas.Canvas(os.path.join(OUT, 'table.pdf'), pagesize=letter)
    c.setTitle('Sales Tables')
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 720, 'Quarterly Sales')
    c.setFont('Helvetica', 11)
    c.drawString(72, 696, 'Figures for the third quarter, by region.')
    draw_table(c, 72, 670, [140, 90, 120, 90], [TABLE_HEADER] + TABLE_ROWS)
    c.setFont('Helvetica', 10)
    c.drawString(72, 540, 'Source: internal sales system.')
    c.showPage()
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, 720, 'Office Supplies')
    draw_table(c, 72, 690, [150, 80, 90, 90], [PLAIN_HEADER] + PLAIN_ROWS, ruled=False)
    c.showPage()
    c.save()


def chart_png():
    img = Image.new('RGB', (400, 200), (255, 255, 255))
    d = ImageDraw.Draw(img)
    bars = [(30, 120, (20, 115, 230)), (110, 60, (38, 142, 108)), (190, 150, (218, 123, 17)), (270, 90, (215, 55, 63))]
    for x, h, col in bars:
        d.rectangle([x, 190 - h, x + 60, 190], fill=col)
    d.line([20, 190, 380, 190], fill=(0, 0, 0), width=2)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return buf


def rich_doc():
    c = canvas.Canvas(os.path.join(OUT, 'rich.pdf'), pagesize=letter)
    c.setTitle('Annual Report')
    # Title: large, bold, centred
    c.setFont('Helvetica-Bold', 26)
    c.drawCentredString(306, 724, 'Annual Report 2025')
    # Heading
    c.setFont('Helvetica-Bold', 16)
    c.drawString(72, 680, 'Introduction')
    # Justified paragraph (platypus)
    body = ParagraphStyle('body', fontName='Times-Roman', fontSize=11, leading=14, alignment=TA_JUSTIFY)
    text = ('This report summarises the results of the past year. Revenue grew in every region, '
            'and the company opened two new offices. The board would like to thank every employee '
            'for their hard work, and our customers for their continued trust in our products and services.')
    p = Paragraph(text, body)
    _, h = p.wrap(468, 200)
    p.drawOn(c, 72, 664 - h)
    y = 664 - h - 22
    # Hyphenated paragraph drawn line by line
    c.setFont('Times-Roman', 11)
    c.drawString(72, y, 'Our sustainability programme reduced energy use by a remarkable amount; the full docu-')
    c.drawString(72, y - 14, 'ment is available on request from the head office.')
    y -= 40
    # Bulleted list
    c.setFont('Helvetica-Bold', 13)
    c.drawString(72, y, 'Highlights')
    y -= 20
    c.setFont('Helvetica', 11)
    for item in ['Record revenue in the third quarter', 'Two new offices opened', 'Customer satisfaction at 94%']:
        c.drawString(84, y, '•')
        c.drawString(100, y, item)
        y -= 16
    y -= 8
    # Numbered list
    for i, item in enumerate(['Review the budget', 'Approve the hiring plan', 'Publish the results'], start=1):
        c.drawString(84, y, f'{i}.')
        c.drawString(100, y, item)
        y -= 16
    y -= 8
    # Coloured italic text and right-aligned line
    c.setFillColor(colors.HexColor('#C0392B'))
    c.setFont('Helvetica-Oblique', 12)
    c.drawString(72, y, 'Important: figures are unaudited.')
    c.setFillColor(colors.black)
    y -= 22
    c.setFont('Helvetica', 10)
    c.drawRightString(540, y, 'Prepared by the finance team')
    y -= 20
    # Image
    c.drawImage(ImageReader(chart_png()), 72, y - 120, width=240, height=120)
    c.setFont('Helvetica', 9)
    c.drawString(72, y - 134, 'Figure 1: revenue by region')
    c.showPage()
    # Page 2: a table and a closing paragraph
    c.setFont('Helvetica-Bold', 16)
    c.drawString(72, 720, 'Regional Results')
    draw_table(c, 72, 700, [140, 90, 120, 90], [TABLE_HEADER] + TABLE_ROWS)
    c.setFont('Times-Roman', 11)
    c.drawString(72, 560, 'Thank you for reading.')
    c.showPage()
    c.save()


def complex_doc():
    """Two columns, a vector chart with labels, a shaded table, underlined and linked text."""
    c = canvas.Canvas(os.path.join(OUT, 'complex.pdf'), pagesize=letter)
    c.setTitle('Complex Layout')
    c.setFont('Helvetica-Bold', 20)
    c.drawString(72, 730, 'Field Report')
    body = ParagraphStyle('col', fontName='Times-Roman', fontSize=10, leading=13, alignment=TA_JUSTIFY)
    left = ('The left column describes the survey. ' * 9).strip()
    right = ('The right column lists the results of the survey in detail. ' * 7).strip()
    for x, text in ((72, left), (318, right)):
        p = Paragraph(text, body)
        _, h = p.wrap(222, 400)
        p.drawOn(c, x, 710 - h)
    # Vector bar chart with grid lines, axis and labels
    ox, oy, w, h = 100, 380, 300, 150
    c.setStrokeColor(colors.HexColor('#BBBBBB'))
    c.setLineWidth(0.5)
    for i in range(1, 5):
        c.line(ox, oy + i * h / 4, ox + w, oy + i * h / 4)
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(ox, oy, ox + w, oy)
    c.line(ox, oy, ox, oy + h)
    for i, (label, val, col) in enumerate([('Q1', 60, '#1473E6'), ('Q2', 110, '#268E6C'), ('Q3', 90, '#DA7B11'), ('Q4', 140, '#D7373F')]):
        c.setFillColor(colors.HexColor(col))
        c.rect(ox + 20 + i * 70, oy, 40, val, stroke=0, fill=1)
        c.setFillColor(colors.black)
        c.setFont('Helvetica', 9)
        c.drawCentredString(ox + 40 + i * 70, oy - 12, label)
    c.setStrokeColor(colors.HexColor('#7B4FD6'))
    c.setLineWidth(2)
    pth = c.beginPath()
    pth.moveTo(ox + 40, oy + 50)
    pth.curveTo(ox + 110, oy + 120, ox + 180, oy + 60, ox + 250, oy + 130)
    c.drawPath(pth, stroke=1, fill=0)
    c.setFont('Helvetica-Bold', 10)
    c.drawString(ox, oy + h + 8, 'Sales by quarter')
    # Shaded-header table
    top = 330
    widths = [160, 100, 100]
    rows = [['Item', 'Count', 'Share'], ['Apples', '120', '40%'], ['Pears', '90', '30%'], ['Plums', '90', '30%']]
    c.setFillColor(colors.HexColor('#DDE7F7'))
    c.rect(72, top - 20, sum(widths), 20, stroke=0, fill=1)
    c.setFillColor(colors.black)
    draw_table(c, 72, top, widths, rows, row_h=20)
    # Underlined text and a link
    c.setFont('Helvetica', 11)
    c.drawString(72, 210, 'Read the full terms at')
    c.setFillColor(colors.HexColor('#1473E6'))
    c.drawString(190, 210, 'example.org/terms')
    c.linkURL('https://example.org/terms', (190, 205, 290, 220), relative=0)
    c.setStrokeColor(colors.HexColor('#1473E6'))
    c.setLineWidth(0.6)
    c.line(190, 208, 190 + c.stringWidth('example.org/terms', 'Helvetica', 11), 208)
    c.setFillColor(colors.black)
    c.drawString(72, 190, 'This sentence is')
    c.drawString(160, 190, 'important')
    c.setStrokeColor(colors.black)
    c.line(160, 188, 160 + c.stringWidth('important', 'Helvetica', 11), 188)
    c.drawString(212, 190, 'for everyone.')
    c.showPage()
    c.save()


def sample_docx():
    from docx import Document
    d = Document()
    d.add_heading('Converted Word Document', level=1)
    d.add_paragraph('This file was written by python-docx and converted to PDF with LibreOffice.')
    d.add_paragraph('Second paragraph with some more text to check the conversion keeps everything.')
    t = d.add_table(rows=3, cols=2)
    for r, (a, b) in enumerate([('Name', 'Value'), ('Alpha', '1'), ('Beta', '2')]):
        t.cell(r, 0).text = a
        t.cell(r, 1).text = b
    d.save(os.path.join(OUT, 'sample.docx'))


def sample_html():
    png = chart_png().getvalue()
    import base64
    data = base64.b64encode(png).decode()
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Sample HTML page</title>
<style>body {{ font-family: sans-serif; }} h1 {{ color: #1473e6; }} table {{ border-collapse: collapse; }}
td, th {{ border: 1px solid #888; padding: 4px 8px; }} .banner {{ background: #ffe9a8; padding: 8px; }}</style>
<link rel="stylesheet" href="https://example.com/remote.css">
</head><body>
<h1>Sample HTML Page</h1>
<p class="banner">This page is converted to PDF without any network access.</p>
<p>It has a table and an embedded image.</p>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr></table>
<p><img src="data:image/png;base64,{data}" width="300" alt="chart"></p>
<img src="https://example.com/remote.png" alt="remote image (blocked)">
<script src="https://example.com/remote.js"></script>
</body></html>
"""
    with open(os.path.join(OUT, 'sample.html'), 'w') as f:
        f.write(html)


if __name__ == '__main__':
    table_doc()
    rich_doc()
    complex_doc()
    sample_docx()
    sample_html()
