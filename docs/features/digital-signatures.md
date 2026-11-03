# Feature: digital-signatures

Certificate-based digital signatures (Acrobat 'Use a certificate', tool group 'certificate') and signature validation.

- Digital IDs: Preferences section 'Digital IDs' and a picker in the sign flow: import .pfx/.p12 (file path stored in store 'digital-signatures:ids' with name/email/issuer/expiry; password asked at signing time, never stored), create a new self-signed Digital ID (name, organisation, email, country, key RSA 2048 / ECDSA P-256 if feasible, validity years) saved as a password-protected .p12 under <userData>/digital-ids/ (systemInfo.userDataPath; write with invoke('file:write')), export the public certificate (.cer), remove ID. Use node-forge (installed) for PKCS#12 parsing/creation and X.509; use WebCrypto (crypto.subtle, available in the worker and UI) where it helps.
- Signing flow (commands sign.useCertificate, tool sign.certificateBox, 'Digitally sign' and 'Certify (visible signature)' / 'Certify (invisible)' rows in the panel; also handle window 'fartcrobat:sign-field' for clicks on existing unsigned signature fields from forms-fill): drag a rectangle (or use the clicked field) -> dialog: choose Digital ID, password, appearance preview (Acrobat-like: name in large text on the left or the user's saved visual signature image from store 'fill-sign:signature' if present, and on the right 'Digitally signed by <CN>', date, reason, location), reason, location, contact, for certify: allowed changes (none / form filling / form filling and annotations) with /DocMDP, 'Lock document after signing' (field /Lock). Then Save As dialog (Acrobat requires saving a signed copy) -> sign -> write file -> replaceDocumentBytes(doc, bytes, path) so the tab shows the signed file.
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
