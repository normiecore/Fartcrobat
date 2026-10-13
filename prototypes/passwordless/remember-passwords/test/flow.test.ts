/**
 * The whole "remember password" flow in Node, as the app would run it, with real MuPDF files and
 * the real store on disk (fake cipher instead of safeStorage):
 *   engine open -> lock info -> lookup keys -> saved candidates -> authenticate -> prompt.
 * Covers what the e2e test will check in the app: open, remember, reopen silently, wrong saved
 * password falls back to the prompt, plus copies, re-protection and agent audit lines.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { pdfKeys } from '../src/keys.ts'
import { readLockInfo } from '../src/lockInfo.ts'
import { nodeFs } from '../src/nodeFs.ts'
import { SavedPasswordStore } from '../src/store.ts'
import { unlock, unlockAuditSummary, type AskState, type RememberOffer, type UnlockOutcome } from '../src/unlock.ts'
import { fakeCipher } from './fakes.ts'

const mupdf = await import('mupdf')
const FIX = '/home/user/Fartcrobat/tests/fixtures'
type PDFDocument = InstanceType<typeof mupdf.PDFDocument>

function save(doc: PDFDocument, opts: string): Uint8Array {
  const buf = doc.saveToBuffer(opts)
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}
const ENC = (user: string, owner: string) => `garbage=yes,compress,encrypt=aes-256,user-password=${user},owner-password=${owner},permissions=-3904`

/** A miniature of the app: the store in the main process, openPath in the renderer. */
class App {
  readonly prompts: AskState[] = []
  answers: ({ password: string; remember: boolean } | null)[] = []
  readonly audit: { tool: string; document: string; summary?: string }[] = []
  readonly store: SavedPasswordStore
  readonly cipher = fakeCipher()
  rememberOffer: RememberOffer = { offer: true, checked: true }

  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    this.store = new SavedPasswordStore({ file: join(dir, 'userData', 'saved-passwords.json'), cipher: this.cipher, fs: nodeFs })
  }

  /** actions.ts openPath + openBytes, with the unlock step; returns null when the person cancels. */
  async open(path: string, actor: 'person' | 'agent' = 'person'): Promise<{ doc: PDFDocument; outcome: UnlockOutcome | null } | null> {
    const doc = new mupdf.PDFDocument(new Uint8Array(readFileSync(path)))
    if (!doc.needsPassword()) return { doc, outcome: null }
    // Engine: OpenResult { ok: false, needsPassword: true, lock }
    const lock = readLockInfo(doc)
    // Main: keys from the lock and the path (IPC passwords:find/used/failed/remember take these inputs)
    const keys = pdfKeys({ lock, pathKey: path })
    const level = (auth: number) => (auth & 4 ? 'owner' : auth & 2 ? 'user' : null)
    const outcome = await unlock(
      {
        find: () => this.store.find(keys),
        attempt: async (pw) => level(doc.authenticatePassword(pw)),
        used: (ref, lvl) => this.store.used(ref, keys, { label: path.split('/').pop(), level: lvl }),
        failed: (ref) => this.store.failed(ref, keys),
        remember: async (pw, lvl) => {
          await this.store.remember({ kind: 'pdf', keys, label: path.split('/').pop()!, level: lvl, password: pw })
        },
        ask: async (state) => {
          this.prompts.push(state)
          return this.answers.shift() ?? null
        }
      },
      { trySaved: true, remember: this.rememberOffer, prompt: true }
    )
    if (actor === 'agent') this.audit.push({ tool: 'open_document', document: path, summary: unlockAuditSummary(outcome) })
    if (!outcome) return null
    return { doc, outcome }
  }
}

let dir: string
let original: string
let app: App
let n = 0

beforeEach(() => {
  dir = join(new URL('../out/', import.meta.url).pathname, `flow-${process.pid}-${++n}`)
  mkdirSync(dir, { recursive: true })
  const plain = new mupdf.PDFDocument(new Uint8Array(readFileSync(join(FIX, 'text.pdf'))))
  original = join(dir, 'contract.pdf')
  writeFileSync(original, save(plain, ENC('u1', 'o1')))
  app = new App(dir)
})

describe('remember password flow (MuPDF + store on disk + fake cipher)', () => {
  it('open, remember, reopen silently (also for an agent, which gets an audit line)', async () => {
    app.answers = [{ password: 'u1', remember: true }]
    const first = await app.open(original)
    expect(first?.outcome).toEqual({ method: 'typed', level: 'user', remembered: true })
    expect(app.prompts).toHaveLength(1)

    const storeFile = join(dir, 'userData', 'saved-passwords.json')
    const text = readFileSync(storeFile, 'utf8')
    expect(text).not.toContain('u1"')
    expect(text).not.toContain(dir) // no path in the store
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)

    const again = await app.open(original)
    expect(again?.outcome).toMatchObject({ method: 'saved', level: 'user' })
    expect(app.prompts).toHaveLength(1) // no new prompt

    const byAgent = await app.open(original, 'agent')
    expect(byAgent?.outcome?.method).toBe('saved')
    expect(app.audit).toEqual([{ tool: 'open_document', document: original, summary: 'unlocked with a password saved on this device' }])
    expect(JSON.stringify(app.audit)).not.toContain('u1')
  })

  it('a wrong saved password is forgotten and the prompt comes back; the new one is remembered', async () => {
    // Saved password is wrong for this file (e.g. remembered from an older version).
    const keys = pdfKeys({ lock: readLockInfo(new mupdf.PDFDocument(new Uint8Array(readFileSync(original)))), pathKey: original })
    await app.store.remember({ kind: 'pdf', keys, label: 'contract.pdf', password: 'stale' })
    app.answers = [{ password: 'u1', remember: true }]
    const r = await app.open(original)
    expect(r?.outcome).toEqual({ method: 'typed', level: 'user', remembered: true })
    expect(app.prompts).toEqual([{ wrong: false, savedStale: true, remember: { offer: true, checked: true } }])
    const list = await app.store.list()
    expect(list).toHaveLength(1) // the stale record is gone, the typed one replaced it
    expect((await app.open(original))?.outcome?.method).toBe('saved')
  })

  it('follows the file: copy, rename, Save (full), re-protect with the same password', async () => {
    app.answers = [{ password: 'u1', remember: true }]
    await app.open(original)
    // Copy + rename: same bytes -> lock key
    const copy = join(dir, 'renamed copy.pdf')
    copyFileSync(original, copy)
    expect((await app.open(copy))?.outcome?.method).toBe('saved')
    // Fartcrobat Save over the file (full rewrite keeps /Encrypt and /ID)
    const d = new mupdf.PDFDocument(new Uint8Array(readFileSync(original)))
    d.authenticatePassword('u1')
    writeFileSync(original, save(d, 'garbage=yes,compress'))
    expect((await app.open(original))?.outcome?.method).toBe('saved')
    // Protect again with the SAME password: new AES-256 salts (new lock), same /ID[0]
    const c = new mupdf.PDFDocument(save(d, 'garbage=yes'))
    c.authenticatePassword('u1')
    const reprotected = join(dir, 'reprotected.pdf')
    writeFileSync(reprotected, save(c, ENC('u1', 'o1')))
    expect((await app.open(reprotected))?.outcome?.method).toBe('saved') // found through /ID
    expect(app.prompts).toHaveLength(1)
  })

  it('protected again with a NEW password (same /ID, same path): asks, and an old copy still opens silently', async () => {
    app.answers = [{ password: 'u1', remember: true }]
    await app.open(original)
    const oldCopy = join(dir, 'old copy.pdf')
    copyFileSync(original, oldCopy)
    const d = new mupdf.PDFDocument(new Uint8Array(readFileSync(original)))
    d.authenticatePassword('u1')
    const c = new mupdf.PDFDocument(save(d, 'garbage=yes'))
    c.authenticatePassword('u1')
    writeFileSync(original, save(c, ENC('u2', 'o2')))
    app.answers = [{ password: 'u2', remember: true }]
    expect((await app.open(original))?.outcome).toEqual({ method: 'typed', level: 'user', remembered: true })
    expect(app.prompts[1]).toMatchObject({ savedStale: true })
    expect((await app.open(original))?.outcome?.method).toBe('saved')
    expect((await app.open(oldCopy))?.outcome?.method).toBe('saved') // exact lock key kept for the old record
    expect(app.prompts).toHaveLength(2)
  })

  it('typed owner password is remembered as owner (full access)', async () => {
    app.answers = [{ password: 'o1', remember: true }]
    expect((await app.open(original))?.outcome).toMatchObject({ level: 'owner' })
    expect((await app.open(original))?.outcome).toMatchObject({ method: 'saved', level: 'owner' })
    expect((await app.store.list())[0].level).toBe('owner')
  })

  it('unticked, or no keyring: nothing is stored and the next open asks again', async () => {
    app.answers = [{ password: 'u1', remember: false }]
    await app.open(original)
    app.answers = [{ password: 'u1', remember: true }]
    app.cipher.state.unavailable = 'no-keyring'
    app.rememberOffer = { offer: false, reason: 'Remembering passwords needs GNOME Keyring or KWallet.' }
    await app.open(original)
    app.answers = [null]
    expect(await app.open(original)).toBeNull()
    expect(app.prompts).toHaveLength(3)
    expect(await app.store.list()).toEqual([])
  })

  it('the repo fixture tests/fixtures/encrypted.pdf (RC4, password "secret")', async () => {
    const path = join(dir, 'encrypted.pdf')
    copyFileSync(join(FIX, 'encrypted.pdf'), path)
    app.answers = [{ password: 'secret', remember: true }]
    expect((await app.open(path))?.outcome?.method).toBe('typed')
    expect((await app.open(path))?.outcome?.method).toBe('saved')
  })
})
