import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PREFERENCES, type Preferences, type RecentFile } from '@shared/types'

interface StoreData {
  prefs: Preferences
  recent: RecentFile[]
  kv: Record<string, unknown>
}

/** Small JSON-file store in the user data folder for preferences, recent files and feature data. */
class Store {
  private data: StoreData
  private timer: NodeJS.Timeout | null = null
  readonly file: string

  constructor() {
    this.file = join(app.getPath('userData'), 'fartcrobat-settings.json')
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        return {
          prefs: { ...DEFAULT_PREFERENCES, ...(raw.prefs ?? {}) },
          recent: Array.isArray(raw.recent) ? raw.recent : [],
          kv: raw.kv && typeof raw.kv === 'object' ? raw.kv : {}
        }
      }
    } catch (err) {
      console.error('Could not read settings, starting fresh', err)
    }
    return { prefs: { ...DEFAULT_PREFERENCES }, recent: [], kv: {} }
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('Could not save settings', err)
    }
  }

  get prefs(): Preferences {
    return this.data.prefs
  }

  setPrefs(patch: Partial<Preferences>): Preferences {
    this.data.prefs = { ...this.data.prefs, ...patch }
    this.scheduleSave()
    return this.data.prefs
  }

  get recent(): RecentFile[] {
    return this.data.recent
  }

  addRecent(file: Omit<RecentFile, 'openedAt'>): RecentFile[] {
    const list = this.data.recent.filter((r) => r.path !== file.path)
    list.unshift({ ...file, openedAt: Date.now() })
    this.data.recent = list.slice(0, Math.max(1, this.data.prefs.recentFilesLimit || 30))
    this.scheduleSave()
    try {
      app.addRecentDocument(file.path)
    } catch {}
    return this.data.recent
  }

  removeRecent(path: string): RecentFile[] {
    this.data.recent = this.data.recent.filter((r) => r.path !== path)
    this.scheduleSave()
    return this.data.recent
  }

  clearRecent() {
    this.data.recent = []
    this.scheduleSave()
    try {
      app.clearRecentDocuments()
    } catch {}
  }

  get(key: string): unknown {
    return this.data.kv[key]
  }

  set(key: string, value: unknown) {
    if (value === undefined) delete this.data.kv[key]
    else this.data.kv[key] = value
    this.scheduleSave()
  }
}

let instance: Store | null = null

export function store(): Store {
  if (!instance) instance = new Store()
  return instance
}
