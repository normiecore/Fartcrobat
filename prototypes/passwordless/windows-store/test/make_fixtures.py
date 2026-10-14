"""Test-only fixtures for the Windows certificate store helper (never shipped).

Creates a small PKI and certificate-encrypted (/Adobe.PubSec) PDFs with pyHanko.

Usage: python -I make_fixtures.py <src.pdf> <recipient.crt> <recipient.key> <outdir>

Certificates (outdir/pki):
  recipient   existing spike cert (KU digitalSignature+keyEncipherment), imported with key
  me-enc      RSA, KU keyEncipherment+dataEncipherment, EKU emailProtection, imported with key
  me-sign     RSA, KU digitalSignature+nonRepudiation only, imported with key (not for encryption)
  me-noku     RSA, no key usage extension, imported with key (usable)
  me-ec       EC P-256, KU keyAgreement, imported with key
  me-expired  RSA, KU keyEncipherment, expired, imported with key
  me-nokey    RSA, KU keyEncipherment, imported WITHOUT key
  colleague   RSA, KU keyEncipherment, public cert only (.cer DER, .pem, and in colleagues.p7b)

PDFs (outdir/pdf):
  pubsec-me-enc.pdf          one envelope, one recipient (me-enc)
  pubsec-multi.pdf           one envelope, two RecipientInfos (colleague first, then recipient)
  pubsec-two-envelopes.pdf   two envelopes: [colleague] then [recipient] (different permissions)
  pubsec-oaep.pdf            recipient, RSAES-OAEP key transport
  pubsec-colleague-only.pdf  nobody in the store can open it
  pubsec-ec.pdf              me-ec, ECDH key agreement (KeyAgreeRecipientInfo)
  pubsec-expired.pdf         me-expired (expired certs still decrypt)
"""
import datetime as dt
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import pkcs7, pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.crypt import PubKeySecurityHandler
from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
from pyhanko.pdf_utils.crypt.pubkey import RecipientEncryptionPolicy
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.writer import copy_into_new_writer

src, rec_crt, rec_key, outdir = sys.argv[1:5]
out = Path(outdir)
pki = out / 'pki'
pdfs = out / 'pdf'
pki.mkdir(parents=True, exist_ok=True)
pdfs.mkdir(parents=True, exist_ok=True)
now = dt.datetime.now(dt.timezone.utc)


def ku(**on):
    names = ['digital_signature', 'content_commitment', 'key_encipherment', 'data_encipherment',
             'key_agreement', 'key_cert_sign', 'crl_sign', 'encipher_only', 'decipher_only']
    return x509.KeyUsage(**{n: on.get(n, False) for n in names})


def make(name, cn, key=None, key_usage=None, eku=None, not_after=None, not_before=None, email=None):
    key = key or rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Fartcrobat Store Test'),
    ])
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
         .public_key(key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(not_before or now - dt.timedelta(days=1))
         .not_valid_after(not_after or now + dt.timedelta(days=365)))
    if key_usage is not None:
        b = b.add_extension(key_usage, critical=True)
    if eku:
        b = b.add_extension(x509.ExtendedKeyUsage(eku), critical=False)
    if email:
        b = b.add_extension(x509.SubjectAlternativeName([x509.RFC822Name(email)]), critical=False)
    cert = b.sign(key, hashes.SHA256())
    (pki / f'{name}.cer').write_bytes(cert.public_bytes(serialization.Encoding.DER))
    (pki / f'{name}.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (pki / f'{name}.key').write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return cert, key


def pfx(name, cert, key):
    data = pkcs12.serialize_key_and_certificates(
        name.encode(), key, cert, None, serialization.BestAvailableEncryption(b'test'))
    (pki / f'{name}.p12').write_bytes(data)


certs = {}
certs['me-enc'] = make('me-enc', 'Store Test Me (encryption)', key_usage=ku(key_encipherment=True, data_encipherment=True),
                       eku=[ExtendedKeyUsageOID.EMAIL_PROTECTION], email='me@example.test')
certs['me-sign'] = make('me-sign', 'Store Test Me (signing only)', key_usage=ku(digital_signature=True, content_commitment=True))
certs['me-noku'] = make('me-noku', 'Store Test Me (no key usage) éè \U0001F511')
certs['me-ec'] = make('me-ec', 'Store Test Me (EC)', key=ec.generate_private_key(ec.SECP256R1()),
                      key_usage=ku(key_agreement=True, digital_signature=True))
certs['me-expired'] = make('me-expired', 'Store Test Me (expired)', key_usage=ku(key_encipherment=True),
                           not_before=now - dt.timedelta(days=400), not_after=now - dt.timedelta(days=30))
certs['me-nokey'] = make('me-nokey', 'Store Test Me (no private key)', key_usage=ku(key_encipherment=True))
certs['colleague'] = make('colleague', 'Store Test Colleague', key_usage=ku(key_encipherment=True),
                          email='colleague@example.test')

for name in ['me-enc', 'me-sign', 'me-noku', 'me-ec', 'me-expired']:
    pfx(name, *certs[name])

# the existing spike recipient
recipient = x509.load_pem_x509_certificate(Path(rec_crt).read_bytes())
recipient_key = serialization.load_pem_private_key(Path(rec_key).read_bytes(), None)
(pki / 'recipient.cer').write_bytes(recipient.public_bytes(serialization.Encoding.DER))
(pki / 'recipient.key').write_bytes(Path(rec_key).read_bytes())
(pdfs / 'source-text.pdf').write_bytes(Path(src).read_bytes())
pfx('recipient', recipient, recipient_key)

# a certs-only PKCS#7 (.p7b) such as Windows "Export > PKCS #7" produces
p7b = pkcs7.serialize_certificates([certs['colleague'][0], certs['me-nokey'][0]], serialization.Encoding.DER)
(pki / 'colleagues.p7b').write_bytes(p7b)


def ph(name):
    return load_cert_from_pemder(str(pki / f'{name}.pem')) if name != 'recipient' else load_cert_from_pemder(rec_crt)


def write(name, sh):
    with open(src, 'rb') as f:
        w = copy_into_new_writer(PdfFileReader(f))
    w._assign_security_handler(sh)
    with open(pdfs / name, 'wb') as o:
        w.write(o)
    print('wrote', name)


restricted = PubKeyPermissions.allow_everything() & ~PubKeyPermissions.ALLOW_MODIFICATION_GENERIC

write('pubsec-me-enc.pdf', PubKeySecurityHandler.build_from_certs([ph('me-enc')]))
write('pubsec-multi.pdf', PubKeySecurityHandler.build_from_certs([ph('colleague'), ph('recipient')]))
sh = PubKeySecurityHandler.build_from_certs([ph('colleague')])
sh.add_recipients([ph('recipient')], perms=restricted)
write('pubsec-two-envelopes.pdf', sh)
write('pubsec-oaep.pdf', PubKeySecurityHandler.build_from_certs(
    [ph('recipient')], policy=RecipientEncryptionPolicy(prefer_oaep=True)))
write('pubsec-colleague-only.pdf', PubKeySecurityHandler.build_from_certs([ph('colleague')]))
write('pubsec-ec.pdf', PubKeySecurityHandler.build_from_certs(
    [ph('me-ec')], policy=RecipientEncryptionPolicy(ignore_key_usage=True)))
write('pubsec-expired.pdf', PubKeySecurityHandler.build_from_certs(
    [ph('me-expired')], policy=RecipientEncryptionPolicy(ignore_key_usage=True)))
