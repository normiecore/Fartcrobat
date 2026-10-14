"""Third-party resave check: does pypdf keep /ID[0] and the lock when it rewrites an encrypted file?"""
import sys
from pypdf import PdfReader, PdfWriter
src, out_same, out_keep = sys.argv[1], sys.argv[2], sys.argv[3]
r = PdfReader(src)
r.decrypt("u1")
print("source /ID[0]", bytes(r.trailer["/ID"][0]).hex())
# 1. rewrite with the same user password (pypdf re-encrypts: AES-256)
w = PdfWriter(clone_from=r)
w.encrypt(user_password="u1", owner_password="o1", algorithm="AES-256")
w.write(out_same)
# 2. pypdf incremental append (keeps the original encryption)
w2 = PdfWriter(src, incremental=True) if False else None
