"""Signed fixtures whose later incremental updates must not pass as harmless.

Each file is a one-page document signed with the "signing only" test key of
tests/fixtures/passwordless/pki/winstore/ (a test key, never used for anything real), followed by
an incremental update made after signing:

update-hidden-prev.pdf   approval signature; the update that replaces the page's form XObject
                         has no startxref/%%EOF of its own, and a later update links to it
                         through /Prev only.
update-xref-filters.pdf  approval signature; the update replaces the form XObject and lists it
                         in a cross-reference stream encoded with [/ASCIIHexDecode /FlateDecode].
update-xobject.pdf       approval signature; a plain update replaces the form XObject the page
                         draws (the page's content stream itself is unchanged).
update-perms-removed.pdf certification (no changes allowed); the update rewrites the catalog
                         without /Perms and changes the value of the text field.
update-lock-removed.pdf  approval signature whose field locks all fields (/Lock, no FieldMDP
                         reference); the update removes the /Lock and changes the text field.

Run from the repository root:  python3 tests/fixtures/digital-signatures/make_update_fixtures.py
Needs the cryptography package.
"""
import zlib
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs7

HERE = Path(__file__).resolve().parent
PKI = HERE.parent / "passwordless" / "pki" / "winstore"
CERT = x509.load_pem_x509_certificate((PKI / "me-sign.pem").read_bytes())
KEY = serialization.load_pem_private_key((PKI / "me-sign.key").read_bytes(), password=None)

CONTENTS_BYTES = 6000
BYTE_RANGE_PLACEHOLDER = b"[0 0000000000 0000000000 0000000000]"


class Pdf:
    """Writes objects and cross-reference sections, remembering offsets."""

    def __init__(self, data: bytes = b"") -> None:
        self.buf = bytearray(data)
        self.offsets: dict[int, int] = {}

    def obj(self, num: int, body: bytes, stream: bytes | None = None) -> None:
        self.offsets[num] = len(self.buf)
        if stream is None:
            self.buf += b"%d 0 obj\n%s\nendobj\n" % (num, body)
        else:
            self.buf += b"%d 0 obj\n<< %s /Length %d >>\nstream\n%s\nendstream\nendobj\n" % (num, body, len(stream), stream)

    def xref(self, trailer: bytes, with_free_head: bool = False, startxref: bool = True) -> int:
        pos = len(self.buf)
        nums = sorted(self.offsets)
        self.buf += b"xref\n"
        if with_free_head:
            nums = [0] + nums
        runs: list[list[int]] = []
        for n in nums:
            if runs and runs[-1][-1] == n - 1:
                runs[-1].append(n)
            else:
                runs.append([n])
        for run in runs:
            self.buf += b"%d %d\n" % (run[0], len(run))
            for n in run:
                if n == 0:
                    self.buf += b"0000000000 65535 f \n"
                else:
                    self.buf += b"%010d 00000 n \n" % self.offsets[n]
        self.buf += b"trailer\n<<%s>>\n" % trailer
        if startxref:
            self.buf += b"startxref\n%d\n%%%%EOF\n" % pos
        self.offsets = {}
        return pos


def form_xobject(text: bytes) -> tuple[bytes, bytes]:
    content = b"BT /F1 20 Tf 72 640 Td (" + text + b") Tj ET"
    return b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 8 0 R >> >>", content


def signed_base(certify: int | None = None, lock: bool = False) -> tuple[bytes, int]:
    """The signed document (one revision). Returns its bytes and the offset of its xref table."""
    pdf = Pdf(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    perms = b" /Perms << /DocMDP 6 0 R >>" if certify else b""
    pdf.obj(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) >>%s >>" % perms)
    pdf.obj(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    pdf.obj(
        3,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X1 7 0 R >> /Font << /F1 8 0 R >> >>"
        b" /Contents 4 0 R /Annots [5 0 R 9 0 R] >>",
    )
    pdf.obj(4, b"", b"BT /F1 24 Tf 72 700 Td (Invoice) Tj ET /X1 Do")
    lock_entry = b" /Lock << /Type /SigFieldLock /Action /All >>" if lock else b""
    pdf.obj(5, b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 6 0 R%s >>" % lock_entry)
    reference = (
        b" /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P %d /V /1.2 >> >>]" % certify
        if certify
        else b""
    )
    pdf.obj(
        6,
        b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Store Test Me) /M (D:20260101120000Z)%s"
        b" /ByteRange %s /Contents <%s> >>" % (reference, BYTE_RANGE_PLACEHOLDER, b"0" * (2 * CONTENTS_BYTES)),
    )
    xo_dict, xo_stream = form_xobject(b"Amount due: 100 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    pdf.obj(8, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    pdf.obj(9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (100) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>")
    xref_pos = pdf.xref(b" /Size 10 /Root 1 0 R ", with_free_head=True)
    data = bytes(pdf.buf)

    # Byte range around the /Contents value, then the detached CMS signature over it.
    start = data.index(b"/Contents <") + len(b"/Contents ")
    end = data.index(b">", start) + 1
    br = b"[0 %d %d %d]" % (start, end, len(data) - end)
    br = br[:-1].ljust(len(BYTE_RANGE_PLACEHOLDER) - 1) + b"]"
    data = data.replace(BYTE_RANGE_PLACEHOLDER, br, 1)
    signed = data[:start] + data[end:]
    cms = (
        pkcs7.PKCS7SignatureBuilder()
        .set_data(signed)
        .add_signer(CERT, KEY, hashes.SHA256())
        .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.DetachedSignature, pkcs7.PKCS7Options.Binary, pkcs7.PKCS7Options.NoCapabilities])
    )
    assert len(cms) <= CONTENTS_BYTES
    hexed = cms.hex().upper().encode().ljust(2 * CONTENTS_BYTES, b"0")
    data = data[: start + 1] + hexed + data[end - 1 :]
    return data, xref_pos


def write(name: str, data: bytes) -> None:
    (HERE / name).write_bytes(data)
    print("wrote", HERE / name)


def hidden_prev() -> None:
    base, base_xref = signed_base()
    pdf = Pdf(base)
    xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    hidden = pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref, startxref=False)
    pdf.obj(10, b"<< /Title (Invoice) >>")
    pdf.xref(b" /Size 11 /Root 1 0 R /Info 10 0 R /Prev %d " % hidden)
    write("update-hidden-prev.pdf", bytes(pdf.buf))


def xref_filters() -> None:
    base, base_xref = signed_base()
    pdf = Pdf(base)
    xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    xref_pos = len(pdf.buf)
    rows = b"".join(bytes([1]) + off.to_bytes(4, "big") + bytes([0]) for off in (pdf.offsets[7], xref_pos))
    encoded = zlib.compress(rows).hex().upper().encode() + b">"
    pdf.obj(
        10,
        b"/Type /XRef /Size 11 /Root 1 0 R /Prev %d /W [1 4 1] /Index [7 1 10 1] /Filter [/ASCIIHexDecode /FlateDecode]" % base_xref,
        encoded,
    )
    pdf.buf += b"startxref\n%d\n%%%%EOF\n" % xref_pos
    write("update-xref-filters.pdf", bytes(pdf.buf))


def xobject() -> None:
    base, base_xref = signed_base()
    pdf = Pdf(base)
    xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-xobject.pdf", bytes(pdf.buf))


def perms_removed() -> None:
    base, base_xref = signed_base(certify=1)
    pdf = Pdf(base)
    pdf.obj(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) >> >>")
    pdf.obj(9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (999) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>")
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-perms-removed.pdf", bytes(pdf.buf))


def lock_removed() -> None:
    base, base_xref = signed_base(lock=True)
    pdf = Pdf(base)
    pdf.obj(5, b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 6 0 R >>")
    pdf.obj(9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (999) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>")
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-lock-removed.pdf", bytes(pdf.buf))


def plain() -> None:
    base, _ = signed_base()
    write("update-base.pdf", base)


if __name__ == "__main__":
    plain()
    hidden_prev()
    xref_filters()
    xobject()
    perms_removed()
    lock_removed()
