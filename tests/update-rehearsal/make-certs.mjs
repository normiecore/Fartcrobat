#!/usr/bin/env node
// Makes the update rehearsal's test certificates (README.md): a CA that lives only as long as the
// rehearsal machine, and a certificate for github.com and GitHub's release asset host signed by it.
//
//   node make-certs.mjs <dir>    writes ca.pem, ca.cer (DER), server.pem and server.key
import forge from 'node-forge'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: make-certs.mjs <dir>')
  process.exit(2)
}
mkdirSync(dir, { recursive: true })
const { pki, md } = forge

function certificate(subject, issuer, publicKey, signingKey, extensions, serial) {
  const cert = pki.createCertificate()
  cert.publicKey = publicKey
  cert.serialNumber = serial
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  cert.setSubject(subject)
  cert.setIssuer(issuer)
  cert.setExtensions(extensions)
  cert.sign(signingKey, md.sha256.create())
  return cert
}

const caKeys = pki.rsa.generateKeyPair(2048)
const caName = [{ name: 'commonName', value: 'Fartcrobat Update Rehearsal CA' }]
const ca = certificate(caName, caName, caKeys.publicKey, caKeys.privateKey, [
  { name: 'basicConstraints', cA: true, critical: true },
  { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  { name: 'subjectKeyIdentifier' }
], '01')

const serverKeys = pki.rsa.generateKeyPair(2048)
const server = certificate([{ name: 'commonName', value: 'github.com' }], caName, serverKeys.publicKey, caKeys.privateKey, [
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true },
  { name: 'subjectAltName', altNames: [{ type: 2, value: 'github.com' }, { type: 2, value: 'release-assets.githubusercontent.com' }] }
], '02')

writeFileSync(join(dir, 'ca.pem'), pki.certificateToPem(ca))
writeFileSync(join(dir, 'ca.cer'), Buffer.from(forge.asn1.toDer(pki.certificateToAsn1(ca)).getBytes(), 'binary'))
writeFileSync(join(dir, 'server.pem'), pki.certificateToPem(server))
writeFileSync(join(dir, 'server.key'), pki.privateKeyToPem(serverKeys.privateKey))
console.log(`certificates in ${dir}`)
