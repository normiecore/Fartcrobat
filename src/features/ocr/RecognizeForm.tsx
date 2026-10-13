/** The Recognize Text options, shared by the Scan & OCR panel and the Recognize Text dialog. */
import { useEffect, useId, useMemo, useState } from 'react'
import { Checkbox, Field, Select, setPrefs, TextInput, useDocState, usePrefs, type DocumentModel } from '@renderer/sdk'
import { BUNDLED_LANGUAGE, DPI_CHOICES } from './constants'
import { parsePageRange } from './pageRange'
import { addLanguage, availableLanguages, isAvailable, languageName, refreshLanguages, useLanguages } from './languages'
import type { RecognizeRequest } from './run'
import { loadOcrSettings, setOcrSettings, useOcrSettings } from './settings'

const P = 'fc-ocr'

export type PageScope = 'all' | 'current' | 'range'

const DPI_LABELS: Record<number, string> = {
  150: '150 dpi (fast)',
  200: '200 dpi',
  300: '300 dpi (recommended)',
  400: '400 dpi',
  600: '600 dpi (small print)'
}

export interface RecognizeFormState {
  scope: PageScope
  setScope: (s: PageScope) => void
  range: string
  setRange: (s: string) => void
  /** What is wrong with the page range (when "Pages" is chosen). */
  rangeError: string | null
  /** The request, or a message saying what is wrong with the options. */
  request: RecognizeRequest | string
}

export function useRecognizeForm(doc: DocumentModel, initialScope: PageScope = 'all'): RecognizeFormState {
  const prefs = usePrefs()
  const settings = useOcrSettings()
  const installed = useLanguages((s) => s.installed)
  const languagesLoaded = useLanguages((s) => s.loaded)
  const pageCount = useDocState(doc, (s) => s.info.pageCount)
  const currentPage = useDocState(doc, (s) => s.currentPage)
  const [scope, setScope] = useState<PageScope>(initialScope)
  const [range, setRange] = useState(() => `1-${pageCount}`)

  useEffect(() => {
    void loadOcrSettings()
    if (!useLanguages.getState().loaded) void refreshLanguages()
  }, [])

  const parsed = useMemo(() => (scope === 'range' ? parsePageRange(range, pageCount) : null), [scope, range, pageCount])
  const rangeError = typeof parsed === 'string' ? parsed : null

  const request = useMemo<RecognizeRequest | string>(() => {
    let pages: number[]
    if (scope === 'all') pages = [...Array(pageCount).keys()]
    else if (scope === 'current') pages = [Math.min(currentPage, pageCount - 1)]
    else if (typeof parsed === 'string' || !parsed) return parsed ?? 'Enter the pages to recognize'
    else pages = parsed
    if (!languagesLoaded) return 'Loading the installed languages…'
    const language = isAvailable(prefs.ocrLanguage, installed) ? prefs.ocrLanguage : BUNDLED_LANGUAGE
    return { pages, language, dpi: settings.dpi, skipPagesWithText: settings.skipPagesWithText }
  }, [scope, parsed, pageCount, currentPage, prefs.ocrLanguage, installed, languagesLoaded, settings.dpi, settings.skipPagesWithText])

  return { scope, setScope, range, setRange, rangeError, request }
}

/** Language picker with "Add language…". */
export function LanguageSelect({ id }: { id?: string }) {
  const prefs = usePrefs()
  const installed = useLanguages((s) => s.installed)
  const loaded = useLanguages((s) => s.loaded)
  const codes = availableLanguages(installed)
  const current = codes.includes(prefs.ocrLanguage) ? prefs.ocrLanguage : BUNDLED_LANGUAGE
  const missing = loaded && prefs.ocrLanguage !== current
  return (
    <>
      <Select<string>
        id={id}
        value={current}
        aria-label="Document language"
        onChange={(v) => {
          if (v === '__add__') {
            void addLanguage().then((code) => code && void setPrefs({ ocrLanguage: code }))
            return
          }
          void setPrefs({ ocrLanguage: v })
        }}
        options={[...codes.map((c) => ({ value: c, label: languageName(c) })), { value: '__add__', label: 'Add language…' }]}
      />
      {missing && (
        <span className={`${P}-hint is-warning`}>
          {languageName(prefs.ocrLanguage)} is no longer installed; {languageName(current)} is used.
        </span>
      )}
    </>
  )
}

export function DpiSelect({ id }: { id?: string }) {
  const dpi = useOcrSettings((s) => s.dpi)
  return (
    <Select<string>
      id={id}
      value={String(dpi)}
      aria-label="Resolution"
      onChange={(v) => void setOcrSettings({ dpi: parseInt(v, 10) })}
      options={DPI_CHOICES.map((d) => ({ value: String(d), label: DPI_LABELS[d] ?? `${d} dpi` }))}
    />
  )
}

export function RecognizeFields({ doc, form }: { doc: DocumentModel; form: RecognizeFormState }) {
  const name = useId()
  const skip = useOcrSettings((s) => s.skipPagesWithText)
  const pageCount = useDocState(doc, (s) => s.info.pageCount)
  const currentPage = useDocState(doc, (s) => s.currentPage)
  const rangeError = form.rangeError
  return (
    <div className={`${P}-fields`}>
      <fieldset className={`${P}-fieldset`}>
        <legend className="ui-field-label">Pages</legend>
        <label className="ui-check">
          <input type="radio" name={name} checked={form.scope === 'all'} onChange={() => form.setScope('all')} />
          <span>{pageCount === 1 ? 'The page' : `All ${pageCount} pages`}</span>
        </label>
        {pageCount > 1 && (
          <label className="ui-check">
            <input type="radio" name={name} checked={form.scope === 'current'} onChange={() => form.setScope('current')} />
            <span>Current page ({currentPage + 1})</span>
          </label>
        )}
        {pageCount > 1 && (
          <div className={`${P}-range-row`}>
            <label className="ui-check">
              <input type="radio" name={name} checked={form.scope === 'range'} onChange={() => form.setScope('range')} />
              <span>Pages</span>
            </label>
            <TextInput
              className={`${P}-range-input`}
              aria-label="Page range"
              value={form.range}
              placeholder="e.g. 1-3, 5"
              onFocus={() => form.setScope('range')}
              onChange={(e) => {
                form.setRange(e.target.value)
                form.setScope('range')
              }}
            />
          </div>
        )}
        {rangeError && <span className="ui-field-error">{rangeError}</span>}
      </fieldset>
      <Field label="Document language" hint="English is included. For another language, choose “Add language…” and pick its language file.">
        <LanguageSelect />
      </Field>
      <Field label="Resolution" hint="Higher resolutions read small print better but take longer.">
        <DpiSelect />
      </Field>
      <div className="ui-field">
        <span className="ui-field-label">Output</span>
        <span className={`${P}-output`}>
          <b>Searchable image</b> — the pages look exactly the same; an invisible text layer makes them searchable and
          selectable.
        </span>
      </div>
      <Checkbox
        checked={skip}
        onChange={(v) => void setOcrSettings({ skipPagesWithText: v })}
        label="Skip pages that already have text"
      />
    </div>
  )
}
