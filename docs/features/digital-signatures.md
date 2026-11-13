# Feature: digital-signatures

Certificate-based digital signatures (Acrobat 'Use a certificate', tool group 'certificate') and signature validation.

- Digital IDs: Preferences section 'Digital IDs' and a picker in the sign flow: import .pfx/.p12 (file path stored in store 'digital-signatures:ids' with name/email/issuer/expiry; password asked at signing time, never stored), create a new self-signed Digital ID (name, organisation, email, country, key RSA 2048 / ECDSA P-256 if feasible, validity years) saved as a password-protected .p12 under <userData>/digital-ids/ (systemInfo.userDataPath; write with invoke('file:write')), export the public certificate (.cer), remove ID. Use node-forge (installed) for PKCS#12 parsing/creation and X.509; use WebCrypto (crypto.subtle, available in the worker and UI) where it helps.
- Signing flow (commands sign.useCertificate, tool sign.certificateBox, 'Digitally sign' and 'Certify (visible signature)' / 'Certify (invisible)' rows in the panel; also handle window 'inkmoor:sign-field' for clicks on existing unsigned signature fields from forms-fill): drag a rectangle (or use the clicked field) -> dialog: choose Digital ID, password, appearance preview (Acrobat-like: name in large text on the left or the user's saved visual signature image from store 'fill-sign:signature' if present, and on the right 'Digitally signed by <CN>', date, reason, location), reason, location, contact, for certify: allowed changes (none / form filling / form filling and annotations) with /DocMDP, 'Lock document after signing' (field /Lock). Then Save As dialog (Acrobat requires saving a signed copy) -> sign -> write file -> replaceDocumentBytes(doc, bytes, path) so the tab shows the signed file.
- Engine namespace 'digital-signatures' (in the worker): 1) prepare: create (or reuse) the signature field + widget (FT Sig, appearance stream built from the chosen appearance: text via base-14 Helvetica + optional image XObject), a /V signature dictionary (/Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached (or adbe.pkcs7.detached) /Reason /Location /ContactInfo /M date /ByteRange placeholder [0 /********** /********** /**********] /Contents <000...> with room for ~16 KB), for certify /Reference with /TransformMethod /DocMDP and catalog /Perms /DocMDP; 2) save incrementally (s.pdf.saveToBuffer('incremental') — keep the Contents placeholder uncompressed; find the exact byte offsets of /ByteRange and /Contents of YOUR signature dictionary in the incremental section), patch ByteRange with real offsets (same width), compute SHA-256 over the two ranges, build a CMS SignedData (detached, signed attributes contentType, messageDigest, signingTime, and ESS signingCertificateV2 for CAdES; include the certificate chain from the p12) with node-forge (or hand-built ASN.1), RSA PKCS#1 v1.5 SHA-256 (ECDSA if you support it), hex-encode into Contents padding with zeros; return the final bytes. Signing must also work on documents that already have signatures (append another incremental update; earlier signatures stay valid) and on encrypted documents if MuPDF supports incremental save there (otherwise explain).
- Validation (right panel 'signatures', order 40; also a message bar 'Signed and all signatures are valid' / 'At least one signature has problems' like Acrobat): for each signature field with /V: parse ByteRange and Contents from s.sourceBytes, check the ranges cover the whole file except Contents (and whether later revisions exist: report 'The document has been modified since this signature was applied' with what changed if feasible), compute the digest and compare to the messageDigest attribute, verify the signature over the signed attributes with the signer certificate public key (WebCrypto RSA/ECDSA), show signer name, signing time, reason, location, certificate details (subject, issuer, serial, validity, key usage, fingerprint) in a dialog, trust status: 'Signature is valid, but the signer's identity is unknown' for self-signed/untrusted (no trust store; allow 'Trust this certificate' stored in store 'digital-signatures:trusted' by SHA-256 fingerprint -> then valid with known identity), certified documents show the MDP permission. 'View signed version' extracts the revision bytes up to the end of that signature's ByteRange and opens it in a new tab (openNewDocument). Panel actions: Validate all, Signature properties, Clear unsigned?/(Clear signature field is optional).
- Unit tests (critical): create a self-signed ID in the test, sign text.pdf, then validate -> valid & integrity ok; tamper a byte inside the signed range -> invalid; sign twice -> both valid; verify the produced file opens in MuPDF and pypdf (python3 -c 'import pypdf' is available; check pypdf sees /Sig fields and ByteRange covers the file), and if `openssl` exists on the machine, verify the CMS with `openssl cms -verify -binary -noverify -inform DER -content <signed ranges>`.
e2e: open text.pdf, create a self-signed Digital ID in Preferences (stub nothing; write into the throwaway userData), sign by dragging a rectangle on page 1 (stub file:saveDialog to a temp path), check the tab reloads and the signatures panel shows one valid signature with 'identity unknown'; screenshot of the appearance and panel.

## Changes after signing: the status fails closed (owner decision, Nov 2026)

A signature whose byte range does not reach the end of the file is followed by later updates.
Its status is decided like this (`status.ts`, `worker/validate.ts`, `worker/later.ts`):

- **Only later signatures** keep it valid (`laterUpdates: 'signing'`). `later.ts` checks every
  object the later updates define, and accepts only: the signature dictionary of a later signature
  whose bytes verified (and the newest signature covers the whole file); a new top-level signature
  field and its widgets (no actions), or an empty signature field of the signed revision that only
  gained /V, /AP and, if it had none, /F and /Lock; new appearance objects of those; pages,
  /Annots, the catalog, the form and /Fields with only those new widgets or fields appended (and
  /SigFlags bits 1 and 2 set); objects written again with the same value; new cross-reference and
  object streams whose dictionaries refer to nothing. A new object must not have a number the
  signed revision already refers to. Anything else, or anything it cannot read, counts as a change.
- **Anything else** (filling in a form, a comment, validation data, an object nothing seems to use,
  changes that cannot be checked) caps the level at **warning**, whether the signer allowed it or
  not. The title is "The document was changed after it was signed." and the details point to
  **View Signed Version** (Signature Properties and the signatures panel), which opens the bytes
  `[0, end of the byte range)` in a new tab that is not linked to the file.
- `describeChanges` (`worker/changes.ts`) only describes: the list of changes shown to the person,
  each marked allowed or not by the signer's rules. It never raises a level. When it finds nothing
  to describe for a change, an "Other parts of the document were changed" entry is added.
- **Invalid** stays for what breaks the signer's rules: a change the certification (DocMDP) or the
  field lock does not allow, changes that cannot be checked under such rules, and any later update
  at all (even a signature) after a certification with P=1 or a lock with P=1
  (`permissionInForce`).
- Field locks are judged as signed: names come from the signed revision and are also matched by
  object number, so renaming or re-parenting a locked field does not unlock it (and under a lock
  any /T or /Parent change is not allowed); `/Action /Exclude` locks every field but the listed
  ones; a listed parent name covers its descendants; an action we do not know locks everything.
  An object shared by several annotations (a /DR font used by every widget) counts as part of each
  of them, and a widget written directly in /Annots is judged as a field, never as a comment.
- Agent access reports the same level and title (`list_signatures`: `status`, `summary`,
  `changedAfterSigning` is false only when nothing or only later signatures followed;
  `signedAgainLater` marks the latter).

## Certificate chains and timestamps

- Trust flows down a chain only through issuers that may issue certificates (CA basic
  constraints, keyCertSign, path length, valid at the signing time); a trusted certificate above
  the signer counts only when it is a CA (`chainTrustedIndex` in `status.ts`, `buildChain` in
  `lib/x509.ts`).
- A timestamp's time is relied on only when its token verified, the token's own signer has the
  time-stamping extended key usage and was valid at that time, and that signer is trusted
  (`timestampTrusted`). Otherwise the time shown is what the signer claims, with a note
  (`signingTimeNote`), in the panel, Signature Properties and agent output.
- A document timestamp is `/Type /DocTimeStamp` with `/SubFilter /ETSI.RFC3161`; its authority is
  the token's signer, never a timestamp nested in the token. The token must be marked as
  id-ct-TSTInfo. Any other combination (a /DocTimeStamp in CMS format, an RFC 3161 token as a /Sig)
  is malformed and invalid. A timestamp never certifies a document: a DocMDP /Reference in its
  dictionary is a problem, and /Perms /DocMDP naming it is ignored (with a warning). Its P never
  locks the document either, whether or not /Perms names it.
- A document is certified only by a signature whose own (signed) dictionary carries a DocMDP
  /Reference. The catalog's /Perms /DocMDP is not covered by any signature, so it never certifies
  on its own: when no signature makes a certification, a /Perms /DocMDP that is a direct
  dictionary, points at some other object, or names a signature without a DocMDP reference leaves
  `certified` null and adds a warning ("The document claims to be certified, but no signature in
  it certifies it", or on the signature it names).

## Signatures copied from another file (Nov 2026, after feedback on 0.4.1)

Combining signed PDFs into one bundle (a court brief of DocuSign documents, for example) copies
each signature dictionary into the new file, but its byte range still describes the small original
file. Such a signature cannot be verified and stays **invalid**, as pdfsig and pyHanko (and, we
expect, Acrobat) report it (owner decision: no separate state), but it is explained:

- `copiedFromAnotherFile` (`worker/validate.ts`): the signature dictionary itself lies at or beyond
  the end of its byte range in this file (a dictionary is always inside the revision it signs), the
  file's cross-reference information is sound (no repair, no `revs.problem`) and the dictionary is
  defined by only one cross-reference section. A signed file that was altered and rewritten as a
  whole looks the same, so the problem text `COPIED_SIGNATURE` (`types.ts`) says what was signed is
  not in this document, that this usually comes from combining documents, and that a changed and
  re-saved document looks the same; it never says the document is unchanged. The title is
  "Signature is invalid: what was signed is not in this document." and, when every invalid
  signature is such a copy, the message bar says "At least one signature is invalid: what was
  signed is not in this document, usually because the signature was copied from another document."
  (`status.ts`). A copy whose dictionary lands inside the old byte range reads as altered.
- Any other byte range failure now starts with "The document has been altered or corrupted since
  the signature was applied." before the technical reason.
- The signer name is read, unverified, from the certificate in the signature (`claimedSigner` in
  `lib/cms.ts`) when the signed bytes cannot be found; before, "Signed by" was empty. A report built
  after an exception says "Unknown signer".
- A signature whose signed bytes are not in this file certifies and locks nothing
  (`signedBytesFound`, `certifies` in `status.ts`): it sets no DocMDP rules for the other
  signatures (`validateSignatures` skips a certification whose byte range does not check out),
  "Rev. N" numbers only signatures whose signed revision is in this file (`signedVersion` 0, and no
  `revision` for agents), the panel, Properties and the field tooltip say "Signed by" and show no
  allowed changes or lock, agents get kind "approval", and the report's `certified`, `certifiedBy`
  and `locked` ignore it (so the message bar does not say "Certified by").
