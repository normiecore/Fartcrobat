// Windows certificate store access for certificate-encrypted PDFs, without native code.
//
// Runs the scripts in winStoreScripts.ts with the Windows PowerShell 5.1 that ships with Windows 10/11
// (.NET Framework EnvelopedCms over CryptoAPI/CNG), so keys in CurrentUser\My, LocalMachine\My and on
// smart cards work, and Windows shows its own PIN prompt. Scripts travel on stdin (`-Command -`), so
// there is no command-line length limit, no encoded command, and no execution policy override (policy
// only governs script files). Runs in the Electron main process.
//
// One helper process serves the whole app session (owner decision: a smart card PIN is asked once per
// session, and Windows keeps it per process). It starts on first use and stays until stop() ("Lock
// smart card", quitting), a timeout or a cancel; the next request then starts a new one, and Windows
// asks for the PIN again. It also ends by itself when Fartcrobat goes away, because its stdin closes.
//
// Nothing the helper prints is logged: its answers are parsed, its stderr is drained and dropped.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { DECRYPT_BODY, LIST_BODY, buildScript, endMarker, type ScriptVars } from './winStoreScripts'

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
  | 'ERROR'

/** A helper failure. `detail` is the helper's answer (public data only); never log it. */
export class WinStoreError extends Error {
  constructor(
    readonly code: WinStoreCode,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'WinStoreError'
  }
}

export interface HelperOptions {
  /** Defaults to %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe (never a PATH lookup). */
  powershellPath?: string
  env?: NodeJS.ProcessEnv
  /** Defaults to process.platform. Without powershellPath, only 'win32' runs anything. */
  platform?: NodeJS.Platform
}

export interface RequestOptions {
  timeoutMs: number
  signal?: AbortSignal
}

/** Probing and listing read certificate properties only. */
export const PROBE_TIMEOUT_MS = 60_000
/** Decrypting may wait for the person to type a smart card PIN in Windows' dialog. */
export const DECRYPT_TIMEOUT_MS = 5 * 60_000

export const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']

/** A runaway answer without a line break: give up rather than buffer it forever. */
const MAX_LINE = 64 * 1024 * 1024

export function defaultPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

interface HelperProcess {
  child: ChildProcess
  buffer: string
  dead: boolean
}

interface Pending {
  id: number
  proc: HelperProcess
  resolve: (value: Record<string, unknown>) => void
  reject: (err: WinStoreError) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort: () => void
}

/** Why the helper cannot run until stop(): the language mode, or PowerShell would not start. */
export type HelperBlock = 'constrained' | 'unavailable'

/** Consecutive helper deaths or empty answers after which the store counts as unavailable. */
const MAX_FAILURES = 3

/**
 * The long-lived PowerShell helper. Requests run one at a time (two decrypts at once could stack two
 * PIN dialogs); each is one script block that answers with exactly one `FCJSON:<id>:<json>` line.
 */
export class PowerShellHelper {
  private proc: HelperProcess | null = null
  private pending: Pending | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private blockedBy: HelperBlock | null = null
  private failures = 0

  constructor(private readonly opts: HelperOptions = {}) {}

  /** Windows, or a PowerShell given explicitly (tests). */
  get supported(): boolean {
    return Boolean(this.opts.powershellPath) || (this.opts.platform ?? process.platform) === 'win32'
  }

  /** Set after Constrained Language Mode or a PowerShell that would not start; cleared by stop(). */
  get blocked(): HelperBlock | null {
    return this.blockedBy
  }

  /** The helper process is running. */
  running(): boolean {
    return this.proc !== null
  }

  /** Process id of the running helper (tests: requests share one process). */
  get pid(): number | undefined {
    return this.proc?.child.pid
  }

  /** Runs `body` with `vars` (see buildScript) and returns the parsed answer, ok or not. */
  run(body: string, vars: ScriptVars, opts: RequestOptions): Promise<Record<string, unknown>> {
    return this.runScript((id) => buildScript(body, vars, id), opts)
  }

  /** Sends one request built for its id; it must answer with one FCJSON:<id>: line. */
  runScript(build: (id: number) => string, opts: RequestOptions): Promise<Record<string, unknown>> {
    const run = this.queue.then(
      () => this.send(build, opts),
      () => this.send(build, opts)
    )
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Ends the helper: a smart card PIN entered in it is forgotten, a request waiting in it fails with
   * ABORTED, and the next request starts a new process (and tries a blocked one again).
   */
  stop(): void {
    const p = this.pending
    if (p) this.finish(p, new WinStoreError('ABORTED', 'Cancelled'))
    if (this.proc) this.kill(this.proc)
    this.blockedBy = null
    this.failures = 0
  }

  private send(build: (id: number) => string, opts: RequestOptions): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.supported) {
        reject(new WinStoreError('NOT_WINDOWS', 'The Windows certificate store is only available on Windows'))
        return
      }
      if (this.blockedBy === 'constrained') {
        reject(new WinStoreError('CONSTRAINED_LANGUAGE', 'PowerShell runs in Constrained Language Mode'))
        return
      }
      if (this.blockedBy === 'unavailable') {
        reject(new WinStoreError('POWERSHELL_UNAVAILABLE', 'PowerShell could not be started'))
        return
      }
      if (opts.signal?.aborted) {
        reject(new WinStoreError('ABORTED', 'Cancelled'))
        return
      }
      let proc: HelperProcess
      let script: string
      const id = this.nextId++
      try {
        script = build(id)
      } catch {
        reject(new WinStoreError('BAD_INPUT', 'The request could not be built'))
        return
      }
      try {
        proc = this.proc ?? this.start()
      } catch {
        this.blockedBy = 'unavailable'
        reject(new WinStoreError('POWERSHELL_UNAVAILABLE', 'PowerShell could not be started'))
        return
      }
      const p: Pending = {
        id,
        proc,
        resolve,
        reject,
        signal: opts.signal,
        timer: setTimeout(() => {
          this.finish(p, new WinStoreError('TIMEOUT', 'The certificate helper did not answer in time'))
          this.kill(proc)
        }, opts.timeoutMs),
        onAbort: () => {
          this.finish(p, new WinStoreError('ABORTED', 'Cancelled'))
          this.kill(proc)
        }
      }
      opts.signal?.addEventListener('abort', p.onAbort, { once: true })
      this.pending = p
      // The block only runs after an empty line; the end marker follows it as its own statement.
      const text = script.endsWith('\n\n') ? script : script.replace(/\n*$/, '\n\n')
      proc.child.stdin?.write(text + endMarker(id), 'utf8')
    })
  }

  private start(): HelperProcess {
    const exe = this.opts.powershellPath ?? defaultPowerShellPath(this.opts.env ?? process.env)
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      TERM: 'dumb',
      POWERSHELL_TELEMETRY_OPTOUT: '1'
    }
    // Started from a PowerShell 7 session, PSModulePath lists PowerShell 7's modules first, and Windows
    // PowerShell 5.1 then fails to load its own built-in cmdlets. Without it, 5.1 uses its defaults.
    if (!this.opts.powershellPath) delete env.PSModulePath
    const child = spawn(exe, POWERSHELL_ARGS, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    const proc: HelperProcess = { child, buffer: '', dead: false }
    child.stdout?.setEncoding('utf8').on('data', (s: string) => this.onStdout(proc, s))
    // Drained and dropped: it can hold .NET messages, which are never kept or logged.
    child.stderr?.on('data', () => undefined)
    // The process may exit before reading everything.
    child.stdin?.on('error', () => undefined)
    child.on('error', () => this.onDead(proc))
    child.on('exit', () => this.onDead(proc))
    this.proc = proc
    return proc
  }

  private onStdout(proc: HelperProcess, chunk: string): void {
    if (proc.dead) return
    proc.buffer += chunk
    let nl: number
    while ((nl = proc.buffer.indexOf('\n')) >= 0) {
      const line = proc.buffer.slice(0, nl).replace(/\r$/, '')
      proc.buffer = proc.buffer.slice(nl + 1)
      this.onLine(proc, line)
    }
    if (proc.buffer.length > MAX_LINE) {
      const p = this.pending
      if (p && p.proc === proc)
        this.finish(p, new WinStoreError('HELPER_FAILED', 'Unreadable answer from the certificate helper'))
      this.kill(proc)
    }
  }

  /** Only `FCJSON:<id>:` and `FCEND:<id>` for the request in flight count; any other output is ignored. */
  private onLine(proc: HelperProcess, line: string): void {
    const p = this.pending
    if (!p || p.proc !== proc) return
    // Found anywhere in the line, in case a host writes a prompt in front of it.
    const answer = /FCJSON:(\d+):(.*)$/.exec(line)
    if (answer && Number(answer[1]) === p.id) {
      let parsed: unknown
      try {
        parsed = JSON.parse(answer[2])
      } catch {
        parsed = null
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.failed(p, 'Unreadable answer from the certificate helper')
        return
      }
      const result = parsed as Record<string, unknown>
      this.failures = 0
      if (result.code === 'CONSTRAINED_LANGUAGE') {
        // Nothing else can run in this process; requests fail at once until stop().
        this.blockedBy = 'constrained'
        this.finish(p, null, result)
        this.kill(proc)
        return
      }
      this.finish(p, null, result)
      return
    }
    const end = /FCEND:(\d+)\s*$/.exec(line)
    if (end && Number(end[1]) === p.id) this.failed(p, 'The certificate helper gave no answer')
  }

  private failed(p: Pending, message: string): void {
    if (++this.failures >= MAX_FAILURES) this.blockedBy = 'unavailable'
    this.finish(p, new WinStoreError('HELPER_FAILED', message))
  }

  private onDead(proc: HelperProcess): void {
    if (proc.dead) return
    proc.dead = true
    if (this.proc === proc) this.proc = null
    const p = this.pending
    if (!p || p.proc !== proc) return
    if (proc.child.pid === undefined) {
      // spawn failed: missing, not executable, or blocked (AppLocker)
      this.blockedBy = 'unavailable'
      this.finish(p, new WinStoreError('POWERSHELL_UNAVAILABLE', 'PowerShell could not be started'))
    } else {
      this.failed(p, 'The certificate helper stopped unexpectedly')
    }
  }

  private kill(proc: HelperProcess): void {
    if (this.proc === proc) this.proc = null
    if (proc.dead) return
    proc.dead = true
    try {
      proc.child.stdin?.destroy()
      proc.child.kill()
    } catch {
      // already gone
    }
  }

  private finish(p: Pending, err: WinStoreError | null, value?: Record<string, unknown>): void {
    if (this.pending !== p) return
    this.pending = null
    clearTimeout(p.timer)
    p.signal?.removeEventListener('abort', p.onAbort)
    if (err) p.reject(err)
    else p.resolve(value ?? {})
  }
}

// ---- typed requests ----

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
  issuer: string
  /** The certificate's common name (or another simple name), for labels. */
  name: string
  /** OID of the certificate's public key algorithm. */
  publicKeyAlgorithm: string
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
  issuer: string
  name: string
  contentEncryptionAlgorithm: string
  keyEncryptionAlgorithm: string
  /** The key that decrypted is on a smart card or the TPM; null when Windows did not say. */
  hardware: boolean | null
  /** The CSP or KSP that holds the key, when known. */
  provider: string | null
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

/** Turns a helper answer with ok: false into a WinStoreError (its message is replaced by the caller). */
function fail(result: Record<string, unknown>): never {
  const code = (typeof result.code === 'string' ? result.code : 'ERROR') as WinStoreCode
  throw new WinStoreError(code, typeof result.message === 'string' ? result.message : code, result)
}

const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')
const unb64 = (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s), 'base64'))
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function blobVars(blobs: Uint8Array[]): string[] {
  if (blobs.length === 0) throw new WinStoreError('BAD_INPUT', 'The document lists no recipients')
  return blobs.map(b64)
}

/** Which of the person's certificates could open these /Recipients, without touching any key (no PIN prompt). */
export async function probeRecipients(
  helper: PowerShellHelper,
  blobs: Uint8Array[],
  opts: Partial<RequestOptions> = {}
): Promise<ProbeResult> {
  const r = await helper.run(
    DECRYPT_BODY,
    { Blobs: blobVars(blobs), Mode: 'probe', Thumbprint: '' },
    { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal }
  )
  if (r.ok !== true) fail(r)
  return { candidates: r.candidates as Candidate[], recipients: r.recipients as RecipientId[] }
}

/**
 * Opens the first envelope one of the person's certificates can decrypt. May show the smart card PIN
 * prompt. `thumbprint` restricts the attempt to one certificate (after the person picked it).
 */
export async function decryptRecipients(
  helper: PowerShellHelper,
  blobs: Uint8Array[],
  opts: Partial<RequestOptions> & { thumbprint?: string } = {}
): Promise<DecryptResult> {
  const thumbprint = opts.thumbprint ?? ''
  if (!/^[0-9A-Fa-f]*$/.test(thumbprint)) throw new WinStoreError('BAD_INPUT', 'Bad thumbprint')
  const r = await helper.run(
    DECRYPT_BODY,
    { Blobs: blobVars(blobs), Mode: 'decrypt', Thumbprint: thumbprint },
    { timeoutMs: opts.timeoutMs ?? DECRYPT_TIMEOUT_MS, signal: opts.signal }
  )
  if (r.ok !== true) fail(r)
  return {
    blob: r.blob as number,
    index: r.index as number,
    store: str(r.store),
    thumbprint: str(r.thumbprint),
    subject: str(r.subject),
    issuer: str(r.issuer),
    name: str(r.name),
    contentEncryptionAlgorithm: str(r.contentEncryptionAlgorithm),
    keyEncryptionAlgorithm: str(r.keyEncryptionAlgorithm),
    hardware: typeof r.hardware === 'boolean' ? r.hardware : null,
    provider: typeof r.provider === 'string' ? r.provider : null,
    content: unb64(r.content)
  }
}

/** The person's certificates usable for encryption (with private key), plus "Other People" if asked. */
export async function listEncryptionCertificates(
  helper: PowerShellHelper,
  opts: Partial<RequestOptions> & { includeOthers?: boolean } = {}
): Promise<StoreCertificate[]> {
  const r = await helper.run(
    LIST_BODY,
    { IncludeOthers: opts.includeOthers ?? false },
    { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal }
  )
  if (r.ok !== true) fail(r)
  return (r.certificates as Array<Record<string, unknown>>).map(
    (c) => ({ ...c, der: unb64(c.der) }) as StoreCertificate
  )
}
