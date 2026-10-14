import { useCallback, useEffect, useState } from 'react'
import type { SavedPasswordInfo, SavedPasswordsStatus } from '@shared/passwords'
import type { DefaultAppStatus, PageLayoutMode, Preferences, ThemePreference, ZoomMode } from '@shared/types'
import type { UpdateStatus } from '@shared/updates'
import { registry } from '../app/registry'
import { useApp } from '../app/store'
import { setPrefs } from '../app/actions'
import { displayShortcut, commandLabel } from '../app/commands'
import { NO_KEYRING_NOTE } from '../app/savedPasswords'
import { openDialog, showError } from '../app/ui-services'
import { invoke, onMainEvent } from '../platform'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { confirm } from '../ui/dialogs'
import { Checkbox, Field, NumberInput, Select, Switch, TextInput } from '../ui/Field'

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

function savedPasswordsNote(status: SavedPasswordsStatus | null, on: boolean): string {
  if (!status) return ''
  if (status.policy) return 'Your organization turned this off for this computer, so it cannot be changed here.'
  if (!on) return 'Passwords saved before are kept, but they are not used while this is off.'
  if (status.available) return `They are protected by ${status.backend} and only work for your account on this computer.`
  if (status.reason === 'no-keyring') return NO_KEYRING_NOTE
  return 'Passwords cannot be saved right now: the system could not protect them.'
}

function lastUsed(t: number): string {
  return new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** Preferences > Passwords: remembering on or off, and the passwords saved on this device. */
export function PasswordSettings() {
  const prefs = useApp((s) => s.prefs)
  const [status, setStatus] = useState<SavedPasswordsStatus | null>(null)
  const [list, setList] = useState<SavedPasswordInfo[] | null>(null)
  const refresh = useCallback(() => {
    invoke('passwords:status').then(setStatus, () => setStatus(null))
    invoke('passwords:list').then(setList, () => setList([]))
  }, [])
  useEffect(refresh, [refresh, prefs.rememberPasswords])
  const policy = !!status?.policy
  const on = !policy && prefs.rememberPasswords
  const remove = async (refs: string[] | 'all') => {
    try {
      await invoke('passwords:forget', refs)
    } catch (err) {
      showError(err, 'Could not remove the saved password')
    }
    refresh()
  }
  const removeAll = async () => {
    const ok = await confirm({
      title: 'Remove all saved passwords?',
      message: 'Fartcrobat will ask for these passwords again the next time the documents and Digital IDs are used.',
      confirmLabel: 'Remove All',
      danger: true
    })
    if (ok) await remove('all')
  }
  return (
    <div className="prefs-passwords">
      <Switch checked={on} disabled={policy} onChange={(v) => void setPrefs({ rememberPasswords: v })} label="Remember passwords on this device" />
      <p className="shell-muted">
        When you open a protected document or sign with a Digital ID, Fartcrobat can remember the password so you only type it once.
        Remembered documents then open without asking, also when an AI app opens them for you.
      </p>
      {status && <p className="prefs-passwords-note">{savedPasswordsNote(status, on)}</p>}
      {list && list.length > 0 ? (
        <>
          <table className="prefs-passwords-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="ui-visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.ref}>
                  <td>
                    {r.label || 'Untitled'}
                    {r.unreadable && <span className="shell-muted"> (can’t be read)</span>}
                  </td>
                  <td>
                    {r.kind === 'digital-id' ? 'Digital ID' : 'Document'}
                    {r.level === 'owner' && <span className="prefs-passwords-tag">Full access</span>}
                  </td>
                  <td>{lastUsed(r.used)}</td>
                  <td>
                    <Button size="sm" variant="quiet" onClick={() => void remove([r.ref])}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.some((r) => r.unreadable) && (
            <p className="prefs-passwords-note">
              Passwords marked “can’t be read” were saved under a key this account no longer has (the keyring was reset, or the settings
              were copied from another account). Typing the password again replaces them.
            </p>
          )}
          <div>
            <Button onClick={() => void removeAll()}>Remove All</Button>
          </div>
        </>
      ) : (
        list && <p className="shell-muted">No passwords are saved on this device.</p>
      )}
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

const CHECK_FAILED = "Couldn't check for updates. Check your internet connection and try again."
const DOWNLOAD_FAILED = 'Could not start the download'

interface AboutUpdateAction {
  label: string
  channel: 'feature:updates:download' | 'feature:updates:restart'
  failed: string
}

/** What About says about updates, and the button that moves the flow on from there. */
function aboutUpdateLine(s: UpdateStatus): { text: string | null; action?: AboutUpdateAction } {
  const v = s.update?.version
  if (s.checksOff === 'policy') return { text: 'Updates are managed by your organization.' }
  switch (s.phase) {
    case 'checking':
      return { text: 'Checking for updates…' }
    case 'upToDate':
      return { text: `Fartcrobat ${s.currentVersion} is up to date.` }
    case 'available':
      return { text: `Fartcrobat ${v} is available.`, action: { label: 'Download', channel: 'feature:updates:download', failed: DOWNLOAD_FAILED } }
    case 'downloading':
      return { text: `Downloading Fartcrobat ${v}… ${Math.floor(s.progress?.percent ?? 0)}%` }
    case 'ready':
      return {
        text: `Fartcrobat ${v} is ready to install.`,
        action: { label: 'Restart now', channel: 'feature:updates:restart', failed: 'Could not restart Fartcrobat' }
      }
    case 'error':
      if (s.errorDuring === 'download')
        return { text: `Couldn't download Fartcrobat ${v}.`, action: { label: 'Try again', channel: 'feature:updates:download', failed: DOWNLOAD_FAILED } }
      // Automatic checks that fail stay silent.
      return { text: s.manual ? (s.error ?? CHECK_FAILED) : null }
    default:
      return { text: null }
  }
}

/**
 * Check for Updates in Help > About. The updates feature (src/features/updates) shows the rest of
 * the flow; core does not import features, so this talks to the main process directly.
 */
function AboutUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  // Set when the check could not reach the main process at all (the status cannot say so).
  const [unreachable, setUnreachable] = useState(false)
  useEffect(() => {
    let live = true
    let received = false
    const off = onMainEvent('updates:status', (s) => {
      received = true
      setStatus(s)
      setUnreachable(false)
    })
    invoke('feature:updates:status').then(
      (s) => live && !received && setStatus(s),
      () => {}
    )
    return () => {
      live = false
      off()
    }
  }, [])
  // No update service in this build: nothing to offer.
  if (!status) return null
  const check = async () => {
    setChecking(true)
    setUnreachable(false)
    try {
      // Main sends every step to every window first, so this answer is the newest status.
      setStatus(await invoke('feature:updates:check'))
    } catch {
      setUnreachable(true)
    } finally {
      setChecking(false)
    }
  }
  const line = checking ? { text: 'Checking for updates…' } : unreachable ? { text: CHECK_FAILED } : aboutUpdateLine(status)
  const action = !checking && !unreachable ? line.action : undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 14 }}>
      <Button size="sm" disabled={checking || status.checksOff === 'policy'} onClick={() => void check()}>
        Check for Updates
      </Button>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
        {line.text && <span className="shell-muted">{line.text}</span>}
        {action && (
          <Button size="sm" variant="quiet" onClick={() => void invoke(action.channel).catch((err) => showError(err, action.failed))}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  )
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
        <AboutUpdates />
      </div>
    </Dialog>
  ))
}
