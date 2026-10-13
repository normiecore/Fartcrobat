/** Preferences > OCR. */
import { useEffect } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Checkbox, Field, IconButton, setPrefs } from '@renderer/sdk'
import { BUNDLED_LANGUAGE } from './constants'
import { addLanguage, languageName, refreshLanguages, removeLanguage, useLanguages } from './languages'
import { DpiSelect, LanguageSelect } from './RecognizeForm'
import { DEFAULT_OCR_SETTINGS, loadOcrSettings, setOcrSettings, useOcrSettings } from './settings'

const P = 'fc-ocr'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function OcrSettingsSection() {
  const settings = useOcrSettings()
  const installed = useLanguages((s) => s.installed)
  useEffect(() => {
    void loadOcrSettings()
    void refreshLanguages()
  }, [])
  return (
    <div className={`${P}-settings`}>
      <div className="prefs-grid">
        <Field label="Default document language">
          <LanguageSelect />
        </Field>
        <Field label="Resolution">
          <DpiSelect />
        </Field>
      </div>
      <div className="prefs-checks">
        <Checkbox
          checked={settings.skipPagesWithText}
          onChange={(v) => void setOcrSettings({ skipPagesWithText: v })}
          label="Skip pages that already have text"
        />
        <Checkbox
          checked={settings.detectScanned}
          onChange={(v) => void setOcrSettings({ detectScanned: v })}
          label="Offer to recognize text when I open a scanned document"
        />
      </div>

      <div className={`${P}-settings-langs`}>
        <div className={`${P}-settings-langs-head`}>
          <b>Languages</b>
          <Button size="sm" icon={Plus} onClick={() => void addLanguage()}>
            Add language…
          </Button>
        </div>
        <ul className={`${P}-lang-list`} aria-label="Recognition languages">
          {!installed.some((l) => l.code === BUNDLED_LANGUAGE) && (
            <li>
              <span className={`${P}-lang-name`}>{languageName(BUNDLED_LANGUAGE)}</span>
              <span className={`${P}-lang-meta`}>Included</span>
            </li>
          )}
          {installed.map((l) => (
            <li key={l.code}>
              <span className={`${P}-lang-name`}>{languageName(l.code)}</span>
              <span className={`${P}-lang-meta`} title={l.path}>
                {l.file} · {formatSize(l.size)}
              </span>
              <IconButton icon={Trash2} size={15} label={`Remove ${languageName(l.code)}`} onClick={() => void removeLanguage(l.code)} />
            </li>
          ))}
        </ul>
        <p className={`${P}-settings-note`}>
          English is included. For other languages, add the Tesseract language file, named like <code>fra.traineddata</code>{' '}
          or <code>deu.traineddata.gz</code> (from the tessdata, tessdata_fast or tessdata_best collections of the
          Tesseract project). It is copied into Fartcrobat&apos;s settings folder, so recognition keeps working offline.
        </p>
      </div>
      <Button
        size="sm"
        onClick={() => {
          void setOcrSettings({ ...DEFAULT_OCR_SETTINGS })
          void setPrefs({ ocrLanguage: BUNDLED_LANGUAGE })
        }}
      >
        Restore defaults
      </Button>
    </div>
  )
}
