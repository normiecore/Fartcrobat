/**
 * The whole "remember password" flow in Node, as the app runs it, with real MuPDF files and the
 * real store on disk (a fake cipher instead of safeStorage):
 *   engine open -> lock -> lookup keys -> saved candidates -> authenticate -> prompt.
 * Covers what the end-to-end test checks in the app, plus copies, protecting again and agent
 * audit lines.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { accessOf, readLockInfo } from '@engine/util/lockInfo'
import { nodeStoreFs } from '@main/passwords/fileStore'
import { targetKeys } from '@main/passwords/keys'
import { SavedPasswordStore } from '@main/passwords/store'
import { unlock, unlockAuditSummary, type AskState, type RememberOffer, type UnlockOutcome } from '@renderer/app/unlock'
import { FIXTURES } from './helpers'
import { fakeCipher } from './saved-passwords-fakes'

type PDFDocument = mupdf.PDFDocument

function save(doc: PDFDocument, opts: string): Uint8Array {
  const buf = doc.saveToBuffer(opts)
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}
const ENC = (user: string, owner: string) =>
  `garbage=yes,compress,encrypt=aes-256,user-password=${user},owner-password=${owner},permissions=-3904`

/** A miniature of the app: the store in the main process, openPath in the renderer. */
class App {
  readonly prompts: AskState[] = []
  answers: ({ password: string; remember: boolean } | null)[] = []
  readonly audit: { tool: string; document: string; summary?: string }[] = []
  readonly store: SavedPasswordStore
  readonly cipher = fakeCipher()
  rememberOffer: RememberOffer = { offer: true, checked: true }

  constructor(readonly dir: string) {
    this.store = new SavedPasswordStore({ file: join(dir, 'userData', 'saved-passwords.json'), cipher: this.cipher, fs: nodeStoreFs })
  }

  /** actions.ts openPath + openBytes with the unlock step; null when the person cancels. */
  async open(path: string, actor: 'person' | 'agent' = 'person'): Promise<{ doc: PDFDocument; outcome: UnlockOutcome | null } | null> {
    const doc = new mupdf.PDFDocument(new Uint8Array(readFileSync(path)))
    if (!doc.needsPassword()) return { doc, outcome: null }
    // Engine: OpenResult { ok: false, needsPassword: true, lock }
    const lock = readLockInfo(doc)
    // Main: the keys passwords:find/used/failed/remember derive from that target.
    const keys = targetKeys({ kind: 'pdf', lock, path }, process.platform)
    const label = basename(path)
    const outcome = await unlock(
      {
        find: () => this.store.find(keys),
        attempt: async (pw) => accessOf(doc.authenticatePassword(pw)),
        used: (ref, level) => this.store.used(ref, keys, { label, level }),
        failed: (ref) => this.store.failed(ref, keys),
        remember: async (pw, level) => {
          const ref = await this.store.remember({ kind: 'pdf', keys, label, level, password: pw })
          if (!ref) throw new Error('not remembered')
          return ref
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-saved-passwords-'))
  const plain = new mupdf.PDFDocument(new Uint8Array(readFileSync(join(FIXTURES, 'text.pdf'))))
  original = join(dir, 'contract.pdf')
  writeFileSync(original, save(plain, ENC('u1', 'o1')))
  app = new App(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('remember password flow (MuPDF, the store on disk, a fake cipher)', () => {
  it('open, remember, reopen silently (also for an agent, which gets an audit line)', async () => {
    app.answers = [{ password: 'u1', remember: true }]
    const first = await app.open(original)
    expect(first?.outcome).toEqual({ method: 'typed', level: 'user', remembered: true, ref: expect.any(String) })
    expect(app.prompts).toHaveLength(1)

    const storeFile = join(dir, 'userData', 'saved-passwords.json')
    const text = readFileSync(storeFile, 'utf8')
    expect(text).not.toContain('u1"')
    expect(text).not.toContain(dir) // no path in the store
    if (process.platform !== 'win32') expect(statSync(storeFile).mode & 0o777).toBe(0o600)

    const again = await app.open(original)
    expect(again?.outcome).toMatchObject({ method: 'saved-password', level: 'user' })
    expect(app.prompts).toHaveLength(1) // no new prompt

    const byAgent = await app.open(original, 'agent')
    expect(byAgent?.outcome?.method).toBe('saved-password')
    expect(app.audit).toEqual([{ tool: 'open_document', document: original, summary: 'unlocked with a password saved on this device' }])
    expect(JSON.stringify(app.audit)).not.toContain('u1')
  })

  it('a wrong saved password is forgotten and the prompt comes back; the new one is remembered', async () => {
    // The saved password is wrong for this file (remembered from an older version, say).
    const lock = readLockInfo(new mupdf.PDFDocument(new Uint8Array(readFileSync(original))))
    await app.store.remember({ kind: 'pdf', keys: targetKeys({ kind: 'pdf', lock, path: original }, process.platform), label: 'contract.pdf', password: 'stale' })
    app.answers = [{ password: 'u1', remember: true }]
    const r = await app.open(original)
    expect(r?.outcome).toMatchObject({ method: 'typed', level: 'user', remembered: true })
    expect(app.prompts).toEqual([{ wrong: false, savedStale: true, remember: { offer: true, checked: true } }])
    expect(await app.store.list()).toHaveLength(1) // the stale record is gone, the typed one replaced it
    expect((await app.open(original))?.outcome?.method).toBe('saved-password')
  })

  it('follows the file: copy, rename, Save (full), protect again with the same password', async () => {
    app.answers = [{ password: 'u1', remember: true }]
    await app.open(original)
    // Copy and rename: same bytes, so the lock key.
    const copy = join(dir, 'renamed copy.pdf')
    copyFileSync(original, copy)
    expect((await app.open(copy))?.outcome?.method).toBe('saved-password')
    // Save over the file (a full rewrite keeps /Encrypt and /ID).
    const d = new mupdf.PDFDocument(new Uint8Array(readFileSync(original)))
    d.authenticatePassword('u1')
    writeFileSync(original, save(d, 'garbage=yes,compress'))
    expect((await app.open(original))?.outcome?.method).toBe('saved-password')
    // Protect again with the SAME password: new AES-256 salts (a new lock), the same /ID[0].
    const c = new mupdf.PDFDocument(save(d, 'garbage=yes'))
    c.authenticatePassword('u1')
    const reprotected = join(dir, 'reprotected.pdf')
    writeFileSync(reprotected, save(c, ENC('u1', 'o1')))
    expect((await app.open(reprotected))?.outcome?.method).toBe('saved-password') // found through /ID
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
    expect((await app.open(original))?.outcome).toMatchObject({ method: 'typed', level: 'user', remembered: true })
    expect(app.prompts[1]).toMatchObject({ savedStale: true })
    expect((await app.open(original))?.outcome?.method).toBe('saved-password')
    expect((await app.open(oldCopy))?.outcome?.method).toBe('saved-password') // the old record keeps its exact lock
    expect(app.prompts).toHaveLength(2)
  })

  it("the Protect panel and its Forget use the document's lock only, never another file's password found by /ID", async () => {
    app.answers = [{ password: 'u1', remember: true }]
    await app.open(original)
    const copy = join(dir, 'copy.pdf')
    copyFileSync(original, copy)
    // Protect into b.pdf with a new password, Remember unticked: same /ID[0], new lock.
    const d = new mupdf.PDFDocument(new Uint8Array(readFileSync(original)))
    d.authenticatePassword('u1')
    const c = new mupdf.PDFDocument(save(d, 'garbage=yes'))
    c.authenticatePassword('u1')
    const b = join(dir, 'b.pdf')
    writeFileSync(b, save(c, ENC('u2', 'o2')))
    const lockB = readLockInfo(new mupdf.PDFDocument(new Uint8Array(readFileSync(b))))
    expect(lockB?.id).toBe(readLockInfo(new mupdf.PDFDocument(new Uint8Array(readFileSync(original))))?.id)
    // /ID or path would reach contract.pdf's record...
    expect(await app.store.savedFor(targetKeys({ kind: 'pdf', lock: lockB, path: b }, process.platform))).not.toBeNull()
    // ...but the panel's target (documentTarget in savedPasswords.ts) is the lock alone.
    const panel = targetKeys({ kind: 'pdf', lock: lockB && { ...lockB, id: null }, path: null }, process.platform)
    expect(panel).toHaveLength(1)
    expect(await app.store.savedFor(panel)).toBeNull()
    expect(await app.store.forgetKeys(panel)).toBe(0)
    expect((await app.open(original))?.outcome?.method).toBe('saved-password')
    expect((await app.open(copy))?.outcome?.method).toBe('saved-password')
    expect(app.prompts).toHaveLength(1)
  })

  it('a typed owner password is remembered as owner (full access)', async () => {
    app.answers = [{ password: 'o1', remember: true }]
    expect((await app.open(original))?.outcome).toMatchObject({ level: 'owner' })
    expect((await app.open(original))?.outcome).toMatchObject({ method: 'saved-password', level: 'owner' })
    expect((await app.store.list())[0].level).toBe('owner')
  })

  it('unticked, or no keyring: nothing is stored and the next open asks again', async () => {
    app.answers = [{ password: 'u1', remember: false }]
    await app.open(original)
    app.answers = [{ password: 'u1', remember: true }]
    app.cipher.state.unavailable = 'no-keyring'
    app.rememberOffer = { offer: false, reason: 'To remember passwords on this computer, Fartcrobat needs GNOME Keyring or KWallet.' }
    await app.open(original)
    app.answers = [null]
    expect(await app.open(original)).toBeNull()
    expect(app.prompts).toHaveLength(3)
    expect(await app.store.list()).toEqual([])
  })

  it('the repo fixture tests/fixtures/encrypted.pdf (RC4, password "secret")', async () => {
    const path = join(dir, 'encrypted.pdf')
    copyFileSync(join(FIXTURES, 'encrypted.pdf'), path)
    app.answers = [{ password: 'secret', remember: true }]
    expect((await app.open(path))?.outcome?.method).toBe('typed')
    expect((await app.open(path))?.outcome?.method).toBe('saved-password')
  })
})
