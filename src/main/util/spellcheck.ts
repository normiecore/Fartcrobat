/**
 * Keeps Chromium's spell checker from going online. Where it has no system checker to use (Linux)
 * it downloads a Hunspell dictionary from Google (redirector.gvt1.com) for every language on a
 * session's list, as soon as the session starts and whether or not checking is turned on:
 * setSpellCheckerEnabled(false) does not stop the download, an empty language list does.
 * Fartcrobat makes no network request of its own besides the update check, so every session on
 * Linux starts with no spell-check languages (main/index.ts, on 'session-created'). Windows and
 * macOS use the system's checker, which downloads nothing (the update rehearsal saw no request from
 * 0.2.0 on either); on Windows, Chromium would still fetch Hunspell dictionaries for a language
 * the system has none for, so its download address points at this computer. Kept free of Electron
 * so it can be unit tested.
 */

/** The part of an Electron session this needs. */
export interface SpellCheckSession {
  setSpellCheckerLanguages(languages: string[]): void
  setSpellCheckerDictionaryDownloadURL(url: string): void
}

/** A dictionary download address that never leaves the computer (the discard port on loopback). */
export const NO_DICTIONARY_DOWNLOADS = 'http://127.0.0.1:9/'

export function keepSpellCheckOffline(session: SpellCheckSession, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'linux') session.setSpellCheckerLanguages([])
  else if (platform === 'win32') session.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_DOWNLOADS)
}

/** Whether windows get the spell checker: where the system provides one (Windows, macOS). */
export const spellCheckInWindows = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'linux'
