// Windows system programs, for the main process and the MCP shim.

type Env = Record<string, string | undefined>

/**
 * The full path of a program in %SystemRoot%\System32. Windows looks for a program started by
 * name in the current folder first, so system tools are always started by full path.
 */
export function system32Exe(name: string, env: Env): string {
  const root = (env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows').replace(/[\\/]+$/, '')
  return `${root}\\System32\\${name}`
}

/** %SystemRoot%\System32\reg.exe */
export function regExe(env: Env): string {
  return system32Exe('reg.exe', env)
}
