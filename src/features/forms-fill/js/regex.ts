/**
 * Guards the native regular expressions form scripts use. A backtracking regex engine can take
 * exponential or high-polynomial time on some patterns, and a native match cannot be interrupted
 * by the interpreter's step budget, so a PDF could freeze the window with one `test()` call.
 *
 * Every pattern is analysed when the script creates it:
 * - Patterns that can take exponential time are refused: backreferences, and a repeated
 *   (`*`, `+`, `{n,}`) group whose body can match in more than one way (nested quantifiers like
 *   `(a+)+`, alternation like `(a|ab)*`).
 * - For the rest, the work a backtracking match can do is bounded by a polynomial in the input
 *   length: c * (n + 1)^k, where k counts the unbounded quantifiers (plus one when the match can
 *   start anywhere) and c the choices of bounded quantifiers and alternations.
 *
 * Before each native call the bound for the actual input is added to the run's regex budget; a
 * call that would go over it fails like an endless loop does, before it starts.
 */
import { ScriptError } from './parser'

export interface PatternCost {
  /** Exponent: unbounded quantifiers in sequence (+1 when the match is not anchored). */
  k: number
  /** Natural log of the constant factor (bounded quantifier and alternation choices). */
  logC: number
}

interface Cost {
  k: number
  logC: number
  /** The sub-pattern can match the same text in more than one way (has quantifiers or |). */
  variable: boolean
}

const ZERO: Cost = { k: 0, logC: 0, variable: false }
const MAX_PATTERN = 2000

/** Estimated backtracking work allowed per script run (about a second of matching at worst). */
export const REGEX_BUDGET = 1e9
const LOG_BUDGET = Math.log(REGEX_BUDGET)

function logSumExp(values: number[]): number {
  const max = Math.max(...values)
  return max + Math.log(values.reduce((s, v) => s + Math.exp(v - max), 0))
}

class PatternParser {
  private i = 0
  constructor(private readonly src: string) {}

  parse(): { cost: Cost; anchored: boolean } {
    const r = this.alternation()
    if (this.i < this.src.length) throw this.unsupported()
    return r
  }

  private unsupported(why = 'is not supported') {
    return new ScriptError(`The regular expression /${this.src.slice(0, 60)}/ ${why}`, true)
  }

  private alternation(): { cost: Cost; anchored: boolean } {
    const branches = [this.sequence()]
    while (this.src[this.i] === '|') {
      this.i++
      branches.push(this.sequence())
    }
    if (branches.length === 1) return branches[0]
    return {
      cost: {
        k: Math.max(...branches.map((b) => b.cost.k)),
        logC: logSumExp(branches.map((b) => b.cost.logC)),
        variable: true
      },
      anchored: branches.every((b) => b.anchored)
    }
  }

  private sequence(): { cost: Cost; anchored: boolean } {
    let cost = ZERO
    let first = true
    let anchored = false
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
      if (first && this.src[this.i] === '^') anchored = true
      first = false
      const atom = this.quantified(this.atom())
      cost = { k: cost.k + atom.k, logC: cost.logC + atom.logC, variable: cost.variable || atom.variable }
    }
    return { cost, anchored }
  }

  private atom(): Cost {
    const s = this.src
    const c = s[this.i]
    if (c === '(') {
      this.i++
      if (s.startsWith('?:', this.i) || s.startsWith('?=', this.i) || s.startsWith('?!', this.i)) this.i += 2
      else if (s.startsWith('?<=', this.i) || s.startsWith('?<!', this.i)) this.i += 3
      else if (s.startsWith('?<', this.i)) {
        const end = s.indexOf('>', this.i)
        if (end < 0) throw this.unsupported()
        this.i = end + 1
      }
      const body = this.alternation().cost
      if (s[this.i] !== ')') throw this.unsupported()
      this.i++
      return body
    }
    if (c === '[') {
      this.i++
      if (s[this.i] === '^') this.i++
      while (this.i < s.length && s[this.i] !== ']') this.i += s[this.i] === '\\' ? 2 : 1
      this.i++
      return ZERO
    }
    if (c === '\\') {
      const d = s[this.i + 1] ?? ''
      if (/[1-9]/.test(d) || (d === 'k' && s[this.i + 2] === '<')) throw this.unsupported('uses a backreference, which is not supported')
      if ((d === 'u' || d === 'p' || d === 'P') && s[this.i + 2] === '{') {
        const end = s.indexOf('}', this.i)
        this.i = end < 0 ? s.length : end + 1
      } else this.i += 2
      return ZERO
    }
    // ^ $ . and literal characters (including a { or } that is not a quantifier).
    this.i++
    return ZERO
  }

  private quantified(atom: Cost): Cost {
    const s = this.src
    let min: number
    let max: number
    const c = s[this.i]
    if (c === '*') [min, max] = [0, Infinity]
    else if (c === '+') [min, max] = [1, Infinity]
    else if (c === '?') [min, max] = [0, 1]
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(this.i, this.i + 40))
      if (!m) return atom
      min = Number(m[1])
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3])
      this.i += m[0].length - 1
    } else return atom
    this.i++
    if (s[this.i] === '?') this.i++ // lazy
    if (max === Infinity) {
      if (atom.variable) throw this.unsupported('can take too long to run (nested repetition)')
      return { k: atom.k + 1, logC: atom.logC, variable: true }
    }
    if (min === max) return { k: atom.k * min, logC: atom.logC * min, variable: atom.variable && min > 0 }
    return { k: atom.k * max, logC: atom.logC * max + Math.log(max - min + 1), variable: true }
  }
}

const analysed = new WeakMap<RegExp, PatternCost>()
/** Patterns analysed lately (a regex literal in a loop is created again on every pass). */
const recent = new Map<string, PatternCost>()

/** Analyses a pattern; throws a ScriptError for patterns that can take exponential time. */
export function patternCost(source: string, flags: string): PatternCost {
  if (source.length > MAX_PATTERN) throw new ScriptError('The regular expression is too long', true)
  const key = `${flags}/${source}`
  const known = recent.get(key)
  if (known) return known
  const { cost, anchored } = new PatternParser(source).parse()
  const fixedStart = flags.includes('y') || (anchored && !flags.includes('m'))
  const result = { k: cost.k + (fixedStart ? 0 : 1), logC: cost.logC }
  if (recent.size >= 500) recent.clear()
  recent.set(key, result)
  return result
}

/** Creates a RegExp for a script (literal or `new RegExp`), refusing unsafe patterns. */
export function scriptRegExp(source: string, flags: string): RegExp {
  let re: RegExp
  try {
    re = new RegExp(source, flags.replace(/[^gimsuy]/g, ''))
  } catch {
    throw new ScriptError(`Invalid regular expression /${source}/`)
  }
  analysed.set(re, patternCost(re.source, re.flags))
  return re
}

/** Natural log of the most work matching `re` against `input` can take. */
export function matchLogCost(re: RegExp, input: string): number {
  let cost = analysed.get(re)
  if (!cost) {
    cost = patternCost(re.source, re.flags)
    analysed.set(re, cost)
  }
  return cost.logC + cost.k * Math.log(input.length + 1)
}

/** Tracks the regex work of one script run. */
export class RegexBudget {
  private used = 0

  reset() {
    this.used = 0
  }

  /** Call before every native match; throws when the run would go over its budget. */
  charge(re: RegExp, input: string) {
    const log = matchLogCost(re, input)
    if (log > LOG_BUDGET) throw new ScriptError('The script took too long to run')
    this.used += Math.exp(log)
    if (this.used > REGEX_BUDGET) throw new ScriptError('The script took too long to run')
  }
}
