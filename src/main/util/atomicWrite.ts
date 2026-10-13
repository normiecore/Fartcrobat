import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** File-system calls atomicWrite uses; tests replace some of them to simulate failures. */
export interface AtomicWriteFs {
  rename(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  writeData(handle: fsp.FileHandle, data: Uint8Array): Promise<void>
}

export interface AtomicWriteOptions {
  platform?: string
  /** Pauses between rename attempts when Windows reports the file as busy (virus scanners, indexers). */
  retryDelays?: number[]
  fs?: Partial<AtomicWriteFs>
}

const defaultFs: AtomicWriteFs = {
  rename: (from, to) => fsp.rename(from, to),
  copyFile: (from, to) => fsp.copyFile(from, to),
  writeData: async (handle, data) => {
    await handle.writeFile(data)
  }
}

const WINDOWS_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Follows symbolic links (also dangling ones) so saving updates the file a link points to. */
export async function resolveWriteTarget(path: string): Promise<string> {
  let current = resolve(path)
  for (let i = 0; i < 40; i++) {
    let st: Stats
    try {
      st = await fsp.lstat(current)
    } catch {
      return current
    }
    if (!st.isSymbolicLink()) return current
    current = resolve(dirname(current), await fsp.readlink(current))
  }
  throw Object.assign(new Error(`Too many symbolic links: ${path}`), { code: 'ELOOP' })
}

async function removeQuietly(path: string) {
  try {
    await fsp.unlink(path)
  } catch {}
}

/**
 * Writes a file so that a crash or a full disk never leaves a half-written document: the data
 * goes to a temporary file next to the target, is flushed to disk and then renamed over it.
 *
 * - Symbolic links are followed: the file they point to is updated and the link stays.
 * - The original file's permissions (and owner, when allowed) are kept.
 * - Files with several hard links are rewritten in place so every link sees the new content.
 * - On Windows a rename blocked for a moment by a virus scanner or indexer is retried before
 *   falling back to overwriting the file in place.
 * - The temporary file is removed whatever happens.
 */
export async function atomicWrite(path: string, data: Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const fs: AtomicWriteFs = { ...defaultFs, ...opts.fs }
  const retryDelays = opts.retryDelays ?? [50, 100, 200, 400, 800]
  const target = await resolveWriteTarget(path)
  let existing: Stats | null = null
  try {
    existing = await fsp.stat(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existing?.isDirectory()) throw Object.assign(new Error(`${target} is a folder`), { code: 'EISDIR' })

  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString('hex')}.fartcrobat-tmp`)
  const handle = await fsp.open(tmp, 'wx', existing ? existing.mode & 0o777 : 0o666)
  try {
    await fs.writeData(handle, data)
    if (existing && platform !== 'win32') {
      // open() applies the umask; restore the exact permissions, then the owner if we may.
      await handle.chmod(existing.mode & 0o7777)
      if (typeof process.getuid === 'function' && (existing.uid !== process.getuid() || existing.gid !== process.getgid?.())) {
        try {
          await handle.chown(existing.uid, existing.gid)
        } catch {}
      }
    }
    await handle.sync()
    await handle.close()
  } catch (err) {
    await handle.close().catch(() => {})
    await removeQuietly(tmp)
    throw err
  }

  try {
    if (existing && existing.nlink > 1) {
      // Renaming would detach this name from the other hard links; update the shared file.
      await fs.copyFile(tmp, target)
      return
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, target)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (platform !== 'win32' || !WINDOWS_BUSY.has(code)) throw err
        if (attempt < retryDelays.length) {
          await sleep(retryDelays[attempt])
          continue
        }
        // Another program keeps the file open without allowing it to be replaced: overwrite it.
        try {
          await fs.copyFile(tmp, target)
        } catch {
          throw err
        }
        break
      }
    }
    if (platform !== 'win32') {
      // Make the rename itself durable.
      try {
        const dir = await fsp.open(dirname(target), 'r')
        await dir.sync().catch(() => {})
        await dir.close()
      } catch {}
    }
  } finally {
    await removeQuietly(tmp)
  }
}
