// The saved-password store on disk: atomic writes, readable by this user only.
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWrite } from '../util/atomicWrite'
import type { StoreFs } from './store'

export const nodeStoreFs: StoreFs = {
  async read(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  async write(path, text) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await atomicWrite(path, new TextEncoder().encode(text), { mode: 0o600 })
  },
  async remove(path) {
    try {
      await unlink(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
