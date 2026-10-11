import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLocalEngine, type LocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type { ClientOps } from '@engine/define'
import type { DocInfo, OpenResult } from '@shared/types'

export const FIXTURES = resolve(__dirname, '../fixtures')

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)))
}

export interface OpenedEngine extends LocalEngine {
  info: DocInfo
  doc: ClientOps<typeof docOps>
}

/** Creates an in-process engine and opens a fixture in it. */
export async function openFixture(name: string, password?: string): Promise<OpenedEngine> {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const res: OpenResult = await doc.open(fixture(name), { fileName: name, password })
  if (!res.ok) throw new Error(`could not open ${name}: needs password`)
  return Object.assign(engine, { info: res.info, doc })
}

/** Saves the document and reopens the bytes in a fresh engine (round-trip check). */
export async function roundTrip(engine: OpenedEngine): Promise<OpenedEngine> {
  const bytes = await engine.doc.save({})
  const fresh = await createLocalEngine()
  const doc = fresh.ops<typeof docOps>('doc')
  const res = await doc.open(bytes, { fileName: 'roundtrip.pdf' })
  if (!res.ok) throw new Error('round trip needs password')
  return Object.assign(fresh, { info: res.info, doc })
}
