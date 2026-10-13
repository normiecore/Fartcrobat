/**
 * OCR languages: English is bundled; any other Tesseract language works once the user adds its
 * <code>.traineddata(.gz) file (copied into <userData>/tessdata).
 */
import { create } from 'zustand'
import { basename, invoke, joinPath, readFile, showError, toast, writeFile } from '@renderer/sdk'
import { BUNDLED_LANGUAGE } from './constants'
import type { InstalledLanguage } from './ipc'

/** Names of Tesseract language codes (ISO 639-2 with Tesseract's script suffixes). */
export const LANGUAGE_NAMES: Record<string, string> = {
  afr: 'Afrikaans',
  amh: 'Amharic',
  ara: 'Arabic',
  aze: 'Azerbaijani',
  bel: 'Belarusian',
  ben: 'Bengali',
  bos: 'Bosnian',
  bul: 'Bulgarian',
  cat: 'Catalan',
  ces: 'Czech',
  chi_sim: 'Chinese (Simplified)',
  chi_sim_vert: 'Chinese (Simplified, vertical)',
  chi_tra: 'Chinese (Traditional)',
  chi_tra_vert: 'Chinese (Traditional, vertical)',
  cym: 'Welsh',
  dan: 'Danish',
  deu: 'German',
  ell: 'Greek',
  eng: 'English',
  enm: 'English (Middle)',
  epo: 'Esperanto',
  est: 'Estonian',
  eus: 'Basque',
  fas: 'Persian',
  fil: 'Filipino',
  fin: 'Finnish',
  fra: 'French',
  frk: 'German (Fraktur)',
  gle: 'Irish',
  glg: 'Galician',
  guj: 'Gujarati',
  heb: 'Hebrew',
  hin: 'Hindi',
  hrv: 'Croatian',
  hun: 'Hungarian',
  hye: 'Armenian',
  ind: 'Indonesian',
  isl: 'Icelandic',
  ita: 'Italian',
  jpn: 'Japanese',
  jpn_vert: 'Japanese (vertical)',
  kan: 'Kannada',
  kat: 'Georgian',
  kaz: 'Kazakh',
  khm: 'Khmer',
  kor: 'Korean',
  kor_vert: 'Korean (vertical)',
  lao: 'Lao',
  lat: 'Latin',
  lav: 'Latvian',
  lit: 'Lithuanian',
  mal: 'Malayalam',
  mar: 'Marathi',
  mkd: 'Macedonian',
  mlt: 'Maltese',
  msa: 'Malay',
  mya: 'Burmese',
  nep: 'Nepali',
  nld: 'Dutch',
  nor: 'Norwegian',
  pan: 'Punjabi',
  pol: 'Polish',
  por: 'Portuguese',
  ron: 'Romanian',
  rus: 'Russian',
  sin: 'Sinhala',
  slk: 'Slovak',
  slv: 'Slovenian',
  spa: 'Spanish',
  sqi: 'Albanian',
  srp: 'Serbian (Cyrillic)',
  srp_latn: 'Serbian (Latin)',
  swa: 'Swahili',
  swe: 'Swedish',
  tam: 'Tamil',
  tel: 'Telugu',
  tha: 'Thai',
  tur: 'Turkish',
  uig: 'Uyghur',
  ukr: 'Ukrainian',
  urd: 'Urdu',
  uzb: 'Uzbek',
  vie: 'Vietnamese',
  yid: 'Yiddish'
}

export function languageName(code: string): string {
  return code
    .split('+')
    .map((c) => LANGUAGE_NAMES[c] ?? c)
    .join(' + ')
}

/** <code>.traineddata or <code>.traineddata.gz */
export const LANGUAGE_FILE = /^([a-z]{3}(?:_[a-z0-9]+)*)\.traineddata(\.gz)?$/i

interface LanguageState {
  installed: InstalledLanguage[]
  loaded: boolean
}

export const useLanguages = create<LanguageState>(() => ({ installed: [], loaded: false }))

export async function refreshLanguages(): Promise<InstalledLanguage[]> {
  try {
    const installed = await invoke('feature:ocr:languages')
    useLanguages.setState({ installed, loaded: true })
    return installed
  } catch (err) {
    useLanguages.setState({ loaded: true })
    showError(err, 'Could not list the OCR languages')
    return []
  }
}

/** Codes that can be recognized right now: English plus every added language. */
export function availableLanguages(installed: InstalledLanguage[]): string[] {
  const codes = new Set([BUNDLED_LANGUAGE, ...installed.map((l) => l.code)])
  return [...codes].sort((a, b) =>
    a === BUNDLED_LANGUAGE ? -1 : b === BUNDLED_LANGUAGE ? 1 : languageName(a).localeCompare(languageName(b))
  )
}

/** True when every part of a language string ("eng+fra") can be used. */
export function isAvailable(language: string, installed: InstalledLanguage[]): boolean {
  const have = new Set(availableLanguages(installed))
  return language.split('+').every((c) => have.has(c))
}

function looksLikeLanguageData(bytes: Uint8Array, gz: boolean): boolean {
  if (gz) return bytes.length > 100 && bytes[0] === 0x1f && bytes[1] === 0x8b
  // A traineddata file starts with the number of its components (a small little-endian integer).
  if (bytes.length < 1024) return false
  const n = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  return n > 0 && n < 64
}

/**
 * Asks for a Tesseract language file and copies it into <userData>/tessdata. Returns the code of
 * the added language, or null when cancelled or the file was not usable.
 */
export async function addLanguage(): Promise<string | null> {
  const paths = await invoke('file:openDialog', {
    title: 'Add OCR language',
    filters: [
      { name: 'Tesseract language data', extensions: ['traineddata', 'gz'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  const path = paths[0]
  if (!path) return null
  const name = basename(path)
  const m = LANGUAGE_FILE.exec(name)
  if (!m) {
    toast(
      `“${name}” is not a Tesseract language file. Choose a file named like fra.traineddata or deu.traineddata.gz (from the tessdata, tessdata_fast or tessdata_best collections).`,
      { kind: 'error', timeout: 10000 }
    )
    return null
  }
  const code = m[1].toLowerCase()
  try {
    const bytes = await readFile(path)
    if (!looksLikeLanguageData(bytes, !!m[2])) {
      toast(`“${name}” does not contain Tesseract language data.`, { kind: 'error', timeout: 8000 })
      return null
    }
    const dir = await invoke('feature:ocr:languageDir')
    await invoke('feature:ocr:removeLanguage', code)
    await writeFile(joinPath(dir, `${code}.traineddata${m[2] ? '.gz' : ''}`), bytes)
    await refreshLanguages()
    toast(`${languageName(code)} can now be used for text recognition.`, { kind: 'success' })
    return code
  } catch (err) {
    showError(err, `Could not add ${name}`)
    return null
  }
}

export async function removeLanguage(code: string) {
  try {
    const installed = await invoke('feature:ocr:removeLanguage', code)
    useLanguages.setState({ installed, loaded: true })
  } catch (err) {
    showError(err, `Could not remove ${languageName(code)}`)
  }
}
