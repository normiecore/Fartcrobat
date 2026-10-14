// Windows certificate store access for certificate-encrypted PDFs, without native code.
//
// Runs the scripts in winStoreScripts.ts with the Windows PowerShell 5.1 that ships with Windows 10/11
// (.NET Framework EnvelopedCms over CryptoAPI/CNG), so keys in CurrentUser\My, LocalMachine\My and on
// smart cards work, and Windows shows its own PIN prompt. The script travels on stdin
// (`-Command -`), so there is no command-line length limit, no encoded command, and no execution policy
// override (policy only governs script files). Runs in the Electron main process.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { DECRYPT_BODY, DIRECTORY_BODY, LIST_BODY, buildScript } from './winStoreScripts.ts'

export type WinStoreCode =
  | 'NOT_WINDOWS'
  | 'POWERSHELL_UNAVAILABLE'
  | 'CONSTRAINED_LANGUAGE'
  | 'HELPER_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'BAD_INPUT'
  | 'NO_MATCHING_CERT'
  | 'CANCELLED'
  | 'WRONG_PIN'
  | 'PIN_BLOCKED'
  | 'CARD_NOT_PRESENT'
  | 'KEY_UNAVAILABLE'
  | 'KEY_ACCESS_DENIED'
  | 'UI_REQUIRED'
  | 'DECRYPT_FAILED'
  | 'UNSUPPORTED'
  | 'DIRECTORY_UNAVAILABLE'
  | 'ERROR'

export class WinStoreError extends Error {
  readonly code: WinStoreCode
  readonly detail: unknown
  constructor(code: WinStoreCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'WinStoreError'
    this.code = code
    this.detail = detail
  }
}

export interface RunOptions {
  /** Defaults to %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe (never a PATH lookup). */
  powershellPath?: string
  /** Decrypt waits for the person to type a PIN, so its default is long. */
  timeoutMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export interface RecipientId {
  blob: number
  index: number
  type?: string
  idType?: string
  keyEncryptionAlgorithm?: string
  issuer?: string
  serial?: string
  ski?: string
  error?: string
  message?: string
}

export interface Candidate {
  blob: number
  index: number
  store: string
  thumbprint: string
  subject: string
  notAfter: string
  issuerMatch: boolean
}

export interface ProbeResult {
  candidates: Candidate[]
  recipients: RecipientId[]
}

export interface DecryptResult {
  /** Index into the /Recipients array whose envelope was opened. */
  blob: number
  /** RecipientInfo index inside that envelope. */
  index: number
  store: string
  thumbprint: string
  subject: string
  contentEncryptionAlgorithm: string
  keyEncryptionAlgorithm: string
  /** ContentInfo.Content: for PubSec, the 20-byte seed followed by 4 permission bytes. */
  content: Uint8Array
}

export interface StoreCertificate {
  store: string
  thumbprint: string
  subject: string
  issuer: string
  serial: string
  notBefore: string
  notAfter: string
  publicKeyAlgorithm: string
  /** X509KeyUsageFlags, or -1 when the certificate has no key usage extension. */
  keyUsage: number
  encryptionUsage: 'unrestricted' | 'keyEncipherment' | 'dataEncipherment' | 'keyAgreement' | null
  ekus: string[]
  email: string
  friendlyName: string
  hasPrivateKey: boolean
  der: Uint8Array
}

export interface DirectoryPerson {
  displayName: string
  mail: string
  userCertificate: Uint8Array[]
  /** PKCS#7 blobs (S/MIME capabilities and certificates); parse the certificates out with node-forge. */
  userSMIMECertificate: Uint8Array[]
}

const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']
const SENTINEL = 'FCJSON:'

export function defaultPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// One helper at a time: two concurrent decrypts could stack two PIN dialogs.
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Runs one script and returns the parsed FCJSON object (ok or not). */
export function runHelper(script: string, opts: RunOptions = {}): Promise<Record<string, unknown>> {
  return serialized(
    () =>
      new Promise((resolve, reject) => {
        if (!opts.powershellPath && process.platform !== 'win32') {
          reject(new WinStoreError('NOT_WINDOWS', 'The Windows certificate store is only available on Windows'))
          return
        }
        if (opts.signal?.aborted) {
          reject(new WinStoreError('ABORTED', 'Cancelled'))
          return
        }
        const exe = opts.powershellPath ?? defaultPowerShellPath(opts.env)
        const child = spawn(exe, PS_ARGS, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...(opts.env ?? process.env), TERM: 'dumb', POWERSHELL_TELEMETRY_OPTOUT: '1' },
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          fn()
        }
        const timer = setTimeout(() => {
          child.kill()
          finish(() => reject(new WinStoreError('TIMEOUT', 'The certificate helper did not answer in time')))
        }, opts.timeoutMs ?? 60_000)
        const onAbort = (): void => {
          child.kill()
          finish(() => reject(new WinStoreError('ABORTED', 'Cancelled')))
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s))
        child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
        child.on('error', (err: NodeJS.ErrnoException) => {
          finish(() =>
            reject(
              new WinStoreError('POWERSHELL_UNAVAILABLE', `Could not start PowerShell (${err.code ?? err.message})`, {
                errno: err.code,
                path: exe,
              }),
            ),
          )
        })
        child.on('close', (exitCode) => {
          const line = stdout.split(/\r?\n/).find((l) => l.startsWith(SENTINEL))
          if (!line) {
            finish(() =>
              reject(
                new WinStoreError('HELPER_FAILED', 'The certificate helper gave no answer', {
                  exitCode,
                  stderr: stderr.slice(-2000),
                  stdout: stdout.slice(-500),
                }),
              ),
            )
            return
          }
          try {
            const parsed = JSON.parse(line.slice(SENTINEL.length)) as Record<string, unknown>
            finish(() => resolve(parsed))
          } catch (e) {
            finish(() => reject(new WinStoreError('HELPER_FAILED', 'Unreadable answer from the certificate helper', e)))
          }
        })
        child.stdin.on('error', () => undefined) // the process may exit before reading everything
        child.stdin.end(script, 'utf8')
      }),
  )
}

function fail(result: Record<string, unknown>): never {
  const code = (typeof result.code === 'string' ? result.code : 'ERROR') as WinStoreCode
  const messages: Record<string, string> = {
    CONSTRAINED_LANGUAGE: 'PowerShell runs in Constrained Language Mode on this computer, so Fartcrobat cannot use the Windows certificate store',
    NO_MATCHING_CERT: 'None of your certificates can open this document',
    CANCELLED: 'Cancelled',
    WRONG_PIN: 'The smart card PIN was wrong',
    PIN_BLOCKED: 'The smart card is blocked',
    CARD_NOT_PRESENT: 'Insert the smart card that holds your certificate',
    KEY_UNAVAILABLE: 'The private key for your certificate is not available',
    KEY_ACCESS_DENIED: 'Windows denied access to the private key',
    UNSUPPORTED: 'This kind of certificate encryption is not supported',
    DIRECTORY_UNAVAILABLE: 'The directory could not be searched',
  }
  throw new WinStoreError(code, messages[code] ?? String(result.message ?? 'Certificate store error'), result)
}

const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')
const unb64 = (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s), 'base64'))

function blobVars(blobs: Uint8Array[]): string[] {
  if (blobs.length === 0) throw new WinStoreError('BAD_INPUT', 'The document lists no recipients')
  return blobs.map(b64)
}

/** Which of the person's certificates could open these /Recipients, without touching any key (no PIN prompt). */
export async function probeRecipients(blobs: Uint8Array[], opts: RunOptions = {}): Promise<ProbeResult> {
  const script = buildScript(DECRYPT_BODY, { Blobs: blobVars(blobs), Mode: 'probe', Thumbprint: '' })
  const r = await runHelper(script, { timeoutMs: 60_000, ...opts })
  if (r.ok !== true) fail(r)
  return { candidates: r.candidates as Candidate[], recipients: r.recipients as RecipientId[] }
}

/**
 * Opens the first envelope one of the person's certificates can decrypt. May show the smart card PIN
 * prompt. `thumbprint` restricts the attempt to one certificate (after the person picked it).
 */
export async function decryptRecipients(
  blobs: Uint8Array[],
  opts: RunOptions & { thumbprint?: string } = {},
): Promise<DecryptResult> {
  const thumbprint = opts.thumbprint ?? ''
  if (!/^[0-9A-Fa-f]*$/.test(thumbprint)) throw new WinStoreError('BAD_INPUT', 'Bad thumbprint')
  const script = buildScript(DECRYPT_BODY, { Blobs: blobVars(blobs), Mode: 'decrypt', Thumbprint: thumbprint })
  const r = await runHelper(script, { timeoutMs: 5 * 60_000, ...opts })
  if (r.ok !== true) fail(r)
  return {
    blob: r.blob as number,
    index: r.index as number,
    store: r.store as string,
    thumbprint: r.thumbprint as string,
    subject: r.subject as string,
    contentEncryptionAlgorithm: r.contentEncryptionAlgorithm as string,
    keyEncryptionAlgorithm: r.keyEncryptionAlgorithm as string,
    content: unb64(r.content),
  }
}

/** The person's certificates usable for encryption (with private key), plus "Other People" if asked. */
export async function listEncryptionCertificates(
  opts: RunOptions & { includeOthers?: boolean } = {},
): Promise<StoreCertificate[]> {
  const script = buildScript(LIST_BODY, { IncludeOthers: opts.includeOthers ?? false })
  const r = await runHelper(script, { timeoutMs: 60_000, ...opts })
  if (r.ok !== true) fail(r)
  return (r.certificates as Array<Record<string, unknown>>).map((c) => ({ ...c, der: unb64(c.der) }) as StoreCertificate)
}

/** Active Directory lookup of colleagues' encryption certificates (domain-joined Windows only). */
export async function findDirectoryCertificates(query: string, opts: RunOptions = {}): Promise<DirectoryPerson[]> {
  const q = query.trim()
  if (!q || q.length > 256) throw new WinStoreError('BAD_INPUT', 'Type a name or e-mail address')
  const script = buildScript(DIRECTORY_BODY, { QueryB64: Buffer.from(q, 'utf8').toString('base64') })
  const r = await runHelper(script, { timeoutMs: 30_000, ...opts })
  if (r.ok !== true) fail(r)
  return (r.people as Array<Record<string, unknown>>).map((p) => ({
    displayName: String(p.displayName ?? ''),
    mail: String(p.mail ?? ''),
    userCertificate: (p.userCertificate as string[]).map(unb64),
    userSMIMECertificate: (p.userSMIMECertificate as string[]).map(unb64),
  }))
}
