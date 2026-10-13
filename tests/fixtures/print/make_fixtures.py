"""Generates fixtures for the print feature tests (requires pypdf).

Run: python3 tests/fixtures/print/make_fixtures.py
"""
import os

from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions as P

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, '..', 'text.pdf')


def no_print():
    """text.pdf with an empty open password and an owner password that forbids printing."""
    writer = PdfWriter(clone_from=PdfReader(SOURCE))
    allowed = P.MODIFY | P.EXTRACT | P.ADD_OR_MODIFY | P.FILL_FORM_FIELDS | P.EXTRACT_TEXT_AND_GRAPHICS | P.ASSEMBLE_DOC
    writer.encrypt(user_password='', owner_password='owner-secret', permissions_flag=allowed, algorithm='AES-128')
    with open(os.path.join(HERE, 'no-print.pdf'), 'wb') as f:
        writer.write(f)


if __name__ == '__main__':
    no_print()
