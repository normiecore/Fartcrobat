/**
 * One FormController per open document: caches the form snapshot and script runtime, serialises
 * edits (check -> format -> calculate -> write, one undo step each), tracks the mounted field
 * controls for Tab navigation, and runs button actions.
 */
import type { FieldInfo } from '@engine/ops/forms'
import type formOps from '@engine/ops/forms'
import {
  alertDialog,
  followExternalLink,
  registry,
  runCommand,
  showError,
  toast,
  type DocumentModel
} from '@renderer/sdk'
import type fillOps from './engine'
import type { ButtonAction, FillChange, FormSnapshotData, WidgetExtra } from './engine'
import { FormRuntime, type FieldChange, type FieldValue, type RuntimeHost } from './js/runtime'
import { formsSettings } from './settings'


export interface ControlHandle {
  focus(): void
  element: HTMLElement | null
}

/** Field types the user can type into or pick values for. */
export const FILLABLE = new Set(['text', 'checkbox', 'radio', 'combo', 'list'])

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : a ? [a] : []
    const y = Array.isArray(b) ? b : b ? [b] : []
    return x.length === y.length && x.every((v, i) => v === y[i])
  }
  return a === b
}

export class FormController {
  private snapshotCache: { version: number; promise: Promise<FormSnapshotData> } | null = null
  private runtimeCache: { version: number; runtime: FormRuntime } | null = null
  private runtimeLoading: { version: number; promise: Promise<FormRuntime> } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private reportedProblems = 0
  private notified = new Set<string>()
  /** Mounted field controls by widget id. */
  readonly controls = new Map<number, ControlHandle>()
  /** Widget to focus as soon as its page is mounted (Tab onto a page that was not rendered yet). */
  pendingFocus: number | null = null
  /** The focused control's "commit what you have" hook (used before saving). */
  activeEditor: { id: number; flush: () => void } | null = null
  /** Tab order (widget ids) of the last snapshot, for synchronous Tab handling. */
  tabOrder: number[] = []
  fieldsById = new Map<number, FieldInfo>()
  /** Widget details of the pages loaded so far. */
  readonly extras = new Map<number, WidgetExtra>()
  private loadErrorShown = false

  constructor(readonly doc: DocumentModel) {}

  get fill() {
    return this.doc.ops<typeof fillOps>('forms-fill')
  }

  get forms() {
    return this.doc.ops<typeof formOps>('forms')
  }

  // ---- snapshot & runtime ---------------------------------------------------------------

  snapshot(): Promise<FormSnapshotData> {
    const version = this.doc.state.docVersion
    if (this.snapshotCache?.version !== version) {
      const promise = this.fill.snapshot().then((snap) => {
        if (this.snapshotCache?.promise === promise) {
          this.tabOrder = snap.tabOrder
          this.fieldsById = new Map(snap.fields.map((f) => [f.id, f]))
        }
        return snap
      })
      promise.catch(() => {
        if (this.snapshotCache?.promise === promise) this.snapshotCache = null
      })
      this.snapshotCache = { version, promise }
    }
    return this.snapshotCache.promise
  }

  /** Script runtime matching the current document state (rebuilt after changes made elsewhere). */
  runtime(): Promise<FormRuntime> {
    const version = this.doc.state.docVersion
    if (this.runtimeCache?.version === version) return Promise.resolve(this.runtimeCache.runtime)
    // Callers that ask at the same time (several pages, an edit) share one runtime.
    if (this.runtimeLoading?.version === version) return this.runtimeLoading.promise
    const promise = this.snapshot().then((snap) => {
      const cached = this.runtimeCache
      if (cached && cached.version === version) return cached.runtime
      const runtime = new FormRuntime(snap, this.host())
      this.runtimeCache = { version, runtime }
      this.reportedProblems = 0
      return runtime
    })
    this.runtimeLoading = { version, promise }
    const done = () => {
      if (this.runtimeLoading?.promise === promise) this.runtimeLoading = null
    }
    promise.then(done, done)
    return promise
  }

  /** The runtime if it is ready and current (for synchronous keystroke checks). */
  currentRuntime(): FormRuntime | null {
    const c = this.runtimeCache
    return c && c.version === this.doc.state.docVersion ? c.runtime : null
  }

  /** Starts loading the runtime so keystroke checks are ready when the user types. */
  prepare() {
    void this.runtime().catch((err) => console.warn('Could not prepare form scripts', err))
  }

  private reportProblems(rt: FormRuntime) {
    if (rt.problems.length <= this.reportedProblems) return
    for (const p of rt.problems.slice(this.reportedProblems)) {
      console.warn(`[forms-fill] ${p.event} script of “${p.field || 'document'}”: ${p.message}`)
    }
    if (this.reportedProblems === 0) {
      toast("Some scripts in this form use features Fartcrobat can't run. You can still fill it in; some automatic formatting or calculations may be skipped.", {
        kind: 'warning',
        timeout: 8000
      })
    }
    this.reportedProblems = rt.problems.length
  }

  private host(): RuntimeHost {
    const doc = this.doc
    return {
      print: () => {
        if (registry.commands.has('file.print')) void runCommand('file.print')
        else this.notSupported('Printing')
      },
      resetForm: (names) => void this.reset(names),
      submitForm: (url) => this.explainSubmit(url),
      launchURL: (url) => void followExternalLink(url),
      gotoPage: (p) => doc.view?.goToPage(Math.max(0, Math.min(doc.pageCount - 1, Math.round(p)))),
      currentPage: () => doc.state.currentPage,
      pageCount: () => doc.pageCount,
      save: () => void runCommand('file.save'),
      exportData: () => void runCommand('forms.exportData'),
      importData: () => void runCommand('forms.importData'),
      setFocus: (name) => {
        const id = this.tabOrder.find((i) => this.fieldsById.get(i)?.name === name)
        if (id !== undefined) setTimeout(() => this.focusField(id), 0)
      },
      notSupported: (what) => this.notSupported(what),
      fileName: () => doc.state.title
    }
  }

  /** A page's fields could not be loaded (shown once per document). */
  loadFailed(err: unknown) {
    if (this.loadErrorShown) {
      console.warn('Could not load form fields', err)
      return
    }
    this.loadErrorShown = true
    showError(err, 'Could not load the form fields')
  }

  notSupported(what: string) {
    if (this.notified.has(what)) return
    this.notified.add(what)
    toast(`${what} is not supported by this form's scripts in Fartcrobat.`, { kind: 'warning', timeout: 6000 })
  }

  explainSubmit(url: string) {
    toast(
      `This form is set up to send its data${url ? ` to ${url}` : ''}. Fartcrobat works offline and never sends forms over the internet: save the PDF or export the form data and send it yourself.`,
      { kind: 'info', timeout: 12000, action: { label: 'Export data…', run: () => void runCommand('forms.exportData') } }
    )
  }

  // ---- queue -----------------------------------------------------------------------------

  /** Runs edits one after another so every check sees the previous edit's values. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Commits the focused field and waits for every pending edit (called before saving). */
  async flush() {
    try {
      this.activeEditor?.flush()
    } catch (err) {
      console.warn('Could not commit the active field', err)
    }
    await this.queue
  }

  private async showAlerts(alerts: string[], title: string) {
    for (const a of alerts) await alertDialog(title, a)
  }

  /** Writes changes: core forms.setValue for a simple single-field edit, else one fill step. */
  private async write(rt: FormRuntime, changes: FillChange[], label?: string) {
    if (!changes.length) return
    const versionBefore = this.doc.state.docVersion
    const c = changes[0]
    const f = c.id !== undefined ? this.fieldsById.get(c.id) : undefined
    const single = changes.length === 1 && f && !c.textColor && c.visibility === undefined && c.readOnly === undefined && c.required === undefined
    const widgetCount = f ? [...this.fieldsById.values()].filter((x) => x.name === f.name).length : 0
    if (single && widgetCount === 1 && c.value !== undefined && !label && (f.type === 'text' || f.type === 'checkbox' || f.type === 'radio')) {
      const value = typeof c.value === 'boolean' ? c.value : Array.isArray(c.value) ? c.value.join(', ') : c.value
      let display = c.display
      if (f.type === 'text' && f.password && typeof value === 'string') display = '*'.repeat(Math.min(value.length, 64))
      await this.forms.setValue(c.id!, value, display !== undefined && display !== value ? { display } : {})
    } else {
      await this.fill.fill(changes, label)
    }
    // Our own write: the runtime already holds these values, keep it.
    if (this.runtimeCache?.runtime === rt && this.doc.state.docVersion === versionBefore + 1) {
      this.runtimeCache = { version: this.doc.state.docVersion, runtime: rt }
    }
  }

  private toFill(changes: FieldChange[]): FillChange[] {
    return changes.map((c) => ({
      name: c.name,
      value: c.value,
      display: c.display !== undefined && c.display !== c.value ? c.display : undefined,
      textColor: c.textColor,
      visibility: c.visibility,
      readOnly: c.readOnly,
      required: c.required
    }))
  }

  private calculations(rt: FormRuntime): { changes: FillChange[]; alerts: string[] } {
    if (!formsSettings().autoCalculate || !rt.hasCalculations()) return { changes: [], alerts: [] }
    const r = rt.calculate()
    return { changes: this.toFill(r.changes), alerts: r.alerts }
  }

  /** Merges changes for the same field (later ones win). */
  private merge(changes: FillChange[]): FillChange[] {
    const out = new Map<string, FillChange>()
    for (const c of changes) out.set(c.name, { ...out.get(c.name), ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) } as FillChange)
    return [...out.values()]
  }

  // ---- edits -----------------------------------------------------------------------------

  /** Checks a keystroke against the field's keystroke script (synchronous; allows when not ready). */
  keystroke(field: FieldInfo, k: { value: string; change: string; selStart: number; selEnd: number }): { rc: boolean; change: string } {
    const rt = this.currentRuntime()
    if (!rt || !rt.has(field.name)) return { rc: true, change: k.change }
    const r = rt.keystroke(field.name, k)
    this.reportProblems(rt)
    if (r.alerts.length) void this.showAlerts(r.alerts, 'Invalid entry')
    return { rc: r.rc, change: r.change }
  }

  /**
   * Commits a typed value: keystroke/validation scripts, format, calculations, write.
   * Resolves to false (and shows Acrobat's message) when the value is rejected.
   */
  commitText(field: FieldInfo, raw: string): Promise<{ ok: boolean; display: string }> {
    return this.enqueue(async () => {
      const rt = await this.runtime()
      const before = rt.value(field.name)
      if (sameValue(before, raw)) return { ok: true, display: rt.format(field.name, raw).display }
      const c = rt.commit(field.name, raw)
      this.reportProblems(rt)
      if (!c.rc) {
        await this.showAlerts(c.alerts.length ? c.alerts : [`The value entered does not match the format of the field [ ${field.name} ]`], 'Invalid entry')
        return { ok: false, display: '' }
      }
      rt.setValue(field.name, c.value)
      const fmt = rt.format(field.name, c.value)
      const calc = this.calculations(rt)
      this.reportProblems(rt)
      const changes = this.merge([
        { id: field.id, name: field.name, value: c.value, display: fmt.display !== c.value ? fmt.display : undefined, textColor: fmt.textColor },
        ...calc.changes
      ])
      await this.write(rt, changes)
      void this.showAlerts([...c.alerts, ...fmt.alerts, ...calc.alerts], 'Message from this form')
      return { ok: true, display: fmt.display }
    })
  }

  /** Check box: toggles; radio button: selects (or clears when the field allows it). */
  toggle(field: FieldInfo, extra: WidgetExtra | undefined): Promise<void> {
    return this.enqueue(async () => {
      const rt = await this.runtime()
      // Use the runtime's value (not the rendered one) so quick double clicks toggle twice.
      const current = rt.value(field.name)
      const isOn = field.onState !== null && current === field.onState
      let value: string
      if (field.type === 'radio') {
        if (isOn) {
          if (extra?.noToggleToOff !== false) return
          value = 'Off'
        } else value = field.onState ?? 'Off'
      } else value = isOn ? 'Off' : (field.onState ?? 'Yes')
      rt.setValue(field.name, value)
      const changes: FillChange[] = [{ id: field.id, name: field.name, value: field.type === 'checkbox' ? value !== 'Off' : value }]
      const alerts: string[] = []
      if (extra?.action?.kind === 'js') {
        const r = rt.runAction(extra.action.script, field.name)
        changes.push(...this.toFill(r.changes))
        alerts.push(...r.alerts)
      }
      const calc = this.calculations(rt)
      this.reportProblems(rt)
      await this.write(rt, this.merge([...changes, ...calc.changes]))
      if (extra?.action?.kind === 'reset') void this.reset(extra.action.exclude ? this.otherNames(rt, extra.action.fields) : extra.action.fields)
      void this.showAlerts([...alerts, ...calc.alerts], 'Message from this form')
    })
  }

  /** Combo box or list box selection. */
  setChoice(field: FieldInfo, value: string | string[]): Promise<boolean> {
    return this.enqueue(async () => {
      const rt = await this.runtime()
      if (sameValue(rt.value(field.name), value)) return true
      let v: FieldValue = value
      let display: string | undefined
      let textColor: string | undefined
      if (typeof value === 'string') {
        const c = rt.commit(field.name, value)
        if (!c.rc) {
          this.reportProblems(rt)
          await this.showAlerts(c.alerts.length ? c.alerts : [`The value entered does not match the format of the field [ ${field.name} ]`], 'Invalid entry')
          return false
        }
        v = c.value
        const fmt = rt.format(field.name, c.value)
        if (fmt.display !== c.value) display = fmt.display
        textColor = fmt.textColor
      }
      rt.setValue(field.name, v)
      const calc = this.calculations(rt)
      this.reportProblems(rt)
      await this.write(rt, this.merge([{ id: field.id, name: field.name, value: v, display, textColor }, ...calc.changes]))
      void this.showAlerts(calc.alerts, 'Message from this form')
      return true
    })
  }

  private otherNames(rt: FormRuntime, names: string[]): string[] {
    const excluded = new Set(names)
    return rt.fieldNames().filter((n) => !excluded.has(n) && ![...excluded].some((e) => n.startsWith(e + '.')))
  }

  /**
   * Clears the form (or the named fields and their children) to default values in one undo step,
   * showing defaults with their field formats and recalculating calculated fields, like Acrobat.
   */
  reset(names?: string[]): Promise<void> {
    return this.enqueue(async () => {
      const list = names && names.length ? names : undefined
      const defaults = await this.fill.defaultValues(list)
      if (!defaults.length) return
      const rt = await this.runtime()
      const changes: FillChange[] = []
      for (const d of defaults) {
        rt.setValue(d.name, d.value)
        if (d.type !== 'text' || typeof d.value !== 'string' || !d.value || !rt.hasScripts(d.name)) continue
        const fmt = rt.format(d.name, d.value)
        if (fmt.display !== d.value || fmt.textColor) changes.push({ name: d.name, value: d.value, display: fmt.display !== d.value ? fmt.display : undefined, textColor: fmt.textColor })
      }
      const calc = this.calculations(rt)
      this.reportProblems(rt)
      const versionBefore = this.doc.state.docVersion
      await this.fill.reset(list, this.merge([...changes, ...calc.changes]))
      if (this.runtimeCache?.runtime === rt && this.doc.state.docVersion === versionBefore + 1) {
        this.runtimeCache = { version: this.doc.state.docVersion, runtime: rt }
      }
      void this.showAlerts([...calc.alerts], 'Message from this form')
    })
  }

  /** Recalculates every calculated field now. */
  calculateNow(): Promise<number> {
    return this.enqueue(async () => {
      const rt = await this.runtime()
      if (!rt.hasCalculations()) return 0
      const r = rt.calculate()
      this.reportProblems(rt)
      const changes = this.toFill(r.changes)
      await this.write(rt, changes, 'Calculate Fields')
      void this.showAlerts(r.alerts, 'Message from this form')
      return changes.length
    })
  }

  /** Imports values by field name (one undo step); returns counts. */
  importValues(entries: { name: string; value: FieldValue }[]): Promise<{ imported: number; unknown: string[] }> {
    return this.enqueue(async () => {
      const rt = await this.runtime()
      const unknown: string[] = []
      const changes: FillChange[] = []
      for (const e of entries) {
        const f = rt.field(e.name)
        if (!f) {
          unknown.push(e.name)
          continue
        }
        if (f.type === 'button' || f.type === 'signature' || f.type === 'unknown') continue
        let value: FieldValue = e.value
        if (f.type === 'list') value = Array.isArray(value) ? value : value ? [value] : []
        else if (Array.isArray(value)) value = f.type === 'text' ? value.join(', ') : (value[0] ?? '')
        if (f.type === 'checkbox' || f.type === 'radio') {
          const v = value as string
          const states = f.widgets.map((w) => w.onState).filter(Boolean) as string[]
          if (!v || v === 'Off' || /^(false|no|0)$/i.test(v)) value = 'Off'
          else if (states.includes(v)) value = v
          else if (f.type === 'checkbox' && /^(true|yes|on|1|x)$/i.test(v)) value = states[0] ?? 'Yes'
          else {
            unknown.push(e.name)
            continue
          }
        }
        rt.setValue(e.name, value)
        const display = typeof value === 'string' && f.type === 'text' ? rt.format(e.name, value) : null
        changes.push({
          name: e.name,
          value,
          display: display && display.display !== value ? display.display : undefined,
          textColor: display?.textColor
        })
      }
      const calc = this.calculations(rt)
      this.reportProblems(rt)
      const all = this.merge([...changes, ...calc.changes])
      if (all.length) await this.write(rt, all, 'Import Form Data')
      return { imported: changes.length, unknown }
    })
  }

  /** Push button actions. */
  async runButton(field: FieldInfo, action: ButtonAction | null) {
    try {
      if (!action) return
      switch (action.kind) {
        case 'reset': {
          const rt = await this.runtime()
          await this.reset(action.exclude ? this.otherNames(rt, action.fields) : action.fields)
          return
        }
        case 'submit':
          this.explainSubmit(action.url)
          return
        case 'uri':
          if (action.uri) await followExternalLink(action.uri)
          return
        case 'goto':
          this.doc.view?.goToPage(action.page, { x: action.x, y: action.y })
          return
        case 'named':
          this.runNamed(action.name)
          return
        case 'hide': {
          const rt = await this.runtime()
          await this.enqueue(async () => {
            for (const n of action.fields) rt.setProperty(n, { visibility: action.hide ? 1 : 0 })
            const changes = action.fields.filter((n) => rt.has(n)).map((n) => ({ name: n, visibility: action.hide ? 1 : 0 }))
            await this.write(rt, changes, action.hide ? 'Hide Fields' : 'Show Fields')
          })
          return
        }
        case 'js':
          await this.enqueue(async () => {
            const rt = await this.runtime()
            const r = rt.runAction(action.script, field.name)
            this.reportProblems(rt)
            const calc = r.changes.some((c) => c.value !== undefined) ? this.calculations(rt) : { changes: [], alerts: [] }
            const changes = this.merge([...this.toFill(r.changes), ...calc.changes])
            if (changes.length) await this.write(rt, changes, 'Run Form Action')
            void this.showAlerts([...r.alerts, ...calc.alerts], 'Message from this form')
          })
          return
        case 'other':
          this.notSupported(`The “${action.type}” button action`)
          return
      }
    } catch (err) {
      showError(err, 'The button action failed')
    }
  }

  private runNamed(name: string) {
    const d = this.doc
    const page = d.state.currentPage
    switch (name) {
      case 'NextPage':
        d.view?.goToPage(page + 1)
        break
      case 'PrevPage':
        d.view?.goToPage(page - 1)
        break
      case 'FirstPage':
        d.view?.goToPage(0)
        break
      case 'LastPage':
        d.view?.goToPage(d.pageCount - 1)
        break
      case 'Print':
        if (registry.commands.has('file.print')) void runCommand('file.print')
        else this.notSupported('Printing')
        break
      case 'Save':
        void runCommand('file.save')
        break
      case 'GoBack':
        void runCommand('nav.back')
        break
      case 'GoForward':
        void runCommand('nav.forward')
        break
      default:
        this.notSupported(`The “${name}” menu action`)
    }
  }

  // ---- focus & Tab -------------------------------------------------------------------------

  /** Widget ids that Tab stops at, in order. */
  tabStops(): number[] {
    const seenRadio = new Set<string>()
    const out: number[] = []
    for (const id of this.tabOrder) {
      const f = this.fieldsById.get(id)
      if (!f || f.hidden || f.readOnly || this.extras.get(id)?.noView) continue
      if (f.type === 'unknown') continue
      if (f.type === 'radio') {
        if (seenRadio.has(f.name)) continue
        seenRadio.add(f.name)
        // stop at the selected button of the group, else the first one
        const group = this.tabOrder.map((i) => this.fieldsById.get(i)!).filter((x) => x && x.name === f.name && !x.hidden)
        out.push((group.find((x) => x.checked) ?? f).id)
        continue
      }
      out.push(id)
    }
    return out
  }

  /** Moves focus to the next (dir 1) or previous (-1) field after `fromId`, wrapping around. */
  focusNext(fromId: number, dir: 1 | -1): boolean {
    const stops = this.tabStops()
    if (!stops.length) return false
    let next: number
    const i = stops.indexOf(fromId)
    if (i >= 0) next = i + dir
    else {
      // A radio button that is not its group's stop, or a field that is not a stop at all.
      const from = this.fieldsById.get(fromId)
      const j = from ? stops.findIndex((id) => this.fieldsById.get(id)?.name === from.name) : -1
      if (j >= 0) next = j + dir
      else {
        const pos = this.tabOrder.indexOf(fromId)
        const after = pos < 0 ? -1 : stops.findIndex((id) => this.tabOrder.indexOf(id) > pos)
        if (pos < 0) next = dir === 1 ? 0 : stops.length - 1
        else next = dir === 1 ? (after < 0 ? stops.length : after) : (after < 0 ? stops.length : after) - 1
      }
    }
    next = ((next % stops.length) + stops.length) % stops.length
    return this.focusField(stops[next])
  }

  /** First field at or after the current page (Tab from the document). */
  focusFirst(dir: 1 | -1): boolean {
    const stops = this.tabStops()
    if (!stops.length) return false
    const page = this.doc.state.currentPage
    const onOrAfter = stops.filter((id) => (this.fieldsById.get(id)?.page ?? 0) >= page)
    const target = dir === 1 ? (onOrAfter[0] ?? stops[0]) : stops.filter((id) => (this.fieldsById.get(id)?.page ?? 0) <= page).pop() ?? stops[stops.length - 1]
    return this.focusField(target)
  }

  focusField(id: number): boolean {
    const f = this.fieldsById.get(id)
    const handle = this.controls.get(id)
    if (f) this.doc.view?.scrollToRect(f.page, f.rect)
    if (handle?.element?.isConnected) {
      handle.focus()
      return true
    }
    if (!f) return false
    // The page is not rendered yet: focus the control once it mounts.
    this.pendingFocus = id
    this.doc.view?.scrollToRect(f.page, f.rect, { center: true })
    return true
  }
}

const controllers = new WeakMap<DocumentModel, FormController>()

export function formController(doc: DocumentModel): FormController {
  let c = controllers.get(doc)
  if (!c) {
    c = new FormController(doc)
    controllers.set(doc, c)
  }
  return c
}
