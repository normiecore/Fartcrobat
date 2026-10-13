/**
 * Search patterns for "Find text & redact" (Acrobat: Find Text > Patterns). Pure functions so they
 * can be unit tested. The regular expressions run on page text normalised by `searchPage` (runs of
 * white space collapsed to one space).
 */
import { searchPage, type PageText, type SearchHit } from '@renderer/document/textModel'

export type PatternId = 'phone' | 'email' | 'creditCard' | 'ssn' | 'date'

export interface PatternDef {
  id: PatternId
  label: string
  example: string
  regex: string
  /** Extra check on the matched text (e.g. the Luhn checksum for card numbers). */
  accept?: (match: string) => boolean
}

const MONTHS =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/** Luhn checksum used by payment card numbers. */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '')
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let double = false
  for (let i = d.length - 1; i >= 0; i--) {
    let v = d.charCodeAt(i) - 48
    if (double) {
      v *= 2
      if (v > 9) v -= 9
    }
    sum += v
    double = !double
  }
  return sum % 10 === 0
}

function validSsn(m: string): boolean {
  const d = m.replace(/\D/g, '')
  const area = d.slice(0, 3)
  return area !== '000' && area !== '666' && area[0] !== '9' && d.slice(3, 5) !== '00' && d.slice(5) !== '0000'
}

function validDate(m: string): boolean {
  if (/[a-z]/i.test(m)) return true // month names are already constrained by the expression
  const nums = (m.match(/\d+/g) ?? []).map(Number)
  if (nums.length !== 3) return false
  if (/^\d{4}/.test(m.trim())) return nums[1] >= 1 && nums[1] <= 12 && nums[2] >= 1 && nums[2] <= 31
  const [a, b] = nums
  return (a >= 1 && a <= 31 && b >= 1 && b <= 12) || (a >= 1 && a <= 12 && b >= 1 && b <= 31)
}

export const PATTERNS: PatternDef[] = [
  {
    id: 'phone',
    label: 'Phone numbers',
    example: '(555) 010-0123, +44 20 7946 0958',
    // US/NANP: (555) 010-0123, 555-010-0123, 555.010.0123, +1 555 010 0123
    // International: + country code then 6-14 more digits in groups
    regex:
      '(?<![\\d+])(?:(?:\\+?1[\\s.-]?)?(?:\\(\\d{3}\\)|\\d{3})[\\s.-]?\\d{3}[\\s.-]\\d{4}|\\(\\d{3}\\)\\s?\\d{3}[\\s.-]?\\d{4}|\\+\\d{1,3}(?:[\\s.-]?\\(?\\d{1,5}\\)?){2,6})(?![\\d])',
    accept: (m) => {
      const n = m.replace(/\D/g, '').length
      return n >= 10 && n <= 15
    }
  },
  {
    id: 'email',
    label: 'Email addresses',
    example: 'name@example.com',
    regex: "[\\p{L}\\p{N}._%+'-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}",
    accept: (m) => !m.startsWith('.') && !m.includes('..')
  },
  {
    id: 'creditCard',
    label: 'Credit card numbers',
    example: '4111 1111 1111 1111',
    regex: '(?<![\\d])(?:\\d[ -]?){12,18}\\d(?![\\d])',
    accept: luhnValid
  },
  {
    id: 'ssn',
    label: 'Social security numbers',
    example: '123-45-6789',
    regex: '(?<![\\d-])\\d{3}([- ])\\d{2}\\1\\d{4}(?![\\d-])',
    accept: validSsn
  },
  {
    id: 'date',
    label: 'Dates',
    example: '03/14/2024, 2024-03-14, 14 March 2024, March 14, 2024',
    regex:
      `(?<![\\d/.-])(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|\\d{1,2}(?:st|nd|rd|th)?\\s${MONTHS}\\.?,?\\s\\d{4}|${MONTHS}\\.?\\s\\d{1,2}(?:st|nd|rd|th)?,?\\s\\d{4})(?![\\d/])`,
    accept: validDate
  }
]

export function patternById(id: PatternId): PatternDef {
  return PATTERNS.find((p) => p.id === id)!
}

/** Finds a pattern on one page. */
export function searchPattern(t: PageText, id: PatternId): SearchHit[] {
  const def = patternById(id)
  const hits = searchPage(t, def.regex, { regex: true, matchCase: false })
  return def.accept ? hits.filter((h) => def.accept!(t.text.slice(h.start, h.end))) : hits
}

export type FindMode = 'phrase' | 'list' | 'pattern'

export interface FindQuery {
  mode: FindMode
  phrase: string
  list: string[]
  pattern: PatternId
  wholeWords: boolean
  matchCase: boolean
}

/** Runs a Find & Redact query on one page; hits are sorted and never overlap. */
export function findOnPage(t: PageText, q: FindQuery): SearchHit[] {
  let hits: SearchHit[] = []
  if (q.mode === 'pattern') hits = searchPattern(t, q.pattern)
  else {
    const terms = q.mode === 'phrase' ? [q.phrase] : q.list
    for (const term of terms) {
      if (!term.trim()) continue
      hits.push(...searchPage(t, term, { wholeWords: q.wholeWords, matchCase: q.matchCase }))
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SearchHit[] = []
  for (const h of hits) {
    const last = out[out.length - 1]
    if (last && h.start < last.end) {
      if (h.end > last.end) last.end = h.end
      continue
    }
    out.push({ ...h })
  }
  return out
}
