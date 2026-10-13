import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { MainContext } from '@main/context'

/** A language data file the user added (same shape as ./ipc.ts in the renderer). */
interface InstalledLanguage {
  code: string
  file: string
  path: string
  size: number
}

declare module '@shared/ipc' {
  interface IpcApi {
    'feature:ocr:languageDir': () => string
    'feature:ocr:languages': () => InstalledLanguage[]
    'feature:ocr:removeLanguage': (code: string) => InstalledLanguage[]
  }
}

/** <code>.traineddata or <code>.traineddata.gz, e.g. fra.traineddata, chi_sim.traineddata.gz. */
export const LANGUAGE_FILE = /^([a-z]{3}(?:_[a-z0-9]+)*)\.traineddata(\.gz)?$/i

function languageDir(): string {
  return join(app.getPath('userData'), 'tessdata')
}

export function listLanguages(dir: string): InstalledLanguage[] {
  if (!existsSync(dir)) return []
  const byCode = new Map<string, InstalledLanguage>()
  for (const file of readdirSync(dir)) {
    const m = LANGUAGE_FILE.exec(file)
    if (!m) continue
    const path = join(dir, file)
    let size = 0
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      size = st.size
    } catch {
      continue
    }
    const code = m[1].toLowerCase()
    // Prefer the uncompressed file when both exist (it is what was added last, usually).
    const prev = byCode.get(code)
    if (!prev || !m[2]) byCode.set(code, { code, file, path, size })
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))
}

export function register(ctx: MainContext) {
  ctx.handle('feature:ocr:languageDir', () => {
    const dir = languageDir()
    mkdirSync(dir, { recursive: true })
    return dir
  })
  ctx.handle('feature:ocr:languages', () => listLanguages(languageDir()))
  ctx.handle('feature:ocr:removeLanguage', (_e, code) => {
    const dir = languageDir()
    for (const l of listLanguages(dir)) {
      if (l.code !== String(code).toLowerCase()) continue
      for (const file of [`${l.code}.traineddata`, `${l.code}.traineddata.gz`]) {
        const p = join(dir, file)
        if (existsSync(p)) unlinkSync(p)
      }
    }
    return listLanguages(dir)
  })
}
