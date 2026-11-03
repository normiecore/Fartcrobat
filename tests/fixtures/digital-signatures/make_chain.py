"""Certificate chains for the chain-building tests (tests/engine/digital-signatures-chain.test.ts).

TEST KEYS ONLY - never use for anything real. Keys are EC P-256 derived from fixed labels, so
anyone can recompute them; every certificate carries OU=TEST KEYS ONLY. ECDSA signatures are
randomised, so running this again gives different (equally valid) files. Only the DER
certificates (chain/<name>.cer), the RFC 3161 tokens (chain/<name>.tst) and a few signed PDFs
are written; tests never run this script. Files that already exist are kept (the keys are fixed,
so new certificates still chain to them); pass --force to write every file again.

Run from anywhere:  python3 -I tests/fixtures/digital-signatures/make_chain.py [--force]
Needs the cryptography package and the openssl command (for the timestamp tokens).

Valid 2025-01-01 to 2045-01-01 unless noted:
  root            CA, keyCertSign, no path length limit (self-signed)
  inter           CA issued by root
  leaf            end entity issued by inter                       -> proper chain
  ee-issuer       end entity (CA:FALSE) issued by root
  leaf-of-ee      end entity issued by ee-issuer                   -> issuer is not a CA
  root-pl0        CA with pathLenConstraint 0 (self-signed)
  inter-pl0       CA issued by root-pl0
  leaf-pl0        end entity issued by inter-pl0                   -> path length exceeded
  leaf-direct-pl0 end entity issued by root-pl0                    -> within the path length
  inter-expired   CA issued by root, valid 2020-01-01 to 2021-01-01
  leaf-expired    end entity issued by inter-expired               -> expired intermediate
  inter-nokcs     CA issued by root whose key usage lacks keyCertSign
  leaf-nokcs      end entity issued by inter-nokcs                 -> issuer may not sign certificates
  self-leaf       self-signed end entity (CA:FALSE)
  leaf-of-self    end entity issued by self-leaf                   -> trusted leaf as issuer
  ee-noku         end entity (CA:FALSE) issued by root, no keyUsage extension
  leaf-of-ee-noku end entity issued by ee-noku                     -> issuer is not a CA (only basicConstraints says so)
  nobc            issued by root with keyCertSign but no basicConstraints extension
  leaf-of-nobc    end entity issued by nobc                        -> issuer is not a CA (no basicConstraints)

Time-stamping authorities (a separate root, so trusting it does not trust the signers above):
  tsa-root        CA (self-signed)
  tsa             issued by tsa-root, critical EKU timeStamping    -> a proper authority
  tsa-wrong-eku   issued by tsa-root, EKU emailProtection          -> not a time-stamping certificate
  tsa-expired     issued by tsa-root, EKU timeStamping, valid 2020-01-01 to 2021-01-01

Timestamp tokens over the bytes of chain/ts-data.bin (time: when this script ran):
  ts-good.tst       made by `openssl ts -reply`, signed by tsa (tsa and tsa-root embedded)
  ts-wrong-eku.tst  the same TSTInfo signed by tsa-wrong-eku with `openssl cms`
  ts-expired.tst    the same TSTInfo signed by tsa-expired with `openssl cms`

signed-timestamp.pdf (one directory up): one page, signature field "Signature1" signed by leaf
(adbe.pkcs7.detached, inter and root embedded) with an embedded timestamp from tsa over the
signature value (an unsigned timeStampToken attribute).

Document timestamps (one directory up): one page, field "Timestamp1", /Type /DocTimeStamp,
/SubFilter /ETSI.RFC3161, the token over the byte range of the file:
  doctimestamp-good.pdf      made by `openssl ts -reply`, signed by tsa
  doctimestamp-wrong-eku.pdf the same kind of TSTInfo signed by tsa-wrong-eku (tsa-root embedded)
  doctimestamp-leaf.pdf      the same kind of TSTInfo signed by leaf (inter and root embedded)

Malformed document timestamps (one directory up, the same one-page layout):
  doctimestamp-pkcs7.pdf        /Type /DocTimeStamp but /SubFilter /adbe.pkcs7.detached, a CMS
                                signature by leaf (inter and root embedded), /M (D:20250601000000Z)
  doctimestamp-pkcs7-token.pdf  the same with an embedded timestamp from tsa over the signature value
  sig-rfc3161.pdf               field "Signature1", /Type /Sig with /SubFilter /ETSI.RFC3161, a
                                token over the byte range signed by tsa
"""
import datetime
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

HERE = Path(__file__).resolve().parent
OUT = HERE / "chain"
FORCE = "--force" in sys.argv
START = datetime.datetime(2025, 1, 1, tzinfo=datetime.timezone.utc)
END = datetime.datetime(2045, 1, 1, tzinfo=datetime.timezone.utc)
CURVE_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def key_for(label: str) -> ec.EllipticCurvePrivateKey:
    digest = hashlib.sha256(f"fartcrobat chain test {label}".encode()).digest()
    return ec.derive_private_key(int.from_bytes(digest, "big") % (CURVE_ORDER - 1) + 1, ec.SECP256R1())


def name(cn: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Fartcrobat Chain Test"),
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "TEST KEYS ONLY - never use for anything real"),
            x509.NameAttribute(NameOID.COMMON_NAME, cn),
        ]
    )


CERTS: dict[str, tuple[x509.Certificate, ec.EllipticCurvePrivateKey]] = {}


def make(label, issuer=None, ca=False, path_len=None, cert_sign=None, start=START, end=END, basic=True, key_usage=True, eku=None):
    key = key_for(label)
    path = OUT / f"{label}.cer"
    if path.exists() and not FORCE:
        CERTS[label] = (x509.load_der_x509_certificate(path.read_bytes()), key)
        return
    issuer_cert, issuer_key = CERTS[issuer] if issuer else (None, key)
    pub = key.public_key()
    if cert_sign is None:
        cert_sign = ca
    builder = (
        x509.CertificateBuilder()
        .subject_name(name(label))
        .issuer_name(issuer_cert.subject if issuer_cert else name(label))
        .public_key(pub)
        .serial_number(int.from_bytes(hashlib.sha256(label.encode()).digest()[:8], "big"))
        .not_valid_before(start)
        .not_valid_after(end)
    )
    if basic:
        builder = builder.add_extension(x509.BasicConstraints(ca=ca, path_length=path_len), critical=True)
    if key_usage:
        builder = builder.add_extension(
            x509.KeyUsage(
                digital_signature=not ca,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=cert_sign,
                crl_sign=ca,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
    if eku:
        builder = builder.add_extension(x509.ExtendedKeyUsage(eku), critical=True)
    builder = builder.add_extension(x509.SubjectKeyIdentifier.from_public_key(pub), critical=False).add_extension(
        x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False
    )
    cert = builder.sign(issuer_key, hashes.SHA256())
    CERTS[label] = (cert, key)
    path.write_bytes(cert.public_bytes(serialization.Encoding.DER))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    make("root", ca=True)
    make("inter", "root", ca=True)
    make("leaf", "inter")
    make("ee-issuer", "root")
    make("leaf-of-ee", "ee-issuer")
    make("root-pl0", ca=True, path_len=0)
    make("inter-pl0", "root-pl0", ca=True)
    make("leaf-pl0", "inter-pl0")
    make("leaf-direct-pl0", "root-pl0")
    make(
        "inter-expired",
        "root",
        ca=True,
        start=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
        end=datetime.datetime(2021, 1, 1, tzinfo=datetime.timezone.utc),
    )
    make("leaf-expired", "inter-expired")
    make("inter-nokcs", "root", ca=True, cert_sign=False)
    make("leaf-nokcs", "inter-nokcs")
    make("self-leaf")
    make("leaf-of-self", "self-leaf")
    make("ee-noku", "root", key_usage=False)
    make("leaf-of-ee-noku", "ee-noku")
    make("nobc", "root", ca=True, basic=False)
    make("leaf-of-nobc", "nobc")
    make("tsa-root", ca=True)
    make("tsa", "tsa-root", eku=[ExtendedKeyUsageOID.TIME_STAMPING])
    make("tsa-wrong-eku", "tsa-root", eku=[ExtendedKeyUsageOID.EMAIL_PROTECTION])
    make(
        "tsa-expired",
        "tsa-root",
        eku=[ExtendedKeyUsageOID.TIME_STAMPING],
        start=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
        end=datetime.datetime(2021, 1, 1, tzinfo=datetime.timezone.utc),
    )
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for label in ("leaf", "inter", "root", "tsa", "tsa-root", "tsa-wrong-eku", "tsa-expired"):
            cert, key = CERTS[label]
            (work / f"{label}.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            (work / f"{label}.key").write_bytes(
                key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            )
        (work / "signer-chain.pem").write_bytes((work / "inter.pem").read_bytes() + (work / "root.pem").read_bytes())
        data = b"Fartcrobat timestamp test data"  # no line break, so no end-of-line conversion can change it
        write(OUT / "ts-data.bin", lambda: data)
        good = write(OUT / "ts-good.tst", lambda: timestamp(work, data, "tsa"))
        tst_info = encapsulated_content(work, good)
        write(OUT / "ts-wrong-eku.tst", lambda: cms_sign(work, tst_info, "tsa-wrong-eku", TST_INFO_OID))
        write(OUT / "ts-expired.tst", lambda: cms_sign(work, tst_info, "tsa-expired", TST_INFO_OID))
        write(HERE / "signed-timestamp.pdf", lambda: signed_pdf(work))
        write(HERE / "doctimestamp-good.pdf", lambda: doc_timestamp_pdf(work, lambda b: timestamp(work, b, "tsa")))
        write(HERE / "doctimestamp-wrong-eku.pdf", lambda: doc_timestamp_pdf(work, lambda b: resigned_token(work, b, "tsa-wrong-eku")))
        write(
            HERE / "doctimestamp-leaf.pdf",
            lambda: doc_timestamp_pdf(work, lambda b: resigned_token(work, b, "leaf", "signer-chain.pem")),
        )
        pkcs7_doc_ts = b"/Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /M (D:20250601000000Z)"
        write(
            HERE / "doctimestamp-pkcs7.pdf",
            lambda: one_page_signed_pdf(
                b"Malformed document timestamp - TEST KEYS ONLY",
                b"Timestamp1",
                pkcs7_doc_ts,
                lambda b: cms_sign(work, b, "leaf", chain="signer-chain.pem"),
            ),
        )
        write(
            HERE / "doctimestamp-pkcs7-token.pdf",
            lambda: one_page_signed_pdf(
                b"Malformed document timestamp - TEST KEYS ONLY",
                b"Timestamp1",
                pkcs7_doc_ts,
                lambda b: add_timestamp(work, cms_sign(work, b, "leaf", chain="signer-chain.pem")),
            ),
        )
        write(
            HERE / "sig-rfc3161.pdf",
            lambda: one_page_signed_pdf(
                b"Signature in the document timestamp format - TEST KEYS ONLY",
                b"Signature1",
                b"/Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161 /Name (tsa) /M (D:20250601000000Z)",
                lambda b: timestamp(work, b, "tsa"),
            ),
        )


def write(path: Path, make_bytes) -> bytes:
    """Writes make_bytes() to path unless the file exists (and --force was not given)."""
    if path.exists() and not FORCE:
        return path.read_bytes()
    data = make_bytes()
    path.write_bytes(data)
    return data


# ---- timestamp tokens and the signed PDF (openssl) -----------------------------------------

TST_INFO_OID = "1.2.840.113549.1.9.16.1.4"
TS_CONFIG = """
[ tsa ]
default_tsa = tsa_config
[ tsa_config ]
serial = {serial}
crypto_device = builtin
signer_digest = sha256
default_policy = 1.2.3.4.1
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
other_policies = 1.2.3.4.2
"""


def openssl(work: Path, *args: str) -> None:
    subprocess.run(["openssl", *args], cwd=work, check=True, stdout=subprocess.DEVNULL)


def timestamp(work: Path, data: bytes, tsa: str) -> bytes:
    """An RFC 3161 token over `data` from `openssl ts -reply`."""
    (work / "data.bin").write_bytes(data)
    (work / "serial").write_text("01\n")
    (work / "ts.cnf").write_text(TS_CONFIG.format(serial=work / "serial"))
    openssl(work, "ts", "-query", "-data", "data.bin", "-sha256", "-cert", "-no_nonce", "-out", "q.tsq")
    openssl(
        work, "ts", "-reply", "-config", "ts.cnf", "-queryfile", "q.tsq", "-signer", f"{tsa}.pem", "-inkey", f"{tsa}.key",
        "-chain", "tsa-root.pem", "-token_out", "-out", "token.der",
    )
    return (work / "token.der").read_bytes()


def encapsulated_content(work: Path, cms: bytes) -> bytes:
    (work / "in.der").write_bytes(cms)
    openssl(work, "cms", "-verify", "-noverify", "-inform", "DER", "-in", "in.der", "-binary", "-out", "content.der")
    return (work / "content.der").read_bytes()


def cms_sign(work: Path, content: bytes, signer: str, econtent_type: str | None = None, chain: str = "tsa-root.pem") -> bytes:
    """CMS SignedData by `signer`: encapsulated with `econtent_type`, else detached."""
    (work / "content.bin").write_bytes(content)
    args = ["cms", "-sign", "-binary", "-md", "sha256", "-nosmimecap", "-signer", f"{signer}.pem", "-inkey", f"{signer}.key"]
    args += ["-certfile", chain, "-in", "content.bin", "-outform", "DER", "-out", "signed.der"]
    if econtent_type:
        args += ["-nodetach", "-econtent_type", econtent_type]
    openssl(work, *args)
    return (work / "signed.der").read_bytes()


def der_header(b: bytes, i: int) -> tuple[int, int, int]:
    """(tag byte, header length, content length) of the DER element at i."""
    first = b[i + 1]
    if first < 0x80:
        return b[i], 2, first
    n = first & 0x7F
    return b[i], 2 + n, int.from_bytes(b[i + 2 : i + 2 + n], "big")


def der_children(b: bytes) -> list[bytes]:
    """The child elements (with headers) of the constructed DER element b."""
    _, h, length = der_header(b, 0)
    out, i = [], h
    while i < h + length:
        _, ch, cl = der_header(b, i)
        out.append(b[i : i + ch + cl])
        i += ch + cl
    return out


def der_tlv(tag: int, content: bytes) -> bytes:
    n = len(content)
    if n < 0x80:
        return bytes([tag, n]) + content
    nb = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([tag, 0x80 | len(nb)]) + nb + content


def der_oid(dotted: str) -> bytes:
    parts = [int(p) for p in dotted.split(".")]
    body = bytes([parts[0] * 40 + parts[1]])
    for p in parts[2:]:
        enc = [p & 0x7F]
        p >>= 7
        while p:
            enc.append(0x80 | (p & 0x7F))
            p >>= 7
        body += bytes(reversed(enc))
    return der_tlv(0x06, body)


def add_timestamp(work: Path, cms: bytes) -> bytes:
    """Adds a timeStampToken unsigned attribute (over the signature value) to the first SignerInfo."""
    content_info = der_children(cms)
    signed_data = der_children(content_info[1])[0]
    sd_kids = der_children(signed_data)
    signer_info = der_children(sd_kids[-1])[0]
    si_kids = der_children(signer_info)
    signature = si_kids[-1]
    _, h, _ = der_header(signature, 0)
    token = timestamp(work, signature[h:], "tsa")
    attr = der_tlv(0x30, der_oid("1.2.840.113549.1.9.16.2.14") + der_tlv(0x31, token))
    signer_info = der_tlv(0x30, b"".join(si_kids) + der_tlv(0xA1, attr))
    signed_data = der_tlv(0x30, b"".join(sd_kids[:-1]) + der_tlv(0x31, signer_info))
    return der_tlv(0x30, content_info[0] + der_tlv(0xA0, signed_data))


def resigned_token(work: Path, data: bytes, signer: str, chain: str = "tsa-root.pem") -> bytes:
    """A token over `data` whose TSTInfo comes from `openssl ts -reply` but is signed by `signer`."""
    return cms_sign(work, encapsulated_content(work, timestamp(work, data, "tsa")), signer, TST_INFO_OID, chain)


def signed_pdf(work: Path) -> bytes:
    """A one-page PDF with signature field Signature1 signed by leaf, with an embedded timestamp."""
    return one_page_signed_pdf(
        b"Signed with an embedded timestamp - TEST KEYS ONLY",
        b"Signature1",
        b"/Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (leaf) /M (D:20260601000000Z)",
        lambda signed: add_timestamp(work, cms_sign(work, signed, "leaf", chain="signer-chain.pem")),
    )


def doc_timestamp_pdf(work: Path, token_for) -> bytes:
    """A one-page PDF with a document timestamp in field Timestamp1: token_for(signed bytes)."""
    return one_page_signed_pdf(
        b"Document timestamp - TEST KEYS ONLY",
        b"Timestamp1",
        b"/Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161",
        token_for,
    )


def one_page_signed_pdf(text: bytes, field: bytes, sig_entries: bytes, sign) -> bytes:
    """A one-page PDF with one signature field whose /Contents is sign(the bytes in its byte range)."""
    contents_len = 16384
    placeholder_range = b"[0 0000000000 0000000000 0000000000]"
    stream = b"BT /F1 18 Tf 72 720 Td (" + text + b") Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
        b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (" + field + b") /F 4 /Rect [72 560 300 640] /P 3 0 R /V 5 0 R >>",
        b"<< " + sig_entries + b" /ByteRange "
        + placeholder_range
        + b" /Contents <"
        + b"0" * contents_len
        + b"> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for o in offsets:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    start = out.index(b"/Contents <") + len(b"/Contents ")
    end = start + contents_len + 2
    byte_range = f"[0 {start:010d} {end:010d} {len(out) - end:010d}]".encode()
    at = out.index(placeholder_range)
    out[at : at + len(placeholder_range)] = byte_range
    signed = bytes(out[:start] + out[end:])
    cms = sign(signed)
    hex_cms = cms.hex().encode()
    assert len(hex_cms) <= contents_len
    out[start + 1 : start + 1 + len(hex_cms)] = hex_cms
    return bytes(out)


if __name__ == "__main__":
    main()
