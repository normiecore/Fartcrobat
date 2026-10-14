// Test-only: read the /Encrypt dictionary of a PubSec PDF with a classic xref (pyHanko output) and return
// the /Recipients blobs, as the PubSec bridge does. The app reads these with its own PDF parser.
export interface PubSecInfo {
  encNum: number
  filter: string
  subFilter: string
  v: number
  encryptMetadata: boolean
  recipients: Uint8Array[]
}

export function readPubSec(pdf: Uint8Array): PubSecInfo {
  const text = Buffer.from(pdf).toString('latin1')
  const trailerEnc = [...text.matchAll(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/g)].pop()
  if (!trailerEnc) throw new Error('not encrypted')
  const encNum = Number(trailerEnc[1])
  const objAt = text.lastIndexOf(`\n${encNum} 0 obj`)
  const encDict = text.slice(objAt, text.indexOf('endobj', objAt))
  const recArr = /\/Recipients\s*\[([^\]]*)\]/.exec(encDict)?.[1] ?? ''
  const recipients = [...recArr.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map(
    (m) => new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ''), 'hex')),
  )
  return {
    encNum,
    filter: /\/Filter\s*\/([\w.]+)/.exec(encDict)?.[1] ?? '',
    subFilter: /\/SubFilter\s*\/([\w.]+)/.exec(encDict)?.[1] ?? '',
    v: Number(/\/V\s+(\d)/.exec(encDict)?.[1] ?? 0),
    encryptMetadata: !/\/EncryptMetadata\s+false/.test(encDict),
    recipients,
  }
}
