import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { htmlLoadPolicy } from '@features/export-create/main/htmlPolicy'

describe('HTML conversion load policy (POSIX)', () => {
  const policy = htmlLoadPolicy('/home/me/site/page.html', 'posix')

  it('allows the page and files in its folder', () => {
    expect(policy.pageUrl).toBe('file:///home/me/site/page.html')
    expect(policy.allowsNavigation('file:///home/me/site/page.html')).toBe(true)
    expect(policy.allowsNavigation('file:///home/me/site/page.html#part')).toBe(true)
    expect(policy.allowsResource('file:///home/me/site/style.css')).toBe(true)
    expect(policy.allowsResource('file:///home/me/site/img/a%20b.png')).toBe(true)
    expect(policy.allowsResource('data:image/png;base64,AAAA')).toBe(true)
    expect(policy.allowsResource('blob:file:///abc')).toBe(true)
    expect(policy.allowsResource('about:blank')).toBe(true)
  })

  it('refuses files outside the folder', () => {
    expect(policy.allowsResource('file:///home/me/secret.txt')).toBe(false)
    expect(policy.allowsResource('file:///home/me/site/../secret.txt')).toBe(false)
    expect(policy.allowsResource('file:///home/me/site/%2e%2e/secret.txt')).toBe(false)
    expect(policy.allowsResource('file:///home/me/site2/x.png')).toBe(false)
    expect(policy.allowsResource('file:///etc/passwd')).toBe(false)
    expect(policy.allowsResource('file:///home/me/site%2F..%2Fsecret.txt')).toBe(false)
  })

  it('refuses hosts, UNC paths, the network and browser pages', () => {
    expect(policy.allowsResource('file://server/share/x.png')).toBe(false)
    // The URL parser turns file://localhost/ into file:/// (the same local file).
    expect(policy.allowsResource('file://localhost/home/me/site/x.png')).toBe(true)
    expect(policy.allowsResource('file://localhost/etc/passwd')).toBe(false)
    expect(policy.allowsResource('file:////server/share/x.png')).toBe(false)
    expect(policy.allowsResource('https://example.com/x.png')).toBe(false)
    expect(policy.allowsResource('http://127.0.0.1/x')).toBe(false)
    expect(policy.allowsResource('ws://example.com/')).toBe(false)
    expect(policy.allowsResource('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(policy.allowsResource('chrome://gpu')).toBe(false)
    expect(policy.allowsResource('about:srcdoc')).toBe(false)
    expect(policy.allowsResource('not a url')).toBe(false)
  })

  it('refuses navigation to anything but the page', () => {
    expect(policy.allowsNavigation('file:///home/me/site/other.html')).toBe(false)
    expect(policy.allowsNavigation('file:///home/me/secret.html')).toBe(false)
    expect(policy.allowsNavigation('about:blank')).toBe(false)
    expect(policy.allowsNavigation('data:text/html,hi')).toBe(false)
    expect(policy.allowsNavigation('https://example.com/')).toBe(false)
    expect(policy.allowsNavigation('file://server/home/me/site/page.html')).toBe(false)
  })
})

describe('HTML conversion load policy (Windows)', () => {
  const policy = htmlLoadPolicy('C:\\Users\\me\\site\\page.html', 'win32')

  it('allows the page and files in its folder, ignoring case', () => {
    expect(policy.pageUrl).toBe('file:///C:/Users/me/site/page.html')
    expect(policy.allowsNavigation('file:///c:/users/me/site/PAGE.html')).toBe(true)
    expect(policy.allowsResource('file:///C:/Users/me/site/img/a.png')).toBe(true)
    expect(policy.allowsResource('file:///c:/USERS/me/Site/style.css')).toBe(true)
  })

  it('refuses UNC shares, other drives and paths outside the folder', () => {
    expect(policy.allowsResource('file://attacker/share/x.png')).toBe(false)
    expect(policy.allowsResource('file:////attacker/share/x.png')).toBe(false)
    expect(policy.allowsResource('file:///%5C%5Cattacker/share/x.png')).toBe(false)
    expect(policy.allowsResource('file://%3F/UNC/attacker/share/x.png')).toBe(false)
    expect(policy.allowsResource('file:///D:/Users/me/site/x.png')).toBe(false)
    expect(policy.allowsResource('file:///C:/Users/me/secret.txt')).toBe(false)
    expect(policy.allowsResource('file:///C:/Users/me/site/..%5Csecret.txt')).toBe(false)
  })

  it('refuses a page on a network share', () => {
    const unc = htmlLoadPolicy('\\\\server\\share\\page.html', 'win32')
    expect(unc.allowsNavigation(unc.pageUrl)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('HTML conversion load policy with symbolic links', () => {
  it('refuses a link in the folder that points outside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-html-policy-'))
    const site = join(dir, 'site')
    mkdirSync(join(site, 'img'), { recursive: true })
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(site, 'page.html'), '<p>x</p>')
    writeFileSync(join(site, 'img', 'a.png'), 'x')
    writeFileSync(join(dir, 'outside', 'secret.txt'), 'x')
    symlinkSync(join(dir, 'outside'), join(site, 'linked'))
    symlinkSync(join(dir, 'outside', 'secret.txt'), join(site, 'secret-link.txt'))
    const policy = htmlLoadPolicy(join(site, 'page.html'))
    expect(policy.allowsResource(pathToFileURL(join(site, 'img', 'a.png')).toString())).toBe(true)
    expect(policy.allowsResource(pathToFileURL(join(site, 'linked', 'secret.txt')).toString())).toBe(false)
    expect(policy.allowsResource(pathToFileURL(join(site, 'secret-link.txt')).toString())).toBe(false)
  })
})
