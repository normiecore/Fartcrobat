// The Windows certificate store and smart cards as a source of keys for certificate-encrypted PDFs
// (Windows only). Keys stay in Windows: the PowerShell helper (winCertStore.ts) unwraps the envelope
// with .NET EnvelopedCms, and only the envelope's content (seed and permission bytes) comes back.
// Windows shows its own smart card PIN dialog; the PIN stays entered in the helper process until
// stop() ("Lock smart card", quitting Fartcrobat).
import type {
  CertKeyCandidate,
  CertKeysErrorCode,
  EncryptionCertificate,
  WindowsStoreState
} from '@shared/certkeys'
import {
  CertKeyError,
  type RecipientKeySource,
  type SourceDecryptOptions,
  type SourceDecryptResult
} from './source'
import {
  DECRYPT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  PowerShellHelper,
  WinStoreError,
  decryptRecipients,
  listEncryptionCertificates,
  probeRecipients,
  type WinStoreCode
} from './winCertStore'

export interface WindowsStoreOptions {
  platform: NodeJS.Platform
  /** Preferences > Digital IDs: "Use certificates from the Windows certificate store". */
  enabled: () => boolean
  /** Tests only: a PowerShell to run instead of the stock Windows PowerShell 5.1. */
  powershellPath?: string
  env?: NodeJS.ProcessEnv
  /** Tests only: shorter timeouts than 60 s (probe, list) and 5 min (decrypt, which may wait for a PIN). */
  timeouts?: { probeMs?: number; decryptMs?: number }
}

export interface WindowsStore extends RecipientKeySource {
  readonly kind: 'windows-store'
  state(): Promise<WindowsStoreState>
  /** The helper process is running (a smart card PIN entered in it stays valid until stop()). */
  running(): boolean
  listEncryptionCertificates(opts: { includeOthers: boolean }): Promise<EncryptionCertificate[]>
  /** Stops the helper ("Lock smart card", quitting). The next call starts a new one. */
  stop(): void
}

/**
 * Options for createWindowsStore from the environment, for tests of unpackaged builds:
 * FARTCROBAT_TEST_POWERSHELL runs that PowerShell (pwsh on Linux) instead of Windows PowerShell 5.1, and
 * FARTCROBAT_TEST_POWERSHELL_HOME sets its HOME, so .NET on Linux reads an isolated certificate store
 * (~/.dotnet/corefx/cryptography/x509stores) instead of the person's own. Packaged builds ignore both.
 */
export function testPowerShellOptions(
  env: NodeJS.ProcessEnv,
  packaged: boolean
): Pick<WindowsStoreOptions, 'powershellPath' | 'env'> {
  const powershellPath = env.FARTCROBAT_TEST_POWERSHELL
  if (packaged || !powershellPath) return {}
  const home = env.FARTCROBAT_TEST_POWERSHELL_HOME
  return { powershellPath, env: home ? { ...env, HOME: home } : env }
}

const RSA_OID = '1.2.840.113549.1.1.1'
const EC_OID = '1.2.840.10045.2.1'
const ID_PREFIX = 'windows-store:'

function keyType(oid: string): 'rsa' | 'ec' | 'other' {
  return oid === RSA_OID ? 'rsa' : oid === EC_OID ? 'ec' : 'other'
}

/** Helper codes as the renderer gets them, with a plain message (no paths, no .NET text). */
const ERRORS: Record<WinStoreCode, { code: CertKeysErrorCode; message: string; hresult?: boolean }> = {
  NOT_WINDOWS: { code: 'ERROR', message: 'The Windows certificate store is only available on Windows.' },
  POWERSHELL_UNAVAILABLE: {
    code: 'POWERSHELL_UNAVAILABLE',
    message:
      'Windows PowerShell could not be started, so Fartcrobat cannot use the Windows certificate store. Use a Digital ID instead.'
  },
  CONSTRAINED_LANGUAGE: {
    code: 'CONSTRAINED_LANGUAGE',
    message:
      'PowerShell runs in Constrained Language Mode on this computer, so Fartcrobat cannot use the Windows certificate store. Use a Digital ID instead.'
  },
  HELPER_FAILED: { code: 'ERROR', message: 'The Windows certificate store could not be used. Try again.' },
  TIMEOUT: { code: 'TIMEOUT', message: 'Windows did not answer in time. Try again.' },
  ABORTED: { code: 'CANCELLED', message: 'Cancelled.' },
  BAD_INPUT: {
    code: 'ERROR',
    message: 'The list of people this document is encrypted for could not be read.'
  },
  NO_MATCHING_CERT: {
    code: 'NO_MATCHING_CERT',
    message: 'None of your certificates can open this document.'
  },
  CANCELLED: { code: 'CANCELLED', message: 'Cancelled.' },
  WRONG_PIN: { code: 'WRONG_PIN', message: 'The smart card PIN was wrong.' },
  PIN_BLOCKED: {
    code: 'PIN_BLOCKED',
    message: 'The smart card is blocked because a wrong PIN was entered too many times.'
  },
  CARD_NOT_PRESENT: {
    code: 'CARD_NOT_PRESENT',
    message: 'Insert the smart card that holds your certificate, then try again.'
  },
  KEY_UNAVAILABLE: {
    code: 'KEY_UNAVAILABLE',
    message: 'The private key for your certificate is not available.',
    hresult: true
  },
  KEY_ACCESS_DENIED: {
    code: 'KEY_UNAVAILABLE',
    message: 'Windows denied access to the private key for your certificate.',
    hresult: true
  },
  UI_REQUIRED: {
    code: 'KEY_UNAVAILABLE',
    message: 'Windows needs to ask you before this key can be used, but could not show its dialog.',
    hresult: true
  },
  DECRYPT_FAILED: {
    code: 'ERROR',
    message: 'Windows could not decrypt this document with your certificate.',
    hresult: true
  },
  UNSUPPORTED: {
    code: 'UNSUPPORTED',
    message:
      'This document is encrypted for a kind of certificate Fartcrobat cannot use yet. Only RSA certificates are supported.'
  },
  ERROR: { code: 'ERROR', message: 'The Windows certificate store could not be used.', hresult: true }
}

/** The HRESULT Windows gave, e.g. "0x80090016" (public; people quote it when reporting a problem). */
function hresultOf(detail: Record<string, unknown> | undefined): string | null {
  const h = detail?.hresult
  return typeof h === 'string' && /^0x[0-9A-F]{8}$/.test(h) ? h : null
}

/** A helper failure as the CertKeyError the certkeys handlers pass on. */
export function toCertKeyError(err: unknown): CertKeyError {
  if (err instanceof CertKeyError) return err
  const known = err instanceof WinStoreError ? ERRORS[err.code] : undefined
  const { code, message, hresult } = known ?? ERRORS.ERROR
  const h = hresult && err instanceof WinStoreError ? hresultOf(err.detail) : null
  return new CertKeyError(code, h ? `${message} (Windows error ${h})` : message)
}

export function createWindowsStore(opts: WindowsStoreOptions): WindowsStore {
  const helper = new PowerShellHelper({
    powershellPath: opts.powershellPath,
    env: opts.env,
    platform: opts.platform
  })
  const probeMs = opts.timeouts?.probeMs ?? PROBE_TIMEOUT_MS
  const decryptMs = opts.timeouts?.decryptMs ?? DECRYPT_TIMEOUT_MS
  // Hardware is only known after a key was used. Remembered for the app session, so the next probe
  // can say "smart card" (and the renderer tries it after keys that need nothing).
  const hardwareByThumbprint = new Map<string, boolean | null>()
  // The helper process in which a smart card (or a key whose kind Windows did not say) was unlocked.
  let unlockedIn: number | undefined

  /** Off: also stops the helper, so turning the switch off locks a smart card at once. */
  const usable = (): boolean => {
    if (!helper.supported) return false
    if (opts.enabled()) return true
    helper.stop()
    return false
  }

  return {
    kind: 'windows-store',

    async state() {
      if (!helper.supported) return 'not-windows'
      if (!usable()) return 'off'
      return helper.blocked ?? 'available'
    },

    running() {
      return helper.running() && unlockedIn !== undefined && helper.pid === unlockedIn
    },

    async probe(blobs) {
      if (!usable() || helper.blocked || blobs.length === 0) return []
      let found
      try {
        found = await probeRecipients(helper, blobs, { timeoutMs: probeMs })
      } catch {
        // No match, or the store cannot be used here (state() says why): Digital IDs are still tried.
        return []
      }
      const seen = new Set<string>()
      const out: CertKeyCandidate[] = []
      for (const c of found.candidates) {
        const thumbprint = c.thumbprint.toUpperCase()
        if (seen.has(thumbprint)) continue
        seen.add(thumbprint)
        const hardware = hardwareByThumbprint.get(thumbprint) ?? null
        const notAfter = Date.parse(c.notAfter)
        out.push({
          id: ID_PREFIX + thumbprint,
          source: 'windows-store',
          label: c.name || c.subject,
          subject: c.subject,
          issuer: c.issuer,
          fingerprint: thumbprint,
          envelope: c.blob,
          index: c.index,
          needs: hardware ? 'pin' : 'nothing',
          hardware,
          keyType: keyType(c.publicKeyAlgorithm),
          ...(Number.isFinite(notAfter) && notAfter < Date.now() ? { expired: true } : {})
        })
      }
      return out
    },

    async decrypt(blobs, candidate, decryptOpts: SourceDecryptOptions): Promise<SourceDecryptResult> {
      const m = /^windows-store:([0-9A-Fa-f]{40})$/.exec(candidate.id)
      if (!m) throw new CertKeyError('ERROR', 'This certificate is not in the Windows certificate store.')
      if (!helper.supported) throw toCertKeyError(new WinStoreError('NOT_WINDOWS', 'not Windows'))
      if (!usable()) {
        throw new CertKeyError(
          'KEY_UNAVAILABLE',
          'Using certificates from the Windows certificate store is turned off in Preferences > Digital IDs.'
        )
      }
      let r
      try {
        r = await decryptRecipients(helper, blobs, {
          thumbprint: m[1],
          timeoutMs: decryptMs,
          signal: decryptOpts.signal
        })
      } catch (err) {
        throw toCertKeyError(err)
      }
      if (!Number.isInteger(r.blob) || r.blob < 0 || r.blob >= blobs.length || r.content.length < 20) {
        throw toCertKeyError(new WinStoreError('HELPER_FAILED', 'bad answer'))
      }
      const thumbprint = r.thumbprint.toUpperCase()
      hardwareByThumbprint.set(thumbprint, r.hardware)
      if (r.hardware !== false) unlockedIn = helper.pid
      return {
        envelope: r.blob,
        content: r.content,
        via: {
          source: 'windows-store',
          label: r.name || r.subject,
          subject: r.subject,
          fingerprint: thumbprint,
          hardware: r.hardware === true
        }
      }
    },

    async listEncryptionCertificates({ includeOthers }) {
      if (!usable()) return []
      let certs
      try {
        certs = await listEncryptionCertificates(helper, { includeOthers, timeoutMs: probeMs })
      } catch (err) {
        throw toCertKeyError(err)
      }
      return certs.map((c) => ({
        store: c.store,
        thumbprint: c.thumbprint.toUpperCase(),
        subject: c.subject,
        issuer: c.issuer,
        serial: c.serial.toUpperCase(),
        notBefore: c.notBefore,
        notAfter: c.notAfter,
        keyType: keyType(c.publicKeyAlgorithm),
        email: c.email ?? '',
        friendlyName: c.friendlyName ?? '',
        hasPrivateKey: c.hasPrivateKey,
        der: c.der
      }))
    },

    stop() {
      unlockedIn = undefined
      helper.stop()
    }
  }
}
