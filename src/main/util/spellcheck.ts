/**
 * Keeps Chromium's spell checker from going online. On Windows and Linux it uses Hunspell
 * dictionaries that it downloads from Google (redirector.gvt1.com) for every language on a
 * session's list, as soon as the session starts and whether or not checking is turned on:
 * setSpellCheckerEnabled(false) does not stop the download, an empty language list does.
 * Fartcrobat makes no network request of its own besides the update check, so every session
 * starts with no spell-check languages there (main/index.ts, on 'session-created'). macOS uses the
 * system's checker, which downloads nothing, and keeps it. Kept free of Electron so it can be unit
 * tested.
 */

/** The part of an Electron session this needs. */
export interface SpellCheckSession {
  setSpellCheckerLanguages(languages: string[]): void
}

export function keepSpellCheckOffline(session: SpellCheckSession, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') session.setSpellCheckerLanguages([])
}

/** Whether windows get the spell checker: only where it works without downloading (macOS). */
export const spellCheckInWindows = (platform: NodeJS.Platform = process.platform): boolean => platform === 'darwin'
