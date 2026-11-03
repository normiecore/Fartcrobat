// The app's names. PRODUCT_NAME is the one people see; the rest are ids that copies installed
// before a rename, files they saved and administrators' setups depend on.
//
// To rename the app: change PRODUCT_NAME (and productName in package.json and electron-builder.yml).
// Leave everything in LEGACY alone: changing any of it breaks updates from installed copies, files
// people saved, or machine policies already deployed. docs/features/rename.md explains each one.

/** The name people see: windows, menus, installers, the userData folder of new installs. */
export const PRODUCT_NAME = 'Fartcrobat'

/**
 * Ids that keep their first value for good. Nothing a person reads uses them, apart from the
 * GitHub repository name in links.
 */
export const LEGACY = {
  /** The name 0.1 to 0.3 shipped under: their userData folder, policy locations and executables. */
  productName: 'Fartcrobat',
  /** electron-builder appId and Windows AppUserModelId; the NSIS GUID derives from it. */
  appId: 'org.fartcrobat.app',
  /**
   * The NSIS install GUID (UUID v5 of appId), pinned as nsis.guid in electron-builder.yml so an
   * update never installs next to the old copy. The registry key `Software\<guid>` holds the
   * install folder.
   */
  nsisGuid: 'bd977413-7ee9-5f76-80a8-7e980aa59bd1',
  /** The Windows ProgId for .pdf: a user's default-app choice points at it. */
  windowsProgId: 'Fartcrobat.Document',
  /** The .deb package name (deb.packageName): dpkg upgrades in place only under the same name. */
  debPackage: 'fartcrobat',
  /** The desktop entry file name (package.json desktopName): xdg-mime defaults point at it. */
  desktopFile: 'fartcrobat.desktop',
  /** The GitHub repository releases come from: installed copies only follow redirects within it. */
  githubOwner: 'normiecore',
  githubRepo: 'Fartcrobat',
  /**
   * The MCP server's id: the Claude Desktop extension's manifest name (an installed extension is
   * replaced only by one with the same name) and the ChatGPT Desktop config table key.
   */
  mcpServer: 'fartcrobat',
  /** Environment variable that points the app (and the MCP helper) at another userData folder. */
  userDataEnv: 'FARTCROBAT_USER_DATA'
} as const

/** Names a function works with; tests pass a renamed product to try the fallbacks before the rename. */
export interface Names {
  current: string
  legacy: string
}

export const NAMES: Names = { current: PRODUCT_NAME, legacy: LEGACY.productName }

/** `<NAME>_USER_DATA` for a product name. */
export const userDataEnvFor = (name: string): string => `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_USER_DATA`

/** The environment variable for another userData folder under the current name. */
export const USER_DATA_ENV = userDataEnvFor(PRODUCT_NAME)

/** Every product name an install may be found under, current first. */
export const productNames = (names: Names = NAMES): string[] => [...new Set([names.current, names.legacy])]

/** The userData folder named in the environment: the current variable first, then the legacy one. */
export function userDataOverride(env: Record<string, string | undefined>, names: Names = NAMES): string | null {
  return env[userDataEnvFor(names.current)] || env[LEGACY.userDataEnv] || null
}

/**
 * Which userData folder under `appData` to use, by name: an install that already has a folder from
 * before the rename keeps it (settings, recent files, Digital IDs, the agent endpoint and helper
 * copy, and on Windows the safeStorage key all live there); everything else uses the current name.
 * Folders are never moved, so going back to an older version keeps working too.
 */
export function userDataFolderName(exists: (name: string) => boolean, names: Names = NAMES): string {
  if (names.current === names.legacy) return names.current
  return !exists(names.current) && exists(names.legacy) ? names.legacy : names.current
}
