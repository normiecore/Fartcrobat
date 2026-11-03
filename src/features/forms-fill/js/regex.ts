/**
 * Guards the native regular expressions form scripts use. A backtracking regex engine can take
 * exponential or high-polynomial time on some patterns, and a native match cannot be interrupted
 * by the interpreter's step budget, so a PDF could freeze the window with one `test()` call.
 *
 * - Where V8's linear-time engine is available (the main process turns it on for the renderer
 *   with the `--enable-experimental-regexp-engine` js-flag, src/main/index.ts), every pattern it
 *   can run is compiled for it (the `l` flag). One match then costs at most about
 *   (text length) * (pattern size), whatever the pattern.
 * - Patterns it cannot run (the `i` and `u` flags, lookarounds, large counted repeats) use the
 *   backtracking engine. Those that can take exponential time are refused: backreferences, and a
 *   repeated group whose body can match in more than one way (`(a+)+`, `(a|ab)*`). For the rest,
 *   one match attempt is bounded by a polynomial: size * c * (n + 1)^k, where k counts the
 *   unbounded quantifiers (plus one when the match can start at any position) and c the choices
 *   of counted quantifiers and alternations.
 *
 * Every native match goes through `exec` (String.prototype.replace/split/match/search call it for
 * each match, split once per position), so each one is checked before it starts: one that could
 * take longer than a fraction of a second is refused. The time the matches really take is added
 * up per event (document load, a click or keystroke, an agent's fill), and once that goes over
 * its budget further matches fail like an endless loop does, until the next event.
 */
import { ScriptError } from './parser'

export interface PatternInfo {
  /** Exponent of the backtracking bound for one attempt at a fixed position. */
  k: number
  /** Natural log of the constant factor (bounded quantifier and alternation choices). */
  logC: number
  /** Pattern size with counted repeats unrolled (the work per position of the match). */
  size: number
  /** Starts with ^ (outside multiline mode): an attempt at any later position fails at once. */
  anchored: boolean
  /** Why the backtracking engine could take exponential time on it, if it could. */
  exponential?: string
}

interface Cost {
  k: number
  logC: number
  size: number
  /** The sub-pattern can match the same text in more than one way (has quantifiers or |). */
  variable: boolean
}

const ZERO: Cost = { k: 0, logC: 0, size: 1, variable: false }
const MAX_PATTERN = 2000

/** Most work one linear-engine match may do: about (n + 1) * (size + 1). Tens of ms at worst. */
export const MAX_LINEAR_MATCH = 1e7
/** Most work one backtracking match may do (the polynomial bound above). */
export const MAX_BACKTRACKING_MATCH = 5e7
/** Milliseconds of matching allowed per event (document load, click, keystroke, agent fill). */
export const REGEX_TIME_BUDGET_MS = 250

const TOO_LONG = 'The script took too long to run'

function logSumExp(values: number[]): number {
  const max = Math.max(...values)
  return max + Math.log(values.reduce((s, v) => s + Math.exp(v - max), 0))
}

class PatternParser {
  private i = 0
  private exponential: string | undefined
  constructor(private readonly src: string) {}

  parse(): PatternInfo {
    const r = this.alternation()
    if (this.i < this.src.length) throw this.unsupported()
    return { k: r.cost.k, logC: r.cost.logC, size: r.cost.size, anchored: r.anchored, exponential: this.exponential }
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
        size: branches.reduce((s, b) => s + b.cost.size, 0),
        variable: true
      },
      anchored: branches.every((b) => b.anchored)
    }
  }

  private sequence(): { cost: Cost; anchored: boolean } {
    let cost: Cost = { ...ZERO, size: 0 }
    let first = true
    let anchored = false
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
      if (first && this.src[this.i] === '^') anchored = true
      first = false
      const atom = this.quantified(this.atom())
      cost = { k: cost.k + atom.k, logC: cost.logC + atom.logC, size: cost.size + atom.size, variable: cost.variable || atom.variable }
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
      return { ...body, size: body.size + 1 }
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
      if (/[1-9]/.test(d) || (d === 'k' && s[this.i + 2] === '<')) this.exponential ??= 'uses a backreference, which is not supported'
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
    // Unrolled size: a counted repeat is matched (and backtracked) once per count.
    const size = atom.size * Math.max(1, Math.min(isFinite(max) ? max : min, 1e6))
    if (max === Infinity) {
      if (atom.variable) this.exponential ??= 'can take too long to run (nested repetition)'
      return { k: atom.k + 1, logC: atom.logC, size, variable: true }
    }
    if (min === max) return { k: atom.k * min, logC: atom.logC * min, size, variable: atom.variable && min > 0 }
    return { k: atom.k * max, logC: atom.logC * max + Math.log(max - min + 1), size, variable: true }
  }
}

/** Patterns analysed lately (a regex literal in a loop is created again on every pass). */
const recent = new Map<string, PatternInfo>()

/** Analyses a pattern (throws a ScriptError for ones that are too long or cannot be parsed). */
export function analysePattern(source: string, flags: string): PatternInfo {
  if (source.length > MAX_PATTERN) throw new ScriptError('The regular expression is too long', true)
  const key = `${flags}/${source}`
  const known = recent.get(key)
  if (known) return known
  const info = new PatternParser(source).parse()
  if (flags.includes('m')) info.anchored = false
  if (recent.size >= 500) recent.clear()
  recent.set(key, info)
  return info
}

/** Whether V8's linear-time engine can be asked for (the `l` flag). */
export function linearEngineAvailable(): boolean {
  try {
    // eslint-disable-next-line no-invalid-regexp -- the `l` flag is V8's, behind a js-flag
    new RegExp('', 'l')
    return true
  } catch {
    return false
  }
}

/**
 * Work one match attempt of `re` on `input` can do at most, in rough nanoseconds. `start` is the
 * position the attempt starts at (lastIndex for global and sticky patterns).
 */
export function matchCost(info: PatternInfo, linear: boolean, sticky: boolean, input: string, start: number): number {
  const rest = Math.max(0, input.length - start) + 1
  if (linear) return rest * (info.size + 1)
  // A search tries every position from `start`; ^ fails at once at all but the first.
  const fixed = sticky || info.anchored
  const attempt = Math.exp(info.logC) * rest ** (info.k + (fixed ? 0 : 1))
  return (info.size + 1) * (attempt + rest)
}

/** Tracks the time native matches take during one event (see the comment at the top). */
export class RegexBudget {
  private usedMs = 0

  /** A new event starts: the budget is full again. */
  reset() {
    this.usedMs = 0
  }

  /** Runs one native match, refusing it when it could take too long or the budget is used up. */
  run<T>(cost: number, linear: boolean, match: () => T): T {
    if (this.usedMs > REGEX_TIME_BUDGET_MS || !(cost <= (linear ? MAX_LINEAR_MATCH : MAX_BACKTRACKING_MATCH)))
      throw new ScriptError(TOO_LONG)
    const start = performance.now()
    try {
      return match()
    } finally {
      this.usedMs += performance.now() - start
    }
  }
}

/**
 * A script's regular expression. Its `exec` (which test, replace, split, match and search all call
 * for every match they make) checks each match against the budget before running it.
 */
export class ScriptRegExp extends RegExp {
  info!: PatternInfo
  budget!: RegexBudget
  /** Compiled for the linear-time engine (the `l` flag). */
  private linearEngine = false

  constructor(pattern: string | RegExp, flags?: string) {
    super(pattern, flags)
    this.linearEngine = flags !== undefined ? flags.includes('l') : pattern instanceof ScriptRegExp && pattern.linearEngine
    // split() makes a sticky copy through the species constructor: it keeps the original's budget.
    if (pattern instanceof ScriptRegExp) {
      this.budget = pattern.budget
      this.info = pattern.info
    }
  }

  /**
   * V8's `flags` getter reads this for the `l` flag (a subclass does not get it otherwise), and
   * the copy split() makes is created from `flags`: it has to stay on the linear engine.
   */
  get linear(): boolean {
    return this.linearEngine
  }

  override exec(input: string): RegExpExecArray | null {
    if (!this.budget || !this.info) throw new ScriptError(TOO_LONG)
    if (!this.linearEngine && this.info.exponential) throw new ScriptError(`The regular expression /${this.source.slice(0, 60)}/ ${this.info.exponential}`, true)
    const s = String(input)
    const start = this.global || this.sticky ? Math.min(Math.max(0, Math.trunc(Number(this.lastIndex)) || 0), s.length + 1) : 0
    const cost = matchCost(this.info, this.linearEngine, this.sticky, s, start)
    return this.budget.run(cost, this.linearEngine, () => super.exec(s))
  }

  /** How scripts see it: without the internal `l` flag. */
  override toString(): string {
    return `/${this.source}/${this.flags.replace('l', '')}`
  }
}

/**
 * Creates a RegExp for a script (literal, `new RegExp`, or a string given to match/search),
 * charging its matches to `budget`. Refuses patterns that can take exponential time.
 */
export function scriptRegExp(source: string, flags: string, budget: RegexBudget): ScriptRegExp {
  const f = [...new Set(flags.replace(/[^gimsuy]/g, ''))].join('')
  let re: ScriptRegExp
  try {
    re = new ScriptRegExp(source, f)
  } catch {
    throw new ScriptError(`Invalid regular expression /${source}/`)
  }
  const info = analysePattern(re.source, re.flags)
  if (linearEngineAvailable()) {
    try {
      re = new ScriptRegExp(source, f + 'l')
    } catch {
      // The linear engine cannot run this pattern: it stays with the backtracking engine.
    }
  }
  if (!re.linear && info.exponential) throw new ScriptError(`The regular expression /${source.slice(0, 60)}/ ${info.exponential}`, true)
  re.info = info
  re.budget = budget
  return re
}
