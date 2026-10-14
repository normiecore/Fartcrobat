/**
 * Certificate encryption, renderer side: the unlock logic of unlock.ts wired to the main process
 * ('certkeys:*') and to the app's dialogs. The person's private keys, Digital ID passwords and smart
 * card PINs stay in the main process; only the seed a key unwrapped comes here, to be given to this
 * window's engines (CertificateKey). Never log, show or persist a key.
 */
import type {
  CertificateKey,
  CertificateLock,
  CertKeyActor,
  CertKeyCandidate,
  CertKeysDecryptRequest,
  CertKeysDecryptResult,
  CertKeysErrorCode,
  CertKeyVia
} from '@shared/certkeys'
import type { PasswordAccess } from '@shared/types'
import { invoke } from '../platform'
import { ask, promptPassword } from '../ui/dialogs'
import { runCommand } from './commands'
import { registry } from './registry'
import { keepRememberChoice, rememberOffer } from './savedPasswords'
import { useApp, type ProgressEntry } from './store'
import { toast } from './ui-services'
import { digitalIdPromptMessage, unlockCertificateOutcome, type BlockedWindowsStore, type CertProblem } from './unlock'

/** The command that adds a Digital ID (registered by the digital-signatures feature). */
export const ADD_DIGITAL_ID_COMMAND = 'sign.addDigitalId'

/** How long a Windows store decrypt may take before "Waiting for your smart card..." shows. */
const WAITING_DELAY_MS = 1000

export interface UnlockCertificateRequest {
  /** File name, shown in the messages. */
  name: string
  /**
   * Where the file is; null for content only in memory. Like unlockFile's, though keys are found by
   * the file's recipients, not by where it is.
   */
  filePath?: string | null
  /** The file's certificate security (from the engine's needsCertificate result). */
  certificate: CertificateLock
  /**
   * Gives a key to the engine that has the file (doc.unlockCertificate, or doc.addCertificateKey
   * and then open it again); false when that key does not open it.
   */
  attempt(key: CertificateKey): Promise<boolean>
  /** Replaces "to open “file.pdf”" in the Digital ID prompt, e.g. "to compare “file.pdf”". */
  purpose?: string
  /** Default 'person'. Agents unlock silently like the person; the main process logs it. */
  actor?: CertKeyActor
  /**
   * Throw instead of resolving null when the person did not cancel, so an agent learns why (after
   * the person was told): CertificateUnavailableError when none of their keys opens the file,
   * CertificateKeyFailedError when a key that matches could not be used.
   */
  failWithoutKey?: boolean
}

export interface CertificateUnlocked {
  /** Opens this file and everything made from it. Secret: only for this window's engines. */
  key: CertificateKey
  /** Which key opened it (no secrets), for the audit log and the Protect panel. */
  via: CertKeyVia
  access: PasswordAccess
}

/** None of the person's keys opens a certificate-encrypted file (they were told why). */
export class CertificateUnavailableError extends Error {
  readonly code = 'NO_CERTIFICATE'
  constructor(
    message: string,
    /** Only keys Fartcrobat cannot use yet (elliptic-curve) match. */
    readonly unsupportedKey: boolean,
    /** The Windows certificate store could not be searched, and why. */
    readonly windowsStore?: BlockedWindowsStore
  ) {
    super(message)
    this.name = 'CertificateUnavailableError'
  }
}

/**
 * A key of the person's that matches a certificate-encrypted file could not be used, and they could
 * only acknowledge it (a blocked PIN, a Digital ID file that is gone, a key that did not open the
 * file...). The message is the one they were shown.
 */
export class CertificateKeyFailedError extends Error {
  readonly code = 'CERTIFICATE_FAILED'
  constructor(
    message: string,
    /** The key's name (Digital ID name or certificate common name). */
    readonly label: string,
    /** Why it failed (certkeys:decrypt's code; 'ERROR' for a key the engine refused). */
    readonly problem: CertKeysErrorCode
  ) {
    super(message)
    this.name = 'CertificateKeyFailedError'
  }
}

/** Dialog titles for key problems. */
function problemTitle(p: CertProblem): string {
  switch (p.code) {
    case 'WRONG_PIN':
      return 'Incorrect PIN'
    case 'PIN_BLOCKED':
      return 'Smart card blocked'
    case 'CARD_NOT_PRESENT':
      return 'Smart card not found'
    case 'CONSTRAINED_LANGUAGE':
    case 'POWERSHELL_UNAVAILABLE':
      return 'Windows certificate store unavailable'
    default:
      return `Could not use “${p.candidate.label}”`
  }
}

/** A certkeys:decrypt that may be waiting for the person in Windows' dialog. */
interface Wait {
  candidate: CertKeyCandidate
  /** Stops waiting for it (and the request in the main process). */
  stop: () => void
}

/**
 * Decrypts shown as waiting, oldest first. One progress window stands for all of them: it says what
 * the newest waits for, and its Cancel stops them all (they wait on the same Windows helper, which
 * a cancel stops anyway).
 */
const waits: Wait[] = []
/** The progress the waiting window covers, shown again when nothing waits any more. */
let covered: ProgressEntry | null = null

function cancelWaits() {
  for (const w of [...waits]) w.stop()
}

/** The waiting window, also after withProgress reported into it (that copies the entry). */
function isWaitingWindow(p: ProgressEntry | null): boolean {
  return !!p && p.cancel === cancelWaits
}

/** Shows the waiting window for the newest wait, or what it covered once none is left. */
function showWaits() {
  const current = useApp.getState().progress
  const newest = waits.at(-1)
  if (!newest) {
    if (isWaitingWindow(current)) useApp.setState({ progress: covered })
    covered = null
    return
  }
  // Another progress replaced the window (or cleared it) meanwhile: that is what it covers now.
  if (!isWaitingWindow(current)) covered = current
  useApp.setState({
    progress:
      newest.candidate.hardware === false
        ? { title: 'Waiting for Windows…', message: 'If Windows asks, allow Fartcrobat to use your certificate.', fraction: null, cancel: cancelWaits }
        : { title: 'Waiting for your smart card…', message: 'Enter your PIN in the Windows dialog.', fraction: null, cancel: cancelWaits }
  })
}

/**
 * Shows the progress window while Windows may be waiting for the person (a smart card PIN, or
 * consent to use a protected key). Returns its removal: the window then shows the next wait, or
 * what it covered; another progress shown meanwhile stays.
 */
function showWaiting(wait: Wait): () => void {
  waits.push(wait)
  showWaits()
  return () => {
    const i = waits.indexOf(wait)
    if (i < 0) return
    waits.splice(i, 1)
    const current = useApp.getState().progress
    if (!waits.length || current === null || isWaitingWindow(current)) showWaits()
  }
}

/** Names a certkeys:decrypt for certkeys:cancel. */
function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * certkeys:decrypt. A Windows store key may wait for the person in Windows' own dialog: after about
 * a second, say so, with Cancel. Cancel ends the unlock at once and stops the request in the main
 * process (certkeys:cancel), which closes Windows' dialog and frees the helper for the next file.
 * That stops the helper, so a smart card PIN already entered is asked again next time.
 */
async function decrypt(request: CertKeysDecryptRequest, candidate: CertKeyCandidate | undefined): Promise<CertKeysDecryptResult> {
  const requestId = newRequestId()
  const call = invoke('certkeys:decrypt', { ...request, requestId })
  if (candidate?.source !== 'windows-store') return call
  let stop!: () => void
  const stopped = new Promise<CertKeysDecryptResult>((resolve) => {
    let sent = false
    stop = () => {
      resolve({ ok: false, code: 'CANCELLED', message: 'Cancelled.' })
      if (sent) return
      sent = true
      void Promise.resolve()
        .then(() => invoke('certkeys:cancel', requestId))
        .catch(() => {})
    }
  })
  const waiting: { hide?: () => void } = {}
  const timer = setTimeout(() => (waiting.hide = showWaiting({ candidate, stop })), WAITING_DELAY_MS)
  try {
    return await Promise.race([call, stopped])
  } finally {
    clearTimeout(timer)
    waiting.hide?.()
  }
}

/**
 * Opens a certificate-encrypted file with one of the person's keys: keys that need nothing open it
 * silently (the Windows certificate store, Digital IDs whose password is saved), a smart card asks
 * for its PIN in Windows' dialog, else the person types their Digital ID's password, with
 * "Remember password on this device". When no key matches, the person is told who the file is
 * encrypted for (and why the Windows certificate store was not searched, when it could not be) and
 * can add a Digital ID. Null when they cancel or no key opens it; with `failWithoutKey`, only when
 * they cancel (the other cases throw, see there).
 */
export async function unlockCertificateFile(req: UnlockCertificateRequest): Promise<CertificateUnlocked | null> {
  const blobs = req.certificate.recipients
  const actor = req.actor ?? 'person'
  const byId = new Map<string, CertKeyCandidate>()
  let key: CertificateKey | null = null
  let rememberAsked = false
  let noKey: NoKey | null = null
  const canAddDigitalId = registry.commands.has(ADD_DIGITAL_ID_COMMAND)

  const outcome = await unlockCertificateOutcome(
    {
      probe: async () => {
        const res = await invoke('certkeys:probe', { blobs })
        for (const c of res.candidates) if (!byId.has(c.id)) byId.set(c.id, c)
        return res
      },
      decrypt: (request) => decrypt({ ...request, blobs }, byId.get(request.candidate)),
      attempt: async (res) => {
        const envelope = blobs[res.envelope]
        if (!envelope) return false
        const k: CertificateKey = { envelope, seed: res.seed, permissions: res.permissions }
        if (!(await req.attempt(k))) return false
        key = k
        return true
      },
      askPassword: async (state) => {
        const answer = await promptPassword({
          title: 'Digital ID password',
          message: digitalIdPromptMessage(req.name, state, req.purpose),
          remember: state.remember
        })
        if (answer && state.remember.offer) {
          rememberAsked = answer.remember
          if (answer.remember !== state.remember.checked) keepRememberChoice(answer.remember)
        }
        return answer
      },
      problem: async (p) => {
        const answer = await ask({
          title: problemTitle(p),
          message: p.message,
          buttons: p.canRetry
            ? [
                { id: 'cancel' as const, label: 'Cancel' },
                { id: 'retry' as const, label: 'Try Again', variant: 'primary' as const }
              ]
            : [{ id: 'cancel' as const, label: 'OK', variant: 'primary' as const }]
        })
        return answer === 'retry' ? 'retry' : 'cancel'
      },
      noKey: async (state) => {
        noKey = { message: state.message, unsupportedKey: state.unsupportedKey, windowsStore: state.windowsStore }
        const answer = await ask({
          title: `Cannot open “${req.name}”`,
          message: state.message,
          buttons: state.canAdd
            ? [
                { id: 'cancel' as const, label: 'Cancel' },
                { id: 'add' as const, label: 'Add Digital ID…', variant: 'primary' as const }
              ]
            : [{ id: 'cancel' as const, label: 'OK', variant: 'primary' as const }]
        })
        return answer === 'add' ? 'add' : 'cancel'
      },
      addDigitalId: async () => {
        noKey = null
        await runCommand(ADD_DIGITAL_ID_COMMAND)
      }
    },
    { name: req.name, actor, remember: rememberOffer, canAddDigitalId }
  )
  // Set by the ports above (TypeScript does not follow assignments made in callbacks).
  const opened = key as CertificateKey | null
  const unavailable = noKey as NoKey | null
  if (!outcome.ok || !opened) {
    if (req.failWithoutKey) {
      // The person did not cancel: say why to the agent (the person was told already).
      if (unavailable) throw new CertificateUnavailableError(unavailable.message, unavailable.unsupportedKey, unavailable.windowsStore)
      const failed = outcome.ok ? null : outcome.problem
      if (failed) throw new CertificateKeyFailedError(failed.message, failed.candidate.label, failed.code)
    }
    return null
  }
  const { via, access } = outcome.unlocked
  if (via.source === 'digital-id' && rememberAsked && !via.remembered && !via.savedPassword)
    toast(`The password of your Digital ID “${via.label}” could not be saved on this device.`, { kind: 'warning' })
  return { key: opened, via, access }
}

/** What the no-key message said (for CertificateUnavailableError). */
interface NoKey {
  message: string
  unsupportedKey: boolean
  windowsStore?: BlockedWindowsStore
}
