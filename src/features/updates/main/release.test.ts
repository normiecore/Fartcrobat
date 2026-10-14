// Updates: reading the release GitHub's /releases/latest redirects to, comparing versions, and
// which pages the app may open.
import { describe, expect, it } from 'vitest'
import {
  CHECK_OFFLINE,
  CHECK_UNEXPECTED,
  RELEASES_BASE,
  ReleaseCheckError,
  isNewerRelease,
  latestRelease,
  parseReleaseLocation,
  releasePageAllowed,
  type RedirectProbe
} from './release'
import {
  DOWNLOAD_DAMAGED,
  DOWNLOAD_FAILED,
  DOWNLOAD_NO_SPACE,
  DOWNLOAD_OFFLINE,
  UpdateMismatchError,
  downloadErrorMessage,
  mismatchMessage
} from './updater'

const LATEST = `${RELEASES_BASE}/releases/latest`

describe('release tags', () => {
  it('reads the version from an absolute or relative Location', () => {
    expect(parseReleaseLocation(`${RELEASES_BASE}/releases/tag/v0.2.0`, LATEST, RELEASES_BASE)).toEqual({
      version: '0.2.0',
      releaseUrl: 'https://github.com/normiecore/Fartcrobat/releases/tag/v0.2.0'
    })
    expect(
      parseReleaseLocation('/normiecore/Fartcrobat/releases/tag/v1.10.3', LATEST, RELEASES_BASE)
    ).toEqual({
      version: '1.10.3',
      releaseUrl: 'https://github.com/normiecore/Fartcrobat/releases/tag/v1.10.3'
    })
    // Relative to the request (…/releases/latest).
    expect(parseReleaseLocation('tag/v0.3.0', LATEST, RELEASES_BASE)?.releaseUrl).toBe(
      `${RELEASES_BASE}/releases/tag/v0.3.0`
    )
    // GitHub's names are case-insensitive; query and fragment are dropped.
    expect(
      parseReleaseLocation(
        'https://github.com/NormieCore/fartcrobat/releases/tag/v0.2.0?x=1#y',
        LATEST,
        RELEASES_BASE
      )
    ).toEqual({
      version: '0.2.0',
      releaseUrl: 'https://github.com/NormieCore/fartcrobat/releases/tag/v0.2.0'
    })
    // A test server.
    const base = 'http://127.0.0.1:4567/normiecore/Fartcrobat'
    expect(
      parseReleaseLocation('/normiecore/Fartcrobat/releases/tag/v9.0.0', `${base}/releases/latest`, base)
        ?.releaseUrl
    ).toBe('http://127.0.0.1:4567/normiecore/Fartcrobat/releases/tag/v9.0.0')
  })

  it('refuses anything that is not a release of this repository', () => {
    const parse = (location: string) => parseReleaseLocation(location, LATEST, RELEASES_BASE)
    // No release yet: GitHub redirects to the releases list.
    expect(parse(`${RELEASES_BASE}/releases`)).toBeNull()
    expect(parse(`${RELEASES_BASE}/releases/tag/0.2.0`)).toBeNull() // no v
    expect(parse(`${RELEASES_BASE}/releases/tag/vnext`)).toBeNull()
    expect(parse(`${RELEASES_BASE}/releases/tag/v0.2`)).toBeNull()
    expect(parse(`${RELEASES_BASE}/releases/tag/v0.2.0/extra`)).toBeNull()
    expect(parse(`${RELEASES_BASE}/releases/tag/v%E0%A4%A`)).toBeNull()
    expect(parse('https://github.com/someone/else/releases/tag/v9.9.9')).toBeNull()
    expect(parse('https://github.com/normiecore/Fartcrobat-fork/releases/tag/v9.9.9')).toBeNull()
    expect(parse('https://evil.example/normiecore/Fartcrobat/releases/tag/v9.9.9')).toBeNull()
    expect(parse('http://github.com/normiecore/Fartcrobat/releases/tag/v9.9.9')).toBeNull()
  })

  it('keeps pre-release tags readable but never offers them', () => {
    expect(
      parseReleaseLocation(`${RELEASES_BASE}/releases/tag/v0.3.0-beta.1`, LATEST, RELEASES_BASE)?.version
    ).toBe('0.3.0-beta.1')
    expect(isNewerRelease('0.3.0-beta.1', '0.2.0')).toBe(false)
  })

  it('compares versions as semver', () => {
    expect(isNewerRelease('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerRelease('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerRelease('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerRelease('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerRelease('0.1.0', '0.2.0')).toBe(false)
    // A pre-release build of the app moves on to the release.
    expect(isNewerRelease('0.2.0', '0.2.0-beta.2')).toBe(true)
    expect(isNewerRelease('not a version', '0.1.0')).toBe(false)
  })
})

describe('latestRelease', () => {
  const probe =
    (result: { status: number; location: string | null } | Error): RedirectProbe =>
    async (url, timeoutMs) => {
      expect(url).toBe(LATEST)
      expect(timeoutMs).toBe(20_000)
      if (result instanceof Error) throw result
      return result
    }

  it('follows nothing: the redirect says which release is the latest', async () => {
    await expect(
      latestRelease(RELEASES_BASE, probe({ status: 302, location: `${RELEASES_BASE}/releases/tag/v0.2.0` }))
    ).resolves.toEqual({
      version: '0.2.0',
      releaseUrl: `${RELEASES_BASE}/releases/tag/v0.2.0`
    })
    // A trailing slash on the base changes nothing.
    await expect(
      latestRelease(
        `${RELEASES_BASE}/`,
        probe({ status: 301, location: '/normiecore/Fartcrobat/releases/tag/v0.2.1' })
      )
    ).resolves.toMatchObject({
      version: '0.2.1'
    })
  })

  it('fails with a plain message on errors and unexpected answers', async () => {
    const failure = async (p: RedirectProbe) => {
      const err = await latestRelease(RELEASES_BASE, p).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ReleaseCheckError)
      return (err as Error).message
    }
    expect(await failure(probe(new Error('net::ERR_INTERNET_DISCONNECTED')))).toBe(CHECK_OFFLINE)
    expect(await failure(probe({ status: 200, location: null }))).toBe(CHECK_UNEXPECTED)
    expect(await failure(probe({ status: 404, location: null }))).toBe(CHECK_UNEXPECTED)
    expect(await failure(probe({ status: 503, location: null }))).toBe(CHECK_UNEXPECTED)
    expect(await failure(probe({ status: 302, location: null }))).toBe(CHECK_UNEXPECTED)
    expect(await failure(probe({ status: 302, location: `${RELEASES_BASE}/releases` }))).toBe(
      CHECK_UNEXPECTED
    )
    expect(await failure(probe({ status: 302, location: 'https://example.com/releases/tag/v1.0.0' }))).toBe(
      CHECK_UNEXPECTED
    )
  })
})

describe('release pages', () => {
  it('opens only pages of the Fartcrobat repository on github.com, or the test base', () => {
    expect(releasePageAllowed(`${RELEASES_BASE}/releases/tag/v0.2.0`)).toBe(true)
    expect(releasePageAllowed(`${RELEASES_BASE}/releases`)).toBe(true)
    expect(releasePageAllowed('https://github.com/normiecore/fartcrobat/releases')).toBe(true)
    expect(releasePageAllowed(RELEASES_BASE)).toBe(false)
    expect(releasePageAllowed('http://github.com/normiecore/Fartcrobat/releases')).toBe(false)
    expect(releasePageAllowed('https://github.com/normiecore/Fartcrobat-evil/releases')).toBe(false)
    expect(releasePageAllowed('https://github.com.evil.example/normiecore/Fartcrobat/releases')).toBe(false)
    expect(releasePageAllowed('https://user@github.com/normiecore/Fartcrobat/releases')).toBe(false)
    expect(releasePageAllowed('file:///etc/passwd')).toBe(false)
    expect(releasePageAllowed('not a url')).toBe(false)
    const test = 'http://127.0.0.1:4567/normiecore/Fartcrobat'
    expect(releasePageAllowed(`${test}/releases/tag/v0.2.0`)).toBe(false)
    expect(releasePageAllowed(`${test}/releases/tag/v0.2.0`, test)).toBe(true)
    expect(releasePageAllowed('http://127.0.0.1:4567/other/releases', test)).toBe(false)
  })
})

describe('download errors', () => {
  it('says what went wrong in plain language', () => {
    expect(downloadErrorMessage(new Error('net::ERR_CONNECTION_RESET'))).toBe(DOWNLOAD_OFFLINE)
    expect(
      downloadErrorMessage(
        Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
      )
    ).toBe(DOWNLOAD_OFFLINE)
    expect(downloadErrorMessage(new Error('sha512 checksum mismatch, expected abc, got def'))).toBe(
      DOWNLOAD_DAMAGED
    )
    expect(downloadErrorMessage(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(
      DOWNLOAD_NO_SPACE
    )
    expect(downloadErrorMessage(new Error('Cannot find latest.yml in the latest release artifacts'))).toBe(
      DOWNLOAD_FAILED
    )
    expect(downloadErrorMessage('something')).toBe(DOWNLOAD_FAILED)
    expect(downloadErrorMessage(new UpdateMismatchError(mismatchMessage('0.2.0')))).toBe(
      "Fartcrobat 0.2.0 can't be installed from inside the app. Download it from GitHub instead."
    )
  })
})
