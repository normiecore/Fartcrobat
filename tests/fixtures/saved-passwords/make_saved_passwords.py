"""Fixtures for the saved-passwords tests (tests/e2e/saved-passwords.spec.ts).

encrypted-changed.pdf: tests/fixtures/encrypted.pdf protected again with the password "changed"
(AES-256). It keeps the trailer /ID[0] of encrypted.pdf, as the same file protected again does,
so a password saved for encrypted.pdf is found through /ID and no longer opens it.

    python3 tests/fixtures/saved-passwords/make_saved_passwords.py
"""
from pathlib import Path

from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).resolve().parent
src = HERE.parent / "encrypted.pdf"
reader = PdfReader(src)
assert reader.decrypt("secret")
writer = PdfWriter(clone_from=reader)
writer.encrypt(user_password="changed", owner_password="changed-owner", algorithm="AES-256")
target = HERE / "encrypted-changed.pdf"
with target.open("wb") as f:
    writer.write(f)
kept = bytes(PdfReader(target).trailer["/ID"][0]) == bytes(reader.trailer["/ID"][0])
assert kept, "the /ID[0] of encrypted.pdf was not kept"
print("wrote", target.name, "(ID[0] kept)")
