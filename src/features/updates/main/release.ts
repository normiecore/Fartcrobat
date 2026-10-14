// Finding out about a new release (docs/features/updates.md, U1): github.com/<owner>/<repo>/releases/latest
// answers with a redirect to the newest release's page, .../releases/tag/v0.2.0. One request, no
// API token and no api.github.com rate limit. No Electron here (./net.ts makes the request).
import { gt, parse } from 'semver'
import { UPDATE_REPO, type AvailableUpdate } from '@shared/updates'

/** Where releases live. Unpackaged test builds may replace it (FARTCROBAT_UPDATE_URL, see ./settings.ts). */
export const RELEASES_BASE = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`

/** How long a check may take before it counts as failed. */
export const CHECK_TIMEOUT_MS = 20_000

export const CHECK_OFFLINE = "Couldn't check for updates. Check your internet connection and try again."
export const CHECK_UNEXPECTED =
  "Couldn't check for updates. GitHub sent an answer Fartcrobat doesn't understand. Try again later."

/** A failed check; the message is what the person sees. */
export class ReleaseCheckError extends Error {}

/** What the request for `<base>/releases/latest` got back, without following a redirect. */
export interface ProbeResult {
  status: number
  /** The redirect's target (Location), for 3xx answers. */
  location: string | null
}

/** Requests `url` without following redirects. Rejects when the request fails or takes longer than `timeoutMs`. */
export type RedirectProbe = (url: string, timeoutMs: number) => Promise<ProbeResult>

/** `base` without a trailing slash. */
export const trimBase = (base: string) => base.replace(/\/+$/, '')

/**
 * The release a redirect points at: a Location (absolute, or relative to `requestUrl`) whose path
 * ends in /releases/tag/v<version> and that stays under `base`. Null for anything else, such as
 * the releases list GitHub redirects to when a repository has no release yet.
 */
export function parseReleaseLocation(
  location: string,
  requestUrl: string,
  base: string
): AvailableUpdate | null {
  let url: URL
  let root: URL
  try {
    url = new URL(location, requestUrl)
    root = new URL(trimBase(base))
  } catch {
    return null
  }
  // GitHub treats owner and repository names case-insensitively.
  const prefix = `${root.pathname.replace(/\/+$/, '')}/`.toLowerCase()
  if (url.origin !== root.origin || !url.pathname.toLowerCase().startsWith(prefix)) return null
  const tag = /\/releases\/tag\/v([^/]+)$/.exec(url.pathname)
  if (!tag) return null
  let raw: string
  try {
    raw = decodeURIComponent(tag[1])
  } catch {
    return null
  }
  const version = parse(raw)
  if (!version) return null
  url.search = ''
  url.hash = ''
  return { version: version.version, releaseUrl: url.href }
}

/** Whether `latest` is a stable release newer than `current`. Pre-releases never count. */
export function isNewerRelease(latest: string, current: string): boolean {
  const l = parse(latest)
  const c = parse(current)
  if (!l || !c || l.prerelease.length) return false
  return gt(l, c)
}

/**
 * Asks GitHub which release is the latest. Rejects with a ReleaseCheckError (plain-language
 * message) when it cannot tell: no connection, a timeout, or an answer that is not a redirect to a
 * release (2xx, 4xx, 5xx, or a redirect somewhere else).
 */
export async function latestRelease(
  base: string,
  probe: RedirectProbe,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<AvailableUpdate> {
  const requestUrl = `${trimBase(base)}/releases/latest`
  let res: ProbeResult
  try {
    res = await probe(requestUrl, timeoutMs)
  } catch (err) {
    throw new ReleaseCheckError(CHECK_OFFLINE, { cause: err })
  }
  if (res.status >= 300 && res.status < 400 && res.location) {
    const update = parseReleaseLocation(res.location, requestUrl, base)
    if (update) return update
  }
  throw new ReleaseCheckError(CHECK_UNEXPECTED)
}

/**
 * Whether the app may open `url` as a release page: only pages of the Fartcrobat repository on
 * github.com, or under the test base of an unpackaged build.
 */
export function releasePageAllowed(url: string, testBase: string | null = null): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const under = (base: string) => {
    let root: URL
    try {
      root = new URL(trimBase(base))
    } catch {
      return false
    }
    const prefix = `${root.pathname.replace(/\/+$/, '')}/`.toLowerCase()
    return (
      target.origin === root.origin &&
      target.pathname.toLowerCase().startsWith(prefix) &&
      !target.username &&
      !target.password
    )
  }
  if (target.protocol === 'https:' && under(RELEASES_BASE)) return true
  return !!testBase && /^https?:$/.test(target.protocol) && under(testBase)
}
