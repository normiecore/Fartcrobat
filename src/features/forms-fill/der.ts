/**
 * Just enough DER/BER reading to find who signed a PDF signature: the common name (CN) of the
 * signer's certificate inside the PKCS#7 /Contents of a signature dictionary.
 */

interface Node {
  tag: number
  constructed: boolean
  /** Offset of the content. */
  start: number
  end: number
  children: Node[]
}

const MAX_NODES = 20000

function parse(bytes: Uint8Array, start: number, end: number, depth: number, budget: { n: number }): Node[] {
  const out: Node[] = []
  let i = start
  while (i < end) {
    if (++budget.n > MAX_NODES || depth > 40) throw new Error('too deep')
    const tag = bytes[i++]
    if (tag === 0 && bytes[i] === 0) break // end-of-contents of an indefinite-length parent
    if ((tag & 0x1f) === 0x1f) {
      // high tag number form
      while (i < end && bytes[i] & 0x80) i++
      i++
    }
    let len = bytes[i++]
    let indefinite = false
    if (len === 0x80) indefinite = true
    else if (len & 0x80) {
      const n = len & 0x7f
      if (n > 4) throw new Error('length too long')
      len = 0
      for (let k = 0; k < n; k++) len = len * 256 + bytes[i++]
    }
    const constructed = (tag & 0x20) !== 0
    const node: Node = { tag, constructed, start: i, end: indefinite ? end : i + len, children: [] }
    if (node.end > end) throw new Error('truncated')
    if (constructed) {
      node.children = parse(bytes, node.start, node.end, depth + 1, budget)
      if (indefinite) {
        // find the end-of-contents after the last child
        const last = node.children[node.children.length - 1]
        let j = last ? last.end : node.start
        if (bytes[j] === 0 && bytes[j + 1] === 0) j += 2
        node.end = j
      }
    } else if (indefinite) throw new Error('indefinite primitive')
    out.push(node)
    i = node.end
  }
  return out
}

const CN_OID = [0x55, 0x04, 0x03]

function decodeString(bytes: Uint8Array, n: Node): string {
  const raw = bytes.subarray(n.start, n.end)
  if (n.tag === 0x1e) {
    // BMPString (UTF-16BE)
    let s = ''
    for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode((raw[k] << 8) | raw[k + 1])
    return s
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(raw)
  } catch {
    return String.fromCharCode(...raw)
  }
}

function commonName(bytes: Uint8Array, name: Node | undefined): string | null {
  if (!name) return null
  for (const rdn of name.children) {
    for (const atv of rdn.children) {
      const [oid, value] = atv.children
      if (!oid || !value || oid.tag !== 0x06) continue
      const o = bytes.subarray(oid.start, oid.end)
      if (o.length === 3 && o[0] === CN_OID[0] && o[1] === CN_OID[1] && o[2] === CN_OID[2]) return decodeString(bytes, value)
    }
  }
  return null
}

function sameBytes(bytes: Uint8Array, a: Node, b: Node): boolean {
  if (a.end - a.start !== b.end - b.start) return false
  for (let k = 0; k < a.end - a.start; k++) if (bytes[a.start + k] !== bytes[b.start + k]) return false
  return true
}

/** Common name of the signing certificate in a PKCS#7 signature, or null. */
export function signerCommonName(bytes: Uint8Array): string | null {
  try {
    // /Contents is zero padded; parsing stops at the padding.
    const [contentInfo] = parse(bytes, 0, bytes.length, 0, { n: 0 })
    const explicit = contentInfo?.children[1]
    const signedData = explicit?.children[0]
    if (!signedData) return null
    const certSet = signedData.children.find((c) => c.tag === 0xa0)
    const signerInfos = signedData.children[signedData.children.length - 1]
    const certs = (certSet?.children ?? []).map((cert) => {
      const tbs = cert.children[0]
      const fields = tbs?.children ?? []
      const off = fields[0]?.tag === 0xa0 ? 1 : 0
      return { serial: fields[off], subject: fields[off + 4] }
    })
    const signer = signerInfos?.children[0]
    const sid = signer?.children[1]
    if (sid && sid.tag === 0x30) {
      const serial = sid.children[1]
      const match = serial && certs.find((c) => c.serial && sameBytes(bytes, c.serial, serial))
      const cn = match ? commonName(bytes, match.subject) : null
      if (cn) return cn
    }
    for (const c of certs) {
      const cn = commonName(bytes, c.subject)
      if (cn) return cn
    }
    return null
  } catch {
    return null
  }
}
