"""Protected sources for the derived-protection tests (requires reportlab and pypdf with cryptography).

Run: python3 tests/fixtures/derived-protection/make_fixtures.py   (outputs are committed next to this file)

  aes256-open.pdf            4 pages with bookmarks. 256-bit AES, open password "open-256", permissions
                             password "perm-256"; no copying, changing or page assembly.
  aes256-restricted.pdf      3 pages. 256-bit AES, opens without a password, permissions password
                             "perm-256"; no printing, copying or changing.
  rc4-40.pdf                 2 pages. 40-bit RC4, open password "rc4-open", permissions password
                             "rc4-owner"; no copying or changing.
  contract-old-protected.pdf compare/contract-old.pdf with 128-bit AES, open password "old-open",
                             permissions password "old-owner", nothing restricted.
"""
import io
import os

from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions as P
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))


def pages_pdf(title, label, count):
    """`count` Letter pages with a heading each and one bookmark per page."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle(title)
    for i in range(1, count + 1):
        c.bookmarkPage(f'p{i}')
        c.addOutlineEntry(f'{label} {i}', f'p{i}', level=0)
        c.setFont('Helvetica-Bold', 20)
        c.drawString(72, 700, f'{label} {i}')
        c.setFont('Helvetica', 12)
        c.drawString(72, 670, f'Confidential text on page {i} of {count}.')
        c.showPage()
    c.save()
    return buf.getvalue()


def encrypt(src, name, user, owner, allowed, algorithm):
    reader = PdfReader(io.BytesIO(src) if isinstance(src, bytes) else src)
    writer = PdfWriter(clone_from=reader)
    writer.encrypt(user_password=user, owner_password=owner, permissions_flag=allowed, algorithm=algorithm)
    with open(os.path.join(OUT, name), 'wb') as f:
        writer.write(f)


def main():
    encrypt(pages_pdf('Protected sections', 'Section', 4), 'aes256-open.pdf', 'open-256', 'perm-256',
            P.PRINT | P.PRINT_TO_REPRESENTATION | P.ADD_OR_MODIFY | P.FILL_FORM_FIELDS | P.EXTRACT_TEXT_AND_GRAPHICS,
            'AES-256')
    encrypt(pages_pdf('Restricted pages', 'Restricted page', 3), 'aes256-restricted.pdf', '', 'perm-256',
            P.ADD_OR_MODIFY | P.FILL_FORM_FIELDS | P.EXTRACT_TEXT_AND_GRAPHICS | P.ASSEMBLE_DOC,
            'AES-256')
    encrypt(pages_pdf('Old cipher', 'Old cipher page', 2), 'rc4-40.pdf', 'rc4-open', 'rc4-owner',
            P.PRINT | P.ADD_OR_MODIFY, 'RC4-40')
    everything = (P.PRINT | P.MODIFY | P.EXTRACT | P.ADD_OR_MODIFY | P.FILL_FORM_FIELDS | P.EXTRACT_TEXT_AND_GRAPHICS
                  | P.ASSEMBLE_DOC | P.PRINT_TO_REPRESENTATION)
    encrypt(os.path.join(OUT, '..', 'compare', 'contract-old.pdf'), 'contract-old-protected.pdf', 'old-open',
            'old-owner', everything, 'AES-128')


if __name__ == '__main__':
    main()
