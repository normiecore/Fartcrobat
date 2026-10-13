import type { CompareOptions, PageTokens, Raster } from './types'

type PageMeta = Pick<PageTokens, 'width' | 'height' | 'textRects' | 'imageRects'>

export type WorkerRequest =
  | { kind: 'text'; id: number; oldPages: PageTokens[]; newPages: PageTokens[]; options: CompareOptions }
  | { kind: 'visual'; id: number; a: Raster; b: Raster; oldPage: PageMeta; newPage: PageMeta }

export type WorkerResponse =
  | { kind: 'progress'; id: number; fraction: number; message: string }
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number; message: string }
