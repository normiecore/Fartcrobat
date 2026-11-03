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
update-annots-xobject.pdf approval signature; the update replaces the form XObject and also lists
                         it in the page's /Annots next to a new comment.
update-popup-p3.pdf      certification allowing comments; the update replaces the form XObject and
                         makes it the /Popup of a new comment.
update-fields-p2.pdf     certification allowing form filling; the update replaces the form XObject
                         and lists it in the form's /Fields.
update-dss-p1.pdf        certification without changes, with an /OpenAction; the update changes
                         the action and also lists it in a new /DSS.
update-xref-mismatch.pdf the signed revision holds an unlisted copy of the form XObject saying
                         999 EUR; the update lists a new object at the offset of another object of
                         the signed revision and uses it as an appearance of a new comment.
update-signed-mismatch.pdf the same copy, and the signed revision's own cross-reference table
                         lists an unused object at the offset of another object; the update uses
                         it as an appearance of a new comment.
update-encrypt-dropped.pdf approval signature with a field lock in a password-protected file
                         (password "secret"); the update drops the encryption, removes the lock and
                         changes the text field.
update-needappearances-p1.pdf certification without changes; the update sets /NeedAppearances.
update-da-p2.pdf         certification allowing form filling; the update changes the form's /DA.
update-objstm.pdf        approval signature in a file that keeps its objects in an object stream;
                         the update writes the object stream again without the form XObject in
                         the page resources (no new cross-reference entry for the page).
update-objstm-p1-field.pdf the same file certified without changes; the update writes the object
                         stream again with a new value for the text field.
update-lock-reparent.pdf approval signature whose field locks all fields; the update moves the
                         signature value to a new parent field without a lock and changes the
                         text field.
update-lock-copy.pdf     the same signed file; the update lists a copy of the signature widget
                         without the lock on the page instead of the signed one, and changes the
                         text field.
update-dr-locked-ap.pdf  approval signature whose field locks all fields, the text field with an
                         appearance stream; the update lists that appearance in the form's /DR and
                         changes it.
update-sig-widget-p2.pdf certification allowing form filling; the update moves the certifying
                         signature's own widget over the page with a new appearance.
update-field-moved-p2.pdf certification allowing form filling; the update moves the text field
                         over the page text with a new appearance.
update-comment-removed-p2.pdf certification allowing form filling, with a comment on the page; the
                         update removes the comment and changes the text field.

Run from the repository root:  python3 tests/fixtures/digital-signatures/make_update_fixtures.py
Needs the cryptography package.
"""
import hashlib
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


PAD = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")
FILE_ID = bytes.fromhex("0123456789ABCDEF0123456789ABCDEF")


def rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for c in data:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        out.append(c ^ s[(s[i] + s[j]) % 256])
    return bytes(out)


def standard_encrypt(password: bytes) -> bytes:
    """Trailer entries of a 40-bit RC4 standard security handler (revision 2) for `password`.

    Only the password check matters for these fixtures: the strings stay as they are.
    """
    owner = rc4(hashlib.md5(PAD).digest()[:5], (password + PAD)[:32])
    key = hashlib.md5((password + PAD)[:32] + owner + (-4).to_bytes(4, "little", signed=True) + FILE_ID).digest()[:5]
    user = rc4(key, PAD)
    return b" /Encrypt << /Filter /Standard /V 1 /R 2 /O <%s> /U <%s> /P -4 >> /ID [<%s> <%s>]" % (
        owner.hex().encode(),
        user.hex().encode(),
        FILE_ID.hex().encode(),
        FILE_ID.hex().encode(),
    )


def signed_base(
    certify: int | None = None,
    lock: bool = False,
    open_action: bool = False,
    planted: bool = False,
    mislisted: bool = False,
    password: bytes | None = None,
    comment: bool = False,
    amount_ap: bool = False,
) -> tuple[bytes, int]:
    """The signed document (one revision). Returns its bytes and the offset of its xref table.

    open_action adds an /OpenAction (object 10). planted writes an unlisted copy of the form
    XObject (object 7) saying 999 EUR before the cross-reference table; mislisted also lists an
    unused object 11 at the offset of object 8. password protects the file. comment adds a
    FreeText comment (object 12) to the page; amount_ap gives the text field an appearance stream
    (object 13).
    """
    pdf = Pdf(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    perms = b" /Perms << /DocMDP 6 0 R >>" if certify else b""
    action = b" /OpenAction 10 0 R" if open_action else b""
    pdf.obj(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) >>%s%s >>" % (perms, action))
    pdf.obj(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    pdf.obj(
        3,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X1 7 0 R >> /Font << /F1 8 0 R >> >>"
        b" /Contents 4 0 R /Annots [5 0 R 9 0 R%s] >>" % (b" 12 0 R" if comment else b""),
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
    amount_appearance = b" /AP << /N 13 0 R >>" if amount_ap else b""
    pdf.obj(9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (100) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g)%s >>" % amount_appearance)
    if comment:
        pdf.obj(12, PAID_COMMENT)
    if amount_ap:
        pdf.obj(13, AMOUNT_AP, amount_appearance_stream(b"100"))
    size = max(pdf.offsets) + 1
    if open_action:
        pdf.obj(10, b"<< /S /URI /URI (https://example.com/invoice) >>")
        size = max(size, 11)
    if mislisted:
        pdf.offsets[11] = pdf.offsets[8]
        size = max(size, 12)
    if planted:
        listed = dict(pdf.offsets)
        xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
        pdf.obj(7, xo_dict, xo_stream)
        pdf.offsets = listed
    trailer = b" /Size %d /Root 1 0 R " % size
    if password is not None:
        trailer += standard_encrypt(password) + b" "
    xref_pos = pdf.xref(trailer, with_free_head=True)
    return sign(bytes(pdf.buf)), xref_pos


PAID_COMMENT = b"<< /Type /Annot /Subtype /FreeText /Rect [300 600 600 700] /Contents (PAID - do not pay) /DA (/Helv 24 Tf 1 0 0 rg) /P 3 0 R >>"
AMOUNT_AP = b"/Type /XObject /Subtype /Form /BBox [0 0 200 30] /Resources << /Font << /F1 8 0 R >> >>"


def amount_appearance_stream(text: bytes) -> bytes:
    return b"BT /F1 12 Tf 2 10 Td (" + text + b") Tj ET"


def sign(data: bytes) -> bytes:
    """Fills in the byte range and the detached CMS signature of the placeholder in `data`."""
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
    return data[: start + 1] + hexed + data[end - 1 :]


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


PAGE_WITH_NOTE = (
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X1 7 0 R >> /Font << /F1 8 0 R >> >>"
    b" /Contents 4 0 R /Annots [5 0 R 9 0 R 10 0 R%s] >>"
)


def annots_xobject() -> None:
    base, base_xref = signed_base()
    pdf = Pdf(base)
    pdf.obj(3, PAGE_WITH_NOTE % b" 7 0 R")
    xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    pdf.obj(10, b"<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (note) /P 3 0 R >>")
    pdf.xref(b" /Size 11 /Root 1 0 R /Prev %d " % base_xref)
    write("update-annots-xobject.pdf", bytes(pdf.buf))


def popup_p3() -> None:
    base, base_xref = signed_base(certify=3)
    pdf = Pdf(base)
    pdf.obj(3, PAGE_WITH_NOTE % b"")
    xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    pdf.obj(10, b"<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (note) /P 3 0 R /Popup 7 0 R >>")
    pdf.xref(b" /Size 11 /Root 1 0 R /Prev %d " % base_xref)
    write("update-popup-p3.pdf", bytes(pdf.buf))


def fields_p2() -> None:
    base, base_xref = signed_base(certify=2)
    pdf = Pdf(base)
    pdf.obj(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R 7 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) >> /Perms << /DocMDP 6 0 R >> >>")
    xo_dict, xo_stream = form_xobject(b"Amount due: 999 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-fields-p2.pdf", bytes(pdf.buf))


def dss_p1() -> None:
    base, base_xref = signed_base(certify=1, open_action=True)
    pdf = Pdf(base)
    pdf.obj(
        1,
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) >>"
        b" /Perms << /DocMDP 6 0 R >> /OpenAction 10 0 R /DSS << /Certs [10 0 R] >> >>",
    )
    pdf.obj(10, b"<< /S /URI /URI (https://example.net/pay-here) >>")
    pdf.xref(b" /Size 11 /Root 1 0 R /Prev %d " % base_xref)
    write("update-dss-p1.pdf", bytes(pdf.buf))


def square_with_appearance(pdf: Pdf, down: int) -> None:
    pdf.obj(3, PAGE_WITH_NOTE % b"")
    pdf.obj(10, b"<< /Type /Annot /Subtype /Square /Rect [10 10 30 30] /P 3 0 R /AP << /N 12 0 R /D %d 0 R >> >>" % down)
    pdf.obj(12, b"/Type /XObject /Subtype /Form /BBox [0 0 20 20]", b"0 0 1 rg 0 0 20 20 re f")


def xref_mismatch() -> None:
    base, base_xref = signed_base(planted=True)
    pdf = Pdf(base)
    square_with_appearance(pdf, 11)
    pdf.offsets[11] = base.index(b"8 0 obj")
    pdf.xref(b" /Size 13 /Root 1 0 R /Prev %d " % base_xref)
    write("update-xref-mismatch.pdf", bytes(pdf.buf))


def signed_mismatch() -> None:
    base, base_xref = signed_base(planted=True, mislisted=True)
    pdf = Pdf(base)
    square_with_appearance(pdf, 11)
    pdf.xref(b" /Size 13 /Root 1 0 R /Prev %d " % base_xref)
    write("update-signed-mismatch.pdf", bytes(pdf.buf))


def encrypt_dropped() -> None:
    base, base_xref = signed_base(lock=True, password=b"secret")
    pdf = Pdf(base)
    pdf.obj(5, b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 6 0 R >>")
    pdf.obj(9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (999) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>")
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-encrypt-dropped.pdf", bytes(pdf.buf))


def needappearances_p1() -> None:
    base, base_xref = signed_base(certify=1)
    pdf = Pdf(base)
    pdf.obj(
        1,
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) /NeedAppearances true >>"
        b" /Perms << /DocMDP 6 0 R >> >>",
    )
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-needappearances-p1.pdf", bytes(pdf.buf))


def da_p2() -> None:
    base, base_xref = signed_base(certify=2)
    pdf = Pdf(base)
    pdf.obj(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 40 Tf 1 0 0 rg) >> /Perms << /DocMDP 6 0 R >> >>")
    pdf.xref(b" /Size 10 /Root 1 0 R /Prev %d " % base_xref)
    write("update-da-p2.pdf", bytes(pdf.buf))


def obj_stream(objs: list[tuple[int, bytes]]) -> tuple[bytes, bytes]:
    """Dictionary entries and data of an object stream holding `objs` ([number, body])."""
    head = b""
    body = b""
    for n, b in objs:
        head += b"%d %d " % (n, len(body))
        body += b + b"\n"
    return b"/Type /ObjStm /N %d /First %d" % (len(objs), len(head) + 1), head + b"\n" + body


def xref_stream(buf: bytearray, num: int, entries: dict[int, tuple[int, int, int]], size: int, prev: int | None = None) -> int:
    """Appends cross-reference stream `num` listing `entries` (number -> type, field 2, field 3)."""
    pos = len(buf)
    entries = dict(entries)
    entries[num] = (1, pos, 0)
    nums = sorted(entries)
    index: list[list[int]] = []
    for n in nums:
        if index and index[-1][0] + index[-1][1] == n:
            index[-1][1] += 1
        else:
            index.append([n, 1])
    rows = b"".join(bytes([t]) + f2.to_bytes(4, "big") + f3.to_bytes(2, "big") for t, f2, f3 in (entries[n] for n in nums))
    data = zlib.compress(rows)
    d = b"/Type /XRef /Size %d /Root 1 0 R /W [1 4 2] /Index [%s] /Filter /FlateDecode" % (size, b" ".join(b"%d %d" % (a, b) for a, b in index))
    if prev is not None:
        d += b" /Prev %d" % prev
    buf += b"%d 0 obj\n<< %s /Length %d >>\nstream\n" % (num, d, len(data)) + data + b"\nendstream\nendobj\n"
    buf += b"startxref\n%d\n%%%%EOF\n" % pos
    return pos


def compressed_objects(certify: int | None, resources: bytes, amount: bytes = b"100") -> list[tuple[int, bytes]]:
    """The catalog, page tree, page, widgets, font and page resources (object 11), for an object stream."""
    perms = b" /Perms << /DocMDP 6 0 R >>" if certify else b""
    return [
        (1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 9 0 R] /SigFlags 3 /DA (/Helv 0 Tf 0 g) >>%s >>" % perms),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 11 0 R /Contents 4 0 R /Annots [5 0 R 9 0 R] >>"),
        (5, b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 6 0 R >>"),
        (8, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
        (9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (%s) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>" % amount),
        (11, resources),
    ]


WITH_XOBJECT = b"<< /XObject << /X1 7 0 R >> /Font << /F1 8 0 R >> >>"


def signed_objstm_base(certify: int | None = None) -> tuple[bytes, int]:
    """Like signed_base, with most objects in object stream 20 and a cross-reference stream."""
    pdf = Pdf(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    reference = (
        b" /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P %d /V /1.2 >> >>]" % certify
        if certify
        else b""
    )
    pdf.obj(4, b"", b"BT /F1 24 Tf 72 700 Td (Invoice) Tj ET /X1 Do")
    pdf.obj(
        6,
        b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Store Test Me) /M (D:20260101120000Z)%s"
        b" /ByteRange %s /Contents <%s> >>" % (reference, BYTE_RANGE_PLACEHOLDER, b"0" * (2 * CONTENTS_BYTES)),
    )
    xo_dict, xo_stream = form_xobject(b"Amount due: 100 EUR")
    pdf.obj(7, xo_dict, xo_stream)
    objs = compressed_objects(certify, WITH_XOBJECT)
    stm_dict, stm_data = obj_stream(objs)
    pdf.obj(20, stm_dict, stm_data)
    entries = {0: (0, 0, 65535)}
    for n, off in pdf.offsets.items():
        entries[n] = (1, off, 0)
    for i, (n, _) in enumerate(objs):
        entries[n] = (2, 20, i)
    pos = xref_stream(pdf.buf, 21, entries, 22)
    return sign(bytes(pdf.buf)), pos


def objstm_update(base: bytes, prev: int, objs: list[tuple[int, bytes]]) -> bytes:
    """An update that only writes object stream 20 again (its objects keep their old entries)."""
    pdf = Pdf(base)
    stm_dict, stm_data = obj_stream(objs)
    pdf.obj(20, stm_dict, stm_data)
    xref_stream(pdf.buf, 22, {20: (1, pdf.offsets[20], 0)}, 23, prev=prev)
    return bytes(pdf.buf)


def objstm() -> None:
    base, prev = signed_objstm_base()
    write("update-objstm.pdf", objstm_update(base, prev, compressed_objects(None, b"<< /Font << /F1 8 0 R >> >>")))
    base, prev = signed_objstm_base(certify=1)
    write("update-objstm-p1-field.pdf", objstm_update(base, prev, compressed_objects(1, WITH_XOBJECT, b"999")))


CATALOG = b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [%s] /SigFlags 3 /DA (/Helv 0 Tf 0 g)%s >>%s >>"
PAGE = (
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X1 7 0 R >> /Font << /F1 8 0 R >> >>"
    b" /Contents 4 0 R /Annots [%s] >>"
)
AMOUNT_999 = b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (999) /Rect [72 500 272 530] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>"


def lock_moved() -> None:
    base, base_xref = signed_base(lock=True)
    pdf = Pdf(base)
    pdf.obj(1, CATALOG % (b"5 0 R 9 0 R 30 0 R", b"", b""))
    pdf.obj(5, b"<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [0 0 0 0] /F 132 /P 3 0 R >>")
    pdf.obj(30, b"<< /FT /Sig /T (Signature1) /V 6 0 R /Kids [5 0 R] >>")
    pdf.obj(9, AMOUNT_999)
    pdf.xref(b" /Size 31 /Root 1 0 R /Prev %d " % base_xref)
    write("update-lock-reparent.pdf", bytes(pdf.buf))
    pdf = Pdf(base)
    pdf.obj(1, CATALOG % (b"5 0 R 9 0 R 31 0 R", b"", b""))
    pdf.obj(3, PAGE % b"31 0 R 9 0 R")
    pdf.obj(31, b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 6 0 R >>")
    pdf.obj(9, AMOUNT_999)
    pdf.xref(b" /Size 32 /Root 1 0 R /Prev %d " % base_xref)
    write("update-lock-copy.pdf", bytes(pdf.buf))


def dr_locked_ap() -> None:
    base, base_xref = signed_base(lock=True, amount_ap=True)
    pdf = Pdf(base)
    pdf.obj(1, CATALOG % (b"5 0 R 9 0 R", b" /DR << /XObject << /Z 13 0 R >> >>", b""))
    pdf.obj(13, AMOUNT_AP, amount_appearance_stream(b"999"))
    pdf.xref(b" /Size 14 /Root 1 0 R /Prev %d " % base_xref)
    write("update-dr-locked-ap.pdf", bytes(pdf.buf))


OVERLAY = b"1 1 1 rg 0 0 330 40 re f BT /F1 20 Tf 0 0 0 rg 2 12 Td (Amount due: 999 EUR) Tj ET"
OVERLAY_DICT = b"/Type /XObject /Subtype /Form /BBox [0 0 330 40] /Resources << /Font << /F1 8 0 R >> >>"


def widgets_moved_p2() -> None:
    base, base_xref = signed_base(certify=2)
    pdf = Pdf(base)
    pdf.obj(5, b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [70 630 400 670] /F 4 /P 3 0 R /V 6 0 R /AP << /N 30 0 R >> >>")
    pdf.obj(30, OVERLAY_DICT, OVERLAY)
    pdf.xref(b" /Size 31 /Root 1 0 R /Prev %d " % base_xref)
    write("update-sig-widget-p2.pdf", bytes(pdf.buf))
    pdf = Pdf(base)
    pdf.obj(9, b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /V (100) /Rect [70 630 400 670] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) /AP << /N 30 0 R >> >>")
    pdf.obj(30, OVERLAY_DICT, OVERLAY)
    pdf.xref(b" /Size 31 /Root 1 0 R /Prev %d " % base_xref)
    write("update-field-moved-p2.pdf", bytes(pdf.buf))


def comment_removed_p2() -> None:
    base, base_xref = signed_base(certify=2, comment=True)
    pdf = Pdf(base)
    pdf.obj(3, PAGE % b"5 0 R 9 0 R")
    pdf.obj(9, AMOUNT_999)
    pdf.xref(b" /Size 13 /Root 1 0 R /Prev %d " % base_xref)
    write("update-comment-removed-p2.pdf", bytes(pdf.buf))


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
    annots_xobject()
    popup_p3()
    fields_p2()
    dss_p1()
    xref_mismatch()
    signed_mismatch()
    encrypt_dropped()
    needappearances_p1()
    da_p2()
    objstm()
    lock_moved()
    dr_locked_ap()
    widgets_moved_p2()
    comment_removed_p2()
