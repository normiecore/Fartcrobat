// The MCP helper (shim) for AI apps that are set up by hand, such as ChatGPT Desktop: they run it
// with Node from a path in their own settings. Installed builds give them a copy in userData,
// because an AppImage's resources move on every launch and an update replaces them.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWrite } from '@main/util/atomicWrite'

/**
 * Copies `from` to `to` when the two differ, so the copy always matches this version of Fartcrobat.
 * With `create` false a missing copy stays missing: no AI app has been set up with it yet.
 * Returns whether the copy exists afterwards.
 */
export async function refreshHelperCopy(from: string, to: string, create: boolean): Promise<boolean> {
  const next = await readFile(from)
  const current = await readFile(to).catch(() => null)
  if (current?.equals(next)) return true
  if (!current && !create) return false
  await mkdir(dirname(to), { recursive: true })
  // Written aside and renamed (retried while Windows reports the file busy), so an AI app starting
  // the helper never reads half a file and no temporary file is left behind.
  await atomicWrite(to, next)
  return true
}
