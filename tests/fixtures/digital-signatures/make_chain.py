"""Certificate chains for the chain-building tests (tests/engine/digital-signatures-chain.test.ts).

TEST KEYS ONLY - never use for anything real. Keys are EC P-256 derived from fixed labels, so
anyone can recompute them; every certificate carries OU=TEST KEYS ONLY. ECDSA signatures are
randomised, so running this again gives different (equally valid) files. Only the DER
certificates (chain/<name>.cer) are written; tests never run this script.

Run from anywhere:  python3 -I tests/fixtures/digital-signatures/make_chain.py
Needs the cryptography package.

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
"""
import datetime
import hashlib
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

OUT = Path(__file__).resolve().parent / "chain"
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


def make(label, issuer=None, ca=False, path_len=None, cert_sign=None, start=START, end=END):
    key = key_for(label)
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
        .add_extension(x509.BasicConstraints(ca=ca, path_length=path_len), critical=True)
        .add_extension(
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
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(pub), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False)
    )
    cert = builder.sign(issuer_key, hashes.SHA256())
    CERTS[label] = (cert, key)
    (OUT / f"{label}.cer").write_bytes(cert.public_bytes(serialization.Encoding.DER))


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


if __name__ == "__main__":
    main()
