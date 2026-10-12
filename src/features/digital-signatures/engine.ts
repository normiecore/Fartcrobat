import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { AppearanceContent, SignRequest, SignatureFieldInfo } from './types'
import { renderAppearancePng } from './worker/appearance'
import { listSignatureFields } from './worker/fields'
import { clearSignatureField, signCapability, signDocument } from './worker/sign'
import { validateSignatures } from './worker/validate'

export default defineOps('digital-signatures', {
  /** Signature fields (signed and unsigned) with their page positions. */
  fields(s): SignatureFieldInfo[] {
    return listSignatureFields(s.pdf, s).map(({ field: _f, widget: _w, fieldNum: _n, ...rest }) => rest)
  },

  /** Whether the document can be signed or certified, and why not. */
  capability(s) {
    return signCapability(s)
  },

  /** Validates every signature against the bytes the document was opened from. */
  validate(s) {
    return validateSignatures(s)
  },

  /** The file as it was when a signature was applied (bytes up to the end of its byte range). */
  revisionBytes(s, end: number) {
    const src = s.sourceBytes
    if (!src) throw new EngineError('The original file is not available', 'NO_SOURCE')
    if (!Number.isInteger(end) || end <= 0 || end > src.length) throw new EngineError('That revision is not part of this file', 'BAD_REVISION')
    const bytes = src.slice(0, end)
    return withTransfer(bytes, [bytes.buffer])
  },

  /** PNG preview of a signature appearance of the given size (points) at `scale` pixels per point. */
  previewAppearance(s, content: AppearanceContent, width: number, height: number, scale: number) {
    const w = Math.max(4, Math.min(2000, width))
    const h = Math.max(4, Math.min(2000, height))
    const png = renderAppearancePng(s.mupdf, content, w, h, Math.max(0.25, Math.min(6, scale)))
    return withTransfer(png, [png.buffer as ArrayBuffer])
  },

  /**
   * Signs (or certifies) the document and returns the complete signed file. The open document is
   * not modified; write the bytes to disk and reload the tab from them.
   */
  async sign(s, req: SignRequest) {
    const res = await signDocument(s, req)
    return withTransfer(res, [res.bytes.buffer as ArrayBuffer])
  },

  /** Acrobat's "Clear Signature": removes the signature value from a field (undoable). */
  clearSignature: mutation('Clear Signature', (s, fieldName: string) => {
    clearSignatureField(s, fieldName)
  })
})
