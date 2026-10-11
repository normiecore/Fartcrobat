import { useEffect, useState } from 'react'
import type { DefaultAppStatus, PageLayoutMode, Preferences, ThemePreference, ZoomMode } from '@shared/types'
import { registry } from '../app/registry'
import { useApp } from '../app/store'
import { setPrefs } from '../app/actions'
import { displayShortcut, commandLabel } from '../app/commands'
import { openDialog } from '../app/ui-services'
import { invoke } from '../platform'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Checkbox, Field, NumberInput, Select, TextInput } from '../ui/Field'

function GeneralSettings() {
  const prefs = useApp((s) => s.prefs)
  const set = (patch: Partial<Preferences>) => void setPrefs(patch)
  const [status, setStatus] = useState<DefaultAppStatus | null>(null)
  useEffect(() => {
    void invoke('defaultApp:status').then(setStatus).catch(() => {})
  }, [])
  return (
    <div className="prefs-grid">
      <Field label="Your name (used as the author of comments)">
        <TextInput value={prefs.authorName} placeholder="e.g. Jane Smith" onChange={(e) => set({ authorName: e.target.value })} />
      </Field>
      <Field label="Appearance">
        <Select<ThemePreference>
          value={prefs.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'system', label: 'Match system' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </Field>
      <Field label="Default zoom">
        <Select<string>
          value={String(prefs.defaultZoom)}
          onChange={(v) => set({ defaultZoom: /^[a-z-]+$/.test(v) ? (v as ZoomMode) : parseFloat(v) })}
          options={[
            { value: 'fit-width', label: 'Fit width' },
            { value: 'fit-page', label: 'Fit page' },
            { value: 'actual-size', label: 'Actual size (100%)' },
            { value: '0.75', label: '75%' },
            { value: '1.25', label: '125%' },
            { value: '1.5', label: '150%' }
          ]}
        />
      </Field>
      <Field label="Default page layout">
        <Select<PageLayoutMode>
          value={prefs.defaultLayout}
          onChange={(v) => set({ defaultLayout: v })}
          options={[
            { value: 'continuous', label: 'Single page continuous' },
            { value: 'single', label: 'Single page' },
            { value: 'two-page-continuous', label: 'Two page scrolling' },
            { value: 'two-page', label: 'Two page' }
          ]}
        />
      </Field>
      <Field label="Page colours (accessibility)">
        <Select<Preferences['pageColors']>
          value={prefs.pageColors}
          onChange={(v) => set({ pageColors: v })}
          options={[
            { value: 'document', label: 'Use document colours' },
            { value: 'dark', label: 'Dark pages (invert brightness)' },
            { value: 'high-contrast', label: 'High contrast' }
          ]}
        />
      </Field>
      <Field label="Measurement units">
        <Select<Preferences['measurementUnits']>
          value={prefs.measurementUnits}
          onChange={(v) => set({ measurementUnits: v })}
          options={[
            { value: 'in', label: 'Inches' },
            { value: 'mm', label: 'Millimetres' },
            { value: 'cm', label: 'Centimetres' },
            { value: 'pt', label: 'Points' }
          ]}
        />
      </Field>
      <Field label="Recent files to remember">
        <NumberInput value={prefs.recentFilesLimit} min={1} max={100} onChange={(v) => set({ recentFilesLimit: Math.round(v) })} />
      </Field>
      <div className="prefs-checks">
        <Checkbox checked={prefs.singleKeyShortcuts} onChange={(v) => set({ singleKeyShortcuts: v })} label="Use single-key shortcuts for tools (V, H, Z…)" />
        <Checkbox checked={prefs.restoreLastView} onChange={(v) => set({ restoreLastView: v })} label="Reopen documents at the page and zoom where I left off" />
        <Checkbox checked={prefs.highlightFormFields} onChange={(v) => set({ highlightFormFields: v })} label="Highlight form fields" />
        <Checkbox checked={prefs.keepToolSelected} onChange={(v) => set({ keepToolSelected: v })} label="Keep annotation tools selected after use" />
        <Checkbox checked={prefs.checkDefaultAppOnStartup} onChange={(v) => set({ checkDefaultAppOnStartup: v })} label="Offer to make Fartcrobat the default PDF app" />
        <Checkbox checked={prefs.hardwareAcceleration} onChange={(v) => set({ hardwareAcceleration: v })} label="Use hardware acceleration (restart required)" />
      </div>
      <div className="prefs-default-app">
        <div>
          <b>Default PDF app</b>
          <div className="shell-muted">
            {status === null
              ? 'Checking…'
              : status.isDefault
                ? 'Fartcrobat opens PDF files by default.'
                : status.instructions}
          </div>
        </div>
        <Button onClick={() => void invoke('defaultApp:set').then(setStatus)} disabled={status?.isDefault === true}>
          Make default
        </Button>
      </div>
    </div>
  )
}

export function openPreferences(section?: string) {
  void openDialog((close) => <PreferencesDialog close={close} initial={section} />)
}

function PreferencesDialog({ close, initial }: { close: () => void; initial?: string }) {
  const sections = [{ id: 'general', label: 'General', order: 0, component: GeneralSettings }, ...registry.settings]
  const [active, setActive] = useState(initial && sections.some((s) => s.id === initial) ? initial : 'general')
  const Section = sections.find((s) => s.id === active)!.component
  return (
    <Dialog title="Preferences" onClose={close} width={820} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="prefs">
        <nav className="prefs-nav">
          {sections.map((s) => (
            <button key={s.id} className={s.id === active ? 'is-active' : ''} onClick={() => setActive(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="prefs-body">
          <Section />
        </div>
      </div>
    </Dialog>
  )
}

export function openShortcuts() {
  const rows: { label: string; keys: string[] }[] = []
  for (const cmd of registry.commands.values()) {
    if (!cmd.shortcut) continue
    const keys = (Array.isArray(cmd.shortcut) ? cmd.shortcut : [cmd.shortcut]).map(displayShortcut)
    rows.push({ label: commandLabel(cmd, { doc: null }), keys })
  }
  for (const t of registry.tools.values()) if (t.shortcut) rows.push({ label: t.label, keys: [t.shortcut] })
  rows.sort((a, b) => a.label.localeCompare(b.label))
  void openDialog((close) => (
    <Dialog title="Keyboard shortcuts" onClose={() => close()} width={620} footer={<Button variant="primary" onClick={() => close()}>Close</Button>}>
      <p className="shell-muted">Most shortcuts match Adobe Acrobat. Single-key shortcuts can be turned off in Preferences.</p>
      <table className="shortcuts-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label + r.keys.join()}>
              <td>{r.label}</td>
              <td>
                {r.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  ))
}

export function openAbout() {
  const info = useApp.getState().systemInfo
  void openDialog((close) => (
    <Dialog title="About Fartcrobat" onClose={() => close()} width={480} footer={<Button variant="primary" onClick={() => close()}>Close</Button>}>
      <div className="about">
        <div className="about-logo">F</div>
        <h3>Fartcrobat {info?.appVersion}</h3>
        <p>A free, open-source PDF reader, editor and signer.</p>
        <p className="shell-muted">
          Licensed under the GNU Affero General Public License v3 or later. PDF engine: MuPDF by Artifex Software
          (AGPL). Built with Electron {info?.electron}, Chromium {info?.chrome}.
        </p>
      </div>
    </Dialog>
  ))
}
