import { app } from 'electron'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { MainContext } from '@main/context'
import './ipc'

function idsDir(): string {
  const dir = join(app.getPath('userData'), 'digital-ids')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function register(ctx: MainContext) {
  ctx.handle('feature:digital-signatures:idsDir', () => idsDir())
  ctx.handle('feature:digital-signatures:deleteId', (_e, path) => {
    const dir = resolve(idsDir())
    const target = resolve(String(path))
    if (!target.startsWith(dir + sep)) throw new Error('Only Digital IDs stored by Fartcrobat can be deleted')
    if (existsSync(target)) unlinkSync(target)
    return true
  })
}
