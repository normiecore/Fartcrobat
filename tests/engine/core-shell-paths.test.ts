import { describe, expect, it } from 'vitest'
import { normalizePath, pathKey } from '@shared/paths'

describe('normalizePath', () => {
  it('removes . and .. segments and repeated separators from POSIX paths', () => {
    expect(normalizePath('/home/me/./docs/text.pdf')).toBe('/home/me/docs/text.pdf')
    expect(normalizePath('/home/me/tmp/../docs//text.pdf')).toBe('/home/me/docs/text.pdf')
    expect(normalizePath('/../text.pdf')).toBe('/text.pdf')
    expect(normalizePath('docs/../a/./b.pdf')).toBe('a/b.pdf')
    expect(normalizePath('../b.pdf')).toBe('../b.pdf')
  })

  it('keeps backslashes in POSIX file names', () => {
    expect(normalizePath('/home/me/a\\b.pdf')).toBe('/home/me/a\\b.pdf')
  })

  it('handles Windows drive and network paths', () => {
    expect(normalizePath('C:\\Users\\me\\.\\Docs\\..\\text.pdf')).toBe('C:\\Users\\me\\text.pdf')
    expect(normalizePath('C:/Users/me/text.pdf')).toBe('C:\\Users\\me\\text.pdf')
    expect(normalizePath('C:\\..\\text.pdf')).toBe('C:\\text.pdf')
    expect(normalizePath('\\\\server\\share\\.\\text.pdf')).toBe('\\\\server\\share\\text.pdf')
  })

  it('compares file names without case on Windows and macOS only', () => {
    expect(pathKey('C:\\Docs\\Text.PDF', 'win32')).toBe(pathKey('c:/docs/./text.pdf', 'win32'))
    expect(pathKey('/Users/me/Text.pdf', 'darwin')).toBe(pathKey('/Users/me/text.pdf', 'darwin'))
    expect(pathKey('/home/me/Text.pdf', 'linux')).not.toBe(pathKey('/home/me/text.pdf', 'linux'))
  })
})
