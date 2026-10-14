/**
 * StoreFs on the real disk: atomic replace, readable by this user only.
 *
 * Port target: src/main/passwords/main.ts (use src/main/util/atomicWrite.ts instead of the
 * rename below; it also retries renames Windows virus scanners block).
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StoreFs } from './store.ts'

export const nodeFs: StoreFs = {
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
    const tmp = `${path}.${process.pid}.tmp`
    const fh = await open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(text, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  },
  async remove(path) {
    try {
      await unlink(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
