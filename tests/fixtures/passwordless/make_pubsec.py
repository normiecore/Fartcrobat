"""Fixtures for certificate-encrypted PDFs (/Filter /Adobe.PubSec), for the passwordless feature.

TEST KEYS ONLY - never use for anything real. Every private key here is derived from a fixed
label in this script, so anyone can recompute it. Every certificate carries
OU=TEST KEYS ONLY - never use for anything real.

Usage (paths are relative to this file's folder, so it runs from anywhere):

    python3 -I tests/fixtures/passwordless/make_pubsec.py

Needs pyHanko 0.37, cryptography, asn1crypto, reportlab and pypdf. The outputs are committed and
tests never run this script. Running it again gives byte-identical files: keys come from a seeded
generator, and pyHanko's randomness (seeds, envelope keys, IVs, RSA padding, /ID) is replaced by a
seeded DRBG per file. The exception is a .p12, which is only rewritten when its key, certificate or
name changes, because PKCS#12 salts come from OpenSSL. See README.md for passwords and recipients.

PKI (pki/), RSA 2048 unless noted, valid 2025-01-01 to 2045-01-01:
  ca.crt, ca.cer                  "Fartcrobat Test CA", self-signed, names as PrintableString
  ca-unicode.crt, ca-unicode.cer  "Fartcrobat Tëst CA Ünïcode ✓", self-signed, names as UTF8String
  alice.crt/.cer/.key/.p12        Alice Test <alice@example.test>, issued by ca, KU keyEncipherment
                                  + dataEncipherment + digitalSignature, EKU emailProtection.
                                  .p12 password "alice-pass". The main recipient.
  bob.crt/.cer/.key/.p12          Bob Tëst, issued by ca-unicode, serial with the high bit set (DER
                                  INTEGER starts with 00), KU keyEncipherment. "bob-pass".
  stranger.crt/.cer/.key/.p12     Stranger Test, issued by ca, KU keyEncipherment. "stranger-pass".
  ec.crt/.cer/.key/.p12           EC Test, P-256, issued by ca, KU keyAgreement. "ec-pass".
  colleagues.p7b                  certs-only PKCS#7 (DER) with bob and stranger
  (.crt = PEM certificate, .cer = DER certificate, .key = unencrypted PKCS#8 PEM, .p12 = PBES2
  AES-256-CBC + PBKDF2-SHA256 with an HMAC-SHA256 MAC, readable by node-forge and .NET)

Windows certificate store helper (pki/winstore/, import with winstore/import_store.ps1), ported
from prototypes/passwordless/windows-store/test/make_fixtures.py: self-signed, O=Fartcrobat Store
Test, every .p12 password "test", .cer = DER, .pem = PEM:
  recipient   alice's certificate and key again, under the spike's name, so the store opens every
              fixture made for alice
  me-enc      KU keyEncipherment + dataEncipherment, EKU emailProtection, me@example.test
  me-sign     KU digitalSignature + nonRepudiation only (not for encryption)
  me-noku     no key usage extension; subject with non-ASCII characters and an emoji
  me-ec       EC P-256, KU keyAgreement + digitalSignature
  me-expired  KU keyEncipherment, valid 2020-01-01 to 2021-01-01
  me-nokey    KU keyEncipherment, certificate only (.cer, .pem)
  colleague   KU keyEncipherment, colleague@example.test, certificate only (.cer, .pem)
  colleagues.p7b  colleague and me-nokey

PDFs (all from source.pdf unless noted; V5 AES-256 for alice, all permissions, PDF MAC off,
EncryptMetadata true, classic xref table, unless noted):
  source.pdf                plain: 2 pages, outline, /Text annotation, AcroForm field "name",
                            uncompressed XMP with "xmp-marker-123"
  v5-classic.pdf            classic xref table
  v5-objstm.pdf             xref stream, every non-stream object in an object stream
  v5-incremental.pdf        v5-objstm.pdf plus an update that changes /Title (newest must win)
  v5-nometa.pdf             EncryptMetadata false, XMP stream written in clear (no /Crypt filter)
  v5-two-recipients.pdf     one envelope, two RecipientInfos: bob, then alice
  v5-two-envelopes.pdf      two envelopes: [bob] all permissions, then [alice] printing only
  v5-oaep.pdf               RSAES-OAEP (SHA-256) key transport
  v5-ski.pdf                recipient identified by SubjectKeyIdentifier (own CMS code)
  v5-env-aes128.pdf         envelope content encrypted with AES-128-CBC (own CMS code)
  v5-env-3des.pdf           envelope content encrypted with des-ede3-cbc (own CMS code)
  v4-aes128.pdf             V4, AESV2, 128-bit, classic xref table
  v4-aes128-objstm.pdf      V4, AESV2, xref stream and object streams
  v4-rc4.pdf                V4 with a /V2 (RC4) crypt filter, 128-bit
  v5-mac.pdf                pyHanko's default, with an ISO/TS 32004 PDF MAC
  v5-signed.pdf             encrypted, then signed by alice in an incremental update
  stranger-only.pdf         encrypted for stranger only
  v5-ec.pdf                 recipient ec, ECDH key agreement (KeyAgreeRecipientInfo)
  v5-damaged-first.pdf      two envelopes; the first is a truncated (invalid DER) envelope for bob
  v5-direct-encrypt.pdf     v5-classic.pdf with /Encrypt as a direct dictionary in the trailer
  text-v5.pdf               ../text.pdf for alice and bob (one envelope), for end-to-end tests
  expected.json             per PDF: handler, recipients, who opens it, permissions, seeds, file key
"""
import contextlib
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import types
from pathlib import Path

from asn1crypto import cms
from asn1crypto import keys as asn1_keys
from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.decrepit.ciphers.algorithms import ARC4, TripleDES
from cryptography.hazmat.primitives import hashes, keywrap, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.asymmetric.padding import MGF1, OAEP, PKCS1v15
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.x963kdf import X963KDF
from cryptography.hazmat.primitives.serialization import pkcs7, pkcs12
from cryptography.x509.name import _ASN1Type
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

import pyhanko.pdf_utils.crypt._util as ph_util
import pyhanko.pdf_utils.crypt.filter_mixins as ph_filter_mixins
import pyhanko.pdf_utils.crypt.pdfmac as ph_pdfmac
import pyhanko.pdf_utils.crypt.pubkey as ph_pubkey
import pyhanko.pdf_utils.incremental_writer as ph_incremental
import pyhanko.pdf_utils.writer as ph_writer
import pyhanko.sign.signers.pdf_cms as ph_pdf_cms
import pyhanko.sign.signers.pdf_signer as ph_pdf_signer
from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.crypt import AuthStatus, PubKeySecurityHandler, SimpleEnvelopeKeyDecrypter
from pyhanko.pdf_utils.crypt.api import SecurityHandlerVersion
from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
from pyhanko.pdf_utils.crypt.pubkey import RecipientEncryptionPolicy
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.writer import copy_into_new_writer
from pyhanko.sign import signers
from pyhanko.sign.fields import enumerate_sig_fields
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.settings import KeyUsageConstraints
from pyhanko_certvalidator import ValidationContext

HERE = Path(__file__).resolve().parent
PKI = HERE / 'pki'
WIN = PKI / 'winstore'
TEXT_PDF = HERE.parent / 'text.pdf'

TEST_OU = 'TEST KEYS ONLY - never use for anything real'
ORG = 'Fartcrobat Test Keys'
STORE_ORG = 'Fartcrobat Store Test'
UTC = dt.timezone.utc
VALIDITY = (dt.datetime(2025, 1, 1, tzinfo=UTC), dt.datetime(2045, 1, 1, tzinfo=UTC))
EXPIRED = (dt.datetime(2020, 1, 1, tzinfo=UTC), dt.datetime(2021, 1, 1, tzinfo=UTC))
SIGNING_TIME = dt.datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC)
PASSWORDS = {'alice': 'alice-pass', 'bob': 'bob-pass', 'stranger': 'stranger-pass', 'ec': 'ec-pass'}
P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551

SOURCE_TITLE = 'Secret title'
UPDATED_TITLE = 'Updated secret title'
PAGE1_TEXT = 'Hello secret world'
NOTE_TEXT = 'Note text in an object stream'
XMP_MARKER = 'xmp-marker-123'

ALL = PubKeyPermissions.allow_everything()
PRINT_ONLY = (PubKeyPermissions.ALLOW_PRINTING | PubKeyPermissions.ALLOW_HIGH_QUALITY_PRINTING
              | PubKeyPermissions.TOLERATE_MISSING_PDF_MAC)

written = []


def write(path: Path, data: bytes) -> None:
    """Write only when the bytes change, so a re-run leaves the tree untouched."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not (path.exists() and path.read_bytes() == data):
        path.write_bytes(data)
    written.append(path)


# --- Deterministic randomness -------------------------------------------------------------------

class Drbg:
    """SHA-256 in counter mode, keyed by a label: the same 'random' bytes on every run."""

    def __init__(self, label: str):
        self._key = hashlib.sha256(b'fartcrobat-test-fixtures/' + label.encode()).digest()
        self._counter = 0
        self._pool = b''

    def bytes(self, n: int) -> bytes:
        while len(self._pool) < n:
            self._pool += hashlib.sha256(self._key + self._counter.to_bytes(8, 'big')).digest()
            self._counter += 1
        out, self._pool = self._pool[:n], self._pool[n:]
        return out

    def below(self, n: int) -> int:
        return int.from_bytes(self.bytes((n.bit_length() + 7) // 8 + 8), 'big') % n


_SMALL_PRIMES = [p for p in range(3, 3000, 2) if all(p % d for d in range(3, int(p ** 0.5) + 1, 2))]


def _probable_prime(n: int, rng: Drbg) -> bool:
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d, s = d // 2, s + 1
    for _ in range(40):
        x = pow(2 + rng.below(n - 3), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(rng: Drbg, bits: int, e: int) -> int:
    while True:
        c = int.from_bytes(rng.bytes(bits // 8), 'big') | (3 << (bits - 2)) | 1
        if math.gcd(c - 1, e) == 1 and _probable_prime(c, rng):
            return c


def rsa_key(label: str, bits: int = 2048) -> rsa.RSAPrivateKey:
    rng = Drbg('rsa/' + label)
    e = 65537
    p = _prime(rng, bits // 2, e)
    q = _prime(rng, bits // 2, e)
    while q == p:
        q = _prime(rng, bits // 2, e)
    p, q = max(p, q), min(p, q)
    d = rsa.rsa_recover_private_exponent(e, p, q)
    return rsa.RSAPrivateNumbers(
        p, q, d, rsa.rsa_crt_dmp1(d, p), rsa.rsa_crt_dmq1(d, q), rsa.rsa_crt_iqmp(p, q),
        rsa.RSAPublicNumbers(e, p * q)).private_key()


def ec_key(label: str) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(1 + Drbg('ec/' + label).below(P256_ORDER - 1), ec.SECP256R1())


def serial(label: str, high_bit: bool = False) -> int:
    b = bytearray(Drbg('serial/' + label).bytes(16))
    b[0] = (b[0] | 0x80) if high_bit else ((b[0] & 0x7F) or 0x01)
    return int.from_bytes(b, 'big')


# --- Certificates ---------------------------------------------------------------------------------

def ku(**on) -> x509.KeyUsage:
    names = ['digital_signature', 'content_commitment', 'key_encipherment', 'data_encipherment',
             'key_agreement', 'key_cert_sign', 'crl_sign', 'encipher_only', 'decipher_only']
    return x509.KeyUsage(**{n: on.get(n, False) for n in names})


def name(cn: str, printable: bool = False) -> x509.Name:
    t = _ASN1Type.PrintableString if printable else _ASN1Type.UTF8String
    return x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, ORG, _type=t),
                      x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEST_OU, _type=t),
                      x509.NameAttribute(NameOID.COMMON_NAME, cn, _type=t)])


def store_name(cn: str) -> x509.Name:
    # The spike's order (CN first), plus the test-only OU
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, STORE_ORG),
                      x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEST_OU)])


def make_cert(subject, key, sn, *, issuer=None, key_usage=None, eku=None, email=None, ca=None,
              ids=True, validity=VALIDITY) -> x509.Certificate:
    """issuer is (cert, key) or None for self-signed. ids adds BasicConstraints, SKI and AKI."""
    issuer_name = issuer[0].subject if issuer else subject
    issuer_key = issuer[1] if issuer else key
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer_name)
         .public_key(key.public_key()).serial_number(sn)
         .not_valid_before(validity[0]).not_valid_after(validity[1]))
    if ids:
        b = b.add_extension(x509.BasicConstraints(ca=bool(ca), path_length=None), critical=True)
        b = b.add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        aki_key = issuer[0].public_key() if issuer else key.public_key()
        b = b.add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(aki_key), critical=False)
    if key_usage is not None:
        b = b.add_extension(key_usage, critical=True)
    if eku:
        b = b.add_extension(x509.ExtendedKeyUsage(eku), critical=False)
    if email:
        b = b.add_extension(x509.SubjectAlternativeName([x509.RFC822Name(email)]), critical=False)
    extra = {'ecdsa_deterministic': True} if isinstance(issuer_key, ec.EllipticCurvePrivateKey) else {}
    return b.sign(issuer_key, hashes.SHA256(), **extra)


def der(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.DER)


def pem(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


def pkcs8(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def write_p12(path: Path, friendly: str, key, cert: x509.Certificate, password: str) -> None:
    """PBES2 (PBKDF2-SHA256, AES-256-CBC) for key and certificate, HMAC-SHA256 MAC. Kept when an
    existing file already holds the same key, certificate and name (the salts are random)."""
    if path.exists():
        try:
            old = pkcs12.load_pkcs12(path.read_bytes(), password.encode())
            if (old.key is not None and pkcs8(old.key) == pkcs8(key) and old.cert is not None
                    and der(old.cert.certificate) == der(cert)
                    and old.cert.friendly_name == friendly.encode() and not old.additional_certs):
                written.append(path)
                return
        except ValueError:
            pass
    enc = (serialization.PrivateFormat.PKCS12.encryption_builder()
           .kdf_rounds(2048)
           .key_cert_algorithm(pkcs12.PBES.PBESv2SHA256AndAES256CBC)
           .hmac_hash(hashes.SHA256())
           .build(password.encode()))
    write(path, pkcs12.serialize_key_and_certificates(friendly.encode(), key, cert, None, enc))


def make_pki():
    ca_key, cau_key = rsa_key('ca'), rsa_key('ca-unicode')
    ca = make_cert(name('Fartcrobat Test CA', printable=True), ca_key, serial('ca'), ca=True,
                   key_usage=ku(key_cert_sign=True, crl_sign=True))
    cau = make_cert(name('Fartcrobat Tëst CA Ünïcode ✓'), cau_key, serial('ca-unicode'), ca=True,
                    key_usage=ku(key_cert_sign=True, crl_sign=True))
    for stem, cert in (('ca', ca), ('ca-unicode', cau)):
        write(PKI / f'{stem}.crt', pem(cert))
        write(PKI / f'{stem}.cer', der(cert))

    ids = {}
    specs = [
        ('alice', 'Alice Test', rsa_key('alice'), (ca, ca_key), False,
         ku(key_encipherment=True, data_encipherment=True, digital_signature=True),
         [ExtendedKeyUsageOID.EMAIL_PROTECTION], 'alice@example.test'),
        ('bob', 'Bob Tëst', rsa_key('bob'), (cau, cau_key), True, ku(key_encipherment=True), None,
         'bob@example.test'),
        ('stranger', 'Stranger Test', rsa_key('stranger'), (ca, ca_key), False,
         ku(key_encipherment=True), None, 'stranger@example.test'),
        ('ec', 'EC Test', ec_key('ec'), (ca, ca_key), False, ku(key_agreement=True), None,
         'ec@example.test'),
    ]
    for stem, cn, key, issuer, high_bit, key_usage, eku, email in specs:
        cert = make_cert(name(cn), key, serial(stem, high_bit), issuer=issuer, key_usage=key_usage,
                         eku=eku, email=email)
        write(PKI / f'{stem}.crt', pem(cert))
        write(PKI / f'{stem}.cer', der(cert))
        write(PKI / f'{stem}.key', pkcs8(key))
        write_p12(PKI / f'{stem}.p12', cn, key, cert, PASSWORDS[stem])
        ids[stem] = (cert, key)
    write(PKI / 'colleagues.p7b', pkcs7.serialize_certificates(
        [ids['bob'][0], ids['stranger'][0]], serialization.Encoding.DER))

    # Windows store set (the spike's make_fixtures.py, with fixed dates and the test-only OU)
    store = [
        ('me-enc', 'Store Test Me (encryption)', rsa_key('me-enc'),
         dict(key_usage=ku(key_encipherment=True, data_encipherment=True),
              eku=[ExtendedKeyUsageOID.EMAIL_PROTECTION], email='me@example.test')),
        ('me-sign', 'Store Test Me (signing only)', rsa_key('me-sign'),
         dict(key_usage=ku(digital_signature=True, content_commitment=True))),
        ('me-noku', 'Store Test Me (no key usage) éè \U0001F511', rsa_key('me-noku'), {}),
        ('me-ec', 'Store Test Me (EC)', ec_key('me-ec'),
         dict(key_usage=ku(key_agreement=True, digital_signature=True))),
        ('me-expired', 'Store Test Me (expired)', rsa_key('me-expired'),
         dict(key_usage=ku(key_encipherment=True), validity=EXPIRED)),
        ('me-nokey', 'Store Test Me (no private key)', rsa_key('me-nokey'),
         dict(key_usage=ku(key_encipherment=True))),
        ('colleague', 'Store Test Colleague', rsa_key('colleague'),
         dict(key_usage=ku(key_encipherment=True), email='colleague@example.test')),
    ]
    store_certs = {}
    for stem, cn, key, kw in store:
        cert = make_cert(store_name(cn), key, serial('store/' + stem), ids=False, **kw)
        store_certs[stem] = cert
        write(WIN / f'{stem}.cer', der(cert))
        write(WIN / f'{stem}.pem', pem(cert))
        if stem not in ('me-nokey', 'colleague'):
            write(WIN / f'{stem}.key', pkcs8(key))
            write_p12(WIN / f'{stem}.p12', stem, key, cert, 'test')
    alice_cert, alice_key = ids['alice']
    write(WIN / 'recipient.cer', der(alice_cert))
    write(WIN / 'recipient.pem', pem(alice_cert))
    write(WIN / 'recipient.key', pkcs8(alice_key))
    write_p12(WIN / 'recipient.p12', 'recipient', alice_key, alice_cert, 'test')
    write(WIN / 'colleagues.p7b', pkcs7.serialize_certificates(
        [store_certs['colleague'], store_certs['me-nokey']], serialization.Encoding.DER))
    return ids


# --- The plain source --------------------------------------------------------------------------

XMP = f'''<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Keywords>{XMP_MARKER}</pdf:Keywords>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>'''.encode('utf-8')


def make_source() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, invariant=1, pageCompression=0)
    c.setTitle(SOURCE_TITLE)
    c.setAuthor('Fartcrobat Tests')
    c.setSubject('Passwordless test fixture')
    c.bookmarkPage('p1')
    c.addOutlineEntry('Page 1', 'p1', level=0)
    c.setFont('Helvetica', 24)
    c.drawString(72, 700, PAGE1_TEXT)
    c.setFont('Helvetica', 14)
    c.drawString(72, 670, 'Second line of page one')
    c.textAnnotation(NOTE_TEXT, Rect=(72, 600, 92, 620), relative=0)
    c.acroForm.textfield(name='name', value='Field value', x=72, y=520, width=200, height=24,
                         fontName='Helvetica', fontSize=12)
    c.showPage()
    c.bookmarkPage('p2')
    c.addOutlineEntry('Page 2', 'p2', level=0)
    c.setFont('Helvetica', 24)
    c.drawString(72, 700, 'Page two text')
    c.showPage()
    c.save()

    # reportlab has no XMP: add an uncompressed /Metadata stream with pypdf
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    meta = DecodedStreamObject()
    meta.set_data(XMP)
    meta[NameObject('/Type')] = NameObject('/Metadata')
    meta[NameObject('/Subtype')] = NameObject('/XML')
    w._root_object[NameObject('/Metadata')] = w._add_object(meta)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


# --- Making pyHanko deterministic ----------------------------------------------------------------

def _mgf1(seed: bytes, length: int, hash_name: str) -> bytes:
    out = b''
    for i in range((length + hashlib.new(hash_name).digest_size - 1) // hashlib.new(hash_name).digest_size):
        out += hashlib.new(hash_name, seed + i.to_bytes(4, 'big')).digest()
    return out[:length]


def rsa_encrypt(pub: RSAPublicKey, message: bytes, padding, rng: Drbg) -> bytes:
    """RSA encryption with PKCS#1 v1.5 or OAEP padding drawn from rng (RFC 8017, 7.1 and 7.2)."""
    nums = pub.public_numbers()
    k = (nums.n.bit_length() + 7) // 8
    if isinstance(padding, PKCS1v15):
        ps = b''
        while len(ps) < k - 3 - len(message):
            ps += bytes(b for b in rng.bytes(k - 3 - len(message) - len(ps)) if b)
        em = b'\x00\x02' + ps + b'\x00' + message
    elif isinstance(padding, OAEP):
        h, mh = padding.algorithm.name, padding.mgf._algorithm.name
        hlen = hashlib.new(h).digest_size
        db = hashlib.new(h, b'').digest() + b'\x00' * (k - len(message) - 2 * hlen - 2) + b'\x01' + message
        seed = rng.bytes(hlen)
        masked_db = bytes(a ^ b for a, b in zip(db, _mgf1(seed, k - hlen - 1, mh)))
        masked_seed = bytes(a ^ b for a, b in zip(seed, _mgf1(masked_db, hlen, mh)))
        em = b'\x00' + masked_seed + masked_db
    else:
        raise ValueError(padding)
    return pow(int.from_bytes(em, 'big'), nums.e, nums.n).to_bytes(k, 'big')


class _DetRsaPublicKey:
    def __init__(self, key, rng):
        self._key, self._rng = key, rng

    def encrypt(self, plaintext, padding):
        return rsa_encrypt(self._key, plaintext, padding, self._rng)

    def __getattr__(self, attr):
        return getattr(self._key, attr)


RSAPublicKey.register(_DetRsaPublicKey)


class _SerializationProxy:
    def __init__(self, rng):
        self._rng = rng

    def __getattr__(self, attr):
        return getattr(serialization, attr)

    def load_der_public_key(self, data, *args, **kwargs):
        key = serialization.load_der_public_key(data, *args, **kwargs)
        return _DetRsaPublicKey(key, self._rng) if isinstance(key, RSAPublicKey) else key


class _OsProxy:
    def __init__(self, rng):
        self.urandom = rng.bytes

    def __getattr__(self, attr):
        return getattr(os, attr)


class _FixedDatetime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return SIGNING_TIME


@contextlib.contextmanager
def deterministic(label: str):
    """Replace every source of randomness pyHanko uses while making one file."""
    rng = Drbg('pdf/' + label)
    fake_secrets = types.SimpleNamespace(token_bytes=rng.bytes)

    def ec_originator(curve):
        assert isinstance(curve, ec.SECP256R1)
        return ec.derive_private_key(1 + rng.below(P256_ORDER - 1), curve)

    patches = [(ph_pubkey, 'secrets', fake_secrets), (ph_util, 'secrets', fake_secrets),
               (ph_filter_mixins, 'secrets', fake_secrets), (ph_pdfmac, 'secrets', fake_secrets),
               (ph_pubkey, 'serialization', _SerializationProxy(rng)),
               (ph_pubkey, 'generate_ec_private_key', ec_originator),
               (ph_writer, 'os', _OsProxy(rng)), (ph_incremental, 'os', _OsProxy(rng)),
               (ph_pdf_signer, 'datetime', _FixedDatetime), (ph_pdf_cms, 'datetime', _FixedDatetime)]
    saved = [(mod, attr, getattr(mod, attr)) for mod, attr, _ in patches]
    for mod, attr, value in patches:
        setattr(mod, attr, value)
    try:
        yield rng
    finally:
        for mod, attr, value in saved:
            setattr(mod, attr, value)


# --- Building encrypted files --------------------------------------------------------------------

class RawBlob:
    """A /Recipients entry that is not valid CMS. pyHanko writes and hashes dump() as is."""

    def __init__(self, data: bytes):
        self.data = data

    def dump(self, force=False):
        return self.data


class ClearStream(generic.StreamObject):
    """Written without encryption and without a /Crypt filter, as Acrobat writes the XMP stream
    when EncryptMetadata is false (pyHanko itself would add an /Identity crypt filter)."""

    def write_to_stream(self, stream, handler=None, container_ref=None):
        super().write_to_stream(stream, None, container_ref)


def doc_id(label: str) -> generic.ArrayObject:
    i = generic.ByteStringObject(hashlib.sha256(b'fartcrobat-test-fixtures/id/' + label.encode()).digest()[:16])
    return generic.ArrayObject([i, i])


def new_writer(src: bytes, label: str, *, xref_stream=False, object_streams=False, clear_xmp=False):
    w = copy_into_new_writer(PdfFileReader(io.BytesIO(src)), writer_kwargs={'stream_xrefs': xref_stream})
    w._update_meta = lambda: None  # keep /Info and the XMP exactly as in the source, no timestamps
    w._document_id = doc_id(label)
    if object_streams:
        stm = w.prepare_object_stream()
        for key in sorted(w.objects):
            gen, idnum = key
            obj = w.objects[key]
            if gen == 0 and not isinstance(obj, generic.StreamObject):
                del w.objects[key]
                stm.add_object(idnum, obj)
                w.objs_in_streams[idnum] = obj
    if clear_xmp:
        ref = w.root.raw_get('/Metadata')
        old = w.objects[(ref.generation, ref.idnum)]
        w.objects[(ref.generation, ref.idnum)] = ClearStream(dict(old), encoded_data=old.encoded_data)
    return w


def write_encrypted(w, sh) -> bytes:
    w._assign_security_handler(sh)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def default_filter(sh):
    return next(iter(sh.crypt_filter_config.standard_filters()))


def ph_cert(stem: str) -> asn1_x509.Certificate:
    return load_cert_from_pemder(str(PKI / f'{stem}.crt'))


def credential(stem: str) -> SimpleEnvelopeKeyDecrypter:
    return SimpleEnvelopeKeyDecrypter.load_pkcs12(str(PKI / f'{stem}.p12'), PASSWORDS[stem].encode())


def v5(certs, **kw):
    kw.setdefault('pdf_mac', False)
    return PubKeySecurityHandler.build_from_certs(certs, **kw)


def v4(certs, use_aes=True):
    return PubKeySecurityHandler.build_from_certs(
        certs, keylen_bytes=16, version=SecurityHandlerVersion.RC4_OR_AES128, use_aes=use_aes, pdf_mac=False)


def _odd_parity(key: bytes) -> bytes:
    return bytes((b & 0xFE) | (bin(b & 0xFE).count('1') % 2 == 0) for b in key)


CONTENT_CIPHERS = {'aes256_cbc': (32, 16, algorithms.AES), 'aes128_cbc': (16, 16, algorithms.AES),
                   'tripledes_3key': (24, 8, TripleDES)}


def build_envelope(rng: Drbg, recipients, content: bytes, cipher='aes256_cbc') -> cms.ContentInfo:
    """A CMS EnvelopedData like pyHanko's construct_recipient_cms (rsaEncryption, PKCS#1 v1.5),
    but with a choice of content cipher and of recipient identifier: pyHanko 0.37 only writes
    AES-256 content and issuerAndSerialNumber. recipients: [(asn1crypto cert, by_ski)]."""
    key_len, block, algo = CONTENT_CIPHERS[cipher]
    cek = rng.bytes(key_len)
    if cipher == 'tripledes_3key':
        cek = _odd_parity(cek)
    iv = rng.bytes(block)
    pad = block - len(content) % block
    enc = Cipher(algo(cek), modes.CBC(iv)).encryptor()
    encrypted = enc.update(content + bytes([pad]) * pad) + enc.finalize()
    infos, version = [], 0
    for cert, by_ski in recipients:
        if by_ski:
            rid = cms.RecipientIdentifier({'subject_key_identifier': cert.key_identifier})
            version = 2  # RFC 5652 6.1: a version 2 RecipientInfo makes the EnvelopedData version 2
        else:
            rid = cms.RecipientIdentifier({'issuer_and_serial_number': cms.IssuerAndSerialNumber(
                {'issuer': cert.issuer, 'serial_number': cert.serial_number})})
        pub = serialization.load_der_public_key(cert.public_key.dump())
        infos.append(cms.RecipientInfo({'ktri': cms.KeyTransRecipientInfo({
            'version': 2 if by_ski else 0, 'rid': rid,
            'key_encryption_algorithm': {'algorithm': 'rsaes_pkcs1v15'},
            'encrypted_key': rsa_encrypt(pub, cek, PKCS1v15(), rng)})}))
    return cms.ContentInfo({'content_type': 'enveloped_data', 'content': cms.EnvelopedData({
        'version': version, 'recipient_infos': infos,
        'encrypted_content_info': {
            'content_type': 'data',
            'content_encryption_algorithm': {'algorithm': cipher, 'parameters': iv},
            'encrypted_content': encrypted}})})


def _tlv(tag: int, content: bytes) -> bytes:
    n = len(content)
    if n < 0x80:
        return bytes([tag, n]) + content
    size = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([tag, 0x80 | len(size)]) + size + content


def in_given_order(envelope: cms.ContentInfo, certs) -> RawBlob:
    """Re-encode an envelope with its RecipientInfos in the order of certs. asn1crypto sorts a
    SET OF by its DER bytes, so pyHanko's own order is lost; CMS is BER, so any order is valid."""
    ed = envelope['content']
    serials = [c.serial_number for c in certs]
    infos = sorted(ed['recipient_infos'], key=lambda ri: serials.index(ri.chosen['rid'].chosen['serial_number'].native))
    body = ed['version'].dump() + _tlv(0x31, b''.join(ri.dump() for ri in infos)) + ed['encrypted_content_info'].dump()
    return RawBlob(_tlv(0x30, envelope['content_type'].dump() + _tlv(0xA0, _tlv(0x30, body))))


def own_envelope_file(src, label, cipher, by_ski):
    """Encrypt for alice with pyHanko, then swap in an envelope from build_envelope that carries
    the same seed. The file key is derived later, from the envelope actually written."""
    with deterministic(label) as rng:
        w = new_writer(src, label)
        sh = v5([ph_cert('alice')])
        cf = default_filter(sh)
        content = cf._recp_key_seed + ALL.as_bytes()
        cf.recipients = [build_envelope(rng, [(ph_cert('alice'), by_ski)], content, cipher)]
        return write_encrypted(w, sh)


def simple_file(src, label, handler, **writer_kw):
    with deterministic(label):
        w = new_writer(src, label, **writer_kw)
        return write_encrypted(w, handler())


def authenticated_update(base: bytes) -> IncrementalPdfFileWriter:
    """An incremental writer on a file opened as alice (the catalog may sit in an encrypted
    object stream, so the reader must be authenticated before the writer reads it)."""
    r = PdfFileReader(io.BytesIO(base))
    assert r.decrypt_pubkey(credential('alice')).status == AuthStatus.USER
    iw = IncrementalPdfFileWriter.from_reader(r)
    iw._update_meta = lambda: None  # no ModDate/Producer/XMP rewrite: only the intended change
    return iw


def incremental_title(base: bytes, label: str) -> bytes:
    with deterministic(label):
        iw = authenticated_update(base)
        info_ref = iw.prev.trailer.raw_get('/Info')
        info = info_ref.get_object()
        info['/Title'] = generic.TextStringObject(UPDATED_TITLE)
        iw.mark_update(info_ref)
        out = io.BytesIO()
        iw.write(out)
        return out.getvalue()


def signed_file(src: bytes, label: str) -> bytes:
    base = simple_file(src, label, lambda: v5([ph_cert('alice')]))
    with deterministic(label + '/sign'):
        iw = authenticated_update(base)
        signer = signers.SimpleSigner.load(
            key_file=str(PKI / 'alice.key'), cert_file=str(PKI / 'alice.crt'),
            ca_chain_files=(str(PKI / 'ca.crt'),))
        meta = signers.PdfSignatureMetadata(field_name='Signature1', md_algorithm='sha256',
                                            reason='Fixture signature')
        out = signers.sign_pdf(iw, meta, signer=signer)
        return out.getvalue()


def damaged_first(src: bytes, label: str) -> bytes:
    with deterministic(label):
        w = new_writer(src, label)
        sh = v5([ph_cert('bob')])
        sh.add_recipients([ph_cert('alice')])
        cf = default_filter(sh)
        bob_envelope = cf.recipients[0].dump()
        cf.recipients[0] = RawBlob(bob_envelope[: len(bob_envelope) // 2])  # truncated: not valid DER
        return write_encrypted(w, sh)


def inline_encrypt(data: bytes) -> bytes:
    """Byte surgery on a one-section classic file: move the Encrypt object's dictionary into the
    trailer, drop the object (its xref entry becomes free) and rebuild the xref table."""
    sx = data.rindex(b'startxref')
    xref_at = int(data[sx + 9:].split()[0])
    assert data[xref_at:xref_at + 4] == b'xref' and b'/Prev' not in data[xref_at:]
    trailer_at = data.index(b'trailer', xref_at)
    entries, pos = {}, xref_at + 4
    lines = data[pos:trailer_at].split(b'\n')
    i = 0
    while i < len(lines):
        head = lines[i].split()
        i += 1
        if len(head) != 2:
            continue
        start, count = int(head[0]), int(head[1])
        for k in range(count):
            off, gen, kind = lines[i].split()[:3]
            entries[start + k] = (int(off), int(gen), kind)
            i += 1
    trailer = data[trailer_at + 7:sx].strip()
    m = re.search(rb'/Encrypt\s*(\d+)\s+(\d+)\s+R', trailer)
    enc_num = int(m[1])
    used = sorted((off, num) for num, (off, gen, kind) in entries.items() if kind == b'n')
    bounds = {num: (off, used[j + 1][0] if j + 1 < len(used) else xref_at) for j, (off, num) in enumerate(used)}
    start, end = bounds[enc_num]
    chunk = data[start:end]
    enc_dict = chunk[chunk.index(b'obj') + 3:chunk.rindex(b'endobj')].strip()
    assert enc_dict.startswith(b'<<') and enc_dict.endswith(b'>>')
    out = bytearray(data[:used[0][0]])
    offsets = {}
    for off, num in used:
        if num == enc_num:
            continue
        offsets[num] = len(out)
        out += data[off:bounds[num][1]]
    size = max(entries) + 1
    new_xref = len(out)
    out += b'xref\n0 %d\n' % size
    for num in range(size):
        if num == 0:
            out += b'%010d 65535 f\r\n' % enc_num
        elif num == enc_num:
            out += b'0000000000 00001 f\r\n'
        else:
            out += b'%010d %05d n\r\n' % (offsets[num], entries[num][1])
    out += b'trailer\n' + trailer[:m.start()] + b'/Encrypt ' + enc_dict + trailer[m.end():]
    out += b'\nstartxref\n%d\n%%%%EOF\n' % new_xref
    return bytes(out)


# --- Reading envelopes ourselves -----------------------------------------------------------------

def decrypt_content(cipher_oid: str, cek: bytes, iv: bytes, data: bytes) -> bytes:
    algo = {'2.16.840.1.101.3.4.1.42': algorithms.AES, '2.16.840.1.101.3.4.1.2': algorithms.AES,
            '1.2.840.113549.3.7': TripleDES}[cipher_oid]
    d = Cipher(algo(cek), modes.CBC(iv)).decryptor()
    plain = d.update(data) + d.finalize()
    return plain[:-plain[-1]]


def unwrap_ktri(ktri, key) -> bytes:
    kea = ktri['key_encryption_algorithm']
    if kea['algorithm'].native == 'rsaes_oaep':
        params = kea['parameters']
        h = hashes.SHA256 if params['hash_algorithm']['algorithm'].native == 'sha256' else None
        mh = params['mask_gen_algorithm']['parameters']['algorithm'].native
        assert h and mh == 'sha256'
        padding = OAEP(mgf=MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    else:
        assert kea['algorithm'].dotted == '1.2.840.113549.1.1.1'
        padding = PKCS1v15()
    return key.decrypt(ktri['encrypted_key'].native, padding)


def unwrap_kari(kari, rek, key) -> bytes:
    kea = kari['key_encryption_algorithm']
    assert kea['algorithm'].dotted == '1.3.132.1.11.1'  # dhSinglePass-stdDH-sha256kdf-scheme
    wrap = cms.KeyEncryptionAlgorithm.load(kea['parameters'].dump())
    kek_len = {'aes128_wrap': 16, 'aes192_wrap': 24, 'aes256_wrap': 32}[wrap['algorithm'].native]
    originator = serialization.load_der_public_key(
        asn1_keys.PublicKeyInfo.load(kari['originator'].chosen.untag().dump()).dump())
    shared_info = ph_pubkey.ECCCMSSharedInfo({
        'key_info': wrap, 'entityUInfo': kari['ukm'].native,
        'suppPubInfo': (kek_len * 8).to_bytes(4, 'big')}).dump()
    kek = X963KDF(algorithm=hashes.SHA256(), length=kek_len, sharedinfo=shared_info).derive(
        key.exchange(ec.ECDH(), originator))
    return keywrap.aes_key_unwrap(kek, rek['encrypted_key'].native)


def read_envelopes(blobs, ids):
    """Summarise every RecipientInfo and decrypt the ones we hold keys for."""
    summary, opened = [], {}
    by_issuer = {(der_issuer(c), c.serial_number): stem for stem, (c, _) in ids.items()}
    by_ski = {c.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value.digest: stem
              for stem, (c, _) in ids.items()}
    for e, blob in enumerate(blobs):
        try:
            ci = cms.ContentInfo.load(blob)
            ed = ci['content']
            _ = ci.native  # parse everything now
        except ValueError:
            summary.append({'envelope': e, 'index': None, 'idType': None, 'issuer': None,
                            'serialHex': None, 'ski': None, 'cert': None, 'damaged': True})
            continue
        eci = ed['encrypted_content_info']
        alg = eci['content_encryption_algorithm']
        cipher_oid = alg['algorithm'].dotted
        for i, ri in enumerate(ed['recipient_infos']):
            if ri.name == 'ktri':
                ktri = ri.chosen
                rid = ktri['rid']
                kea = ktri['key_encryption_algorithm']
                entry = {'envelope': e, 'index': i, 'keyEncryption': kea['algorithm'].dotted}
                if kea['algorithm'].native == 'rsaes_oaep':
                    entry['oaepHash'] = kea['parameters']['hash_algorithm']['algorithm'].native
                if rid.name == 'issuer_and_serial_number':
                    ias = rid.chosen
                    stem = by_issuer.get((ias['issuer'].dump(), ias['serial_number'].native))
                    entry.update(idType='issuerAndSerialNumber', serialHex=ias['serial_number'].contents.hex().upper(),
                                 ski=None)
                else:
                    stem = by_ski.get(rid.chosen.native)
                    entry.update(idType='subjectKeyIdentifier', serialHex=None,
                                 ski=rid.chosen.native.hex().upper())
                cek = unwrap_ktri(ktri, ids[stem][1]) if stem else None
            else:
                kari = ri.chosen
                assert len(kari['recipient_encrypted_keys']) == 1
                rek = kari['recipient_encrypted_keys'][0]
                ias = rek['rid'].chosen
                stem = by_issuer.get((ias['issuer'].dump(), ias['serial_number'].native))
                entry = {'envelope': e, 'index': i, 'idType': 'keyAgreement',
                         'keyEncryption': kari['key_encryption_algorithm']['algorithm'].dotted,
                         'serialHex': ias['serial_number'].contents.hex().upper(), 'ski': None}
                cek = unwrap_kari(kari, rek, ids[stem][1]) if stem else None
            by_name = stem and entry['idType'] != 'subjectKeyIdentifier'
            entry['issuer'] = ids[stem][0].issuer.rfc4514_string() if by_name else None
            entry['cert'] = stem
            entry['contentCipher'] = cipher_oid
            summary.append({k: entry[k] for k in ('envelope', 'index', 'idType', 'issuer', 'serialHex', 'ski', 'cert',
                                                   'keyEncryption', 'contentCipher', 'oaepHash') if k in entry})
            if cek is not None and stem not in opened:
                content = decrypt_content(cipher_oid, cek, alg['parameters'].native, eci['encrypted_content'].native)
                assert len(content) == 24, len(content)
                opened[stem] = (content[:20], int.from_bytes(content[20:], 'big'), e)
    return summary, opened


def der_issuer(cert: x509.Certificate) -> bytes:
    return asn1_x509.Certificate.load(der(cert)).issuer.dump()


# --- pyHanko, reading the way the app should -----------------------------------------------------

@contextlib.contextmanager
def tolerant_pyhanko():
    """pyHanko 0.37 refuses a /Recipients entry that is not CMS and a SubjectKeyIdentifier
    recipient. For checking those two files, skip bad entries and match by SKI too."""
    orig_info, orig_seed = ph_pubkey._read_generic_pubkey_cf_info, ph_pubkey.read_seed_from_recipient_cms

    def read_info(cfdict):
        recipients = cfdict['/Recipients']
        if isinstance(recipients, generic.ByteStringObject):
            recipients = (recipients,)
        objs = []
        for x in recipients:
            try:
                ci = cms.ContentInfo.load(x.original_bytes)
                _ = ci.native
                objs.append(ci)
            except ValueError:
                objs.append(RawBlob(x.original_bytes))
        return {'recipients': objs, 'encrypt_metadata': cfdict.get('/EncryptMetadata', True)}

    def read_seed(recp, decrypter):
        return (None, None) if isinstance(recp, RawBlob) else orig_seed(recp, decrypter)

    def read_key(ed, decrypter):
        for ri in ed['recipient_infos']:
            if ri.name != 'ktri':
                continue
            rid = ri.chosen['rid']
            if rid.name == 'subject_key_identifier':
                match = rid.chosen.native == decrypter.cert.key_identifier
            else:
                match = (rid.chosen['issuer'] == decrypter.cert.issuer
                         and rid.chosen['serial_number'].native == decrypter.cert.serial_number)
            if match:
                return decrypter.decrypt(ri.chosen['encrypted_key'].native, ri.chosen['key_encryption_algorithm'])
        return None

    saved = ph_pubkey.read_envelope_key
    ph_pubkey._read_generic_pubkey_cf_info = read_info
    ph_pubkey.read_seed_from_recipient_cms = read_seed
    ph_pubkey.read_envelope_key = read_key
    try:
        yield
    finally:
        ph_pubkey._read_generic_pubkey_cf_info = orig_info
        ph_pubkey.read_seed_from_recipient_cms = orig_seed
        ph_pubkey.read_envelope_key = saved


def first_page(reader):
    node = reader.root['/Pages']
    while node.get('/Type') != '/Page':
        node = node['/Kids'][0].get_object()
    return node


def page_text_bytes(page) -> bytes:
    contents = page['/Contents']
    if isinstance(contents, generic.ArrayObject):
        return b''.join(c.get_object().data for c in contents)
    return contents.data


def object_key(K: bytes, version: int, cfm: str, num: int, gen: int) -> bytes:
    if version == 5:
        return K
    salt = b'sAlT' if cfm == '/AESV2' else b''
    return hashlib.md5(K + num.to_bytes(3, 'little') + gen.to_bytes(2, 'little') + salt).digest()[:min(len(K) + 5, 16)]


def own_decrypt(data: bytes, K: bytes, version: int, cfm: str, ref) -> bytes:
    """Decrypt one stream with K by hand (no pyHanko key derivation)."""
    raw = PdfFileReader(io.BytesIO(data), strict=False).get_object(ref, never_decrypt=True).encoded_data
    key = object_key(K, version, cfm, ref.idnum, ref.generation)
    if cfm == '/V2':
        d = Cipher(ARC4(key), mode=None).decryptor()
        return d.update(raw) + d.finalize()
    d = Cipher(algorithms.AES(key), modes.CBC(raw[:16])).decryptor()
    plain = d.update(raw[16:]) + d.finalize()
    return plain[:-plain[-1]]


# --- Main ----------------------------------------------------------------------------------------

def main():
    ids = make_pki()
    source = make_source()
    write(HERE / 'source.pdf', source)
    text_pdf = TEXT_PDF.read_bytes()

    alice, bob, stranger, ecc = (ph_cert(s) for s in ('alice', 'bob', 'stranger', 'ec'))
    pdfs = {}

    def add(file, data, *, src=source, opens=('alice',), title=SOURCE_TITLE, expected_title=None,
            how='', strict=True, tolerant=False, layout='table', objstm=False, revisions=1,
            signatures=0, description=''):
        pdfs[file] = dict(data=data, src=src, opens=list(opens), title=title,
                          expected_title=expected_title or title, how=how, strict=strict,
                          tolerant=tolerant, layout=layout, objstm=objstm, revisions=revisions,
                          signatures=signatures, description=description)

    v5_alice = lambda: v5([alice])  # noqa: E731
    add('v5-classic.pdf', simple_file(source, 'v5-classic', v5_alice),
        how='build_from_certs([alice], pdf_mac=False); copy_into_new_writer(stream_xrefs=False)',
        description='V5 AES-256, classic xref table')
    objstm = simple_file(source, 'v5-objstm', v5_alice, xref_stream=True, object_streams=True)
    add('v5-objstm.pdf', objstm, layout='stream', objstm=True,
        how='build_from_certs([alice], pdf_mac=False); stream_xrefs=True, every non-stream object '
            'moved into one object stream',
        description='V5, xref stream, annotation and every other dictionary inside an object stream')
    add('v5-incremental.pdf', incremental_title(objstm, 'v5-incremental'), layout='stream', objstm=True,
        revisions=2, expected_title=UPDATED_TITLE,
        how='v5-objstm.pdf + IncrementalPdfFileWriter.encrypt_pubkey(alice), /Info rewritten (same object number)',
        description='v5-objstm.pdf plus an incremental update that changes /Title; the newest revision wins')
    add('v5-nometa.pdf', simple_file(source, 'v5-nometa', lambda: v5([alice], encrypt_metadata=False),
                                     clear_xmp=True),
        how='build_from_certs([alice], encrypt_metadata=False, pdf_mac=False); XMP stream written in clear '
            'without a /Crypt filter',
        description='EncryptMetadata false: the XMP stream is plain text (no /Crypt filter), the file key '
                    'hashes FF FF FF FF')
    def bob_then_alice():
        sh = v5([bob, alice])
        cf = default_filter(sh)
        cf.recipients = [in_given_order(cf.recipients[0], [bob, alice])]
        return sh
    add('v5-two-recipients.pdf', simple_file(source, 'v5-two-recipients', bob_then_alice),
        opens=('alice', 'bob'),
        how='build_from_certs([bob, alice], pdf_mac=False); envelope re-encoded with bob\'s RecipientInfo first '
            '(asn1crypto sorts the SET OF, which put alice first)',
        description='one envelope with two RecipientInfos: bob first, then alice')

    def two_envelopes():
        sh = v5([bob])
        sh.add_recipients([alice], perms=PRINT_ONLY)
        return sh
    add('v5-two-envelopes.pdf', simple_file(source, 'v5-two-envelopes', two_envelopes), opens=('alice', 'bob'),
        how='build_from_certs([bob], pdf_mac=False); add_recipients([alice], perms=ALLOW_PRINTING | '
            'ALLOW_HIGH_QUALITY_PRINTING | TOLERATE_MISSING_PDF_MAC)',
        description='two envelopes: [bob] with all permissions, then [alice] with printing only')
    add('v5-oaep.pdf', simple_file(source, 'v5-oaep', lambda: v5(
        [alice], policy=RecipientEncryptionPolicy(prefer_oaep=True))),
        how='build_from_certs([alice], policy=RecipientEncryptionPolicy(prefer_oaep=True), pdf_mac=False)',
        description='RSAES-OAEP key transport (SHA-256, MGF1 SHA-256)')
    add('v5-ski.pdf', own_envelope_file(source, 'v5-ski', 'aes256_cbc', by_ski=True), tolerant=True,
        how='build_from_certs([alice], pdf_mac=False), envelope replaced by build_envelope(by_ski=True)',
        description='alice identified by SubjectKeyIdentifier (EnvelopedData and KeyTransRecipientInfo version 2)')
    add('v5-env-aes128.pdf', own_envelope_file(source, 'v5-env-aes128', 'aes128_cbc', by_ski=False),
        how='build_from_certs([alice], pdf_mac=False), envelope replaced by build_envelope(aes128_cbc)',
        description='envelope content encrypted with AES-128-CBC')
    add('v5-env-3des.pdf', own_envelope_file(source, 'v5-env-3des', 'tripledes_3key', by_ski=False),
        how='build_from_certs([alice], pdf_mac=False), envelope replaced by build_envelope(des-ede3-cbc)',
        description='envelope content encrypted with des-ede3-cbc, as Acrobat 7 to X did')
    add('v4-aes128.pdf', simple_file(source, 'v4-aes128', lambda: v4([alice])),
        how='build_from_certs([alice], keylen_bytes=16, version=RC4_OR_AES128, use_aes=True, pdf_mac=False)',
        description='V4, AESV2 (AES-128), classic xref table')
    add('v4-aes128-objstm.pdf', simple_file(source, 'v4-aes128-objstm', lambda: v4([alice]), xref_stream=True,
                                            object_streams=True), layout='stream', objstm=True,
        how='as v4-aes128.pdf; stream_xrefs=True, every non-stream object moved into one object stream',
        description='V4, AESV2, xref stream and object streams')
    add('v4-rc4.pdf', simple_file(source, 'v4-rc4', lambda: v4([alice], use_aes=False)),
        how='build_from_certs([alice], keylen_bytes=16, version=RC4_OR_AES128, use_aes=False, pdf_mac=False)',
        description='V4 with a /V2 (RC4) crypt filter, 128-bit, classic xref table')
    add('v5-mac.pdf', simple_file(source, 'v5-mac', lambda: PubKeySecurityHandler.build_from_certs([alice])),
        how='build_from_certs([alice]) (pyHanko defaults: pdf_mac=True)',
        description='pyHanko default: ISO/TS 32004 PDF MAC (/AuthCode, /KDFSalt), MAC-required permission bit cleared')
    add('v5-signed.pdf', signed_file(source, 'v5-signed'), revisions=2, signatures=1,
        how='build_from_certs([alice], pdf_mac=False), then IncrementalPdfFileWriter.encrypt_pubkey(alice) + '
            'signers.sign_pdf(PdfSignatureMetadata(field_name="Signature1", md_algorithm="sha256"), '
            'SimpleSigner(alice.key, alice.crt, ca.crt))',
        description='certificate encrypted, then signed by alice in an incremental update (field Signature1)')
    add('stranger-only.pdf', simple_file(source, 'stranger-only', lambda: v5([stranger])), opens=('stranger',),
        how='build_from_certs([stranger], pdf_mac=False)',
        description='only stranger can open it ("not a recipient" for alice)')
    add('v5-ec.pdf', simple_file(source, 'v5-ec', lambda: v5(
        [ecc], policy=RecipientEncryptionPolicy(ignore_key_usage=True))), opens=('ec',),
        how='build_from_certs([ec], policy=RecipientEncryptionPolicy(ignore_key_usage=True), pdf_mac=False)',
        description='EC recipient: KeyAgreeRecipientInfo, ECDH dhSinglePass-stdDH-sha256kdf, AES-128 key wrap')
    add('v5-damaged-first.pdf', damaged_first(source, 'v5-damaged-first'), tolerant=True,
        how='build_from_certs([bob], pdf_mac=False); add_recipients([alice]); first /Recipients entry '
            'truncated to half its length',
        description='two envelopes; the first (for bob) is truncated and not valid DER, the second is for alice')
    add('v5-direct-encrypt.pdf', inline_encrypt(pdfs['v5-classic.pdf']['data']), strict=False,
        how='v5-classic.pdf with the Encrypt object moved into the trailer (byte surgery)',
        description='v5-classic.pdf with /Encrypt as a direct dictionary in the trailer (same seed and file key)')
    add('text-v5.pdf', simple_file(text_pdf, 'text-v5', lambda: v5([alice, bob])), src=text_pdf,
        opens=('alice', 'bob'), title='Fixture Text Document',
        how='tests/fixtures/text.pdf; build_from_certs([alice, bob], pdf_mac=False)',
        description='../text.pdf (5 pages, outline, links) for alice and bob in one envelope, for e2e tests')

    expected = []
    for file, p in pdfs.items():
        data = p['data']
        write(HERE / file, data)
        expected.append(check(file, p, data, ids))

    write(HERE / 'expected.json', (json.dumps(
        {'_comment': 'Made by make_pubsec.py. TEST KEYS ONLY - never use for anything real. See README.md.',
         'files': expected}, indent=2, ensure_ascii=False) + '\n').encode('utf-8'))

    total = sum(f.stat().st_size for f in HERE.rglob('*') if f.is_file())
    for f in written:
        print(f'{f.relative_to(HERE)}  {f.stat().st_size}')
    print(f'folder total {total} bytes')


def check(file, p, data, ids):
    """Verify one file with pyHanko and with our own decryption; return its expected.json entry."""
    r = PdfFileReader(io.BytesIO(data), strict=p['strict'])
    enc = r.encrypt_dict
    assert enc['/Filter'] == '/Adobe.PubSec' and enc['/SubFilter'] == '/adbe.pkcs7.s5'
    version = int(enc['/V'])
    cf = enc['/CF']['/DefaultCryptFilter']
    cfm = cf['/CFM']
    blobs = [b.original_bytes for b in cf['/Recipients']]
    em = bool(cf.get('/EncryptMetadata', True))
    cipher = {'/AESV3': 'AESV3', '/AESV2': 'AESV2', '/V2': 'RC4'}[cfm]
    key_bits = 256 if version == 5 else int(cf.get('/Length', 128))
    if key_bits <= 16:
        key_bits *= 8  # /Length in a crypt filter may be bytes (ISO 32000-2, Table 25)

    recipients, opened = read_envelopes(blobs, ids)
    assert sorted(opened) == sorted(p['opens']), (file, sorted(opened), p['opens'])
    seeds = {s for s, _, _ in opened.values()}
    assert len(seeds) == 1, 'one seed per file'
    seed = seeds.pop()
    md = hashlib.sha256 if version == 5 else hashlib.sha1
    K = md(seed + b''.join(blobs) + (b'' if em else b'\xff\xff\xff\xff')).digest()[:key_bits // 8]

    # The source's page 1 content stream, as stored
    sr = PdfFileReader(io.BytesIO(p['src']))
    src_page = first_page(sr)
    src_raw = src_page.raw_get('/Contents').get_object().encoded_data
    page1 = page_text_bytes(src_page)

    ctx = tolerant_pyhanko() if p['tolerant'] else contextlib.nullcontext()
    with ctx:
        for stem in p['opens']:
            r = PdfFileReader(io.BytesIO(data), strict=p['strict'])
            res = r.decrypt_pubkey(credential(stem))
            assert res.status == AuthStatus.USER, (file, stem, res)
            assert res.permission_flags.as_uint32() == opened[stem][1], (file, stem)
            page = first_page(r)
            text = page_text_bytes(page)
            assert text == page1, file
            if p['title'] == SOURCE_TITLE:
                assert PAGE1_TEXT.encode() in text, file
                annots = [a.get_object() for a in page['/Annots']]
                notes = [str(a['/Contents']) for a in annots if a['/Subtype'] == '/Text']
                assert notes == [NOTE_TEXT], (file, notes)
            title = r.trailer_view['/Info']['/Title']
            assert title == p['expected_title'], (file, title)
            ref = page.raw_get('/Contents').reference
            assert own_decrypt(data, K, version, cfm, ref) == src_raw, f'{file}: own K does not decrypt'
            if p['signatures']:
                sigs = r.embedded_signatures
                assert len(sigs) == 1 and len(list(enumerate_sig_fields(r))) == 1
                vc = ValidationContext(trust_roots=[load_cert_from_pemder(str(PKI / 'ca.crt'))],
                                       allow_fetching=False)
                # alice's key usage has digitalSignature but not nonRepudiation (pyHanko's default ask)
                status = validate_pdf_signature(sigs[0], vc, key_usage_settings=KeyUsageConstraints(
                    key_usage={'digital_signature'}))
                assert status.intact and status.valid and status.trusted, status.pretty_print_details()
        others = [s for s in ('alice', 'stranger') if s not in p['opens']]
        for stem in others:
            r = PdfFileReader(io.BytesIO(data), strict=p['strict'])
            assert r.decrypt_pubkey(credential(stem)).status == AuthStatus.FAILED, (file, stem)

    if p['objstm']:
        assert b'/Annot' not in data and b'/ObjStm' in data, f'{file}: annotation not in an object stream'
    else:
        assert b'/Annot' in data
    assert (XMP_MARKER.encode() in data) == (not em), file
    assert (b'/AuthCode' in data) == (file == 'v5-mac.pdf'), file
    assert data.count(b'%%EOF') == p['revisions'], file
    print(f'ok  {file}: V{version} {cipher} opens with {", ".join(p["opens"])}')

    return {
        'file': file,
        'description': p['description'],
        'version': version,
        'cipher': cipher,
        'keyBits': key_bits,
        'subFilter': 'adbe.pkcs7.s5',
        'xref': p['layout'],
        'objectStreams': p['objstm'],
        'revisions': p['revisions'],
        'encryptDirect': not p['strict'],
        'pdfMac': b'/AuthCode' in data,
        'signatures': p['signatures'],
        'recipients': recipients,
        'opensWith': p['opens'],
        'permissions': {stem: opened[stem][1] for stem in p['opens']},
        'encryptMetadata': em,
        'seedHex': {stem: opened[stem][0].hex() for stem in p['opens']},
        'fileKeyHex': K.hex(),
        'title': p['title'],
        'expectedTitle': p['expected_title'],
        'pages': int(sr.root['/Pages']['/Count']),
        'pyhanko': p['how'],
    }


if __name__ == '__main__':
    main()
