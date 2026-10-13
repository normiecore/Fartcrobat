"""Fixtures for the saved-passwords tests (port target: tests/fixtures/saved-passwords/make_saved_passwords.py).

encrypted-changed.pdf: tests/fixtures/encrypted.pdf protected again with the password "changed".
It keeps the trailer /ID[0] of encrypted.pdf (the same file, re-protected), so a password saved
for encrypted.pdf is found through /ID and no longer opens it.

    python3 make_saved_passwords.py <repo>/tests/fixtures/encrypted.pdf <out dir>
"""
import sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter

src, out = Path(sys.argv[1]), Path(sys.argv[2])
reader = PdfReader(src)
assert reader.decrypt("secret")
writer = PdfWriter(clone_from=reader)
writer.encrypt(user_password="changed", owner_password="changed-owner", algorithm="AES-256")
target = out / "encrypted-changed.pdf"
with target.open("wb") as f:
    writer.write(f)
print("wrote", target, "ID[0] kept:", bytes(PdfReader(target).trailer["/ID"][0]) == bytes(reader.trailer["/ID"][0]))
