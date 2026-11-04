// Paths that name another computer. Touching one (even to check that it exists) makes Windows
// connect to that computer over SMB or WebDAV and sign in as the person, so a path that came
// from a document is never looked at before the person agrees to open it.

/**
 * True for a path that reaches another computer or a Windows device namespace:
 * `\\host\share`, `//host/share`, `\\?\UNC\host\share`, `\\.\…` (on Windows), and
 * `file://host/…` URLs on every platform. Mapped drive letters count as local.
 */
export function isRemotePath(path: string, platform: string): boolean {
  const url = /^\s*file:([\\/]*)(.*)$/i.exec(path)
  if (url) {
    const [, slashes, rest] = url
    // file:/x and file:///x are local; file://host/x and file:////host/x are not.
    if (slashes.length === 2) return rest !== '' && !/^localhost(?:[\\/]|$)/i.test(rest)
    return slashes.length >= 4
  }
  return platform === 'win32' && /^\s*[\\/]{2}/.test(path)
}
