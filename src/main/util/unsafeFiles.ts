import type { Stats } from 'node:fs'

/**
 * File types that run code (or install software) when "opened" with the system's default
 * handler. Based on Acrobat's default attachment blocklist plus the macOS and Linux equivalents.
 * PDFs never get these opened from an attachment or a link: the user can still save a copy.
 */
export const UNSAFE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables, installers, shortcuts and scripts
  'exe', 'com', 'bat', 'cmd', 'pif', 'scr', 'cpl', 'dll', 'ocx', 'sys', 'drv', 'msi', 'msp', 'mst', 'msc',
  'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'appx', 'appxbundle', 'msix', 'msixbundle',
  'appref-ms', 'application', 'gadget', 'diagcab', 'cab', 'lnk', 'url', 'website', 'scf', 'shb', 'shs',
  'inf', 'ins', 'isp', 'job', 'reg', 'hta', 'chm', 'hlp', 'js', 'jse', 'vb', 'vbe', 'vbs', 'vbscript',
  'wsf', 'wsc', 'wsh', 'ws', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1', 'psm1', 'sct',
  'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms', 'xbap', 'xll', 'xnk', 'jnlp',
  'jar', 'class', 'mde', 'mdb', 'ade', 'adp', 'accda', 'accde', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar',
  'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mdt', 'mdw', 'mdz', 'ops', 'pcd', 'prf', 'prg', 'pst', 'crt',
  'cer', 'der', 'its', 'vsmacros', 'vsw', 'vss', 'vst', 'img', 'iso', 'vhd', 'vhdx', 'udf',
  // Office documents with macros
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
  // macOS applications, installers, scripts and launchers
  'app', 'command', 'tool', 'pkg', 'mpkg', 'dmg', 'scpt', 'scptd', 'applescript', 'workflow', 'action',
  'terminal', 'prefpane', 'kext', 'plugin', 'bundle', 'framework', 'saver', 'qlgenerator', 'mdimporter',
  'webloc', 'inetloc', 'fileloc', 'osax', 'definition', 'configprofile', 'mobileconfig',
  // Linux and cross-platform launchers, packages and scripts
  'desktop', 'sh', 'bash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish', 'run', 'elf', 'so', 'ko',
  'appimage', 'flatpak', 'flatpakref', 'snap', 'deb', 'rpm', 'apk', 'py', 'pyw', 'pyc', 'pyz', 'pl', 'pm',
  'rb', 'php', 'lua', 'tcl', 'awk', 'cgi', 'fcgi'
])

/** The extensions of a file name, lowercased, e.g. "report.pdf.exe" gives ["pdf", "exe"]. */
function extensionsOf(name: string): string[] {
  const parts = name.toLowerCase().replace(/[.\s]+$/, '').split('.')
  return parts.length > 1 ? parts.slice(1) : []
}

/**
 * Why opening `path` with the system's default app is refused, or null when it is fine.
 * `stats` is the result of stat() on the path (null when it does not exist).
 */
export function unsafeToOpenReason(path: string, stats: Pick<Stats, 'isFile' | 'isDirectory' | 'mode'> | null, platform: string = process.platform): string | null {
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
  const exts = extensionsOf(name)
  const last = exts[exts.length - 1]
  if (last && UNSAFE_EXTENSIONS.has(last)) {
    return `For your safety, Fartcrobat does not open “${name}”: files of this type can run programs on your computer.`
  }
  // Alternate data streams and similar tricks ("file.pdf:evil.exe", trailing dots) on Windows.
  if (platform === 'win32' && /:[^\\/]*$/.test(path.slice(2))) {
    return `For your safety, Fartcrobat does not open “${name}”.`
  }
  // Without an extension the desktop picks a handler from the content, and may run a program.
  if (stats && stats.isFile() && platform !== 'win32' && !exts.length && (stats.mode & 0o111) !== 0) {
    return `For your safety, Fartcrobat does not open “${name}”: it is a program (marked as executable).`
  }
  return null
}
