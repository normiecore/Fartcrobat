// The release check's one request, through Electron's network stack so system proxy settings
// apply. It sends no cookies and nothing about the person (docs/features/updates.md, U4).
import { net } from 'electron'
import type { RedirectProbe } from './release'

/** Requests `url` and reports the first answer (a redirect is not followed). */
export const electronProbe: RedirectProbe = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false
    const request = net.request({
      url,
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store'
    })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      // Nothing else is needed: neither the redirect's target nor a body.
      try {
        request.abort()
      } catch {}
    }
    const timer = setTimeout(() => finish(() => reject(new Error('The request timed out'))), timeoutMs)
    request.on('redirect', (status, _method, redirectUrl) =>
      finish(() => resolve({ status, location: redirectUrl }))
    )
    request.on('response', (response) => {
      finish(() => resolve({ status: response.statusCode, location: null }))
      response.on('error', () => {})
    })
    request.on('error', (err) => finish(() => reject(err)))
    request.on('abort', () => finish(() => reject(new Error('The request was cancelled'))))
    request.end()
  })
