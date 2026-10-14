// pyHanko reads the certificate-encrypted files Fartcrobat writes, as an independent /Adobe.PubSec
// implementation (passwordless-create and passwordless-save). CI installs it from
// tests/requirements.txt and sets FARTCROBAT_REQUIRE_PYHANKO=1, so those checks cannot quietly go
// back to being skipped there; elsewhere they skip when it is missing.
import { spawnSync } from 'node:child_process'

/**
 * The modules the checks import, with the flag they run with: `python3 -I` ignores PYTHONPATH and
 * the user's site-packages. Importing modules, not just `pyhanko` (a namespace package that any
 * folder of that name satisfies), also catches a partial install.
 */
const PROBE = [
  'from pyhanko.pdf_utils import generic',
  'from pyhanko.pdf_utils.crypt import SimpleEnvelopeKeyDecrypter',
  'from pyhanko.pdf_utils.crypt.api import AuthStatus',
  'from pyhanko.pdf_utils.reader import PdfFileReader'
].join('\n')

let available: boolean | undefined

/** Whether pyHanko can run the checks (the probe must exit 0). */
export function hasPyHanko(): boolean {
  if (available === undefined) {
    try {
      const r = spawnSync('python3', ['-I', '-c', PROBE], { stdio: 'ignore' })
      available = r.status === 0 && !r.error
    } catch {
      available = false
    }
  }
  if (!available && process.env.FARTCROBAT_REQUIRE_PYHANKO === '1')
    throw new Error(
      'FARTCROBAT_REQUIRE_PYHANKO is set but `python3 -I` cannot import pyHanko (pip install -r tests/requirements.txt)'
    )
  return available
}
