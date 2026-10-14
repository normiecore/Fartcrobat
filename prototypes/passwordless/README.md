# Passwordless prototypes (not shipped)

Working prototypes from the spikes behind `docs/features/passwordless.md`. They are kept here so the
implementation can port them; delete each folder once its code lives in `src/`. Nothing here is
built, linted, type-checked or tested by the repo's scripts.

| Folder | What it proves | Port to |
| --- | --- | --- |
| `remember-passwords/` | Lock/ID keys read before authentication, a safeStorage-backed store (async API, Linux `v10` check), the unlock flow; 32 vitest tests; Electron probes | `src/main/passwords/`, `src/engine/util/lockInfo.ts`, `src/renderer/src/app/unlock.ts` |
| `certificate-open/` | Opening Adobe.PubSec files: V5 by appending a Standard R6 dictionary that wraps the file key, V2/V4 by a decrypt pass | `src/engine/crypt/` |
| `certificate-create/` | Creating and saving back PubSec V5 files ("encrypt in place" plus a small serialiser), checked in pyHanko, MuPDF and PDFBox | `src/engine/crypt/`, `src/engine/util/pdfWriter.ts`, `src/features/protect-optimize/pubsec*.ts` |
| `windows-store/` | Windows certificate store and smart cards through stock PowerShell 5.1 and .NET `EnvelopedCms`, no native code; 25 tests under pwsh 7 on Linux | `src/main/certkeys/` |

`certificate-create/keys/` holds throwaway test certificates and keys made for these spikes only.
The prototypes import mupdf and node-forge from the repo's `node_modules` by path and expect
pyHanko in a local virtualenv for the cross-checks; see each folder's scripts.
