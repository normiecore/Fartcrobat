// Protect > Encrypt with Certificate and the Protect panel for certificate-encrypted documents:
// recipients, permission groups, the person's own certificate and what the panel shows
// (src/features/protect-optimize/certificates.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CertKeyCandidate, CertKeyVia, EncryptionCertificate, PubSecRecipient } from '@shared/certkeys'
import type { DocInfo, Permission } from '@shared/types'
import type { DigitalIdRecord } from '@features/digital-signatures/types'
import { certificatePermissionBits, certificatePermissions } from '@engine/crypt/keys'
import { certificateAccess, type DocUnlock } from '@renderer/app/unlock'
import { certificateInfo } from '@features/protect-optimize/certificateFiles'
import {
  EC_REASON,
  FULL_ACCESS,
  OPENS_FOR_ANYONE,
  addRecipients,
  certificateRecipientNames,
  certificateSecurity,
  chooseOwnCertificate,
  commonName,
  describeRecipient,
  groupPermissions,
  hasFullAccess,
  hasOwnRecipient,
  moveRecipient,
  ownVia,
  permissionSummary,
  recipientFromDigitalId,
  recipientFromStore,
  recipientRefusal,
  recipientsFromFile,
  removeGroup,
  removeRecipient,
  replaceCertificateSecurityMessage,
  toCertificateGroups,
  type GroupSettings,
  type Recipient,
  type RecipientGroup
} from '@features/protect-optimize/certificates'
import { DEFAULT_PROTECT_SETTINGS, permissionRows, protectedSummary, type ProtectSettings } from '@features/protect-optimize/shared'

const PKI = join(__dirname, '../fixtures/passwordless/pki')
const pki = (name: string) => new Uint8Array(readFileSync(join(PKI, name)))
const cert = (name: string) => certificateInfo(pki(name))

function digitalId(name: string, file: string): DigitalIdRecord {
  const c = cert(file)
  return {
    id: c.sha256,
    path: `/ids/${name}.p12`,
    name,
    email: c.email,
    organization: c.organization,
    issuer: c.issuerName,
    notBefore: c.notBefore.toISOString(),
    notAfter: c.notAfter.toISOString(),
    keyType: c.keyDescription,
    certificate: Buffer.from(c.der).toString('base64'),
    selfSigned: false,
    createdByApp: true,
    addedAt: 0
  }
}

function storeCert(file: string, store: string, hasPrivateKey: boolean): EncryptionCertificate {
  const c = cert(file)
  return {
    store,
    thumbprint: c.sha1,
    subject: c.subject,
    issuer: c.issuer,
    serial: c.serial,
    notBefore: c.notBefore.toISOString(),
    notAfter: c.notAfter.toISOString(),
    keyType: c.keyType,
    email: c.email,
    friendlyName: '',
    hasPrivateKey,
    der: c.der
  }
}

const ALL: Record<Permission, boolean> = { print: true, 'print-hq': true, edit: true, annotate: true, form: true, assemble: true, copy: true, accessibility: true }
const fileRecipient = (file: string) => recipientsFromFile([cert(file)], file)[0]
const group = (id: number, recipients: Recipient[], settings: GroupSettings = FULL_ACCESS): RecipientGroup => ({ id, settings, recipients })

describe('protect-optimize: certificate recipients', () => {
  it('makes recipients from Digital IDs, the Windows store and files', () => {
    const alice = recipientFromDigitalId(digitalId('Alice at work', 'alice.cer'))!
    expect(alice.id).toBe(cert('alice.cer').sha256)
    expect(alice.mine).toBe(true)
    expect(alice.source).toBe('digital-id')
    expect(alice.via).toEqual({ source: 'digital-id', label: 'Alice at work', subject: alice.cert.subject, fingerprint: alice.cert.sha256, hardware: false })
    expect(recipientFromDigitalId({ ...digitalId('Broken', 'alice.cer'), certificate: 'AAAA' })).toBeNull()

    const personal = recipientFromStore(storeCert('winstore/me-enc.cer', 'CurrentUser\\My', true))!
    expect(personal.mine).toBe(true)
    expect(personal.source).toBe('windows-store')
    expect(personal.via?.fingerprint).toBe(cert('winstore/me-enc.cer').sha1)
    expect(personal.via?.source).toBe('windows-store')
    // A personal certificate without its key is not one of the person's keys.
    expect(recipientFromStore(storeCert('winstore/me-nokey.cer', 'CurrentUser\\My', false))!.mine).toBe(false)
    const colleague = recipientFromStore(storeCert('winstore/colleague.cer', 'CurrentUser\\AddressBook', false))!
    expect(colleague.source).toBe('other-people')
    expect(colleague.mine).toBe(false)
    expect(colleague.via).toBeUndefined()

    const bob = fileRecipient('bob.cer')
    expect(bob).toMatchObject({ source: 'file', sourceLabel: 'bob.cer', mine: false })
  })

  it('adds the person’s own certificate by default', () => {
    const ec = recipientFromDigitalId(digitalId('EC', 'ec.cer'))!
    const alice = recipientFromDigitalId(digitalId('Alice', 'alice.cer'))!
    const bob = recipientFromDigitalId(digitalId('Bob', 'bob.cer'))!
    const storeOwn = recipientFromStore(storeCert('winstore/me-enc.cer', 'CurrentUser\\My', true))!
    const storeEc = recipientFromStore(storeCert('winstore/me-ec.cer', 'CurrentUser\\My', true))!
    const storeNoKey = recipientFromStore(storeCert('winstore/me-nokey.cer', 'CurrentUser\\My', false))!

    // The certificate that opened the document, matched by SHA-256 for a Digital ID...
    const openedWithBob: CertKeyVia = { source: 'digital-id', label: 'Bob', subject: bob.cert.subject, fingerprint: bob.cert.sha256.toLowerCase(), hardware: false }
    expect(chooseOwnCertificate({ via: openedWithBob, ids: [ec, alice, bob], store: [storeOwn] })?.id).toBe(bob.id)
    // ...and by SHA-1 thumbprint for the Windows store, keeping what the real via knows (a smart card).
    const openedWithCard: CertKeyVia = {
      source: 'windows-store',
      label: 'Store Test Me',
      subject: storeOwn.cert.subject,
      fingerprint: storeOwn.cert.sha1,
      hardware: true
    }
    const fromCard = chooseOwnCertificate({ via: openedWithCard, ids: [alice], store: [storeNoKey, storeOwn] })!
    expect(fromCard.id).toBe(storeOwn.id)
    expect(fromCard.via?.hardware).toBe(true)

    // Not listed any more: the first Digital ID with an RSA key (the EC one is skipped).
    const gone: CertKeyVia = { ...openedWithBob, fingerprint: 'AB'.repeat(32) }
    expect(chooseOwnCertificate({ via: gone, ids: [ec, alice, bob], store: [storeOwn] })?.id).toBe(alice.id)
    expect(chooseOwnCertificate({ ids: [ec, alice], store: [] })?.id).toBe(alice.id)
    // No Digital ID: the first personal store certificate with a private key and an RSA key.
    expect(chooseOwnCertificate({ ids: [ec], store: [storeEc, storeNoKey, storeOwn] })?.id).toBe(storeOwn.id)
    expect(chooseOwnCertificate({ ids: [], store: [storeNoKey, storeEc] })).toBeNull()
    expect(chooseOwnCertificate({ via: null, ids: [], store: [] })).toBeNull()
  })

  it('turns group settings into permission groups, one per group with recipients', () => {
    expect(groupPermissions(FULL_ACCESS)).toEqual(ALL)
    // Changing the security grants everything, whatever else is set.
    expect(groupPermissions({ ...FULL_ACCESS, printing: 'none', copy: false, edit: false })).toEqual(ALL)
    const printOnly: GroupSettings = {
      printing: 'high',
      edit: false,
      assemble: false,
      annotate: false,
      form: false,
      copy: false,
      accessibility: false,
      changeSecurity: false
    }
    expect(groupPermissions(printOnly)).toEqual({ ...ALL, edit: false, assemble: false, annotate: false, form: false, copy: false, accessibility: false })
    expect(groupPermissions({ ...printOnly, printing: 'low' })).toMatchObject({ print: true, 'print-hq': false })
    expect(groupPermissions({ ...printOnly, printing: 'none' })).toMatchObject({ print: false, 'print-hq': false })
    // Copying implies access for screen readers.
    expect(groupPermissions({ ...printOnly, copy: true }).accessibility).toBe(true)

    expect(permissionSummary(FULL_ACCESS)).toBe('Full access, including the security settings')
    expect(permissionSummary({ ...FULL_ACCESS, changeSecurity: false })).toBe('Everything allowed except changing the security settings')
    expect(permissionSummary({ ...printOnly, printing: 'low', copy: true })).toBe(
      'Not allowed: high-resolution printing, changing the document, inserting, deleting and rotating pages, commenting and filling in forms and signing'
    )

    const alice = fileRecipient('alice.cer')
    const bob = fileRecipient('bob.cer')
    const stranger = fileRecipient('stranger.cer')
    const groups = toCertificateGroups([group(1, [alice, bob]), group(2, []), group(3, [stranger], printOnly)])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ certificates: [pki('alice.cer'), pki('bob.cer')], permissions: ALL, changeSecurity: true })
    expect(groups[1].certificates).toEqual([pki('stranger.cer')])
    expect(groups[1].changeSecurity).toBe(false)
    expect(groups[1].permissions).toEqual(groupPermissions(printOnly))
    expect(toCertificateGroups([group(1, [])])).toEqual([])
    // RSA only: an EC certificate never reaches the engine.
    expect(() => toCertificateGroups([group(1, [alice, fileRecipient('ec.cer')])])).toThrow(EC_REASON)
  })

  it('keeps every certificate once across the groups, and moves and removes them', () => {
    const alice = fileRecipient('alice.cer')
    const bob = fileRecipient('bob.cer')
    const ec = fileRecipient('ec.cer')
    let groups = [group(1, [alice]), group(2, [])]
    const res = addRecipients(groups, 2, [bob, alice, ec, bob])
    expect(res).toMatchObject({ added: 1, duplicates: 2, refused: 1 })
    groups = res.groups
    expect(groups.map((g) => g.recipients.map((r) => r.cert.name))).toEqual([['Alice Test'], ['Bob Tëst']])
    expect(recipientRefusal(ec.cert)).toBe(EC_REASON)

    groups = moveRecipient(groups, bob.id, 1)
    expect(groups.map((g) => g.recipients.map((r) => r.cert.name))).toEqual([['Alice Test', 'Bob Tëst'], []])
    expect(moveRecipient(groups, bob.id, 99)).toBe(groups)

    groups = removeRecipient(groups, alice.id)
    expect(groups[0].recipients.map((r) => r.id)).toEqual([bob.id])

    // Removing a group keeps its recipients in the first remaining group; the last group stays.
    const three = [group(1, [alice]), group(2, [bob]), group(3, [])]
    expect(removeGroup(three, 1).map((g) => [g.id, g.recipients.map((r) => r.id)])).toEqual([
      [2, [bob.id, alice.id]],
      [3, []]
    ])
    const one = [group(1, [alice])]
    expect(removeGroup(one, 1)).toBe(one)
  })

  it('warns when none of the person’s own certificates is a recipient, and says how the reopened file was opened', () => {
    const own = chooseOwnCertificate({ ids: [recipientFromDigitalId(digitalId('Alice', 'alice.cer'))!], store: [] })!
    const bob = fileRecipient('bob.cer')
    const groups = [group(1, [own, bob])]
    expect(hasOwnRecipient(groups)).toBe(true)
    expect(ownVia(groups, own)).toEqual(own.via)
    const without = removeRecipient(groups, own.id)
    expect(hasOwnRecipient(without)).toBe(false)
    expect(ownVia(without, own)).toBeUndefined()
    // Another of their certificates added by hand also counts.
    const other = recipientFromStore(storeCert('winstore/me-enc.cer', 'CurrentUser\\My', true))!
    const withOther = addRecipients(without, 1, [other]).groups
    expect(hasOwnRecipient(withOther)).toBe(true)
    expect(ownVia(withOther, own)).toEqual(other.via)
  })
})

describe('protect-optimize: certificate-encrypted documents', () => {
  const info = (permissions: Partial<Record<Permission, boolean>>, encryption = 'Adobe.PubSec V5 256-bit AES'): Pick<DocInfo, 'encryption' | 'permissions'> => ({
    encryption,
    permissions: { ...ALL, ...permissions }
  })

  it('gives full access only to a certificate that may change the security', () => {
    expect(hasFullAccess({ method: 'certificate', access: 'owner' })).toBe(true)
    expect(hasFullAccess({ method: 'source', access: 'owner' })).toBe(true)
    expect(hasFullAccess({ method: 'certificate', access: 'user' })).toBe(false)
    // Without knowing which envelope opened it, nothing is offered that the engine may refuse.
    expect(hasFullAccess(null)).toBe(false)
    expect(hasFullAccess(undefined)).toBe(false)
  })

  it('does not count an envelope that allows everything except changing the security as full access', () => {
    // "Add a Group with Other Permissions" starts with exactly this group.
    const [group2] = toCertificateGroups([group(2, [fileRecipient('bob.cer')], { ...FULL_ACCESS, changeSecurity: false })])
    const bits = certificatePermissionBits(group2.permissions, group2.changeSecurity)
    expect(bits).toBe(0xfffffffd)
    // What Bob gets when he opens the file: every permission, but not the security settings.
    const opened = certificatePermissions(bits)
    expect(opened.permissions).toEqual(ALL)
    const unlock: DocUnlock = { method: 'certificate', access: certificateAccess(bits) }
    expect(unlock.access).toBe('user')
    expect(hasFullAccess(unlock)).toBe(false)
    const st = certificateSecurity(info(opened.permissions), unlock)
    expect(st.ownerAccess).toBe(false)
    expect(st.permissions).toEqual(ALL)
    // The panel's table says why Protect and Remove security are disabled.
    const rows = permissionRows(st.filePermissions, { changeSecurity: st.ownerAccess })
    expect(rows.at(-1)).toEqual(['Changing the security', 'Not allowed', 'denied'])
    expect(rows.slice(0, -1).every(([, , level]) => level === 'allowed')).toBe(true)
    expect(permissionRows(ALL, { changeSecurity: true }).at(-1)).toEqual(['Changing the security', 'Allowed', 'allowed'])
    // Password security has no such row (its permissions password changes the security).
    expect(permissionRows(ALL).map(([label]) => label)).not.toContain('Changing the security')
  })

  it('says that replacing certificate security without an open password lets anyone open the file', () => {
    // Protect using password: the recipients will need the password instead.
    expect(replaceCertificateSecurityMessage('password')).toBe(
      'This replaces the certificate security with a password. The people it is encrypted for will no longer open it with their certificates.'
    )
    // Restrict editing starts without an open password: say plainly what that means.
    const restrict = replaceCertificateSecurityMessage('restrict')
    expect(restrict).toContain('no longer be encrypted for its recipients')
    expect(restrict).toContain('anyone with the file will be able to open it')
    expect(OPENS_FOR_ANYONE).toContain('anyone with the file will be able to open it')

    // The summary after saving says it too, whatever the document was.
    const restrictOnly: ProtectSettings = { ...DEFAULT_PROTECT_SETTINGS, requireOpenPassword: false, restrictEditing: true, permissionsPassword: 'p', changes: 'comments', allowCopy: false }
    expect(protectedSummary(restrictOnly, { certificate: true })).toEqual([
      'It is no longer encrypted for its recipients: anyone with the file can open it without a password.',
      'Without the permissions password, these are not allowed: changing the document, inserting, deleting and rotating pages and copying text and images.'
    ])
    expect(protectedSummary(restrictOnly)[0]).toBe('Anyone with the file can open it without a password.')
    // With an open password nothing changes.
    const both: ProtectSettings = { ...restrictOnly, requireOpenPassword: true, openPassword: 'o', changes: 'any', allowCopy: true }
    expect(protectedSummary(both, { certificate: true, remembered: true })).toEqual([
      'Opening it needs the password you set. It is saved on this device, so the file opens here without asking.',
      'Changing its security needs the permissions password.'
    ])
    expect(protectedSummary({ ...DEFAULT_PROTECT_SETTINGS, openPassword: 'o' })).toEqual(['Opening it needs the password you set.'])
  })

  it('describes the security without a password', () => {
    const restricted = certificateSecurity(info({ edit: false, copy: false }, 'Adobe.PubSec V4 128-bit AES'), { method: 'certificate', access: 'user' })
    expect(restricted).toEqual({
      encrypted: true,
      method: '128-bit AES',
      needsOpenPassword: false,
      ownerAccess: false,
      permissions: { ...ALL, edit: false, copy: false },
      filePermissions: { ...ALL, edit: false, copy: false }
    })
    expect(certificateSecurity(info({}), { method: 'source', access: 'owner' })).toMatchObject({ method: '256-bit AES', ownerAccess: true })
    expect(certificateSecurity(info({}), { method: 'certificate', access: 'user' })).toMatchObject({ ownerAccess: false })
    expect(certificateSecurity(info({}, 'Adobe.PubSec V4 128-bit RC4'), null).method).toBe('128-bit RC4')
  })

  it('names the recipients by issuer and serial or key ID, and the person’s own key by its label', () => {
    expect(commonName('CN=Fartcrobat Tëst CA Ünïcode ✓,OU=TEST KEYS ONLY - never use for anything real,O=Fartcrobat Test Keys')).toBe('Fartcrobat Tëst CA Ünïcode ✓')
    expect(commonName('O=Contoso, CN=Contoso\\, Inc. CA')).toBe('Contoso, Inc. CA')
    expect(commonName('O=Contoso')).toBe('')

    const bob: PubSecRecipient = {
      envelope: 0,
      index: 0,
      idType: 'issuerAndSerialNumber',
      issuer: 'CN=Fartcrobat Tëst CA Ünïcode ✓, OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Test Keys',
      serial: 'C702FE1F51EB78F7042245CFFD210279',
      keyType: 'rsa'
    }
    const alice: PubSecRecipient = { envelope: 0, index: 1, idType: 'issuerAndSerialNumber', issuer: 'CN=Fartcrobat Test CA, O=Fartcrobat Test Keys', serial: '2BF5739A719BB028F20B38EB7F084141', keyType: 'rsa' }
    const ski: PubSecRecipient = { envelope: 1, index: 0, idType: 'subjectKeyIdentifier', ski: 'D7445486090C462D17C8AAFE207ECC1141FD9F4E', keyType: 'rsa' }
    const noIssuer: PubSecRecipient = { envelope: 1, index: 1, idType: 'issuerAndSerialNumber', issuer: 'O=Contoso', keyType: 'rsa' }
    expect(describeRecipient(bob)).toBe('Certificate from Fartcrobat Tëst CA Ünïcode ✓, serial C702FE1F51EB78F7042245CFFD210279')
    expect(describeRecipient(ski)).toBe('Certificate with key ID D7445486090C462D17C8AAFE207ECC1141FD9F4E')
    expect(describeRecipient(noIssuer)).toBe('Certificate from O=Contoso')
    expect(describeRecipient({ envelope: 2, index: 0, idType: 'other', keyType: 'other' })).toBe('Unknown recipient')

    const mine: CertKeyCandidate = {
      id: 'digital-id:ABC',
      source: 'digital-id',
      label: 'Alice Test',
      subject: 'CN=Alice Test',
      issuer: 'CN=Fartcrobat Test CA',
      fingerprint: 'ABC',
      envelope: 0,
      index: 1,
      needs: 'password',
      hardware: false,
      keyType: 'rsa'
    }
    expect(describeRecipient(alice, [mine])).toBe('Alice Test (you)')
    // The person's own key first, then the others, each once.
    expect(certificateRecipientNames({ recipients: [bob, alice, ski, bob], candidates: [mine] })).toEqual([
      'Alice Test (you)',
      'Certificate from Fartcrobat Tëst CA Ünïcode ✓, serial C702FE1F51EB78F7042245CFFD210279',
      'Certificate with key ID D7445486090C462D17C8AAFE207ECC1141FD9F4E'
    ])
  })
})
