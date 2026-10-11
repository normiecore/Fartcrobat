import { Printer } from 'lucide-react'
import {
  ask,
  defineFeature,
  displayShortcut,
  IconButton,
  invoke,
  openDialog,
  registry,
  runCommand,
  showError,
  toast,
  type DocumentModel
} from '@renderer/sdk'
import { PrintDialog, type PrintDialogResult } from './PrintDialog'
import { runPrintJob } from './printJob'
import { defaultSettings, persistable, sanitizeSettings, type PrintSettings } from './settings'
import './print.css'

export const SETTINGS_KEY = 'print:settings'

/** Settings remembered in this session (also stored with store:set so they survive restarts). */
let remembered: Partial<PrintSettings> | null = null

async function loadSettings(): Promise<PrintSettings> {
  const defaults = defaultSettings(typeof navigator !== 'undefined' ? navigator.language : 'en-US')
  if (remembered) return sanitizeSettings(remembered, defaults)
  try {
    const stored = await invoke('store:get', SETTINGS_KEY)
    return sanitizeSettings(stored, defaults)
  } catch (err) {
    console.warn('Could not read print settings', err)
    return defaults
  }
}

async function rememberSettings(settings: PrintSettings) {
  remembered = persistable(settings)
  try {
    await invoke('store:set', SETTINGS_KEY, remembered)
  } catch (err) {
    showError(err, 'Could not remember the print settings')
  }
}

async function explainNoPrinting(doc: DocumentModel) {
  const canRemove = registry.commands.has('protect.removeSecurity')
  const answer = await ask({
    title: 'Printing isn’t allowed',
    message: (
      <>
        <p>The author of “{doc.state.title}” has restricted this document so that it can’t be printed.</p>
        <p>
          {canRemove
            ? 'If you know its permissions password, you can remove the security and then print it.'
            : 'Ask the author for a copy that allows printing.'}
        </p>
      </>
    ),
    buttons: canRemove
      ? [
          { id: 'ok', label: 'OK' },
          { id: 'remove', label: 'Remove Security…', variant: 'primary' }
        ]
      : [{ id: 'ok', label: 'OK', variant: 'primary' }]
  })
  if (answer === 'remove') await runCommand('protect.removeSecurity')
}

/** True from opening the dialog until the job has been handed to the printer. */
let busy = false

/** File > Print (Ctrl+P). */
export async function openPrintDialog(doc: DocumentModel | null) {
  if (!doc) return
  if (busy) {
    toast('Fartcrobat is still preparing the previous print job.')
    return
  }
  if (doc.info.permissions.print === false) {
    await explainNoPrinting(doc)
    return
  }
  busy = true
  try {
    const initial = await loadSettings()
    const result = await openDialog<PrintDialogResult>((close) => <PrintDialog doc={doc} initial={initial} onClose={close} />)
    if (!result) return
    if (result.action === 'summarize') {
      busy = false
      await runCommand('comments.summarize')
      return
    }
    await rememberSettings(result.settings)
    await runPrintJob(doc, result.settings, result.sheets, result.target)
  } finally {
    busy = false
  }
}

function PrintToolbarButton({ doc }: { doc: DocumentModel }) {
  return (
    <IconButton
      icon={Printer}
      label="Print file"
      shortcut={displayShortcut('Mod+P')}
      className="fc-print-toolbar-btn"
      onClick={() => void openPrintDialog(doc)}
    />
  )
}

export default defineFeature({
  id: 'print',
  commands: [
    {
      id: 'file.print',
      label: 'Print…',
      icon: Printer,
      shortcut: 'Mod+P',
      keywords: ['printer', 'booklet', 'poster', 'pages per sheet', 'n-up', 'grayscale', 'duplex', 'both sides'],
      run: ({ doc }) => openPrintDialog(doc)
    }
  ],
  menus: [{ menu: 'file', group: 'print', command: 'file.print', order: 700 }],
  toolGroups: [
    {
      id: 'print',
      label: 'Print',
      icon: Printer,
      color: '#5c5ce0',
      order: 170,
      category: 'other',
      description: 'Print pages, booklets, posters or several pages per sheet',
      keywords: ['printer', 'booklet', 'poster'],
      run: ({ doc }) => openPrintDialog(doc)
    }
  ],
  docToolbar: [{ id: 'print', order: 5, component: PrintToolbarButton }]
})
