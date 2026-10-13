import { describe, expect, it } from 'vitest'
import type textOps from '@engine/ops/text'
import type { PageText } from '@renderer/document/textModel'
import { findOnPage, luhnValid, searchPattern, type FindQuery, type PatternId } from '@features/redact/patterns'
import { openFixture } from './helpers'

function textPage(text: string): PageText {
  return { pageIndex: 0, text, quads: new Float32Array(text.length * 8), lines: [], spans: [], blocks: [], images: [] }
}

function matches(text: string, id: PatternId): string[] {
  const t = textPage(text)
  return searchPattern(t, id).map((h) => t.text.slice(h.start, h.end))
}

const query = (patch: Partial<FindQuery>): FindQuery => ({
  mode: 'phrase',
  phrase: '',
  list: [],
  pattern: 'email',
  wholeWords: false,
  matchCase: false,
  ...patch
})

describe('redact: Find text & redact patterns', () => {
  it('finds the 5 SSNs, emails and phone numbers in text.pdf and nothing else', async () => {
    const e = await openFixture('text.pdf')
    const text = e.ops<typeof textOps>('text')
    const counts: Record<PatternId, string[]> = { phone: [], email: [], creditCard: [], ssn: [], date: [] }
    for (let p = 0; p < 5; p++) {
      const t = await text.page(p)
      for (const id of Object.keys(counts) as PatternId[]) {
        counts[id].push(...searchPattern(t, id).map((h) => t.text.slice(h.start, h.end)))
      }
    }
    expect(counts.ssn).toEqual(['123-45-6780', '123-45-6781', '123-45-6782', '123-45-6783', '123-45-6784'])
    expect(counts.email).toEqual(['billing0@example.com', 'billing1@example.com', 'billing2@example.com', 'billing3@example.com', 'billing4@example.com'])
    expect(counts.phone).toEqual(['(555) 010-0000', '(555) 010-0011', '(555) 010-0022', '(555) 010-0033', '(555) 010-0044'])
    expect(counts.creditCard).toEqual([])
    expect(counts.date).toEqual([])
  })

  it('recognises US and international phone numbers', () => {
    expect(matches('Call +44 20 7946 0958 or 555.010.0199, (555)010-0199 and +1 555 010 0123 today.', 'phone')).toEqual([
      '+44 20 7946 0958',
      '555.010.0199',
      '(555)010-0199',
      '+1 555 010 0123'
    ])
    expect(matches('SSN 123-45-6789, date 2024-03-14, invoice 1234567890, total $1,234.50', 'phone')).toEqual([])
  })

  it('checks card numbers with the Luhn algorithm', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
    expect(matches('Visa 4111 1111 1111 1111, bad 4111 1111 1111 1112, MC 5500-0000-0000-0004, Amex 378282246310005', 'creditCard')).toEqual([
      '4111 1111 1111 1111',
      '5500-0000-0000-0004',
      '378282246310005'
    ])
  })

  it('recognises social security numbers but not impossible ones', () => {
    expect(matches('ok 123-45-6789 and 123 45 6789; bad 000-12-3456 666-12-3456 900-12-3456 123-00-4567 123-45 6789', 'ssn')).toEqual([
      '123-45-6789',
      '123 45 6789'
    ])
  })

  it('recognises dates in common formats', () => {
    expect(matches('On 03/14/2024, 2024-03-14, 14 March 2024, March 14, 2024 and Mar. 3, 2024 but not 13/13/2024 or 1234-56-78.', 'date')).toEqual([
      '03/14/2024',
      '2024-03-14',
      '14 March 2024',
      'March 14, 2024',
      'Mar. 3, 2024'
    ])
  })

  it('recognises email addresses', () => {
    expect(matches('Write to Jane.Doe+tag@sub.example.co.uk or bob@example.org; not an email@ or @nothing.', 'email')).toEqual([
      'Jane.Doe+tag@sub.example.co.uk',
      'bob@example.org'
    ])
  })

  it('searches single phrases and lists of words with options, merging overlapping hits', () => {
    const t = textPage('The quick brown fox jumps over the lazy dog. Quick thinking; quickly.')
    expect(findOnPage(t, query({ mode: 'phrase', phrase: 'quick' })).length).toBe(3)
    expect(findOnPage(t, query({ mode: 'phrase', phrase: 'quick', wholeWords: true })).length).toBe(2)
    expect(findOnPage(t, query({ mode: 'phrase', phrase: 'Quick', matchCase: true })).length).toBe(1)
    const list = findOnPage(t, query({ mode: 'list', list: ['brown', 'quick brown', 'lazy dog', ''] }))
    expect(list.map((h) => t.text.slice(h.start, h.end))).toEqual(['quick brown', 'lazy dog'])
  })
})
