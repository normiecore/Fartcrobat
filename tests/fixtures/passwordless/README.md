# Certificate-encrypted PDF fixtures (passwordless)

**TEST KEYS ONLY - never use for anything real.** Every private key here is derived from a fixed
label in `make_pubsec.py`, so anyone can recompute it. Every certificate carries
`OU=TEST KEYS ONLY - never use for anything real`.

These fixtures are for the certificate encryption work in `docs/features/passwordless.md`
(`/Filter /Adobe.PubSec`). Regenerate them with:

```
python3 -I tests/fixtures/passwordless/make_pubsec.py
```

This needs pyHanko 0.37, cryptography, asn1crypto, reportlab and pypdf. The outputs are committed,
and tests never run the script.

Running the script again gives byte-identical files:

- keys come from a seeded generator;
- pyHanko's randomness (seeds, envelope keys, IVs, RSA padding, `/ID`, signing time) comes from a
  seeded DRBG for each file.

A `.p12` is the exception. It is only rewritten when its key, certificate or friendly name changes,
because PKCS#12 salts come from OpenSSL.

`expected.json` describes every encrypted PDF. Engine tests can use its `seedHex` to open files
without RSA (see "expected.json" below).

## Certificates and keys (`pki/`)

All keys are RSA 2048 unless noted, and all certificates are valid from 2025-01-01 to 2045-01-01.

- `.crt` is a PEM certificate and `.cer` is a DER certificate.
- `.key` is an unencrypted PKCS#8 PEM key.
- `.p12` uses PBES2 (PBKDF2-HMAC-SHA256, 2048 rounds, AES-256-CBC) for the key and the
  certificate, with an HMAC-SHA256 MAC. It holds one key and one certificate, with no chain.

| Files | Who | Issuer | Key usage, notes | .p12 password |
|---|---|---|---|---|
| `ca.crt`, `ca.cer` | CN=Fartcrobat Test CA | self-signed | CA. Name attributes are PrintableString. | (no key file) |
| `ca-unicode.crt`, `ca-unicode.cer` | CN=Fartcrobat Tëst CA Ünïcode ✓ | self-signed | CA. Name attributes are UTF8String. | (no key file) |
| `alice.crt/.cer/.key/.p12` | CN=Alice Test, alice@example.test | ca | keyEncipherment, dataEncipherment, digitalSignature; EKU emailProtection. The main recipient. Friendly name "Alice Test". | `alice-pass` |
| `bob.crt/.cer/.key/.p12` | CN=Bob Tëst, bob@example.test | ca-unicode | keyEncipherment. The serial's first byte has the high bit set, so the DER INTEGER starts with `00` (`serialHex` `00C702…`). | `bob-pass` |
| `stranger.crt/.cer/.key/.p12` | CN=Stranger Test | ca | keyEncipherment. Opens only `stranger-only.pdf`. | `stranger-pass` |
| `ec.crt/.cer/.key/.p12` | CN=EC Test | ca | EC P-256, keyAgreement. | `ec-pass` |
| `colleagues.p7b` | bob and stranger | | A certs-only PKCS#7 (DER), for "import recipients from .p7b". | |

All subjects are `O=Fartcrobat Test Keys, OU=TEST KEYS ONLY - never use for anything real, CN=…`.
The `issuer` strings in `expected.json` are cryptography's `rfc4514_string()`, for example
`CN=Fartcrobat Test CA,OU=TEST KEYS ONLY - never use for anything real,O=Fartcrobat Test Keys`.

### Windows store set (`pki/winstore/`, imported by `winstore/import_store.ps1`)

This set is ported from `prototypes/passwordless/windows-store/test/make_fixtures.py`. The
certificates are self-signed, with subject `CN=…, O=Fartcrobat Store Test, OU=TEST KEYS ONLY - never use for anything real`.
They have no SKI or AKI extensions, as in the spike. Every `.p12` password is `test`, and its
friendly name is the file stem. `.cer` is DER and `.pem` is PEM.

| Name | Files | Notes |
|---|---|---|
| `recipient` | `.cer .pem .key .p12` | **alice's certificate and key** under the spike's name, so the store opens every fixture made for alice. |
| `me-enc` | `.cer .pem .key .p12` | keyEncipherment + dataEncipherment, EKU emailProtection, me@example.test. |
| `me-sign` | `.cer .pem .key .p12` | digitalSignature + nonRepudiation only, so not an encryption certificate. |
| `me-noku` | `.cer .pem .key .p12` | No key usage extension. CN `Store Test Me (no key usage) éè 🔑`. |
| `me-ec` | `.cer .pem .key .p12` | EC P-256, keyAgreement + digitalSignature. |
| `me-expired` | `.cer .pem .key .p12` | keyEncipherment, valid only from 2020-01-01 to 2021-01-01. |
| `me-nokey` | `.cer .pem` | keyEncipherment, certificate only. It is imported into My without a key. |
| `colleague` | `.cer .pem` | keyEncipherment, colleague@example.test, public certificate only (AddressBook). |
| `colleagues.p7b` | | colleague and me-nokey. |

`winstore/import_store.ps1 -Pki <…>/pki/winstore` has the same body as the spike's script. It was
checked under pwsh 7.4 with a throwaway `HOME`. On Windows, run it only on a test VM or account.

The .NET subject strings now end in the OU, for example
`OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Store Test, CN=Store Test Me (no key usage) éè 🔑`.

## PDFs

`source.pdf` is plain, made with reportlab, with the XMP added by pypdf. It has:

- 2 Letter pages: page 1 says "Hello secret world" and "Second line of page one", and page 2 says
  "Page two text";
- Title "Secret title" and Author "Fartcrobat Tests";
- a `/Text` note "Note text in an object stream" on page 1;
- an outline with one bookmark per page;
- the AcroForm text field `name`, with the value "Field value";
- an uncompressed XMP `/Metadata` stream containing `xmp-marker-123`.

Page content streams are uncompressed, so a plaintext leak would be visible in raw bytes.

Every other PDF is made from `source.pdf` with pyHanko unless noted. Unless the row says otherwise,
it is V5, AES-256 (`/AESV3`), `/SubFilter /adbe.pkcs7.s5`, with a classic xref table. It has one
envelope for alice with all permissions, the PDF MAC is off, and EncryptMetadata is true.

pyHanko writes V5 files as `%PDF-2.0` and V4 files as `%PDF-1.7`. pyHanko's envelopes use
rsaEncryption (PKCS#1 v1.5, NULL parameters), AES-256-CBC content, version 0, and recipients
identified by issuerAndSerialNumber.

Every file opens with a certificate's `.p12` and the password from the table above.

| File | What it tests | Opens with | Permissions (uint32) |
|---|---|---|---|
| `v5-classic.pdf` | Classic xref table. | alice | alice `0xFFFFFFFF` |
| `v5-objstm.pdf` | Xref stream. Every non-stream object is in one object stream: catalog, pages, the annotation, Info. No `/Annot` appears in the raw bytes. | alice | `0xFFFFFFFF` |
| `v5-incremental.pdf` | `v5-objstm.pdf` plus an incremental update (its own xref stream with `/Prev`) that redefines the Info object 19 with Title "Updated secret title". The newest revision must win. Same seed as `v5-objstm.pdf`. | alice | `0xFFFFFFFF` |
| `v5-nometa.pdf` | EncryptMetadata false. The XMP stream is written in clear **without** a `/Crypt` filter, as Acrobat does, so `xmp-marker-123` is in the raw bytes. The file key hashes `FF FF FF FF` after the recipients. MuPDF ignores the flag and fails to "decrypt" the XMP. | alice | `0xFFFFFFFF` |
| `v5-two-recipients.pdf` | One envelope with two RecipientInfos: bob (index 0), then alice (index 1). | alice, bob | both `0xFFFFFFFF` |
| `v5-two-envelopes.pdf` | Two envelopes: [bob] with all permissions, then [alice] with printing only. | alice, bob | bob `0xFFFFFFFF` = 4294967295; alice `0xFFFFF8C5` = 4294965445 |
| `v5-oaep.pdf` | RSAES-OAEP key transport (`1.2.840.113549.1.1.7`), **SHA-256 with MGF1-SHA-256**, empty label. | alice | `0xFFFFFFFF` |
| `v5-ski.pdf` | alice identified by SubjectKeyIdentifier `D7445486090C462D17C8AAFE207ECC1141FD9F4E`. KeyTransRecipientInfo and EnvelopedData are version 2, with rsaEncryption (PKCS#1 v1.5) and AES-256-CBC content. | alice | `0xFFFFFFFF` |
| `v5-env-aes128.pdf` | Envelope content encrypted with AES-128-CBC (`2.16.840.1.101.3.4.1.2`). | alice | `0xFFFFFFFF` |
| `v5-env-3des.pdf` | Envelope content encrypted with des-ede3-cbc (`1.2.840.113549.3.7`), as Acrobat 7 to X did. | alice | `0xFFFFFFFF` |
| `v4-aes128.pdf` | V4, `/AESV2`, 128-bit, classic xref table. The file key is SHA-1(seed ‖ recipients), truncated to 16 bytes. | alice | `0xFFFFFFFF` |
| `v4-aes128-objstm.pdf` | V4, `/AESV2`, xref stream and object streams. | alice | `0xFFFFFFFF` |
| `v4-rc4.pdf` | **V4 with a `/CFM /V2` (RC4) crypt filter, `/Length 128`**. This is what pyHanko makes; it is not a V2 handler. | alice | `0xFFFFFFFF` |
| `v5-mac.pdf` | pyHanko's default, with the ISO/TS 32004 PDF MAC: `/KDFSalt` in Encrypt and `/AuthCode` in the trailer. pyHanko clears the "tolerate missing MAC" bit (4096). | alice | `0xFFFFEFFF` = 4294963199 |
| `v5-signed.pdf` | Encrypted, then signed by alice (with `ca.crt` as the chain) in an incremental update. It has one signature field, `Signature1`, `/adbe.pkcs7.detached`, signed on 2026-01-15T12:00:00Z. The signature validates as intact and trusted when ca is the trust root. | alice | `0xFFFFFFFF` |
| `stranger-only.pdf` | Encrypted only for stranger. alice gets "not a recipient". | stranger | `0xFFFFFFFF` |
| `v5-ec.pdf` | Recipient ec. KeyAgreeRecipientInfo with ECDH `dhSinglePass-stdDH-sha256kdf-scheme` (`1.3.132.1.11.1`) and AES-128 key wrap. pyHanko and OpenSSL open it. .NET on Linux ("KeyAgreement is not supported") and node-forge cannot, so the app should say `UNSUPPORTED`. | ec | `0xFFFFFFFF` |
| `v5-damaged-first.pdf` | Two envelopes. The first is a bob envelope truncated to half its length, so it is not valid DER. The second is a valid envelope for alice. The file key is computed over both blobs as written. | alice | `0xFFFFFFFF` |
| `v5-direct-encrypt.pdf` | `v5-classic.pdf` with `/Encrypt` moved into the trailer as a direct dictionary. Object 20 is now free, and the xref table was rebuilt. It has the same seed and file key as `v5-classic.pdf`. | alice | `0xFFFFFFFF` |
| `text-v5.pdf` | `../text.pdf` (5 pages, outline, links, Title "Fixture Text Document") for alice and bob in one envelope, for end-to-end tests. | alice, bob | both `0xFFFFFFFF` |

What the permission values mean (PubSec permissions, ISO 32000-2 Table 24):

- `0xFFFFFFFF` is everything allowed.
- `0xFFFFF8C5` is "printing only". It sets bits 3 (print) and 12 (high-quality print). It also
  sets bit 13, pyHanko's "tolerate missing MAC", and pyHanko's always-set mask `0xFFFFE0C1`.
- It clears bit 2 (change security), 4 (modify), 5 (copy), 6 (annotate), 9 (fill forms),
  10 (accessibility) and 11 (assemble).

### Readers that refuse some files

**pyHanko 0.37**

- It cannot match an SKI recipient (`NotImplementedError`).
- It fails on the damaged first envelope (`Insufficient data`) instead of skipping it.
- It needs `PdfFileReader(…, strict=False)` for `v5-direct-encrypt.pdf`.
- `make_pubsec.py` checks those files with pyHanko patched to skip bad blobs and match by SKI
  (`tolerant_pyhanko`). That is the behaviour the app should have.

**MuPDF**

- MuPDF refuses every file here ("unknown encryption handler").
- Through the spike's bridge (`prototypes/passwordless/certificate-open`, since removed, given only `seedHex`),
  every file opens with the right text, note, title and page count, and `wasRepaired()` is false.
  Two exceptions:
  - `v5-nometa.pdf` page text opens through the R6 bridge, but MuPDF fails on the clear XMP.
  - The spike's V4-only decrypt pass cannot do V5.

**node-forge 1.4.0**

- It reads every RSA `.p12`.
- It cannot read `ec.p12` or `winstore/me-ec.p12`, because it cannot parse EC certificates.
- It returns UTF8String name values (for example "Bob Tëst") as raw UTF-8 byte strings. Use
  `forge.util.decodeUtf8`.

## expected.json

`expected.json` has `files: [...]`, with one entry per encrypted PDF. Each entry has these fields.

**Encryption**

- `file`, `description`.
- `version`: 4 or 5. `cipher`: `"RC4"`, `"AESV2"` or `"AESV3"`. `keyBits`: 128 or 256.
- `subFilter`: always `"adbe.pkcs7.s5"`.
- `encryptMetadata`.

**Layout**

- `xref`: `"table"` or `"stream"`. `objectStreams`.
- `revisions`: the number of `%%EOF` sections.
- `encryptDirect`: true when `/Encrypt` is a direct dictionary.
- `pdfMac`.
- `signatures`.

**Recipients and keys**

- `recipients`: one entry per RecipientInfo, in file order. Each entry has:
  - `envelope`: the index in `/Recipients`. `index`: the index in that envelope's RecipientInfos.
  - `idType`: `"issuerAndSerialNumber"`, `"subjectKeyIdentifier"` or `"keyAgreement"`. A
    key-agreement recipient is identified by issuer and serial.
  - `issuer`: cryptography's RFC 4514 text, or null for SKI.
  - `serialHex`: the DER INTEGER content bytes, uppercase, including any leading `00`.
  - `ski`: uppercase hex, only for SKI recipients.
  - `cert`: which fixture certificate this is.
  - `keyEncryption` OID, `contentCipher` OID, and `oaepHash` for OAEP.
  - A damaged blob appears as `{ envelope, index: null, idType: null, …, damaged: true }`.
- `opensWith`: the fixture identities that can open the file.
- `permissions`: `{ name: uint32 }`. These are the 4 permission bytes (big-endian) from that
  person's envelope, read by decrypting it.
- `seedHex`: `{ name: 40 hex chars }`, the 20-byte seed from that person's envelope. All envelopes
  in a file share one seed.
- `fileKeyHex`: the file key K, computed with the expected seed:
  - V5: `SHA-256(seed ‖ every /Recipients blob as written ‖ [FF FF FF FF if EncryptMetadata is false])`;
  - V4: the SHA-1 of the same input, truncated to 16 bytes.

**Content**

- `title`: the source's original `/Title`. `expectedTitle`: what a correct reader shows, which is
  the newest revision.
- `pages`.
- `pyhanko`: how the file was made (the pyHanko calls and options).

## How the files were checked

`make_pubsec.py` checks every PDF each time it runs. For each person in `opensWith`:

- pyHanko opens the file with that person's `.p12`, gets `AuthStatus.USER`, and gets the expected
  permissions.
- Page 1's decrypted content equals the source's. For files made from `source.pdf`, it contains
  "Hello secret world", and the `/Text` note is present.
- `/Title` equals `expectedTitle`.

The script also checks:

- Its own decryption with `fileKeyHex` (no pyHanko key derivation) gives page 1's content stream
  as stored in the source.
- alice and stranger fail on files that are not theirs.
- The signature in `v5-signed.pdf` validates.

The seeds and permissions were also checked once with two other decrypters, outside the script:

- `openssl cms -decrypt`, which opens every envelope, including SKI, 3DES, AES-128, OAEP and ECDH,
  and rejects the damaged one;
- .NET `EnvelopedCms` under pwsh 7.4, which opens every RSA envelope, including SKI, 3DES and
  AES-128.
