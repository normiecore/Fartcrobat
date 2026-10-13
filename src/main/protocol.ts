import { net, protocol } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RENDERER_CSP } from './util/csp'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://fartcrobat`

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

/**
 * Serves the built renderer from out/renderer over app://fartcrobat/... Every response carries the
 * app's Content-Security-Policy, so it also applies to Web Workers (the PDF engine), which do not
 * inherit the page's <meta> policy.
 */
export function serveRenderer() {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    let path = decodeURIComponent(url.pathname)
    if (path === '/' || path === '') path = '/index.html'
    const file = normalize(join(root, path))
    if (!file.startsWith(root + sep) && file !== root) {
      return new Response('Forbidden', { status: 403, headers: { 'Content-Security-Policy': RENDERER_CSP } })
    }
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', RENDERER_CSP)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })
}
