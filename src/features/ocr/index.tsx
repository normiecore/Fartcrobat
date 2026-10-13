import { useEffect } from 'react'
import { Eraser, ScanText } from 'lucide-react'
import { defineFeature, getLoadedText, useApp, type DocumentModel } from '@renderer/sdk'
import { OcrPanel } from './OcrPanel'
import { OcrSettingsSection } from './OcrSettingsSection'
import { openRecognizeDialog } from './RecognizeDialog'
import { recognizeText, removeRecognizedText, useRun } from './run'
import { detectScannedDocument, ScanBar, useScanBar } from './scanBar'
import { loadOcrSettings, ocrSettings } from './settings'
import { isAvailable, refreshLanguages, useLanguages } from './languages'
import { BUNDLED_LANGUAGE } from './constants'
import './ocr.css'

/** The message bar's one-click "Recognize text": every page, with the preferred settings. */
async function recognizeWholeDocument(doc: DocumentModel) {
  await loadOcrSettings()
  const installed = useLanguages.getState().loaded ? useLanguages.getState().installed : await refreshLanguages()
  const preferred = useApp.getState().prefs.ocrLanguage
  const s = ocrSettings()
  await recognizeText(doc, {
    pages: [...Array(doc.pageCount).keys()],
    language: isAvailable(preferred, installed) ? preferred : BUNDLED_LANGUAGE,
    dpi: s.dpi,
    skipPagesWithText: s.skipPagesWithText
  })
}

function OcrGlobal() {
  const docs = useApp((s) => s.docs)
  // Forget the message bars of closed documents.
  useEffect(() => {
    const open = new Set(docs.map((d) => d.id))
    const scanned = useScanBar.getState().scanned
    if (Object.keys(scanned).some((id) => !open.has(id))) {
      useScanBar.setState({ scanned: Object.fromEntries(Object.entries(scanned).filter(([id]) => open.has(id))) })
    }
  }, [docs])
  return <ScanBar onRecognize={(doc) => void recognizeWholeDocument(doc)} />
}

export default defineFeature({
  id: 'ocr',
  commands: [
    {
      id: 'ocr.recognize',
      label: 'Recognize Text…',
      icon: ScanText,
      keywords: ['ocr', 'scan', 'scanned', 'searchable', 'optical character recognition', 'recognize text', 'text recognition'],
      enabled: () => !useRun.getState().active,
      run: ({ doc }) => openRecognizeDialog(doc!)
    },
    {
      id: 'ocr.removeText',
      label: 'Remove Recognized Text',
      icon: Eraser,
      keywords: ['ocr', 'remove ocr', 'delete recognized text'],
      enabled: () => !useRun.getState().active,
      run: ({ doc }) => removeRecognizedText(doc!)
    }
  ],
  menus: [
    { menu: 'tools', group: 'ocr', command: 'ocr.recognize', order: 100, submenu: 'Scan & OCR' },
    { menu: 'tools', group: 'ocr', command: 'ocr.removeText', order: 101, submenu: 'Scan & OCR' }
  ],
  toolGroups: [
    {
      id: 'ocr',
      label: 'Scan & OCR',
      icon: ScanText,
      color: '#0f8a7e',
      description: 'Recognize text in scanned documents to make them searchable',
      order: 100,
      category: 'convert',
      homeTile: true,
      panel: OcrPanel,
      keywords: ['ocr', 'scan', 'scanned', 'recognize text', 'searchable', 'optical character recognition']
    }
  ],
  pageContextMenu: [
    {
      id: 'ocr',
      order: 90,
      // Pages without text (as far as their text is loaded) offer recognition right where the user is.
      items: ({ doc, pageIndex }) =>
        !useRun.getState().active && getLoadedText(doc, pageIndex)?.text.trim() === ''
          ? [
              {
                id: 'ocr-recognize-page',
                label: 'Recognize Text on This Page…',
                icon: ScanText,
                run: () => {
                  doc.set({ currentPage: pageIndex })
                  void openRecognizeDialog(doc, 'current')
                }
              }
            ]
          : []
    }
  ],
  settings: [{ id: 'ocr', label: 'OCR', order: 60, component: OcrSettingsSection }],
  globals: [OcrGlobal],
  onDocumentOpen: (doc) => {
    void detectScannedDocument(doc)
  }
})
