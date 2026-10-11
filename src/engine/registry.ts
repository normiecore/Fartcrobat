import type { OpModule } from './define'
import annotOps from './ops/annots'
import docOps from './ops/doc'
import formOps from './ops/forms'
import navOps from './ops/nav'
import pageOps from './ops/pages'
import renderOps from './ops/render'
import textOps from './ops/text'

/** Core operations plus every feature's `src/features/<feature>/engine.ts`. */
export function collectOpModules(): OpModule[] {
  const modules: OpModule[] = [docOps, renderOps, textOps, navOps, annotOps, formOps, pageOps]
  const featureModules = import.meta.glob<{ default?: OpModule }>('../features/*/engine.ts', { eager: true })
  for (const [path, mod] of Object.entries(featureModules)) {
    if (!mod.default || typeof mod.default.namespace !== 'string') {
      console.warn(`[engine] ${path} has no default export from defineOps(); skipped`)
      continue
    }
    modules.push(mod.default)
  }
  return modules
}
