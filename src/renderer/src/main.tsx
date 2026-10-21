import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/ui.css'
import './styles/shell.css'
import './styles/viewer.css'
import { loadFeatures, registry } from './app/registry'
import { getActiveDoc, useApp } from './app/store'
import { commandsAllowed, handleShortcut, runCommand, scheduleMenuUpdate } from './app/commands'
import { answerCloseRequest, openNewDocument, openPaths, refreshRecent, replaceDocumentBytes } from './app/actions'
import { runMenuCommand, trackTextFieldFocus } from './app/editing'
import { reportOpenFiles } from './app/windowState'
import { invoke, onMainEvent } from './platform'
import { authorName, coreFeature } from './core/coreFeature'
import { AppShell } from './shell/AppShell'
import { handlePopupEscape } from './ui/Menu'

loadFeatures([coreFeature])

function applyTheme() {
  const pref = useApp.getState().prefs.theme
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

async function boot() {
  try {
    const [prefs, systemInfo] = await Promise.all([invoke('prefs:get'), invoke('app:systemInfo')])
    useApp.setState({ prefs, systemInfo })
  } catch (err) {
    console.error('Could not load preferences', err)
  }
  applyTheme()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
  useApp.subscribe((s, prev) => {
    if (s.prefs.theme !== prev.prefs.theme) applyTheme()
    if (s.prefs.authorName !== prev.prefs.authorName) {
      for (const d of s.docs) void d.ops<typeof import('@engine/ops/annots').default>('annots').setAuthor(authorName())
    }
  })

  // Escape that closes a popup does nothing else: registered first, before every feature's listener.
  window.addEventListener('keydown', handlePopupEscape, true)
  // Keyboard shortcuts and the temporary hand tool (hold Space).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) {
      const t = e.target as HTMLElement
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName)
      if (!typing && getActiveDoc() && commandsAllowed()) {
        e.preventDefault()
        useApp.setState({ spaceHand: true })
        return
      }
    }
    handleShortcut(e)
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && useApp.getState().spaceHand) useApp.setState({ spaceHand: false })
  })
  window.addEventListener('blur', () => useApp.setState({ spaceHand: false }))

  onMainEvent('app:openFiles', (paths) => void openPaths(paths))
  // Text-editing items act on the focused field; other commands wait like keyboard shortcuts.
  onMainEvent('menu:command', (id) => void runMenuCommand(id))
  onMainEvent('app:beforeQuit', () => void answerCloseRequest())
  onMainEvent('window:fullScreenChanged', (on) => useApp.setState({ fullScreen: on, readMode: on ? useApp.getState().readMode : false }))

  // Window title and native menu follow the active document.
  let unsubDoc: (() => void) | null = null
  const refreshChrome = () => {
    const doc = getActiveDoc()
    const s = doc?.state
    void invoke('window:setTitle', s ? `${s.dirty ? '• ' : ''}${s.title} - Fartcrobat` : 'Fartcrobat')
    scheduleMenuUpdate()
  }
  useApp.subscribe((s, prev) => {
    // Read Mode and Full Screen show a document; Home always has its top bar.
    if (s.activeDocId === null && prev.activeDocId !== null && (s.readMode || s.fullScreen)) {
      if (s.fullScreen) void invoke('window:setFullScreen', false).catch(() => {})
      useApp.setState({ readMode: false, fullScreen: false })
    }
    if (s.activeDocId !== prev.activeDocId || s.docs !== prev.docs) {
      unsubDoc?.()
      const doc = getActiveDoc()
      unsubDoc = doc
        ? doc.store.subscribe((ds, dp) => {
            // Everything the native menu reads (enabled states, check marks): replies that change
            // nothing no longer notify (applyChanges). Back/forward history moves with currentPage.
            if (ds.dirty !== dp.dirty || ds.title !== dp.title || ds.journal !== dp.journal || ds.selection !== dp.selection || ds.layout !== dp.layout || ds.zoomMode !== dp.zoomMode || ds.showAnnotations !== dp.showAnnotations || ds.info !== dp.info || ds.currentPage !== dp.currentPage || ds.search !== dp.search || ds.coverPage !== dp.coverPage)
              refreshChrome()
          })
        : null
      refreshChrome()
    } else if (s.readMode !== prev.readMode || s.toolId !== prev.toolId) scheduleMenuUpdate()
  })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppShell />
    </StrictMode>
  )
  refreshChrome()
  trackTextFieldFocus()
  reportOpenFiles()
  void refreshRecent()
  const launch = await invoke('app:launchFiles').catch(() => [] as string[])
  if (launch.length) await openPaths(launch)
  ;(window as any).__fartcrobat = { registry, useApp, getActiveDoc, openPaths, runCommand, openNewDocument, replaceDocumentBytes }
}

void boot()
