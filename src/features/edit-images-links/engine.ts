import type { Matrix, Rect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { Session } from '@engine/session'
import {
  addImage,
  arrangeImage,
  cropImage,
  deleteImage,
  imagePng,
  listPageImages,
  probeImage,
  replaceImage,
  transformImage,
  type ArrangeWhere,
  type ImageRef,
  type PageImage,
  type TransformKind
} from './images'
import {
  createLink,
  createLinksFromUrls,
  deleteLinks,
  listLinks,
  removeAllLinks,
  unlinkedUrls,
  updateLink,
  type FoundUrl,
  type LinkItem,
  type LinkSpec
} from './links'

export type { PageImage, ImageRef, ArrangeWhere, TransformKind } from './images'
export type { LinkItem, LinkSpec, LinkAction, LinkAppearance, FoundUrl } from './links'

const TRANSFORM_LABELS: Record<TransformKind, string> = {
  move: 'Move Image',
  resize: 'Resize Image',
  rotate: 'Rotate Image',
  flip: 'Flip Image'
}

const ARRANGE_LABELS: Record<ArrangeWhere, string> = {
  front: 'Bring to Front',
  forward: 'Bring Forward',
  backward: 'Send Backward',
  back: 'Send to Back'
}

function pageList(s: Session, pages: number[] | 'all'): number[] {
  const n = s.pageCount()
  if (pages === 'all') return Array.from({ length: n }, (_, i) => i)
  return [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 0 && p < n))].sort((a, b) => a - b)
}

function validMatrix(m: Matrix) {
  if (!Array.isArray(m) || m.length !== 6 || m.some((v) => !Number.isFinite(v))) throw new EngineError('Invalid transformation', 'BAD_MATRIX')
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-9) throw new EngineError('The image cannot be made that small', 'BAD_MATRIX')
}

export default defineOps('edit-images-links', {
  // ---- images ------------------------------------------------------------------------------

  /** Every image drawn on a page (page content and form XObjects), in paint order. */
  images(s, page: number): PageImage[] {
    return listPageImages(s, page)
  },

  /** The pixels of an image as PNG bytes. */
  imagePng(s, page: number, ref: ImageRef) {
    const r = imagePng(s, page, ref)
    return withTransfer(r, [r.png.buffer as ArrayBuffer])
  },

  /** Pixel size and declared resolution of image file bytes; throws when the format is unsupported. */
  probeImage(s, bytes: Uint8Array) {
    return probeImage(s, bytes)
  },

  /** Applies a page-space matrix to an image (move, resize, rotate, flip). */
  transformImage: mutation(
    (_page: number, _ref: ImageRef, _m: Matrix, kind: TransformKind = 'move') => TRANSFORM_LABELS[kind] ?? 'Move Image',
    (s, page: number, ref: ImageRef, matrix: Matrix, _kind: TransformKind = 'move'): PageImage | null => {
      validMatrix(matrix)
      return transformImage(s, page, ref, matrix)
    }
  ),

  cropImage: mutation('Crop Image', (s, page: number, ref: ImageRef, rect: Rect): PageImage | null => cropImage(s, page, ref, rect)),

  deleteImage: mutation('Delete Image', (s, page: number, ref: ImageRef) => {
    deleteImage(s, page, ref)
  }),

  replaceImage: mutation('Replace Image', (s, page: number, ref: ImageRef, bytes: Uint8Array): PageImage | null =>
    replaceImage(s, page, ref, bytes)
  ),

  arrangeImage: mutation(
    (_page: number, _ref: ImageRef, where: ArrangeWhere) => ARRANGE_LABELS[where] ?? 'Arrange Image',
    (s, page: number, ref: ImageRef, where: ArrangeWhere): PageImage | null => arrangeImage(s, page, ref, where)
  ),

  /** Adds an image as page content filling `rect` (page space). */
  addImage: mutation('Add Image', (s, page: number, bytes: Uint8Array, rect: Rect): PageImage | null => {
    if (rect[2] - rect[0] < 0.5 || rect[3] - rect[1] < 0.5) throw new EngineError('The image area is too small', 'BAD_RECT')
    return addImage(s, page, bytes, rect)
  }),

  // ---- links -------------------------------------------------------------------------------

  links(s, page: number): LinkItem[] {
    return listLinks(s, page)
  },

  createLink: mutation('Create Link', (s, page: number, rect: Rect, spec: LinkSpec): LinkItem => {
    const l = createLink(s, page, rect, spec)
    s.documentChanged()
    return l
  }),

  updateLink: mutation(
    (_page: number, _id: number, patch: Partial<LinkSpec> & { rect?: Rect }) =>
      patch.rect && !patch.action && !patch.appearance ? 'Move Link' : 'Edit Link',
    (s, page: number, id: number, patch: Partial<LinkSpec> & { rect?: Rect }): LinkItem => {
      const l = updateLink(s, page, id, patch)
      s.documentChanged()
      return l
    }
  ),

  deleteLink: mutation('Delete Link', (s, page: number, id: number) => {
    deleteLinks(s, page, [id])
    s.documentChanged()
  }),

  /** Web and e-mail addresses in the page text that have no link yet. */
  findUrls(s, pages: number[] | 'all'): FoundUrl[] {
    const list = pageList(s, pages)
    const out: FoundUrl[] = []
    list.forEach((p, i) => {
      out.push(...unlinkedUrls(s, [p]))
      s.progress((i + 1) / list.length, `Searching page ${p + 1}`)
    })
    return out
  },

  createLinksFromUrls: mutation('Create Links from URLs', (s, pages: number[] | 'all'): number => {
    const n = createLinksFromUrls(s, pageList(s, pages))
    s.documentChanged()
    return n
  }),

  removeAllLinks: mutation('Remove All Links', (s, pages: number[] | 'all'): number => {
    const n = removeAllLinks(s, pageList(s, pages))
    if (!n) throw new EngineError('There are no links to remove.', 'NO_CHANGE')
    s.documentChanged()
    return n
  })
})
