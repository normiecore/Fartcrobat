// Files made from protected documents (Extract, Split, Combine, Compare report) keep their protection.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { createLocalEngine, type LocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type pageOps from '@engine/ops/pages'
import type textOps from '@engine/ops/text'
import type compareOps from '@features/compare/engine'
import { inlineBackend, runComparison } from '@features/compare/pipeline'
import type { ReportInput } from '@features/compare/report'
import { DEFAULT_OPTIONS } from '@features/compare/types'
import type organizeOps from '@features/organize-pages/engine'
import { protectionDetails, protectionNote } from '@features/organize-pages/protection'
import { splitEvery } from '@features/organize-pages/split'
import { fixture, openFixture, type OpenedEngine } from './helpers'

const DP = 'derived-protection/'
const org = (e: LocalEngine) => e.ops<typeof organizeOps>('organize-pages')
const cmp = (e: OpenedEngine) => e.ops<typeof compareOps>('compare')
const text = (e: OpenedEngine) => e.ops<typeof textOps>('text')

/** What a file's security looks like from outside: handler, open password, flags, and which passwords work. */
function security(bytes: Uint8Array, passwords: string[]) {
  const doc = new mupdf.PDFDocument(bytes)
  try {
    const encrypt = doc.getTrailer().get('Encrypt')
    const auth = passwords.map((pw) => {
      const d = new mupdf.PDFDocument(bytes)
      try {
        return d.authenticatePassword(pw)
      } finally {
        d.destroy()
      }
    })
    return {
      encryption: doc.getMetaData('encryption'),
      needsPassword: doc.needsPassword(),
      P: encrypt.isNull() ? null : encrypt.resolve().get('P').asNumber(),
      auth
    }
  } finally {
    doc.destroy()
  }
}

/** Opens bytes the way a new tab does (openNewDocument with the source's password). */
async function openOutput(bytes: Uint8Array, password?: string, name = 'out.pdf'): Promise<OpenedEngine> {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const res = await doc.open(bytes, { fileName: name, password, dirty: true })
  if (!res.ok) throw new Error(`${name} needs a password`)
  return Object.assign(engine, { info: res.info, doc })
}

async function pageTexts(e: OpenedEngine): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < e.info.pageCount; i++) out.push((await text(e).plain(i)).trim().split('\n')[0])
  return out
}

interface Source {
  file: string
  /** Password the document is opened with (undefined: it opens without one). */
  open?: string
  user: string
  owner: string
}

const SOURCES: Source[] = [
  { file: 'encrypted.pdf', open: 'secret', user: 'secret', owner: 'owner' },
  { file: `${DP}aes256-open.pdf`, open: 'open-256', user: 'open-256', owner: 'perm-256' },
  // Opened with the permissions password: the copy still needs the open password, which is not known.
  { file: `${DP}aes256-open.pdf`, open: 'perm-256', user: 'open-256', owner: 'perm-256' },
  { file: `${DP}rc4-40.pdf`, open: 'rc4-open', user: 'rc4-open', owner: 'rc4-owner' },
  { file: 'edit-text/no-edit.pdf', user: '', owner: 'owner-secret' },
  { file: `${DP}aes256-restricted.pdf`, user: '', owner: 'perm-256' }
]

const passwords = (src: Source) => [src.user, src.owner, 'wrong']

describe('derived protection: Extract', () => {
  it.each(SOURCES)('extracts from $file (opened with "$open") with the same security', async (src) => {
    const e = await openFixture(src.file, src.open)
    const last = e.info.pageCount - 1
    const bytes = await org(e).extract([0, last])
    const before = security(fixture(src.file), passwords(src))
    expect(before.auth).toEqual([2, 4, 0])
    expect(security(bytes, passwords(src))).toEqual(before)
    const out = await openOutput(bytes, src.open)
    expect(out.info.pageCount).toBe(last === 0 ? 1 : 2)
    expect(out.info.encryption).toBe(e.info.encryption)
    // The copy grants exactly what the source granted in this session.
    expect(out.info.permissions).toEqual(e.info.permissions)
    expect((await pageTexts(out))[0]).toBe((await text(e).plain(0)).trim().split('\n')[0])
  })

  it('keeps restrictions behind a permissions password when the source opens without a password', async () => {
    const e = await openFixture('edit-text/no-edit.pdf')
    const bytes = await org(e).extract([1, 2])
    const out = await openOutput(bytes)
    expect(out.info.permissions).toMatchObject({ edit: false, assemble: false, copy: true })
    // The permissions password is not empty: an empty password is only the open password.
    const d = new mupdf.PDFDocument(bytes)
    expect(d.needsPassword()).toBe(false)
    expect(d.authenticatePassword('')).toBe(2)
    expect(d.authenticatePassword('owner-secret')).toBe(4)
  })

  it('reports the protection and the password that opens extracted files', async () => {
    const enc = await openFixture('encrypted.pdf', 'secret')
    expect(await org(enc).protection()).toEqual({
      method: '128-bit RC4',
      needsPassword: true,
      restricted: true
    })
    expect(await org(enc).openPassword()).toBe('secret')
    const owner = await openFixture(`${DP}aes256-open.pdf`, 'perm-256')
    expect(await org(owner).protection()).toEqual({
      method: '256-bit AES',
      needsPassword: true,
      restricted: true
    })
    // The password it was opened with opens the copy too.
    expect(await org(owner).openPassword()).toBe('perm-256')
    const noEdit = await openFixture('edit-text/no-edit.pdf')
    expect(await org(noEdit).protection()).toEqual({
      method: '128-bit AES',
      needsPassword: false,
      restricted: true
    })
    expect(await org(noEdit).openPassword()).toBeNull()
    const open = await openFixture(`${DP}contract-old-protected.pdf`, 'old-open')
    expect(await org(open).protection()).toEqual({
      method: '128-bit AES',
      needsPassword: true,
      restricted: false
    })
    const plain = await openFixture('text.pdf')
    expect(await org(plain).protection()).toBeNull()
    expect(await org(plain).openPassword()).toBeNull()
  })

  it('opens as a protected tab that saves and reloads without asking for the password', async () => {
    const e = await openFixture(`${DP}aes256-open.pdf`, 'open-256')
    const bytes = await org(e).extract([2])
    const tab = await openOutput(
      bytes,
      (await org(e).openPassword()) ?? undefined,
      'Pages from aes256-open.pdf'
    )
    expect(tab.info.encryption).toContain('256-bit AES')
    expect(await tab.doc.isDirty()).toBe(true)
    const saved = await tab.doc.save({})
    const pws = ['open-256', 'perm-256', 'wrong']
    expect(security(saved, pws)).toEqual(security(fixture(`${DP}aes256-open.pdf`), pws))
    // The tab keeps the password: reopening its own saved bytes does not need it again.
    const reloaded = await tab.doc.reload(saved)
    expect(reloaded.ok).toBe(true)
  })

  it('includes unsaved changes of the source', async () => {
    const e = await openFixture('encrypted.pdf', 'secret')
    await e.ops<typeof pageOps>('pages').rotate([0], 90)
    const out = await openOutput(await org(e).extract([0]), 'secret')
    expect(out.info.pages[0].rotation).toBe(90)
  })

  it('copies pages into another document without protection when asked', async () => {
    const e = await openFixture('encrypted.pdf', 'secret')
    const bytes = await org(e).extract([0], { keepProtection: false })
    expect(security(bytes, []).encryption).toBe('None')
  })

  it('keeps the protection in the thumbnails Extract Pages command too', async () => {
    const e = await openFixture(`${DP}rc4-40.pdf`, 'rc4-open')
    const bytes = await e.ops<typeof pageOps>('pages').extract([1])
    const pws = ['rc4-open', 'rc4-owner', 'wrong']
    expect(security(bytes, pws)).toEqual(security(fixture(`${DP}rc4-40.pdf`), pws))
  })

  it('leaves extracts of unprotected documents as they were', async () => {
    const e = await openFixture('text.pdf')
    const bytes = await org(e).extract([0, 1])
    expect(security(bytes, []).encryption).toBe('None')
    const corePages = await e.ops<typeof pageOps>('pages').extract([0])
    expect(security(corePages, []).encryption).toBe('None')
  })
})

describe('derived protection: Split', () => {
  it('gives every part the protection of the document', async () => {
    const e = await openFixture(`${DP}aes256-open.pdf`, 'open-256')
    const pws = ['open-256', 'perm-256', 'wrong']
    const source = security(fixture(`${DP}aes256-open.pdf`), pws)
    const parts = splitEvery(e.info.pageCount, 2)
    expect(parts).toHaveLength(2)
    const texts: string[] = []
    for (const p of parts) {
      const bytes = await org(e).extract(Array.from({ length: p.end - p.start + 1 }, (_, k) => p.start + k))
      expect(security(bytes, pws)).toEqual(source)
      texts.push(...(await pageTexts(await openOutput(bytes, 'open-256'))))
    }
    expect(texts).toEqual(['Section 1', 'Section 2', 'Section 3', 'Section 4'])
  })

  it('plans a split by size with the size of the protected parts', async () => {
    const e = await openFixture(`${DP}aes256-open.pdf`, 'open-256')
    const whole = (await org(e).extract([0, 1, 2, 3])).length
    const max = Math.round(whole * 0.7)
    const parts = await org(e).splitPlanBySize(max)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      if (p.end === p.start) continue
      const bytes = await org(e).extract(Array.from({ length: p.end - p.start + 1 }, (_, k) => p.start + k))
      expect(bytes.length).toBeLessThanOrEqual(max)
    }
  })
})

describe('derived protection: Combine', () => {
  it('gives the result the protection of the first protected file', async () => {
    const e = await createLocalEngine()
    const o = org(e)
    await o.openScratch('t', fixture('text.pdf'), 'text.pdf')
    await o.openScratch('e', fixture('encrypted.pdf'), 'encrypted.pdf', 'secret')
    await o.openScratch('a', fixture(`${DP}aes256-open.pdf`), 'aes256-open.pdf', 'open-256')
    const sources = [
      { key: 't', fileName: 'text.pdf', pages: [0] },
      { key: 'e', fileName: 'encrypted.pdf' },
      { key: 'a', fileName: 'aes256-open.pdf', pages: [3] }
    ]
    const { bytes, protection } = await o.combineWithProtection(sources)
    expect(protection).toEqual({
      index: 1,
      fileName: 'encrypted.pdf',
      summary: { method: '128-bit RC4', needsPassword: true, restricted: true }
    })
    const pws = ['secret', 'owner', 'open-256', 'perm-256']
    expect(security(bytes, pws)).toEqual(security(fixture('encrypted.pdf'), pws))
    const out = await openOutput(bytes, 'secret')
    expect(out.info.pageCount).toBe(3)
    expect((await pageTexts(out))[2]).toBe('Section 4')
    // combine (bytes only) applies the same rule.
    expect(security(await o.combine(sources), pws)).toEqual(security(bytes, pws))
  })

  it('works with files given as bytes and with protection that needs no open password', async () => {
    const e = await createLocalEngine()
    const { bytes, protection } = await org(e).combineWithProtection([
      { data: fixture(`${DP}aes256-restricted.pdf`), fileName: 'aes256-restricted.pdf' },
      { data: fixture('encrypted.pdf'), fileName: 'encrypted.pdf', password: 'secret' }
    ])
    expect(protection?.index).toBe(0)
    expect(protection?.summary).toEqual({ method: '256-bit AES', needsPassword: false, restricted: true })
    const pws = ['', 'perm-256', 'secret']
    expect(security(bytes, pws)).toEqual(security(fixture(`${DP}aes256-restricted.pdf`), pws))
    const out = await openOutput(bytes)
    expect(out.info.pageCount).toBe(4)
    expect(out.info.permissions).toMatchObject({ print: false, copy: false, edit: false })
  })

  it('takes the protection of a file only when its pages are used', async () => {
    const e = await createLocalEngine()
    const { bytes, protection } = await org(e).combineWithProtection([
      { data: fixture('encrypted.pdf'), fileName: 'encrypted.pdf', password: 'secret', pages: [] },
      { data: fixture('text.pdf'), fileName: 'text.pdf' },
      { data: fixture(`${DP}rc4-40.pdf`), fileName: 'rc4-40.pdf', password: 'rc4-open' }
    ])
    expect(protection?.fileName).toBe('rc4-40.pdf')
    expect(security(bytes, ['rc4-open']).encryption).toBe('Standard V1 R2 40-bit RC4')
  })

  it('leaves combinations of unprotected files unprotected', async () => {
    const e = await createLocalEngine()
    const { bytes, protection } = await org(e).combineWithProtection([
      { data: fixture('text.pdf'), fileName: 'text.pdf' },
      { data: fixture('compare-a.pdf'), fileName: 'compare-a.pdf' }
    ])
    expect(protection).toBeNull()
    expect(security(bytes, []).encryption).toBe('None')
  })

  it('describes the protection in plain words', () => {
    expect(protectionDetails({ method: '128-bit RC4', needsPassword: true, restricted: true })).toBe(
      '128-bit RC4 encryption, the same open password and the same restrictions'
    )
    expect(protectionNote({ method: '256-bit AES', needsPassword: false, restricted: true }, 'a.pdf')).toBe(
      'It keeps the protection of “a.pdf”: 256-bit AES encryption and the same restrictions.'
    )
    expect(
      protectionNote({ method: '256-bit AES', needsPassword: false, restricted: false }, 'a.pdf', 'They keep')
    ).toBe('They keep the protection of “a.pdf”: 256-bit AES encryption.')
  })
})

describe('derived protection: Compare report', () => {
  async function report(
    oldFile: string,
    oldPassword: string | undefined,
    newFile: string,
    newPassword?: string
  ) {
    const ea = await openFixture(oldFile, oldPassword)
    const eb = await openFixture(newFile, newPassword)
    const all = (e: OpenedEngine) => [...Array(e.info.pageCount).keys()]
    const result = await runComparison(
      { ops: cmp(ea), pages: all(ea) },
      { ops: cmp(eb), pages: all(eb) },
      { ...DEFAULT_OPTIONS },
      inlineBackend
    )
    const removedPages = result.changes.filter((c) => c.type === 'pageRemoved').map((c) => c.old!.page)
    const input: ReportInput = {
      oldName: 'old.pdf',
      newName: 'new.pdf',
      oldPageCount: ea.info.pageCount,
      newPageCount: eb.info.pageCount,
      oldPages: result.oldPages,
      newPages: result.newPages,
      options: result.options,
      date: '13 Oct 2026',
      changes: result.changes,
      counts: result.counts,
      pageByPage: false,
      removedPdf: removedPages.length ? await cmp(ea).copyPages(removedPages) : null,
      removedPages
    }
    return { ea, eb, bytes: await cmp(eb).report(input) }
  }

  it('gets the protection of the old document when it is the protected one', async () => {
    const file = `${DP}contract-old-protected.pdf`
    const { ea, bytes } = await report(file, 'old-open', 'compare/contract-new.pdf')
    expect(await cmp(ea).protection()).toEqual({
      method: '128-bit AES',
      needsPassword: true,
      restricted: false
    })
    // The report is built in the new document's engine; the old one protects it.
    expect(security(bytes, []).encryption).toBe('None')
    const protectedBytes = await cmp(ea).protectReport(bytes)
    const pws = ['old-open', 'old-owner', 'wrong']
    expect(security(protectedBytes, pws)).toEqual(security(fixture(file), pws))
    const out = await openOutput(protectedBytes, (await cmp(ea).openPassword()) ?? undefined)
    expect(out.info.pageCount).toBe(new mupdf.PDFDocument(bytes).countPages())
    expect(await text(out).plain(0)).toContain('Compare report')
  })

  it('gets the protection of the new document when only it is protected', async () => {
    const file = `${DP}contract-old-protected.pdf`
    const { eb, bytes } = await report('compare/contract-old.pdf', undefined, file, 'old-owner')
    const protectedBytes = await cmp(eb).protectReport(bytes)
    const pws = ['old-open', 'old-owner', 'wrong']
    expect(security(protectedBytes, pws)).toEqual(security(fixture(file), pws))
    expect(await cmp(eb).openPassword()).toBe('old-owner')
  })

  it('leaves reports of unprotected documents unprotected', async () => {
    const { eb, bytes } = await report('compare/contract-old.pdf', undefined, 'compare/contract-new.pdf')
    expect(await cmp(eb).protection()).toBeNull()
    expect(security(await cmp(eb).protectReport(bytes), []).encryption).toBe('None')
  })
})

// ---- independent check with pypdf ------------------------------------------------------------

function python(code: string, args: string[] = []): { status: number | null; out: string } {
  try {
    const r = spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' })
    return { status: r.error ? null : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } catch {
    return { status: null, out: '' }
  }
}

const hasPypdf = python('import pypdf').status === 0
// pypdf needs the cryptography (or pycryptodome) package for AES.
const hasPypdfAes =
  hasPypdf && python('try:\n import cryptography\nexcept ImportError:\n import Crypto').status === 0

const PYPDF_CHECK = `
import json, sys, pypdf
from pypdf import PasswordType
for case in json.loads(sys.argv[1]):
    path = case['path']
    reader = pypdf.PdfReader(path)
    assert reader.is_encrypted, path
    enc = reader.trailer['/Encrypt'].get_object()
    got = [int(enc['/V']), int(enc['/R']), int(enc['/P'])]
    assert got == case['vrp'], (path, got, case['vrp'])
    assert pypdf.PdfReader(path).decrypt('wrong') == PasswordType.NOT_DECRYPTED, path
    assert pypdf.PdfReader(path).decrypt(case['owner']) == PasswordType.OWNER_PASSWORD, path
    user = pypdf.PdfReader(path)
    assert user.decrypt(case['user']) == PasswordType.USER_PASSWORD, path
    assert len(user.pages) == case['pages'], (path, len(user.pages))
    assert case['text'] in user.pages[0].extract_text(), (path, user.pages[0].extract_text())
print('ok')
`

interface PypdfCase {
  path: string
  vrp: [number, number, number]
  user: string
  owner: string
  pages: number
  text: string
}

function vrp(bytes: Uint8Array): [number, number, number] {
  const doc = new mupdf.PDFDocument(bytes)
  const enc = doc.getTrailer().get('Encrypt').resolve()
  return [enc.get('V').asNumber(), enc.get('R').asNumber(), enc.get('P').asNumber()]
}

function runPypdf(cases: (Omit<PypdfCase, 'path' | 'vrp'> & { bytes: Uint8Array; source: Uint8Array })[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-derived-'))
  try {
    const json: PypdfCase[] = cases.map((c, i) => {
      const path = join(dir, `out-${i}.pdf`)
      writeFileSync(path, c.bytes)
      // The flags pypdf reads from the copy must be those of the source.
      return { path, vrp: vrp(c.source), user: c.user, owner: c.owner, pages: c.pages, text: c.text }
    })
    const r = python(PYPDF_CHECK, [JSON.stringify(json)])
    expect(r.out.trim()).toBe('ok')
    expect(r.status).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('derived protection: pypdf reads the outputs', () => {
  it.skipIf(!hasPypdf)('RC4 outputs: same handler, flags and passwords', async () => {
    const enc = await openFixture('encrypted.pdf', 'secret')
    const rc4 = await openFixture(`${DP}rc4-40.pdf`, 'rc4-open')
    const e = await createLocalEngine()
    const combined = await org(e).combine([
      { data: fixture('text.pdf'), fileName: 'text.pdf', pages: [1] },
      { data: fixture(`${DP}rc4-40.pdf`), fileName: 'rc4-40.pdf', password: 'rc4-open' }
    ])
    runPypdf([
      {
        bytes: await org(enc).extract([0]),
        source: fixture('encrypted.pdf'),
        user: 'secret',
        owner: 'owner',
        pages: 1,
        text: 'protected'
      },
      {
        bytes: await org(rc4).extract([1]),
        source: fixture(`${DP}rc4-40.pdf`),
        user: 'rc4-open',
        owner: 'rc4-owner',
        pages: 1,
        text: 'Old cipher page 2'
      },
      {
        bytes: combined,
        source: fixture(`${DP}rc4-40.pdf`),
        user: 'rc4-open',
        owner: 'rc4-owner',
        pages: 3,
        text: 'Chapter 2'
      }
    ])
  })

  it.skipIf(!hasPypdfAes)('AES outputs: same handler, flags and passwords', async () => {
    const owner = await openFixture(`${DP}aes256-open.pdf`, 'perm-256')
    const restricted = await openFixture(`${DP}aes256-restricted.pdf`)
    const noEdit = await openFixture('edit-text/no-edit.pdf')
    const old = await openFixture(`${DP}contract-old-protected.pdf`, 'old-open')
    // Stands in for a compare report: plain bytes made elsewhere, protected by the old document.
    const plainPages = await cmp(old).copyPages([0, 1])
    runPypdf([
      {
        bytes: await org(owner).extract([1, 2]),
        source: fixture(`${DP}aes256-open.pdf`),
        user: 'open-256',
        owner: 'perm-256',
        pages: 2,
        text: 'Section 2'
      },
      {
        bytes: await org(restricted).extract([2]),
        source: fixture(`${DP}aes256-restricted.pdf`),
        user: '',
        owner: 'perm-256',
        pages: 1,
        text: 'Restricted page 3'
      },
      {
        bytes: await org(noEdit).extract([0, 4]),
        source: fixture('edit-text/no-edit.pdf'),
        user: '',
        owner: 'owner-secret',
        pages: 2,
        text: 'Chapter 1'
      },
      {
        bytes: await cmp(old).protectReport(plainPages),
        source: fixture(`${DP}contract-old-protected.pdf`),
        user: 'old-open',
        owner: 'old-owner',
        pages: 2,
        text: 'Beta'
      }
    ])
  })
})
