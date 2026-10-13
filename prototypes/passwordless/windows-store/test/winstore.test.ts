// node --test test/winstore.test.ts
// env: OUT=<fixtures dir from make_fixtures.py, imported with import_store.ps1>
//      PWSH=<pwsh path> (required off Windows; on Windows the default is the stock powershell.exe 5.1)
//      FC_NODE_MODULES=<app node_modules with mupdf and node-forge>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  WinStoreError,
  decryptRecipients,
  defaultPowerShellPath,
  listEncryptionCertificates,
  probeRecipients,
  runHelper,
} from '../src/winCertStore.ts'
import { DECRYPT_BODY, DIRECTORY_BODY, LIST_BODY, PRELUDE, buildScript } from '../src/winStoreScripts.ts'
import { fileKeyV5, openWithFileKey } from './bridgeOpen.ts'
import { forge, mupdf } from './deps.ts'
import { forgeDecrypt, forgeEnvelope, forgeEnvelopeRawIssuer } from './forgeCms.ts'
import { readPubSec } from './pdfRecipients.ts'

const PWSH = process.env.PWSH ?? ''
const OUT = process.env.OUT ?? ''
const pki = (f: string): string => path.join(OUT, 'pki', f)
const pdfPath = (f: string): string => path.join(OUT, 'pdf', f)
const opts = PWSH ? { powershellPath: PWSH } : {}
const IS_WIN = process.platform === 'win32'
const HAVE_PS = Boolean(PWSH) || IS_WIN
const thumb = (der: Uint8Array): string => createHash('sha1').update(der).digest('hex').toUpperCase()
const thumbOf = (name: string): string => thumb(readFileSync(pki(`${name}.cer`)))
const SEED = new Uint8Array([...Array(20).keys()].map((i) => i * 7 + 1).concat([0xfc, 0xff, 0xff, 0xff]))

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'resolved'
  } catch (e) {
    if (e instanceof WinStoreError) return e.code
    throw e
  }
}

function netEnvelope(cert: string, idType: 'ski' | 'issuer', padding: 'pkcs1' | 'oaep256', content: Uint8Array): Uint8Array {
  const out = execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'net_envelope.ps1'),
    pki(cert), idType, padding, Buffer.from(content).toString('hex')], { env: { ...process.env, TERM: 'dumb' } })
  return new Uint8Array(Buffer.from(out.toString().trim(), 'base64'))
}

describe('script text', () => {
  it('is ASCII, has no backtick or dollar-brace, so it embeds in template literals and survives any code page', () => {
    for (const s of [PRELUDE, DECRYPT_BODY, LIST_BODY, DIRECTORY_BODY]) {
      assert.doesNotMatch(s, /[^\x09\x0a\x0d\x20-\x7e]/)
      assert.ok(!s.includes('`'))
      assert.ok(!s.includes('${'))
    }
  })
  it('only takes literal values from a safe alphabet', () => {
    assert.throws(() => buildScript(LIST_BODY, { X: "a'; Remove-Item x; '" }))
    assert.throws(() => buildScript(LIST_BODY, { X: ['ok', '$(evil)'] }))
    assert.throws(() => buildScript(LIST_BODY, { 'X; evil': 'a' }))
    assert.match(buildScript(DECRYPT_BODY, { Blobs: ['QUJD', 'REVG'], Mode: 'probe' }), /\$Blobs = @\(\n'QUJD'\n'REVG'\n\)/)
  })
  it('avoids PowerShell 6+/7 syntax and .NET Core-only APIs (stand-in for PSScriptAnalyzer, which was unreachable)', () => {
    const banned = [/\?\?/, /\?\./, /&&/, /\|\|/, /-Parallel\b/, /-AsArray\b/, /-AsHashtable\b/, /-Stable\b/,
      /-EscapeHandling\b/, /\bGet-Error\b/, /\$PSStyle\b/, /HashData\b/, /ToHexString\b/, /ExportSubjectPublicKeyInfo/,
      /RSAEncryptionPadding/, /Cert:\\/, /::new\(/, /\bclean\s*\{/, /ConvertTo-Json|ConvertFrom-Json/]
    for (const s of [PRELUDE, DECRYPT_BODY, LIST_BODY, DIRECTORY_BODY]) for (const re of banned) assert.doesNotMatch(s, re)
  })
  it('stays small enough to embed (bytes before data)', () => {
    const size = buildScript(DECRYPT_BODY, { Blobs: [], Mode: 'probe', Thumbprint: '' }).length
    assert.ok(size < 12_000, String(size))
  })
})

describe('outside Windows', () => {
  it('refuses without an explicit PowerShell path', { skip: process.platform === 'win32' }, async () => {
    assert.equal(await code(listEncryptionCertificates()), 'NOT_WINDOWS')
  })
  it('reports a missing PowerShell', async () => {
    assert.equal(await code(listEncryptionCertificates({ powershellPath: '/nonexistent/powershell.exe' })), 'POWERSHELL_UNAVAILABLE')
  })
})

describe('with PowerShell and a test certificate store', { skip: !HAVE_PS || !OUT }, () => {
  it('lists encryption certificates that have private keys, and Other People on request', async () => {
    const mine = await listEncryptionCertificates(opts)
    const byThumb = new Map(mine.map((c) => [c.thumbprint, c]))
    for (const name of ['recipient', 'me-enc', 'me-noku', 'me-ec', 'me-expired']) assert.ok(byThumb.has(thumbOf(name)), name)
    for (const name of ['me-sign', 'me-nokey', 'colleague']) assert.ok(!byThumb.has(thumbOf(name)), name)
    assert.equal(byThumb.get(thumbOf('me-noku'))!.encryptionUsage, 'unrestricted')
    assert.equal(byThumb.get(thumbOf('me-noku'))!.subject, 'O=Fartcrobat Store Test, CN=Store Test Me (no key usage) éè \u{1F511}')
    assert.equal(byThumb.get(thumbOf('me-ec'))!.encryptionUsage, 'keyAgreement')
    const enc = byThumb.get(thumbOf('me-enc'))!
    assert.equal(enc.encryptionUsage, 'keyEncipherment')
    assert.equal(enc.keyUsage, 0x30)
    assert.deepEqual(enc.ekus, ['1.3.6.1.5.5.7.3.4'])
    assert.equal(enc.email, 'me@example.test')
    assert.equal(thumb(enc.der), enc.thumbprint)
    assert.deepEqual(Buffer.from(enc.der), readFileSync(pki('me-enc.cer')))
    assert.ok(Date.parse(byThumb.get(thumbOf('me-expired'))!.notAfter) < Date.now())

    const all = await listEncryptionCertificates({ ...opts, includeOthers: true })
    const colleague = all.find((c) => c.thumbprint === thumbOf('colleague'))!
    assert.equal(colleague.store, 'CurrentUser\\AddressBook')
    assert.equal(colleague.hasPrivateKey, false)
  })

  const text = (() => {
    if (!OUT) return ''
    const doc = mupdf.Document.openDocument(readFileSync(pdfPath('source-text.pdf')), 'application/pdf')
    return doc.loadPage(0).toStructuredText().asText()
  })()

  for (const [file, expect] of [
    ['pubsec-me-enc.pdf', { blob: 0, cert: 'me-enc', kea: '1.2.840.113549.1.1.1' }],
    ['pubsec-multi.pdf', { blob: 0, cert: 'recipient', kea: '1.2.840.113549.1.1.1' }],
    ['pubsec-two-envelopes.pdf', { blob: 1, cert: 'recipient', kea: '1.2.840.113549.1.1.1' }],
    ['pubsec-oaep.pdf', { blob: 0, cert: 'recipient', kea: '1.2.840.113549.1.1.7' }],
    ['pubsec-expired.pdf', { blob: 0, cert: 'me-expired', kea: '1.2.840.113549.1.1.1' }],
  ] as const) {
    it(`opens ${file} end to end (store key -> seed -> file key -> MuPDF)`, async () => {
      const bytes = readFileSync(pdfPath(file))
      const info = readPubSec(bytes)
      const probe = await probeRecipients(info.recipients, opts)
      assert.equal(probe.candidates[0].blob, expect.blob)
      const r = await decryptRecipients(info.recipients, opts)
      assert.equal(r.blob, expect.blob)
      assert.equal(r.thumbprint, thumbOf(expect.cert))
      assert.equal(r.keyEncryptionAlgorithm, expect.kea)
      assert.equal(r.contentEncryptionAlgorithm, '2.16.840.1.101.3.4.1.42')
      assert.equal(r.content.length, 24)
      if (expect.kea === '1.2.840.113549.1.1.1') {
        const keyPem = readFileSync(pki(`${expect.cert}.key`), 'utf8')
        assert.deepEqual(r.content, forgeDecrypt(info.recipients[r.blob], keyPem))
      }
      const opened = openWithFileKey(bytes, info, fileKeyV5(r.content.subarray(0, 20), info))
      assert.equal(opened.text, text)
    })
  }

  it('says who a file is for when none of the certificates match', async () => {
    const info = readPubSec(readFileSync(pdfPath('pubsec-colleague-only.pdf')))
    try {
      await decryptRecipients(info.recipients, opts)
      assert.fail('resolved')
    } catch (e) {
      assert.ok(e instanceof WinStoreError)
      assert.equal(e.code, 'NO_MATCHING_CERT')
      const detail = e.detail as { recipients: Array<{ issuer: string; serial: string }> }
      assert.equal(detail.recipients[0].issuer, 'O=Fartcrobat Store Test, CN=Store Test Colleague')
    }
    assert.equal(await code(probeRecipients(info.recipients, opts)), 'NO_MATCHING_CERT')
  })

  it('ECDH (KeyAgreeRecipientInfo): matched, then UNSUPPORTED on .NET for Linux; Windows outcome recorded', async (t) => {
    const info = readPubSec(readFileSync(pdfPath('pubsec-ec.pdf')))
    assert.equal((await probeRecipients(info.recipients, opts)).candidates[0].thumbprint, thumbOf('me-ec'))
    const outcome = await code(decryptRecipients(info.recipients, opts))
    t.diagnostic(`ECDH decrypt outcome on ${process.platform}: ${outcome}`)
    if (IS_WIN) assert.ok(['resolved', 'UNSUPPORTED', 'KEY_UNAVAILABLE'].includes(outcome), outcome)
    else assert.equal(outcome, 'UNSUPPORTED')
  })

  it('finds the person among several RecipientInfos in a node-forge envelope', async () => {
    const blob = forgeEnvelope([readFileSync(pki('colleague.pem'), 'utf8'), readFileSync(pki('me-enc.pem'), 'utf8')], SEED)
    const r = await decryptRecipients([blob], opts)
    assert.equal(r.index, 1)
    assert.equal(r.thumbprint, thumbOf('me-enc'))
    assert.deepEqual(r.content, SEED)
  })

  it('node-forge mangles non-ASCII issuer names; copying the raw issuer DER fixes it', async () => {
    const pems = [readFileSync(pki('colleague.pem'), 'utf8'), readFileSync(pki('me-noku.pem'), 'utf8')]
    const broken = forgeEnvelope(pems, SEED)
    const p = await probeRecipients([broken], opts)
    assert.equal(p.candidates[0].issuerMatch, false)
    assert.notEqual(p.recipients[1].issuer, 'O=Fartcrobat Store Test, CN=Store Test Me (no key usage) éè \u{1F511}')
    assert.equal(await code(decryptRecipients([broken], opts)), 'NO_MATCHING_CERT')
    const fixed = forgeEnvelopeRawIssuer(pems, SEED)
    const r = await decryptRecipients([fixed], opts)
    assert.equal(r.index, 1)
    assert.equal(r.thumbprint, thumbOf('me-noku'))
    assert.deepEqual(r.content, SEED)
    assert.deepEqual(forgeDecrypt(fixed, readFileSync(pki('me-noku.key'), 'utf8')), SEED)
  })

  it('decrypts .NET envelopes with a SubjectKeyIdentifier recipient and with RSA-OAEP SHA-256', { skip: !PWSH && 'needs pwsh to create OAEP envelopes' }, async () => {
    const ski = netEnvelope('me-enc.cer', 'ski', 'pkcs1', SEED)
    const p = await probeRecipients([ski], opts)
    assert.ok(p.recipients[0].ski)
    assert.equal(p.recipients[0].idType, 'SubjectKeyIdentifier')
    assert.deepEqual((await decryptRecipients([ski], opts)).content, SEED)
    // node-forge 1.4 cannot even parse a SubjectKeyIdentifier RecipientInfo
    assert.throws(() => forgeDecrypt(ski, readFileSync(pki('me-enc.key'), 'utf8')), /not an PKCS#7 RecipientInfo/)
    const oaep = netEnvelope('me-enc.cer', 'issuer', 'oaep256', SEED)
    const r = await decryptRecipients([oaep], opts)
    assert.equal(r.keyEncryptionAlgorithm, '1.2.840.113549.1.1.7')
    assert.deepEqual(r.content, SEED)
  })

  it('skips a malformed blob and still opens the next one', async () => {
    const good = forgeEnvelope([readFileSync(pki('me-enc.pem'), 'utf8')], SEED)
    const garbage = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])
    const p = await probeRecipients([garbage, good], opts)
    assert.equal(p.recipients[0].error, 'BAD_BLOB')
    const r = await decryptRecipients([garbage, good], opts)
    assert.equal(r.blob, 1)
    assert.deepEqual(r.content, SEED)
  })

  it('restricts decryption to a chosen certificate', async () => {
    const info = readPubSec(readFileSync(pdfPath('pubsec-multi.pdf')))
    assert.equal(await code(decryptRecipients(info.recipients, { ...opts, thumbprint: thumbOf('me-enc') })), 'NO_MATCHING_CERT')
    assert.equal((await decryptRecipients(info.recipients, { ...opts, thumbprint: thumbOf('recipient').toLowerCase() })).thumbprint, thumbOf('recipient'))
    assert.equal(await code(decryptRecipients(info.recipients, { ...opts, thumbprint: "x' + 1" })), 'BAD_INPUT')
  })

  it('handles a long recipient list (data travels on stdin, not the command line)', async () => {
    const colleague = readFileSync(pki('colleague.pem'), 'utf8')
    const blobs = Array.from({ length: 150 }, () => forgeEnvelope([colleague], SEED))
    blobs.push(forgeEnvelope([readFileSync(pki('me-enc.pem'), 'utf8')], SEED))
    const total = blobs.reduce((n, b) => n + b.length, 0)
    assert.ok(total > 50_000)
    const r = await decryptRecipients(blobs, opts)
    assert.equal(r.blob, 150)
  })

  it('runs calls one at a time', async () => {
    const blob = forgeEnvelope([readFileSync(pki('me-enc.pem'), 'utf8')], SEED)
    const results = await Promise.all([1, 2, 3].map(() => decryptRecipients([blob], opts)))
    for (const r of results) assert.deepEqual(r.content, SEED)
  })

  it('detects Constrained Language Mode before doing anything', async () => {
    const script = buildScript(LIST_BODY, { IncludeOthers: false }).replace(
      '& {\n',
      "& {\n$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n",
    )
    const r = await runHelper(script, opts)
    assert.deepEqual(r, { ok: false, code: 'CONSTRAINED_LANGUAGE', languageMode: 'ConstrainedLanguage' })
  })

  it('times out and can be cancelled', async () => {
    assert.equal(await code(runHelper('& {\nStart-Sleep -Seconds 20\n}\n\n', { ...opts, timeoutMs: 1500 })), 'TIMEOUT')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1000)
    assert.equal(await code(runHelper('& {\nStart-Sleep -Seconds 20\n}\n\n', { ...opts, signal: ac.signal })), 'ABORTED')
  })

  it('turns an unexpected failure inside a body into a structured answer', async () => {
    const r = await runHelper(buildScript("throw 'unexpected'", {}), opts)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ERROR')
    assert.equal(r.message, 'unexpected')
  })

  it('reports a script that prints no answer', async () => {
    assert.equal(await code(runHelper('& {\n[Console]::Error.WriteLine("boom")\n}\n\n', opts)), 'HELPER_FAILED')
  })
})

const derToPem = (der: Uint8Array): string =>
  forge.pki.certificateToPem(forge.pki.certificateFromAsn1(forge.asn1.fromDer(Buffer.from(der).toString('binary'))))

describe('real Windows key storage (Windows only)', { skip: !IS_WIN && 'needs Windows' }, () => {
  const ps = (command: string): string =>
    execFileSync(defaultPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', command]).toString().trim()
  for (const [label, extra] of [
    ['non-exportable CNG key (Microsoft Software Key Storage Provider)', "-Provider 'Microsoft Software Key Storage Provider'"],
    ['non-exportable CAPI key (Microsoft Enhanced RSA and AES Cryptographic Provider)', "-Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -KeySpec KeyExchange"],
  ] as const) {
    it(`decrypts with a ${label}`, async () => {
      const [thumbprint, derB64] = ps(
        `$c = New-SelfSignedCertificate -Type DocumentEncryptionCert -Subject 'CN=Fartcrobat helper test' ` +
          `-CertStoreLocation Cert:\\CurrentUser\\My -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy NonExportable ${extra} ` +
          `-NotAfter (Get-Date).AddDays(1); [Console]::Out.WriteLine($c.Thumbprint + ' ' + [Convert]::ToBase64String($c.RawData))`,
      ).split(' ')
      try {
        const listed = await listEncryptionCertificates()
        assert.ok(listed.some((c) => c.thumbprint === thumbprint))
        const blob = forgeEnvelopeRawIssuer([derToPem(Buffer.from(derB64, 'base64'))], SEED)
        const r = await decryptRecipients([blob])
        assert.equal(r.thumbprint, thumbprint)
        assert.deepEqual(r.content, SEED)
      } finally {
        ps(`Remove-Item -Path Cert:\\CurrentUser\\My\\${thumbprint} -DeleteKey`)
      }
    })
  }
})
