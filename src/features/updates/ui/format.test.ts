import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/updates'
import {
  cardView,
  checkOutcome,
  lastCheckedLabel,
  percentOf,
  progressLabel,
  sizeLabel,
  statusLine
} from './format'

const MB = 1024 * 1024

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    currentVersion: '0.1.0',
    capability: 'install',
    phase: 'idle',
    update: null,
    progress: null,
    error: null,
    errorDuring: null,
    lastChecked: null,
    checksOff: null,
    checksForcedOn: false,
    dismissedVersion: null,
    manual: false,
    ...patch
  }
}

const update = {
  version: '0.2.0',
  releaseUrl: 'https://github.com/normiecore/Fartcrobat/releases/tag/v0.2.0'
}

describe('cardView', () => {
  it('shows a card only for an update the person can act on', () => {
    expect(cardView(null)).toBeNull()
    expect(cardView(status())).toBeNull()
    expect(cardView(status({ phase: 'checking' }))).toBeNull()
    expect(cardView(status({ phase: 'upToDate' }))).toBeNull()
    expect(
      cardView(status({ phase: 'error', errorDuring: 'check', error: 'offline', manual: true }))
    ).toBeNull()
    expect(cardView(status({ phase: 'available', update }))).toBe('available')
    expect(cardView(status({ phase: 'downloading', update }))).toBe('downloading')
    expect(cardView(status({ phase: 'ready', update }))).toBe('ready')
    expect(
      cardView(status({ phase: 'error', errorDuring: 'download', update, error: 'The download stopped.' }))
    ).toBe('downloadError')
  })

  it('hides the card for the version the person closed it for, in every phase', () => {
    for (const phase of ['available', 'downloading', 'ready'] as const)
      expect(cardView(status({ phase, update, dismissedVersion: '0.2.0' }))).toBeNull()
    expect(
      cardView(status({ phase: 'error', errorDuring: 'download', update, dismissedVersion: '0.2.0' }))
    ).toBeNull()
    // A newer version than the one closed shows again.
    expect(cardView(status({ phase: 'available', update, dismissedVersion: '0.1.5' }))).toBe('available')
  })
})

describe('progress', () => {
  it('gives whole percents between 0 and 100', () => {
    expect(percentOf(null)).toBe(0)
    expect(percentOf({ percent: 45.7, transferred: 0, total: 0, bytesPerSecond: 0 })).toBe(45)
    expect(percentOf({ percent: 120, transferred: 0, total: 0, bytesPerSecond: 0 })).toBe(100)
    expect(percentOf({ percent: NaN, transferred: 25, total: 100, bytesPerSecond: 0 })).toBe(25)
  })

  it('writes sizes in the unit that suits the total', () => {
    expect(sizeLabel(52 * MB, 115 * MB)).toBe('52 of 115 MB')
    expect(sizeLabel(2.25 * MB, 4.5 * MB)).toBe('2.3 of 4.5 MB')
    expect(sizeLabel(500_000, 1_000_000)).toBe('488 of 977 KB')
    expect(sizeLabel(200 * MB, 100 * MB)).toBe('100 of 100 MB')
    expect(sizeLabel(512 * MB, 2048 * MB)).toBe('0.5 of 2.0 GB')
  })

  it('reads "45% (52 of 115 MB)"', () => {
    expect(progressLabel({ percent: 45.2, transferred: 52 * MB, total: 115 * MB, bytesPerSecond: 1 })).toBe(
      '45% (52 of 115 MB)'
    )
    expect(progressLabel({ percent: 10, transferred: 0, total: 0, bytesPerSecond: 0 })).toBe('10%')
    expect(progressLabel(null)).toBe('0%')
  })
})

describe('lastCheckedLabel', () => {
  const now = new Date(2026, 9, 14, 12, 0).getTime()
  it('is relative for the last hour, else the local date and time', () => {
    expect(lastCheckedLabel(null, now)).toBe('Not checked yet')
    expect(lastCheckedLabel(now - 20_000, now)).toBe('Last checked: just now')
    expect(lastCheckedLabel(now - 60_000, now)).toBe('Last checked: 1 minute ago')
    expect(lastCheckedLabel(now - 5 * 60_000, now)).toBe('Last checked: 5 minutes ago')
    expect(lastCheckedLabel(now - 3 * 3600_000, now)).toMatch(/^Last checked: .*2026/)
  })
})

describe('what a manual check found', () => {
  it('tells policy, up to date, failure and updates apart', () => {
    expect(checkOutcome(status({ checksOff: 'policy' }))).toEqual({ kind: 'policy' })
    expect(checkOutcome(status({ phase: 'upToDate' }))).toEqual({ kind: 'upToDate', version: '0.1.0' })
    expect(checkOutcome(status({ phase: 'error', errorDuring: 'check', manual: true }))).toEqual({
      kind: 'error',
      message: "Couldn't check for updates. Check your internet connection and try again."
    })
    // Main's message says why, when it knows.
    expect(
      checkOutcome(status({ phase: 'error', errorDuring: 'check', manual: true, error: 'GitHub said no.' }))
    ).toEqual({ kind: 'error', message: 'GitHub said no.' })
    expect(checkOutcome(status({ phase: 'available', update }))).toEqual({ kind: 'update' })
    expect(checkOutcome(status({ phase: 'ready', update }))).toEqual({ kind: 'update' })
    expect(checkOutcome(status({ phase: 'error', errorDuring: 'download', update }))).toEqual({
      kind: 'update'
    })
    expect(checkOutcome(status({ phase: 'checking' }))).toEqual({ kind: 'none' })
  })

  it('keeps failed automatic checks quiet in Preferences', () => {
    expect(statusLine(status({ phase: 'error', errorDuring: 'check', manual: false }))).toBeNull()
    expect(statusLine(status({ phase: 'error', errorDuring: 'check', manual: true }))).toMatch(
      /^Couldn't check/
    )
    expect(
      statusLine(status({ phase: 'error', errorDuring: 'check', manual: true, error: 'GitHub said no.' }))
    ).toBe('GitHub said no.')
    expect(statusLine(status({ phase: 'upToDate' }))).toBe('Fartcrobat 0.1.0 is up to date.')
    expect(statusLine(status({ phase: 'available', update }))).toBe('Fartcrobat 0.2.0 is available.')
    expect(statusLine(status({ phase: 'idle' }))).toBeNull()
  })
})
