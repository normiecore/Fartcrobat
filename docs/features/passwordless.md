# Feature: passwordless (remembered passwords and certificate encryption)

This feature lets people and AI agents open encrypted PDFs without typing anything after the first time:

1. **Remembered passwords.** The person types a document password once and ticks "Remember password on this device". From then on, Fartcrobat opens that file, its copies and its saved versions without asking. The password is stored with Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux.
2. **Certificate encryption** (PDF public-key security, `/Filter /Adobe.PubSec`). Fartcrobat opens files encrypted to a person's certificate, using their private key. The key can come from the Windows certificate store, a smart card, or a Fartcrobat Digital ID (.p12). Files are saved back still certificate-encrypted, and people can create new certificate-encrypted files for one or more recipients.

An AI agent that opens a file through agent access gets the same silent access as the person. Every such open is written to the agent audit log, without secrets.

**Status of this note.** This began as the design and plan, based on four spikes: three finished, and one that was stopped early and is replaced by a smaller check described in the appendix. Everything in it is now built; the "as built" sections say where the code is and where it differs from the plan, and they win where the two disagree.

- **Phases 0 and 1 (remembered passwords) are implemented** (14 October 2026). See "Remembered passwords as built".
- **Phases 2 to 6 (certificate encryption) are implemented** (14 October 2026). See "Certificate encryption as built". What needs Windows, a smart card or Acrobat is untested until the owner's team runs the manual checklist.

- **Verified** means a command was run and its output was read. **Inferred** means it was not.
- No spike had access to the Windows certificate store, a smart card or Acrobat. Everything about them is inferred until the manual checklist at the end has been run on real Windows machines.

## Owner decisions (13 October 2026, confirmed 14 October)

- Scope: remembered passwords and certificate encryption (open, save back, create). Purview and company password vaults are out of scope.
- Agents unlock remembered and certificate-encrypted files **silently**, like the person; every agent open is in the agent audit log.
- Smart cards: **PIN once per session**. A long-lived helper keeps the card unlocked while Fartcrobat runs (this changes D9 and D11 below: the helper is one process per app session, not per call, and while it holds an unlocked card an agent can open more card-protected files without the person). Stopping the helper (quit, or "Lock smart card" in the app) ends that.
- Saving a certificate-encrypted file that already has signatures: **warn, then allow** ("Saving will invalidate N signatures"); agents get the usual confirm prompt.
- Older AES-128 (V4) certificate-encrypted files are **upgraded to AES-256** when saved.
- Which Acrobat setting the team uses is unknown: support both V4 and V5 for opening; the Windows checklist will tell.

## Decisions

### D1. How a saved password is found

- **Decision.** A saved password is looked up by three keys, strongest first:
  - `lock`: a hash of the /Encrypt values;
  - `id`: a hash of trailer /ID[0];
  - `path`: a hash of the normalised path.
  
  There is no content hash.
- **Why.**
  - `lock` can never give an out-of-date match. It survives copies, renames, Save, Save As, incremental saves and Compress (verified).
  - `id` catches a file that was protected again with the same password.
  - `path` covers files without an /ID.
  - A whole-file hash would break on every save.

### D2. What is stored

- **Decision.**
  - Store exactly what was typed (user or owner password), plus its level.
  - The store is `<userData>/saved-passwords.json`, with file mode 0600 and atomic writes.
  - It holds ciphertext only, and at most 500 records.
- **Why.** This was verified with real Electron 44 safeStorage across app restarts.

### D3. Which safeStorage API

- **Decision.** Use the **async** safeStorage API. On Linux, treat a `v10` ciphertext as "no keyring".
- **Why.**
  - On Linux the reported backend name is wrong in 2 of the 5 setups tested.
  - Without a keyring, the async API still "succeeds" by using Chromium's built-in key, which protects nothing (verified).

### D4. The Remember checkbox

- **Decision.**
  - "Remember password on this device" is **ticked by default**, and the app remembers the person's last choice.
  - A Preferences switch and a machine policy can turn remembering off completely.
- **Why.**
  - The owner's goal is to type a password once.
  - With an unticked default, agents would keep getting stuck on a password prompt.

### D5. How certificate-encrypted files are opened

- **Decision.** MuPDF only knows the Standard security handler. It throws on PubSec files (verified: `unknown encryption handler: 'Adobe.PubSec'`). So we bridge:
  1. Unwrap the seed with the person's key and compute the file key K.
  2. Make MuPDF open the file in memory:
     - **V5 (AES-256):** append an update section that redefines /Encrypt as a Standard V5/R6 dictionary. That dictionary wraps K under a random one-time password.
     - **V2/V4 (RC4, AES-128):** append an update with no /Encrypt. Then decrypt every string and stream ourselves, using MuPDF's parser.
- **Why.**
  - Appending never changes existing byte offsets. So it works the same for classic xref tables, xref streams, object streams and incremental updates (verified on pyHanko files).
  - R2 to R4 derive K from the password, so we cannot wrap a K of our choosing. Short of writing our own full PDF reader, the decrypt pass is the only way.

### D6. How they are saved back

- **Decision.** Use approach B from the create spike:
  1. Make a decrypting full save of a copy.
  2. Encrypt every string and stream with K in our own code.
  3. Write the file with our own small serialiser.
  
  Reuse the original seed and the original /Recipients envelopes. No private key and no other person's certificate is needed.
- **Why.**
  - The output was verified identical in pyHanko, MuPDF and PDFBox.
  - MuPDF's own writer leaves empty strings unencrypted and mishandles EncryptMetadata false.

### D7. What we write

- **Decision.**
  - Always write V5 / AES-256 / AESV3, with EncryptMetadata true.
  - Use RSA PKCS#1 v1.5 key transport.
  - Identify each recipient by issuer and serial number (issuerAndSerialNumber), copying the issuer bytes exactly from the certificate.
  - V2/V4 files are upgraded to V5 when saved back, keeping the same seed and envelopes.
- **Why.**
  - This is the format other readers expect (pdfa.org, pyHanko, PDFBox).
  - node-forge corrupts non-ASCII issuer names (verified), so we build the CMS envelope ourselves.
  - MuPDF and pyHanko ignore EncryptMetadata false when reading (verified).

### D8. Incremental saves and signing

- **Decision.**
  - Certificate-encrypted documents are never saved incrementally.
  - Signing them is disabled in v1, and the Sign tools explain why.
  - Saving one that already has signatures warns that those signatures will become invalid.
- **Why.**
  - MuPDF's incremental save appends to the bytes it opened, and for these files those bytes include our temporary Standard dictionary.
  - A correct incremental update for PubSec files is possible, but it is a project of its own.

### D9. The PowerShell helper

- **Decision.** The Windows certificate store and smart cards are reached through a PowerShell helper:
  - It runs the stock `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -Command -`, with the script on stdin, and uses .NET `EnvelopedCms`.
  - No native module, no `-EncodedCommand`, no `-ExecutionPolicy Bypass`.
  - One long-lived process per app session (owner decision: PIN once per session), started on first use and stopped on quit or "Lock smart card".
- **Why.**
  - 25 of 25 tests passed under pwsh 7 on Linux. Windows PowerShell 5.1 behaviour is inferred.
  - Avoiding a native build keeps the cross-platform release simple.

### D10. Where secrets live

- **Decision.**
  - Private-key operations, safeStorage and the PowerShell helper all live in the **main process**.
  - The renderer and engine only ever see the 24-byte seed and permissions.
  - The engine keeps the seed and K in its Session while the document is open, the same way it keeps `s.password` today.
  - The one-time bridge password never leaves the worker.
- **Why.**
  - Keys and stored passwords stay out of the renderer.
  - K has to reach the worker, because MuPDF runs there.

### D11. What agents get

- **Decision.** Agents get silent access through the same open path as the person:
  - saved passwords;
  - software keys in the Windows store;
  - Digital IDs whose password is remembered.
  
  Smart-card keys always need the human's PIN, and Windows shows its own dialog for it. Agents never receive passwords, PINs, seeds or keys.
- **Why.**
  - This is the owner's requirement.
  - The audit log and the policy switches are the controls.

## Architecture

```
renderer (window)                        main process                         engine worker (MuPDF)
-----------------                        ------------                         ---------------------
openBytes / unlockFile  --doc.open-->                                          openInto: Standard? -> lock
                        <-- needsPassword + lock | needsCertificate + recipients
  passwords:find(lock,path) ----------> SavedPasswordStore (safeStorage)
  <-- [{ref,password,level,via}]
  doc.authenticate(password) ------------------------------------------------> authenticate
  passwords:used / failed / remember -> store

  certkeys:probe(blobs) --------------> WindowsStoreSource (PowerShell helper)
                                        DigitalIdSource (.p12 + saved password)
  <-- candidates (no key used, no prompt)
  certkeys:decrypt(blobs, candidate) -> source.decrypt -> 24 bytes seed+perms
  <-- { seed, permissions, via }
  doc.unlockCertificate(seed) -----------------------------------------------> K = hash(seed, recipients)
                                                                               V5: append R6 update, open
                                                                               V2/V4: append update, decrypt pass
                                                                               s.pubsec = { seed, K, recipients, ... }
Save --------------------------------------------------------------------- -> saveDocument: s.pubsec ? writePubSec : ...
```

### Engine (`src/engine/`, runs in the worker and in vitest)

**New files in `src/engine/crypt/` and `src/engine/util/`**

- **`crypt/pdfLex.ts`:** a small reader for the PDF bytes that MuPDF refuses to open.
  - It reads names, numbers, literal and hex strings, arrays, dictionaries and `n g R` references.
  - `lastTrailer(bytes)` returns the newest trailer: a classic `trailer` or an xref stream dictionary.
  - `readXref(bytes)` reads classic tables and xref streams (Flate with PNG predictors, via `DecompressionStream`).
  - `objectAt(bytes, num, gen)` returns one object.
  - If the xref is damaged, it falls back to scanning for object headers.
  - The encryption dictionary is never inside an object stream (ISO 32000-2, 7.5.7), so a single top-level lookup is enough.
- **`crypt/pdfCrypto.ts`:**
  - AES-CBC with an IV prefix (WebCrypto);
  - RC4 and MD5 (small JS; MD5 from node-forge);
  - V2/V4 per-object keys;
  - SHA-1 and SHA-256 file keys.
- **`crypt/standardR6.ts`:** builds a Standard V5/R6 dictionary around a given 32-byte K and password. Taken from the create spike (algorithms 2.B, 8, 9 and 10).
- **`crypt/pubsecRead.ts`:** `readPubSec(bytes)` returns:
  - the handler, SubFilter, V, CFM and key length;
  - the `/Recipients` blobs (from the crypt filter for V4 and later, from the top level for V2);
  - EncryptMetadata and the Encrypt reference;
  - a public summary of each RecipientInfo (issuer, and serial or SKI), used in messages.
- **`crypt/pubsecBridge.ts`:**
  - `fileKey(info, seed)`.
  - `bridgeV5(bytes, info, K)`: appends an update that redefines the Encrypt object. When /Encrypt is a direct dictionary in the trailer, it adds a new object instead.
  - `neutralise(bytes, info)` plus `decryptAll(doc, info, K)` for V2/V4. Object streams are decrypted first, then every other top-level string and stream.
  - What the decrypt pass skips: the Encrypt object, xref streams, signature `/Contents`, streams with their own Crypt filter, and XMP when EncryptMetadata is false.
  - V5 files with EncryptMetadata false also take the decrypt-pass route, because MuPDF ignores that flag on read. For V5, the pass uses K itself for every object instead of the MD5 per-object key. This is inferred: the pass has only been run on V4 files.
- **`crypt/pubsecWrite.ts` and `util/pdfWriter.ts`:**
  - approach B from the create spike: `encryptObjectsInPlace`, `serialiseEncrypted`, `writePdf`;
  - `assertNoBridge(bytes)`, which throws if a PubSec session's output contains `/Filter/Standard`.
- **`util/lockInfo.ts`:** `readLockInfo(doc)` for remembered passwords, from the remember spike. It uses `asByteString()`, because `asString()` mangles a binary /ID.

**Changes in `ops/doc.ts`**

- **`openInto`:**
  - When `openDocument` throws "unknown encryption handler" and `readPubSec` finds `Adobe.PubSec`, keep the bytes as pending.
  - It then returns `{ ok: false, needsCertificate: true, pubsec: { recipients, summary, version } }`.
  - For the Standard handler, it adds `lock` to the `needsPassword` result.
- **`authenticate`:** returns `access: 'user' | 'owner'`, based on MuPDF's authentication bits.
- **New async op `unlockCertificate(seed: Uint8Array)`:**
  - computes K, bridges and opens the file;
  - sets `s.pubsec = { seed, fileKey, recipients, encryptMetadata, sourceVersion, permissions }`;
  - turns the recipient's permission bits into the R6 `/P`, so MuPDF and the app's restriction checks see them.
- **`saveDocument`:**
  - When `s.pubsec` is set, it forces a full save and then calls `writePubSecDocument`.
  - This makes the save async: add `saveAsync`, and route the renderer's `saveDocument` through it.
  - Optimise (`protect-optimize/optimize.ts`) uses the same route.
  - Security changes work as today: Remove Security writes a plain file, and Protect with a password replaces certificate security.
- **`reload`** (revert, replace bytes): reuses `s.pubsec.seed` when the new bytes have the same `/Recipients`, so revert after a save does not ask again.
- **New ops `lockInfo()` and `pubsecInfo()`** for the Protect panel.

**Guards against writing the temporary dictionary to disk**

- A unit test fails if a new `s.pdf.saveToBuffer` call appears outside these files:
  - `ops/doc.ts`;
  - `optimize.ts`;
  - `digital-signatures/worker/sign.ts` (which is blocked for PubSec sessions).
- Outputs built from a new `PDFDocument` (extract, split, combine, compare report, comment summary) are plain by construction. The "keep source encryption" work on the agent-access branch should reuse the `s.pubsec` envelopes for those outputs.

### Main process

- **`src/main/passwords/`** (core). **safeStorage lives here and nowhere else.**
  - Files:
    - `keys.ts`, `store.ts`, `electronCipher.ts`;
    - `index.ts`, with `registerPasswordHandlers()`, called from `registerCoreHandlers`;
    - `testCipher.ts`, used only when `!app.isPackaged && FARTCROBAT_TEST_SECRET_CIPHER === '1'`.
  - The store is built lazily after the app is `ready` and never logs arguments.
  - Records it cannot decrypt are kept and flagged `unreadable`, not deleted.
- **`src/main/certkeys/`** (core, because opening a file is core):
  - **`winStoreScripts.ts` and `winCertStore.ts`: the PowerShell helper**, from the winstore spike.
    - Calls run one at a time.
    - Timeouts: 60 s, and 5 min for decrypt (to allow for a PIN prompt).
    - Only the `FCJSON:` line of stdout is parsed.
  - **`digitalIdSource.ts`:**
    - reads a Digital ID .p12 from `<userData>/digital-ids` or from an imported path;
    - gets its password from the password store (target `digital-id:<sha256>`) or from the request;
    - unwraps the content key with node-forge (RSA PKCS#1 v1.5 and OAEP);
    - decrypts the envelope content with Node crypto: AES-128, -192 and -256 in CBC mode, and 3DES, which Acrobat 7 to X used;
    - matches recipients by issuerAndSerialNumber or by SubjectKeyIdentifier, using our own parser (node-forge throws on SKI recipients).
  - **`index.ts`:**
    - defines the `RecipientKeySource` interface `{ probe(blobs), decrypt(blobs, opts) }`;
    - WindowsStoreSource implements it on Windows only, controlled by the preference `useWindowsCertificateStore` (default true);
    - DigitalIdSource implements it everywhere.
- **`src/main/policy.ts`** (shared with agent access): `readMachinePolicy()` resolves to `{ agentAccess, rememberPasswords }`, each `'enabled'`, `'disabled'`, `'invalid'` or null.

### IPC channels

These are core channels:

- Add `passwords|certkeys` to the `CHANNEL` regex in `src/preload/index.ts`, and add the types to `src/shared/ipc.ts`.
- Every handler:
  - checks that the sender is the top frame of an app window;
  - never logs arguments;
  - rethrows errors as generic messages.

**Saved passwords**

| Channel | Returns |
|---|---|
| `passwords:status()` | `{ available, reason, backend, policy, count }`, where `reason` is `'policy'`, `'off'`, `'no-keyring'`, `'not-ready'`, `'error'` or `null` |
| `passwords:find(target)` | `{ ref, password, level?, via }[]` |
| `passwords:remember({ target, label, level?, password })` | `ref` or `null` |
| `passwords:used(ref, target, meta)` | moves this file's keys to the record whose password worked |
| `passwords:failed(ref, target)` | drops this file's keys from a record whose password failed |
| `passwords:list()` | the records, without secrets |
| `passwords:forget(refs \| 'all')`, `passwords:forgetFor(target)` | removes records |
| `passwords:savedFor(target)` | the record `find` would try first, without its secret and without using the keyring (Protect panel, Digital IDs list) |

`target` is either `{ kind: 'pdf', lock, path }` or `{ kind: 'digital-id', certificateSha256 }`.

**Certificate keys**

| Channel | Returns |
|---|---|
| `certkeys:status()` | `{ windowsStore, digitalIds: number }`, where `windowsStore` is `'available'`, `'not-windows'`, `'off'`, `'constrained'` or `'unavailable'` |
| `certkeys:probe({ blobs })` | `{ candidates, recipients }`. Each candidate is `{ source, id, label, hardware, needs }`, with `needs` set to `'nothing'`, `'password'` or `'pin'`. Each recipient is `{ issuer, serial }` or `{ issuer, ski }`. Uses no key and never prompts. |
| `certkeys:decrypt({ blobs, candidate, password?, remember?, actor })` | `{ ok: true, seed, permissions, via }`, or `{ ok: false, code }` (codes below) |
| `certkeys:listEncryptionCertificates({ includeOthers })` | Windows personal certificates, and optionally "Other People", with their DER, for creating files |

Error codes from `certkeys:decrypt`:

- from the helper: `CANCELLED`, `WRONG_PIN`, `PIN_BLOCKED`, `CARD_NOT_PRESENT`, `KEY_UNAVAILABLE`, `NO_MATCHING_CERT`, `UNSUPPORTED`, `CONSTRAINED_LANGUAGE`, `POWERSHELL_UNAVAILABLE`, `TIMEOUT`;
- for Digital IDs: `PASSWORD_NEEDED` and `WRONG_PASSWORD`.

### Renderer

**`src/renderer/src/app/unlock.ts`: `unlockFile({ name, filePath, result, actor })`**

It handles both kinds of encryption:

- **Standard (password):** try saved passwords first, then show the prompt with the Remember checkbox.
- **PubSec (certificate):** probe, then try in this order:
  1. candidates that need nothing;
  2. a Digital ID whose password is saved;
  3. hardware keys, showing "Waiting for your smart card..." while Windows asks for the PIN;
  4. a Digital ID password prompt, with Remember.
- **If nothing matches:** "This document is encrypted for Ana Silva (issued by Contoso CA). None of your certificates or Digital IDs can open it.", with an "Add Digital ID..." button.

Where it is used:

- `openBytes`, `replaceDocumentBytes` and `revertDocument`;
- the side inputs in organize-pages (`withPassword`), export-create and compare.

**Document model.** `DocumentModel.unlock = { method: 'typed' | 'saved-password' | 'certificate', savedRef?, via? }`.

**Preferences**

- A new "Passwords" section: the switch, a line naming the protection backend, a table with Remove, and Remove All.
- In "Digital IDs":
  - the switch "Use certificates from the Windows certificate store" (Windows only);
  - a "Password saved" marker for each ID.

**Protect panel (`protect-optimize`)**

- A new "Encrypt with Certificate" dialog:
  - **Recipients** can come from my Digital IDs, the Windows store (personal certificates and Other People), and .cer, .p7b or .p12 files (only the public certificate is used).
  - **Permission groups** work like Acrobat's, with one envelope per group.
  - **The person's own certificate** is added by default, with a warning if they remove it.
  - **Key types:** RSA only. EC certificates are listed but disabled, with the reason shown.
- The security badge says "Certificate security".
- The panel shows "Opened with: <certificate>" or "Password saved on this device · Forget".

### Opening, saving and creating, step by step

**Opening a V5 file** (verified on 7 files):

1. `openDocument` throws. `readPubSec` reads the last trailer and the Encrypt object.
2. The main process returns the seed.
3. The engine computes K = SHA-256(seed, all /Recipients, plus FFFFFFFF when EncryptMetadata is false).
4. The engine generates a 144-bit one-time password and appends:
   - `N G obj <<Standard R6 wrapping K>> endobj`;
   - a classic xref section;
   - a trailer with /Prev.
5. MuPDF opens the result.

MuPDF accepts a classic section appended after an xref-stream file without repairing it (verified). An open takes about 110 to 230 ms in Node, mostly for the R6 hash.

**Opening a V2/V4 file** (verified on 3 small files):

1. K = SHA-1(...), truncated to /Length.
2. Append an update whose trailer leaves out /Encrypt.
3. Open it. MuPDF now sees an unencrypted file that still holds ciphertext.
4. Decrypt the object streams first, so nothing inside them is parsed before it is plaintext.
5. Decrypt every other string and stream with its per-object key.

The cost grows with file size, and all of it happens at open. That should be fine for typical files from the Acrobat 7 and 8 era, but it has not been tested on large ones.

**Saving back:**

1. Make a full save of a copy.
2. Authenticate the copy with the one-time password (V2/V4 sessions need nothing).
3. Make a decrypting `garbage=compact` save.
4. Encrypt in place with K.
5. Serialise with a V5 /Adobe.PubSec dictionary that carries the original /Recipients.

For V2/V4 sources, K is recomputed with SHA-256 from the same seed (verified: pyHanko opens the upgraded files). `assertNoBridge` runs on every output.

**Creating a file:**

1. Build one EnvelopedData per permission group, all sharing one fresh 20-byte seed:
   - AES-256-CBC for the content;
   - RSA PKCS#1 v1.5 for key transport.
2. Write the file with the same path as saving back.

Only public certificates are needed. After writing, the app reloads from the new bytes with the seed it already has, so the person is not asked for their key again.

### Agents and logging

**How agents open protected files**

- The agent's `open_document` call goes through `unlockFile` with `actor: 'agent'`.
- These routes are silent: a saved password, a software key in the Windows store, or a Digital ID with a saved password.
- A smart card shows the Windows PIN dialog to the human, and the agent call waits, up to the decrypt timeout.
- In every other case, the person is prompted, as today.

**Tool description.** The description of `open_document` changes to: "A protected file opens without a prompt when its password is saved on this device or it is encrypted to one of the person's certificates; otherwise it waits for the person in Fartcrobat. You never see passwords or keys."

**Audit log.** The `summary` of an `open_document` entry is one of:

- "unlocked with a password saved on this device";
- "opened with certificate <subject> (<thumbprint>) from the Windows certificate store";
- "opened with Digital ID <name>";
- "the person typed the password".

**Never logged anywhere:** passwords, PINs, seeds, file keys, envelope contents and the one-time password. The helper's stderr is kept only as an error code.

**What agents cannot do.** Agents cannot create certificate encryption or change saved passwords. `protect_document` still opens Fartcrobat's own dialog.

**Machine policy.** The setting goes in the same place as agent access's. On Windows that is the REG_DWORD `RememberPasswords` under `HKLM\SOFTWARE\Policies\Fartcrobat` (Group Policy or Intune), 0 for off. On macOS and Linux it is `policy.json`, `{"rememberPasswords":{"enabled":false}}`. Off:

- hides the checkbox;
- makes `find` return nothing;
- wipes the store at start-up.

A policy that exists but cannot be read or understood (a JSON typo, a file only root can read, `"enabled"` that is not `true` or `false`, a registry value that is not a REG_DWORD 0 or 1) turns remembering off for the session, like the explicit setting, but does not wipe the store: only an explicit off (`"enabled": false`, or 0) does. `readMachinePolicy()` reports such a policy as `'invalid'` and `rememberPolicy` (`src/main/passwords/handlers.ts`) decides what each reading does; `readPolicy` and agent access's `machinePolicy` still fail closed with `'disabled'`.

## Remembered passwords as built (phases 0 and 1)

**Where the code is**

- Main process: `src/main/policy.ts` (the machine policy, shared with agent access, which keeps its own `agentAccessState`; on Windows read from the registry with `reg.exe`, so the `passwords:*` handlers wait for it, and for any wipe, before answering); `src/main/passwords/`: `keys.ts`, `store.ts`, `electronCipher.ts`, `testCipher.ts`, `fileStore.ts` (atomic writes, mode 0600), `handlers.ts` (the IPC handlers without Electron) and `index.ts` (`registerPasswordHandlers()`, called from `registerCoreHandlers`).
- Shared: `src/shared/passwords.ts` (the IPC types), `LockInfo` and `PasswordAccess` in `src/shared/types.ts`, the preferences `rememberPasswords` and `rememberPasswordChecked`.
- Engine: `src/engine/util/lockInfo.ts`; in `ops/doc.ts`, `lock` on every `needsPassword` result (open, authenticate, reload), `access` on results opened with a password, and the ops `lockInfo()` and `checkFile(data, name, password?)`. `openSourceWithAccess` in `ops/pages.ts` carries the lock on its NEEDS_PASSWORD error, so the organize-pages `probe` and `openScratch` report `lock` and `access`.
- Renderer: `src/renderer/src/app/unlock.ts` is the pure logic (no DOM, no IPC, unit-tested); `src/renderer/src/app/savedPasswords.ts` wires it to the IPC and to `promptPassword` (`src/renderer/src/ui/dialogs.tsx`), and has the helpers features use from `@renderer/sdk` (`unlockFile`, `rememberOffer`, `linkDocumentFiles`, `savedPasswordFor`, `forgetSavedPassword`, `rememberDocumentPassword`, `digitalIdTarget`). Preferences > Passwords is `PasswordSettings` in `src/renderer/src/core/dialogs.tsx`, registered by the core feature.
- `DocState.unlock` (`DocUnlock`: `method` is `'typed'`, `'saved-password'` or `'source'`, plus `access`, `savedRef` and the `lock` that password opened) replaces the planned `DocumentModel.unlock`.

**Differences from the plan**

- `find` uses the keyring only when a record matches, so opening a protected file with nothing saved never shows a keyring prompt. The prompt asks `passwords:status` (which does use the keyring) only when it is about to show the checkbox.
- The Preferences switch off keeps saved passwords but neither uses nor offers to save them (Preferences still lists them, with Remove). Only the machine policy wipes the store, at start-up.
- Outputs made from a document whose password is saved (Save As, Extract and Split to files, the agent's `extract_pages` and `combine_files` with a path) link their path to that saved password, but only when their lock is the one it opened. New tabs from such a document (Extract, Combine, the Compare report) carry `derivedFrom`, so a later Save As links too.
- Protect offers "Remember password on this device" for the open password only. The tab keeps full access through the permissions password as before; the next open uses the saved open password and gets the restrictions others get.
- The Sign dialog fills in a Digital ID's saved password and shows "Filled in with the password saved on this device. Click Sign to continue."; only the click signs with it (Enter does nothing while the saved password is in the field, so a stray Enter after an agent's `sign_document` brings the dialog forward signs nothing). Unticking Remember and signing forgets it, and a saved password that no longer works is forgotten with a message. Removing a Digital ID forgets its password. Preferences > Digital IDs marks IDs whose password is saved.
- Agent audit summaries for `open_document`: "unlocked with a password saved on this device", "the person typed the password", "opened" (no password needed or given by a tool) and "already open". `organize_pages` with `insert_file` and `combine_files` add how each protected source was unlocked in brackets. The tool description and the server instructions say a saved password opens files without a prompt.
- The Protect panel's "Password saved on this device" row and its Forget look the document up by its exact lock only. /ID[0] and the path stay keys for opening, but Protect keeps /ID[0], so they could show (and Forget would delete) the password of the file it was protected from.
- When a saved password fails, only this file's keys are unlinked from it, so the prompt says it "no longer opens it and won't be tried for it again": the record still opens older copies.
- After a wrong typed password, the next prompt keeps the Remember choice the person made in the last one.
- A store file that exists but cannot be read (EACCES, EBUSY) is not treated as empty: the call fails and the next one reads it again. Only content that is not a valid store starts empty.
- The test cipher (`FARTCROBAT_TEST_SECRET_CIPHER=1`, unpackaged builds only) is reversible and marked "Test cipher (not protected)" in Preferences.
- Sender check: `URL.origin` is "null" for `app://` URLs, so the handlers compare scheme and host.
- Not wired to saved passwords: Compress still asks for the open password of a protected document, as before, even when a saved password opened it. The engine session already has that password, so a later change can drop the prompt.

**Tests**

- Unit: `tests/engine/core-saved-passwords-{keys,store,unlock,flow,main}.test.ts` (the 32 prototype tests, adapted, plus the engine's `lock` and `access`, `checkFile`, path folding, `electronCipher` with a mocked safeStorage, the test cipher's gate, the handlers: other senders refused, plain errors, nothing logged, and which policy readings turn remembering off or wipe the store).
- End to end: `tests/e2e/saved-passwords.spec.ts` (skipped with `FARTCROBAT_EXECUTABLE`; the only spec that launches with remembering on, see `launch` in `tests/e2e/helpers.ts`), with the fixture `tests/fixtures/saved-passwords/encrypted-changed.pdf` (`make_saved_passwords.py`, pypdf). It covers the prompt, Remove and Remove All, a changed password, unticking (also before a wrong password), Protect and Forget, a Digital ID (Enter does not sign with its saved password), the machine policy, a policy file that cannot be understood, Linux without a keyring (real safeStorage, skipped when a D-Bus session exists) and an agent opening a remembered file, extracting pages, inserting it and combining it through the built MCP shim.

## Certificate encryption as built (phases 2 to 6)

Built on 14 October 2026 by parallel builders on shared contracts, then reviewed adversarially (eight review lenses, each finding checked by two independent verifiers) and fixed. Nothing here has run on Windows hardware, a smart card or Acrobat: for those, the code, the automated tests and the manual checklist below are ready for the owner's team.

**Where the code is**

- Shared contracts: `src/shared/certkeys.ts` (`CertificateLock`, `CertificateKey`, the `certkeys:*` request and result types, `PUBSEC_PERMISSION`, `certificateAuditSummary`, `describeCertKey`); in `src/shared/types.ts`, `OpenResult`'s `needsCertificate` variant, `SaveOptions.encryptCertificate` and `CertificateGroup`, `DocInfo.security` and the preference `useWindowsCertificateStore`.
- Engine, `src/engine/crypt/` (`index.ts` documents the surface):
  - `primitives.ts`: AES, SHA-2 and MD5 from `@noble/ciphers` and `@noble/hashes`, our own RC4;
  - `pdfLex.ts`: a PDF object parser, the newest trailer (the last `startxref`), a real xref reader (classic tables, xref streams with predictors through `fflate`, hybrid files, `/Prev` chains) with a linear scan for damaged files, and bounds on everything a hostile file controls;
  - `standardR6.ts`: the bridge's Standard V5/R6 dictionary, with separate one-time user and owner passwords;
  - `pubsecRead.ts`: `readPubSec`, `certificateLockOf`;
  - `pubsecBridge.ts`: file keys, `bridgeV5`, `neutralise` and `decryptAll`, `verifyFileKey`, `openPubSec` and `openWithKeys`;
  - `pubsecWrite.ts` and `src/engine/util/pdfWriter.ts`: encrypt in place, the serialiser, `writePubSecDocument`, `assertNoBridge`, `assertCertificateOutput`;
  - `keys.ts`: `CertificateKeyRegistry` (keys by envelope) and the permission mapping.
- Engine integration: `Session.pubsec`, `pendingCertificate` and `certificateKeys` (`src/engine/session.ts`); in `src/engine/ops/doc.ts` the ops `open`, `reload`, `unlockCertificate`, `addCertificateKey`, `certificateKey`, `certificateLock` and `checkFile`, `documentFacts`, and the save routes; `openSourceWithAccess` (`ops/pages.ts`); certificate `Protection` for outputs (`src/engine/util/protection.ts`); the organize-pages, compare and export-create engines; Compress and the Optimizer (`protect-optimize/optimize.ts`); `security()` in `protect-optimize/engine.ts`; the signing refusal in `digital-signatures/worker/sign.ts`.
- Envelopes: `src/features/digital-signatures/lib/envelope.ts` (reading, used by the main process) and `envelopeBuild.ts` (building, used by the engine; RSA PKCS#1 v1.5 with BigInt, issuer and serial copied byte for byte).
- Main process, `src/main/certkeys/`: `source.ts` (`RecipientKeySource`), `digitalIdSource.ts`, `handlers.ts` (the IPC handlers without Electron), `index.ts` (Electron glue), `winCertStore.ts` (the long-lived PowerShell helper), `winStoreScripts.ts` (its PowerShell 5.1 scripts) and `windowsStoreSource.ts`. `src/main/passwords/index.ts` exports `savedPasswordStore()`, `rememberPasswordsPolicy()` and `trustedSender()` for it.
- Renderer: the pure logic in `src/renderer/src/app/unlock.ts` (`unlockCertificate`, `orderCandidates`, the messages); `certificates.ts` (`unlockCertificateFile`, the "Waiting for your smart card..." overlay and its Cancel); in `actions.ts`, opening, Revert, replacing bytes and the signatures warning; side inputs in organize-pages (`withUnlock`), compare and export-create; the agent tools; `digital-signatures/ui/encrypted.ts` (signing refused); in Preferences > Digital IDs (`DigitalIdsSettings.tsx`), the Windows store switch and "Lock smart card".
- Protect: `CertificateEncryptDialog.tsx`, `certificates.ts` (pure helpers), `certificateFiles.ts` (.cer, .pem, .p7b and .p12 parsing), and changes to `flows.tsx`, `ProtectPanel.tsx` and `SecurityBadge.tsx`.

**Differences from the plan**

- **Synchronous crypto, no async save route.** The engine uses `@noble/ciphers` 2.4.0, `@noble/hashes` 2.4.0 and `fflate` 0.8.3 (pinned) instead of WebCrypto, so `saveDocument` stays synchronous and writes certificate security itself. Save, Save As, Extract, Split, Combine, the Compare report, Compress and the `insertFiles` mutation all keep the source's certificate security without becoming async. AES runs at about 55 MB/s in the worker. Measured in Node: opening a 5 MB V5 file takes about 120 ms (mostly the R6 hashes), and saving it about 0.8 s (an extra decrypting MuPDF pass plus AES).
- **Keys by envelope.** The engine keeps every `CertificateKey` it was given (the envelope, its seed and its permission bytes) for the life of its worker, and opens any file whose `/Recipients` contain an identical envelope. That is how Revert, reload, files to insert, combine, compare or create from, and new tabs made from a certificate-encrypted document open without asking again. `doc.unlockCertificate(key)` opens the pending document; `doc.addCertificateKey(key)` only registers. The renderer keeps a tab's key in `DocState.unlock.certificateKey` (method `'certificate'`, or `'source'` for tabs made from it) and gives it to new engines; after Encrypt with Certificate, `doc.certificateKey()` hands the new key to the tab.
- **The bridge uses separate one-time user and owner passwords**, and the engine authenticates with the user password, so MuPDF applies the recipient's permissions itself. `doc.lockInfo()` returns null for certificate-encrypted documents, so the bridge's `/U` and `/O` never reach the renderer.
- **A wrong seed is caught before opening.** `verifyFileKey` checks the AES padding of a few streams (for RC4, zlib headers or plain text), so a key for the right envelope but the wrong seed gives `needsCertificate`, not garbage.
- **Damaged files are refused.** A certificate-encrypted file that MuPDF has to repair does not open (CERTIFICATE_OPEN_FAILED).
- **Hostile files.** The reader runs on every file MuPDF refuses, so everything a file controls is bounded: predictor parameters, the decoded size of xref streams (64 MB), `/W`, `/Index` and `/Size`, the length of `/Prev` chains, and the scan of a damaged file (linear, newest 256 trailers). `/Recipients` may hold at most 100 envelopes, 1 MB each and 4 MB in all (`PUBSEC_RECIPIENT_LIMITS` in `src/shared/certkeys.ts`): the engine refuses a larger file with CERTIFICATE_UNSUPPORTED and says why, and the main process refuses such `certkeys:*` requests and bounds parsing (50,000 ASN.1 elements and 1,000 RecipientInfos per envelope).
- **A direct `/Info` dictionary** in the trailer (not conforming, but it occurs) is made an indirect object before encrypting, so its strings are encrypted like any other object. MuPDF keeps it direct through a full save.
- **EncryptMetadata false**: such files open through the decrypt pass (V5 too, with K for every object, leaving the XMP stream alone). Saving back always writes EncryptMetadata true (D7), so the XMP stream becomes encrypted.
- **Restricted recipients.** A recipient whose envelope lacks the change-security bit can edit and save (as their permissions allow) but cannot Remove Security, Protect with a password or Encrypt with Certificate (PERMISSION_DENIED). Recipients with every other permission but not that bit do not get full access either: the Protect panel shows "Changing the security: Not allowed" and explains why those actions are disabled, and the agent's `remove_security` refuses before asking the person.
- **Replacing certificate security with a password** asks first, worded by what the result will be: Restrict Editing without an open password leaves a file anyone can open, and the dialog and the summary say so.
- **Permission groups** in Encrypt with Certificate tie form filling to commenting (bit 6 also allows filling forms, ISO 32000-2 table 24), so what Fartcrobat writes reads back the same way in Acrobat. Opening reads it the same way: an envelope with bit 6 set and bit 9 clear allows filling in forms. Removing a group moves its recipients to the first group, and the dialog says where they went and what that group allows.
- **When the Windows store cannot be searched** (Constrained Language Mode, a blocked or missing PowerShell), the no-key message says so ("None of your Digital IDs can open it" and why the store was not used), and the recipient picker says why its Windows store list is empty.
- **Agents are told why** a certificate-encrypted file did not open: no key matches ("failed", or "unsupported" for elliptic-curve keys), a key problem the person could only acknowledge ("failed"), a damaged file ("file_error"); only the person's own Cancel is reported as "cancelled".
- **Outputs that are plain on purpose**, as for password-protected documents: a comment summary, and a new PDF made with Create from protected files.
- **The PowerShell helper is one process per app session** (owner decision). Requests run one at a time, each with a request id, and only the `FCJSON:<id>:` answer line is read. Timeouts are 60 s, and 5 minutes for a decrypt. A request waits for the one before it at most as long as its own timeout. Cancel in "Waiting for your smart card..." sends `certkeys:cancel` with the request's id; the main process answers CANCELLED at once and stops the helper (Windows closes its PIN dialog), so the next open asks for the PIN again. A Digital ID decrypt stops at its next step and saves nothing. Windows' own "cancelled by the user" (0x80090036, NTE_USER_CANCELLED) is reported as CANCELLED too. "Lock smart card" appears only while the helper holds a key known to be hardware. Whether a key is hardware is read after a decrypt, never in a probe (a probe never opens a key); a key counts as hardware unless its provider is one of Microsoft's software providers (the Base, Enhanced, Strong, RSA and AES, and RSA SChannel CSPs and the Microsoft Software Key Storage Provider); a provider Windows does not name counts as hardware too. Windows Hello for Business (Microsoft Passport Key Storage Provider) counts as hardware: its keys usually live in the TPM, and the helper keeps the Hello PIN or gesture like a smart card PIN. Active Directory lookup was not built.
- **Recipients are named by serial number and issuer** in messages ("encrypted for the certificate with serial number 1A2B (issued by Contoso CA)"): a CMS envelope does not carry the recipient's name.
- **The main process never bundles `@noble/*`.** electron-vite defines `__dirname` in the ES module main bundle by inserting a shim after the last `import` it finds by text, and `@noble`'s doc comments contain such lines, so the shim landed in a comment and the app did not start. `tests/engine/main-bundle.test.ts` walks the main process's imports to keep it that way. node-forge (tens of milliseconds to load) is imported with `import()` only when a Digital ID decrypts, so app start-up does not pay for it; the same test checks that.
- **Agents** open certificate-encrypted files through the same flow as the person (actor `'agent'`). The audit summaries are "opened with Digital ID <name>" (with "(password saved on this device)" when it was), and "opened with certificate <subject> (<thumbprint>) from the Windows certificate store" or "... from a smart card". When no key opens a file, the agent is told why ("failed" or "unsupported"), and only the person's own Cancel is reported as cancelled.
- **Signatures.** Saving a certificate-encrypted document with signatures asks first ("Saving will invalidate N signatures"), once per tab; agents' `save_document` asks the person the same. After the save, the tab describes the file it wrote: it validates its signatures against the new bytes (they no longer cover them), and a V4 file is labelled as the V5 AES-256 file it became. New signatures are refused, and every signing entry point explains why.

**Tests**

- Unit (vitest): `passwordless-lex` (the parser and xref reader), `passwordless-open` (every fixture and recipient, by seed), `passwordless-save` (save back, V4 to V5, no bridge or plaintext in any output, incremental refused, Remove Security, Protect with a password, revert, a pyHanko cross-check), `passwordless-outputs` (Extract, Split, Combine, Compare, Optimize, side inputs, signing refused), `passwordless-create` (Encrypt with Certificate: one and two groups, permission bits, exact issuer bytes, EC refused, a pyHanko cross-check), `passwordless-hardening` (hostile files that must not hang or exhaust memory, a direct `/Info`, what the tab reports after a save), `passwordless-guard` (no new `saveToBuffer` outside an allow-list), `certkeys-envelope`, `certkeys-digitalid`, `certkeys-handlers` (senders, argument bounds, hostile `/Recipients`, cancel, nothing logged), `certkeys-winstore` (script rules, the process model, and the store through pwsh on Linux against a private test store; on Windows, the stock PowerShell 5.1 in the `windows-helper` CI job), `core-certificate-unlock` (the unlock logic), `protect-certificate-files` and `protect-certificate-recipients`, and `main-bundle`.
- End to end: `tests/e2e/certificate-encryption.spec.ts` (skipped with `FARTCROBAT_EXECUTABLE`, like the saved-passwords spec): a Digital ID opens a file and its password is remembered, an edit saves back encrypted, Revert, a file for someone else, a restricted recipient with signing disabled, the signatures warning, Encrypt with Certificate for two recipients reopened by each, an agent opening silently (with the audit line and no secret) and saving a signed file, and the Windows store through the PowerShell helper on Linux (skipped without pwsh).
- Fixtures: `tests/fixtures/passwordless/make_pubsec.py` (pyHanko, cryptography, asn1crypto), deterministic, outputs committed, keys for tests only; see its README.
- CI: pyHanko is in `tests/requirements.txt`, so the cross-checks run there. The `windows-helper` job runs `certkeys-winstore.test.ts` on `windows-latest` against the stock Windows PowerShell 5.1.

## Implementation plan

Estimates are in engineer-days for someone who knows the codebase, and include tests. They assume the spike code is ported, not rewritten.

**Phase 0: shared plumbing (0.5 days)**

- Work:
  - the machine policy reader;
  - the IPC types and the preload regex;
  - `LockInfo` and the `OpenResult` changes.
- Files:
  - `src/main/policy.ts`;
  - `src/shared/ipc.ts`, `src/shared/types.ts`;
  - `src/preload/index.ts`.

**Phase 1: remembered passwords (4 days)**

- Work:
  - the store, the cipher and the handlers;
  - reading the lock;
  - `unlockFile` for Standard files;
  - the checkbox in the password prompt and the Preferences section;
  - "Remember" and "Forget" in Protect;
  - the Digital ID password target;
  - the agent audit summary.
- Files:
  - `src/main/passwords/*`, `src/main/index.ts`;
  - `src/engine/util/lockInfo.ts`, `src/engine/ops/doc.ts`;
  - `src/renderer/src/app/unlock.ts`, `src/renderer/src/app/actions.ts`;
  - `src/renderer/src/ui/dialogs.tsx`, `src/renderer/src/core/dialogs.tsx`;
  - `src/renderer/src/document/DocumentModel.ts`;
  - `src/features/organize-pages/engine.ts` and `files.ts`;
  - `src/features/export-create/createFlow.tsx`;
  - `src/features/compare/sources.ts`;
  - `src/features/protect-optimize/ProtectDialog.tsx` and `flows.tsx`;
  - `src/features/digital-signatures/ui/SignDialog.tsx`;
  - the agent-access `open_document` handler.

**Phase 2: PubSec engine core (4.5 days)**

- Work:
  - the lexer and the xref reader, and `readPubSec`;
  - the V5 append bridge and the V2/V4 decrypt pass;
  - `unlockCertificate` and the Session state;
  - the async save route, `assertNoBridge` and the guard test;
  - permissions;
  - blocking incremental saves and signing.
- Files:
  - `src/engine/crypt/*`, `src/engine/util/pdfWriter.ts`;
  - `src/engine/ops/doc.ts`, `src/engine/session.ts`;
  - `src/features/protect-optimize/optimize.ts`;
  - `src/features/digital-signatures/worker/sign.ts`.

**Phase 3: key sources and the open flow (3 days)**

- Work:
  - DigitalIdSource, with all the envelope ciphers, OAEP and SKI;
  - the `certkeys:*` handlers;
  - `unlockFile` for certificates, and its messages;
  - side inputs (combine, compare, insert) and revert.
- Files:
  - `src/main/certkeys/index.ts` and `digitalIdSource.ts`;
  - `src/renderer/src/app/unlock.ts`;
  - the side-input files in the features.

**Phase 4: Windows certificate store (3 days)**

- Work:
  - port the helper and add WindowsStoreSource;
  - the PIN progress UI and the Preferences switch;
  - handling Constrained Language Mode;
  - a `windows-latest` CI job that runs the helper tests against the stock PowerShell 5.1.
- Files:
  - `src/main/certkeys/winCertStore.ts` and `winStoreScripts.ts`;
  - `.github/workflows/ci.yml`;
  - `tests/engine/certkeys-winstore*.test.ts`.

**Phase 5: creating certificate-encrypted files (3.5 days)**

- Work:
  - `buildEnvelopedData` in `digital-signatures/lib/cms.ts`, copying the issuer bytes exactly from each certificate;
  - `pubsec.ts`;
  - the Encrypt with Certificate dialog, with recipient sources (IDs, the Windows store, files) and permission groups;
  - reloading with the known seed;
  - Remove Security, and password Protect, on a PubSec document.
- Files:
  - `src/features/digital-signatures/lib/cms.ts`;
  - `src/features/protect-optimize/`: `pubsec.ts`, `CertificateEncryptDialog.tsx`, `flows.tsx`, `ProtectPanel.tsx`, `SecurityBadge.tsx`.

**Phase 6: tests, fixtures and docs (2.5 days)**

- Work:
  - fixture generators and committed fixtures;
  - the e2e specs;
  - runs with the CI simulation script;
  - this note, plus updates to ARCHITECTURE and CONTRACTS, and the handoff notes.
- Files:
  - `tests/fixtures/passwordless/*`;
  - `tests/e2e/saved-passwords.spec.ts` and `tests/e2e/certificate-encryption.spec.ts`;
  - docs.

**Total: 21 days.**

Once the owner's team has run the Windows checklist, expect 1 to 3 more days of fixes. The most likely ones:

- CNG/KSP keys with .NET Framework `EnvelopedCms`;
- the PIN dialog's focus;
- the ciphers Acrobat chooses.

### Fitting it into the next two sessions

The request is to finish this, together with the agent-access work already in progress, across the next two sessions. To be candid, about 21 engineer-days fits in two long sessions only because:

- most of the code is ported from working spikes;
- agent access merges first. Phase 1 and the agent parts build on its contracts.

The suggested split:

- **Session 1: phases 0, 1, 2 and 3.**
  - Remembered passwords are complete and ready to release.
  - Certificate-encrypted files open and save back with Digital IDs on every platform.
  - Agents open both kinds silently.
  - Deliver one draft PR, or two, with remembered passwords first because they are independent.
- **Session 2: phases 4, 5 and 6.**
  - The Windows certificate store and smart cards.
  - Creating files.
  - The Windows CI job and the full tests.
- **What cannot be finished inside a session:** anything that needs real Windows hardware, smart cards or Acrobat. For those, "complete" means the code, the automated tests and the checklist below are ready. The owner's team runs the checklist, and we fix what it finds.

If a session runs short, cut in this order:

1. Active Directory lookup (not planned anyway).
2. Other People certificates.
3. Permission groups in the create dialog (keep one group with all permissions).
4. V2/V4 support. Instead, show: "made with an older version of Acrobat; not supported yet".

## Tests

### Unit tests (vitest, `tests/engine/`)

**`core-saved-passwords-*.test.ts`**

- The 32 prototype tests: keys, the store with an injected cipher, the unlock logic, and full flows with MuPDF files.
- `doc.open` returns `lock`, and `authenticate` returns `access`.
- `electronCipher` with a mocked safeStorage: on Linux, a `v10` result means no keyring.
- The handlers refuse other senders and never call `console.*` with arguments.

**`passwordless-lex.test.ts`**

- Literal string escapes, hex strings, nested containers and references.
- The newest trailer of classic, xref-stream, hybrid and incremental files.
- Xref stream decoding with predictors.
- Encrypt as a direct dictionary.

**`passwordless-open.test.ts`.** A matrix over committed fixtures:

- **Method.** Each fixture is opened with the test .p12 key and compared with the plain source: page text, annotations, title, page count, and that the file was not repaired.
- **Fixtures:**
  - V5 classic;
  - V5 xref stream with object streams;
  - V5 incremental;
  - V5 with EncryptMetadata false;
  - two recipients in one envelope, and two envelopes;
  - OAEP, and an SKI recipient;
  - AES-128 and 3DES envelope content;
  - V4 AES-128, classic and with object streams;
  - V4 RC4;
  - a pyHanko file with a PDF MAC.
- **Refusals:**
  - a stranger's key gives "not a recipient";
  - an EC recipient gives `UNSUPPORTED`;
  - a damaged envelope is skipped.

**`passwordless-save.test.ts`**

- Save back after an edit, and reopen as the second recipient.
- The V4-to-V5 upgrade.
- No `/Filter/Standard` and no plaintext source strings in any output.
- Incremental saves are refused.
- Save As keeps the encryption.
- Remove Security, and Protect with a password.
- Revert reuses the seed.
- The static `saveToBuffer` guard.

**`passwordless-create.test.ts`**

- One and two permission groups, and the permission bits.
- Issuer bytes copied exactly, tested with a UTF-8 issuer and a serial with a leading 00.
- EC certificates are refused.
- A cross-check with pyHanko when it is installed. The test skips cleanly when the probe does not exit 0.

**`certkeys-winstore.test.ts`**

- Script building, the PowerShell 5.1 lint, and error mapping.
- An integration block gated on a `pwsh` probe that exits 0. It runs on Linux CI if pwsh is present, and on the new Windows job with the stock 5.1.

**Fixtures.** `tests/fixtures/passwordless/make_pubsec.py` (pyHanko, cryptography) writes:

- the PDFs;
- a test CA;
- recipients, including one with a non-ASCII issuer;
- `.p12` files.

The keys are for tests only and are labelled as such. The outputs are committed, and tests never generate them at run time.

### End-to-end tests (Playwright, `tests/e2e/`)

**`saved-passwords.spec.ts`**

This is the spike's draft. It uses the test cipher and is skipped when `FARTCROBAT_EXECUTABLE` is set. It checks that:

- Remember is ticked by default;
- reopening shows no prompt;
- a changed password shows "no longer opens it";
- Remove in Preferences brings the prompt back;
- unticking is remembered;
- policy off hides the checkbox;
- Linux without a keyring shows the note.

**`certificate-encryption.spec.ts`**

Put the test Digital ID in the test userData, then:

1. Open a PubSec fixture. The Digital ID password prompt appears with Remember, and the file opens.
2. Reopen: no prompt.
3. Edit, save and reopen.
4. With no matching ID, the app shows "encrypted for ...".
5. Use Protect > Encrypt with Certificate for two recipients, then reopen as each one.
6. The signing tools are disabled, with the explanation.

**Agent spec** (after agent access merges)

- `open_document` on a remembered file returns a handle with no dialog.
- `open_document` on a certificate-encrypted file returns a handle with no dialog.
- The audit line has the summary and no secrets.

Run both specs with `scripts/ci-sim.sh`, and again with `--keep-tools`, before pushing.

### Manual checklist for the owner's team (Windows)

Use a throwaway VM or a test machine where you can, because the store tests add certificates. For every failure, record the Windows version, the Acrobat version, and the code and HRESULT shown.

**Remembered passwords**

1. Open `encrypted.pdf` and leave Remember ticked. Quit, start again and reopen: there is no prompt.
2. Copy and rename the file, then reopen: no prompt. Protect it again with a new password: exactly one prompt.
3. Sign in as a second Windows user and copy `%APPDATA%\Fartcrobat\saved-passwords.json` over. Nothing opens silently, and nothing crashes.
4. Delete `%APPDATA%\Fartcrobat\Local State`. The records show as unreadable, and typing the password again replaces them.
5. Set the REG_DWORD `HKLM\SOFTWARE\Policies\Fartcrobat\RememberPasswords` to 0. The checkbox is gone, and the store is wiped at start-up. Set it to 2: the checkbox is gone, and saved passwords are kept.

**Certificate store**

6. Put a software key in CurrentUser\My (made with `New-SelfSignedCertificate`, default KSP). Encrypt a file to it from Acrobat and open it in Fartcrobat: there is no prompt. Repeat on a machine whose execution policy is the client default, Restricted (`Get-ExecutionPolicy -List`): the helper only uses built-in cmdlets on stdin, which Restricted is expected to allow.
7. Repeat with a legacy CSP key, a key marked non-exportable, and a TPM key (Microsoft Platform Crypto Provider). This is the biggest unknown: CNG keys with .NET Framework `EnvelopedCms`.
8. Renew a certificate. A file encrypted to the old one still opens (archived certificates).
9. With strong private key protection, the consent dialog appears in front of Fartcrobat.
10. Turn off "Use certificates from the Windows certificate store". The file now asks for a Digital ID.

**Smart card** (a PIV or Key Management key, with its certificate propagated to the store)

11. Encrypt a file from Acrobat with 128-bit AES, and another with 256-bit AES.
12. Remove the card and open a file. Fartcrobat says which card is needed, and there is no PIN prompt.
13. Insert the card and open the file: the Windows PIN dialog appears in front of Fartcrobat. Then try Cancel, a wrong PIN, and pulling the card out during the prompt. Each one shows a clear message, with the Windows error code (HRESULT) in it. If no PIN dialog appears at all and Fartcrobat keeps saying "Waiting for your smart card...", suspect the hidden window flag: Node starts the helper with `windowsHide`, which also asks Windows to hide the helper's first window. The modern PIN prompt runs in its own process (CredentialUIBroker.exe) and should not be affected, but an older card driver's own dialog could be.
14. Close and reopen the file: there is no second PIN prompt, because one helper process keeps the card unlocked while Fartcrobat runs. Then click "Lock smart card" (Preferences > Digital IDs) and reopen: the PIN is asked again. Quit, start Fartcrobat again and reopen: the PIN is asked again.
15. Have an agent open the file through Claude Desktop. The PIN dialog appears for the human, and the agent call finishes after the PIN is entered.

**Files made by Acrobat**

16. One recipient, with AES-128 and with AES-256, each with and without "encrypt all document contents except metadata". Note the key-transport and content-cipher OIDs that the helper reports.
17. Two recipients with different permissions, one restricted to printing. The restricted one cannot edit in Fartcrobat.
18. A file with attachments, form fields, layers and a tagged structure: everything shows. A file that was signed before it was encrypted: it opens, and Save warns about the signatures.

**Acrobat opening files made by Fartcrobat**

19. Create a file for yourself and a colleague, then open both copies in Acrobat on each machine.
20. Save back an AES-128 file made by Acrobat in Fartcrobat, which upgrades it to AES-256. The colleague opens it in Acrobat.
21. Use a permission group restricted to printing. Acrobat enforces it.
22. Acrobat's Document Properties > Security shows "Certificate Security" and the recipients.

**Locked-down machines**

23. Set `__PSLockdownPolicy=4` (machine scope), or use a real AppLocker or WDAC policy. Fartcrobat says the Windows store cannot be used here and offers Digital IDs.
24. Block `powershell.exe` with AppLocker. Fartcrobat shows the same message and does not crash.
    Also start Fartcrobat from a PowerShell 7 window (so it inherits PowerShell 7's `PSModulePath`): the store still works, because the helper drops that variable before starting Windows PowerShell 5.1.
25. Watch Microsoft Defender, or the company's EDR, for alerts about Fartcrobat starting PowerShell.

## Known limits

**V2/V4 (RC4 and AES-128) files**

- They open by decrypting everything at open time. On large files this is slower and uses more memory. It has not been tested on anything bigger than a few KB.
- They are saved back as V5 / AES-256, so the other recipients need Acrobat 9 or later.
- We never write V4.

**Signing certificate-encrypted files**

- Signing is disabled in v1.
- Every save of a certificate-encrypted file is a full rewrite, so existing signatures in it become invalid. The person is warned.
- The real fix is a PubSec-aware incremental save, estimated at 3 to 5 days.

**Linux without a secret service** (no GNOME Keyring or KWallet, as on minimal desktops and CI)

- Nothing is remembered, and the checkbox is replaced by a note.
- Certificate-encrypted files still open with a Digital ID, but its password is asked for every time.

**Certificate stores on macOS and Linux**

- Only Digital IDs are supported.
- Keychain identities on macOS (possibly through `security cms -D`, inferred) and PKCS#11 smart cards on Linux are not planned.

**Recipient key types**

- **EC (ECDH) recipients** are not supported, for opening or creating. .NET on Linux cannot do it (verified); .NET Framework on Windows is unknown.
- **RSA-OAEP recipients** are opened but never written. Both the Windows store helper (pwsh on Linux) and Digital IDs (tested with the OAEP fixture, SHA-256) open them.

**Smart cards and locked-down machines**

- **The PIN is asked once per session.** Windows keeps a smart card's PIN per process (inferred from Microsoft's documentation), and the helper is one long-lived process per app session (owner decision). While it runs, an agent can open more files protected by that card without the person; "Lock smart card" in Preferences > Digital IDs, or quitting Fartcrobat, stops it. A helper that times out (5 minutes waiting for a PIN) is stopped too, so the next open asks again.
- **Machines in Constrained Language Mode cannot run the helper.** The fix is an Authenticode-signed `.ps1` run with `-File`, which needs the code-signing certificate from backlog item 1.

**Saved secrets and other programs running as the same user**

- DPAPI, Keychain and libsecret protect against other accounts, other machines and offline theft.
- They do not protect against malware, or an agent with shell access, running as the same user.
- A remembered owner password also lifts restrictions silently.

**File size and history**

- Saving back writes no object streams and drops earlier revisions, so files can grow.
- Peak memory is about three times the document.

**PDF MAC** (ISO/TS 32004, which pyHanko adds by default)

- It is ignored on open (verified to open) and dropped on save.
- pyHanko then refuses the saved file: the envelopes it wrote say a missing MAC is not allowed, and those envelopes cannot be changed without every recipient's certificate. Acrobat does not write a PDF MAC, so this only affects files made by pyHanko. Keeping the MAC means implementing ISO/TS 32004.

**What certificate-encrypted files open**

- Files that MuPDF would have to repair are refused (CERTIFICATE_OPEN_FAILED), because a repaired file's xref can no longer be trusted for the decrypt pass.
- Files that encrypt only attachments (`/StmF /Identity`, or `/EFF` with its own recipients), and files whose strings and streams use different crypt filters, are not supported.
- For RC4 files the check that a seed is right is a heuristic (zlib headers or plain text in streams); a file with neither could open with garbage for a wrong seed of the right envelope, which only a broken envelope can produce.
- V1 and V2 public-key files (`/Recipients` at the top level, SubFilters s3 and s4) have a code path but no fixture.
- Messages name recipients by serial number and issuer, because the envelope has no name in it.
- Files with more than 100 envelopes, an envelope over 1 MB or over 4 MB of `/Recipients` in all are refused (CERTIFICATE_UNSUPPORTED). Real files have a few envelopes of a few kilobytes.

**Password security and a direct `/Info` dictionary** (found while building this; not about certificates)

- MuPDF's password writer leaves an `/Info` dictionary that sits directly in the trailer, rather than as an object, unencrypted: with Protect > Encrypt with Password, such a file's title and author stay readable without the password (verified with mupdf 1.28.1 and AES-256). Certificate security moves it into an object first. The same move in the password save path would fix it; see the backlog in `CLAUDE.md`.

**Labels in the store file**

- `saved-passwords.json` holds file names in clear text, like the recent-files list.
- This shows which protected files exist.

## Open questions for the owner

Answered by the owner decisions above: 1 (ticked by default), 2 (agents unlock silently; no separate policy key yet), 3 (PIN once per session), 4 (warn, then allow) and 5 (upgrade V4 to AES-256). The others are still open.

1. Is it acceptable for the Remember checkbox to be ticked by default? (Recommended: yes.)
2. Should agents be allowed to unlock files silently? Or should a policy key such as `agentUnlock.enabled` let IT turn it off for agents while keeping it for people?
3. For smart cards, which do you want?
   - A PIN on every open. This is safer, and it is the current plan.
   - A long-lived helper that caches the PIN for the session. This is more convenient, but an agent could then open more card-protected files without the human.
4. For signed certificate-encrypted files, should Save be blocked entirely, or allowed with the warning (the current plan)?
5. Is it acceptable to upgrade V4 files to AES-256 when they are saved, given that recipients then need Acrobat 9 or later?
6. Should people's own opens of protected files also be logged locally, or only agents' opens (the current plan)?
7. Should the file names in `saved-passwords.json` be encrypted now, or later?
8. Do you need Active Directory lookup of colleagues' certificates in v1? It is not planned. The plan covers .cer files, the Windows "Other People" store and Digital IDs.
9. Which Acrobat setting does your team use for certificate security, 128-bit or 256-bit AES? Checklist items 11 and 16 will tell us, and the answer decides how important the V4 path is.
10. When will a code-signing certificate be available? Locked-down machines depend on it.

## Appendix: evidence for the open path

The open-and-save spike was stopped early, so the open path was checked for this note:

- **Folder:** `prototypes/passwordless/certificate-open` (removed once ported to `src/`, like the other prototypes; it is in the git history).
- **Versions:** Node 22.22.0, mupdf 1.28.1, pyHanko 0.37.0.
- **Code quality:** the code there (`pdflex.mjs`, `bridge-append.mjs`, `bridge-v4.mjs`) is spike quality. It finds the Encrypt object and the object streams by scanning for `n g obj` headers. The app should use a real xref reader instead.

**1. MuPDF refuses PubSec files** in `openDocument`, before `needsPassword` is ever reached (verified). `node probe_open.mjs <files>` printed:

- for every PubSec file: `pubsec-aes256.pdf THROWS: unknown encryption handler: 'Adobe.PubSec'`;
- for the password fixture: `encrypted.pdf opened needsPassword=true Filter=/Standard`.

**2. New pyHanko fixtures**, made with `python -I make_variants.py recipient.crt recipient.key out`:

- V5 classic;
- V5 with an xref stream and object streams;
- a V5 incremental update on top of that;
- V4 AES-128, classic and with object streams;
- V4 RC4.

pyHanko decrypts all of them with `AuthStatus.USER`.

**3. V5 append bridge**, run with `node try_v5.mjs recipient.crt recipient.key <files>`. Each line printed `auth=6 pages=N text=... repaired=false`.

- `v5-classic` and `v5-xrefstream-objstm`: text "Hello secret world", note "Note text in an object stream", title "Secret title".
- `v5-incremental`: title "Updated secret title", which is the newer revision.
  - The first run showed the old title, because the spike took the first `startxref` in the last 2 KB.
  - It was fixed to take the last one. This is worth a regression test.
- The earlier fixtures `pubsec-aes256` (with a PDF MAC), `pubsec-aes256-nometa`, `pubsec-multi` and `pubsec-two-envelopes` all open, with 5 pages and the title "Fixture Text Document".
- `pubsec-oaep`: `FAILED Encryption block is invalid.`
  - The spike's decrypter only does PKCS#1 v1.5.
  - The app's Digital ID source must also try OAEP.

**4. Save back from the incremental file with object streams**, run with `node saveback_any.mjs ...`:

- MuPDF printed: `same K: true | /Filter/Standard left in output: false | plaintext note in output: false | reopened annots: ["Note text in an object stream","Added after a bridged open"] | title: Updated secret title`.
- pyHanko: `AuthStatus.USER`, with annotations `['Note text in an object stream', 'Added after a bridged open']`.

**5. V2/V4 decrypt pass**, run with `node try_v4.mjs ...`:

- All three files printed `needsPassword=false text="Hello secret world" annots=["Note text in an object stream"] title="Secret title" repaired=false`, in 41 to 110 ms.
- After saving them back as V5 with the same envelopes, pyHanko reports `V 5 AuthStatus.USER` for all three, with the same content, note and title.

**Not checked here:**

- files from Acrobat;
- large V4 files;
- damaged files (MuPDF repairing the bridged bytes);
- SKI recipients and 3DES envelopes on the Digital ID path.

