/** Object identifiers used by X.509, CMS and PKCS#12. */
export const OID = {
  // content types
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  // attributes
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  adobeRevocationInfo: '1.2.840.113583.1.1.8',
  // digests
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha224: '2.16.840.1.101.3.4.2.4',
  md5: '1.2.840.113549.2.5',
  // public keys and signatures
  rsaEncryption: '1.2.840.113549.1.1.1',
  md5WithRSA: '1.2.840.113549.1.1.4',
  sha1WithRSA: '1.2.840.113549.1.1.5',
  rsaPSS: '1.2.840.113549.1.1.10',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  sha384WithRSA: '1.2.840.113549.1.1.12',
  sha512WithRSA: '1.2.840.113549.1.1.13',
  sha224WithRSA: '1.2.840.113549.1.1.14',
  mgf1: '1.2.840.113549.1.1.8',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSHA1: '1.2.840.10045.4.1',
  ecdsaWithSHA224: '1.2.840.10045.4.3.1',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  ecdsaWithSHA384: '1.2.840.10045.4.3.3',
  ecdsaWithSHA512: '1.2.840.10045.4.3.4',
  ed25519: '1.3.101.112',
  prime256v1: '1.2.840.10045.3.1.7',
  secp384r1: '1.3.132.0.34',
  secp521r1: '1.3.132.0.35',
  // names
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  serialNumber: '2.5.4.5',
  countryName: '2.5.4.6',
  localityName: '2.5.4.7',
  stateOrProvinceName: '2.5.4.8',
  streetAddress: '2.5.4.9',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  title: '2.5.4.12',
  givenName: '2.5.4.42',
  emailAddress: '1.2.840.113549.1.9.1',
  domainComponent: '0.9.2342.19200300.100.1.25',
  // extensions
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  // extended key usages
  ekuServerAuth: '1.3.6.1.5.5.7.3.1',
  ekuClientAuth: '1.3.6.1.5.5.7.3.2',
  ekuCodeSigning: '1.3.6.1.5.5.7.3.3',
  ekuEmailProtection: '1.3.6.1.5.5.7.3.4',
  ekuTimeStamping: '1.3.6.1.5.5.7.3.8',
  ekuOcspSigning: '1.3.6.1.5.5.7.3.9',
  ekuDocumentSigning: '1.3.6.1.5.5.7.3.36',
  ekuAdobeAuthenticDocuments: '1.2.840.113583.1.1.5',
  ekuMsDocumentSigning: '1.3.6.1.4.1.311.10.3.12',
  ekuAny: '2.5.29.37.0'
} as const

export const DIGEST_BY_OID: Record<string, DigestName> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512',
  [OID.sha224]: 'SHA-224',
  [OID.md5]: 'MD5'
}

export const DIGEST_OID: Record<'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', string> = {
  'SHA-1': OID.sha1,
  'SHA-256': OID.sha256,
  'SHA-384': OID.sha384,
  'SHA-512': OID.sha512
}

export type DigestName = 'SHA-1' | 'SHA-224' | 'SHA-256' | 'SHA-384' | 'SHA-512' | 'MD5'

/** Digest implied by a combined signature algorithm, if any. */
export const SIGNATURE_DIGEST: Record<string, DigestName> = {
  [OID.md5WithRSA]: 'MD5',
  [OID.sha1WithRSA]: 'SHA-1',
  [OID.sha224WithRSA]: 'SHA-224',
  [OID.sha256WithRSA]: 'SHA-256',
  [OID.sha384WithRSA]: 'SHA-384',
  [OID.sha512WithRSA]: 'SHA-512',
  [OID.ecdsaWithSHA1]: 'SHA-1',
  [OID.ecdsaWithSHA224]: 'SHA-224',
  [OID.ecdsaWithSHA256]: 'SHA-256',
  [OID.ecdsaWithSHA384]: 'SHA-384',
  [OID.ecdsaWithSHA512]: 'SHA-512'
}

export const SIGNATURE_NAMES: Record<string, string> = {
  [OID.rsaEncryption]: 'RSA',
  [OID.md5WithRSA]: 'MD5 with RSA',
  [OID.sha1WithRSA]: 'SHA-1 with RSA',
  [OID.sha224WithRSA]: 'SHA-224 with RSA',
  [OID.sha256WithRSA]: 'SHA-256 with RSA',
  [OID.sha384WithRSA]: 'SHA-384 with RSA',
  [OID.sha512WithRSA]: 'SHA-512 with RSA',
  [OID.rsaPSS]: 'RSA-PSS',
  [OID.ecdsaWithSHA1]: 'ECDSA with SHA-1',
  [OID.ecdsaWithSHA224]: 'ECDSA with SHA-224',
  [OID.ecdsaWithSHA256]: 'ECDSA with SHA-256',
  [OID.ecdsaWithSHA384]: 'ECDSA with SHA-384',
  [OID.ecdsaWithSHA512]: 'ECDSA with SHA-512',
  [OID.ed25519]: 'Ed25519'
}

export const CURVE_NAMES: Record<string, 'P-256' | 'P-384' | 'P-521'> = {
  [OID.prime256v1]: 'P-256',
  [OID.secp384r1]: 'P-384',
  [OID.secp521r1]: 'P-521'
}

export const EKU_NAMES: Record<string, string> = {
  [OID.ekuServerAuth]: 'Server authentication',
  [OID.ekuClientAuth]: 'Client authentication',
  [OID.ekuCodeSigning]: 'Code signing',
  [OID.ekuEmailProtection]: 'Email protection',
  [OID.ekuTimeStamping]: 'Time stamping',
  [OID.ekuOcspSigning]: 'OCSP signing',
  [OID.ekuDocumentSigning]: 'Document signing',
  [OID.ekuAdobeAuthenticDocuments]: 'Adobe Authentic Documents Trust',
  [OID.ekuMsDocumentSigning]: 'Microsoft document signing',
  [OID.ekuAny]: 'Any purpose'
}

export const DN_SHORT: Record<string, string> = {
  [OID.commonName]: 'CN',
  [OID.surname]: 'SN',
  [OID.serialNumber]: 'SERIALNUMBER',
  [OID.countryName]: 'C',
  [OID.localityName]: 'L',
  [OID.stateOrProvinceName]: 'ST',
  [OID.streetAddress]: 'STREET',
  [OID.organizationName]: 'O',
  [OID.organizationalUnitName]: 'OU',
  [OID.title]: 'T',
  [OID.givenName]: 'G',
  [OID.emailAddress]: 'E',
  [OID.domainComponent]: 'DC'
}
