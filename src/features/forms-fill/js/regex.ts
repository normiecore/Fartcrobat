/**
 * Guards the native regular expressions form scripts use. A backtracking regex engine can take
 * exponential or high-polynomial time on some patterns, and a native match cannot be interrupted
 * by the interpreter's step budget, so a PDF could freeze the window with one `test()` call.
 *
 * - Where V8's linear-time engine is available (the main process turns it on for the renderer
 *   with the `--enable-experimental-regexp-engine` js-flag, src/main/index.ts), every pattern it
 *   can run is compiled for it (the `l` flag). One match then costs at most about
 *   (text length) * (pattern size), whatever the pattern.
 * - Patterns it cannot run (the `i` and `u` flags, `(?i:)` groups, lookaheads, large counted
 *   repeats) use the backtracking engine. (V8's fallback to the linear engine after too many
 *   backtracks does not help: it only applies to patterns the linear engine can run.) The pattern
 *   is read exactly as V8 reads it, including the web-compatibility rules without the `u` flag
 *   (`\u{2}` is `u{2}` there); one it cannot read exactly is refused. So are those that can take
 *   exponential time: backreferences, and a repeated group whose body can match in more than one
 *   way (`(a+)+`, `(a|ab)*`). For the rest,
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
  /** The analysis may not match the pattern V8 runs: not trusted on the backtracking engine. */
  inexact?: string
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

/** Largest count V8 keeps in a {n,m} quantifier; larger ones mean "no limit". */
const MAX_COUNT = 2 ** 31 - 1

/**
 * Reads a pattern the way V8 does (with the web-compatibility rules of Annex B unless the `u`
 * flag is set), so no quantifier or counted repeat can hide from the analysis. A construct it does
 * not read exactly is recorded in `inexact`, and such patterns are refused on the backtracking
 * engine; the number of capture groups is checked against V8's own count.
 */
class PatternParser {
  private i = 0
  private exponential: string | undefined
  /** Why the analysis may not match what V8 runs (the pattern is then not trusted). */
  inexact: string | undefined
  /** Capture groups seen. */
  groups = 0
  constructor(
    private readonly src: string,
    private readonly unicode: boolean
  ) {}

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
      if (s[this.i] === '?') {
        const head = /\?(?::|=|!|<=|<!|<([^>]*)>|[a-zA-Z]*(?:-[a-zA-Z]*)?:)/y
        head.lastIndex = this.i
        const m = head.exec(s)
        if (!m) {
          this.inexact ??= 'group'
          this.i++
        } else {
          if (m[1] !== undefined) this.groups++
          this.i += m[0].length
        }
      } else this.groups++
      const body = this.alternation().cost
      if (s[this.i] !== ')') throw this.unsupported()
      this.i++
      return { ...body, size: body.size + 1 }
    }
    if (c === '[') {
      this.i++
      if (s[this.i] === '^') this.i++
      while (this.i < s.length && s[this.i] !== ']') this.i += s[this.i] === '\\' ? 2 : 1
      if (this.i >= s.length) this.inexact ??= 'class'
      this.i++
      return ZERO
    }
    if (c === '\\') {
      this.escape()
      return ZERO
    }
    // Quantifier characters cannot start an atom (V8 refuses those patterns).
    if (c === '*' || c === '+' || c === '?') this.inexact ??= 'quantifier'
    // ^ $ . and literal characters (including a { } or ] that is not part of a quantifier or class).
    this.i++
    return ZERO
  }

  /** Steps over an escape outside a class (one character, class or assertion: never quantified). */
  private escape() {
    const s = this.src
    const d = s[this.i + 1] ?? ''
    const at = (re: RegExp) => {
      re.lastIndex = this.i + 2
      const m = re.exec(s)
      return m ? m[0].length : -1
    }
    if (/[1-9]/.test(d) || d === 'k') {
      // A backreference (or, without named groups, a literal k: refused all the same).
      this.exponential ??= 'uses a backreference, which is not supported'
      if (/[1-9]/.test(d)) this.inexact ??= 'backreference'
      this.i += 2
      return
    }
    if (d === 'c') {
      // \cX with a letter; otherwise (Annex B) the backslash alone is a literal and c comes next.
      this.i += /[a-zA-Z]/.test(s[this.i + 2] ?? '') ? 3 : this.unicode ? 2 : 1
      return
    }
    if (d === '0') {
      if (/[0-9]/.test(s[this.i + 2] ?? '')) this.inexact ??= 'octal escape'
      this.i += 2
      return
    }
    if (d === 'x') {
      const n = at(/[0-9a-fA-F]{2}/y)
      this.i += 2 + Math.max(0, n)
      return
    }
    if (d === 'u') {
      // \uXXXX; with the u flag also \u{X...}. Otherwise (Annex B) a literal u.
      const n = this.unicode ? at(/[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\}/y) : at(/[0-9a-fA-F]{4}/y)
      this.i += 2 + Math.max(0, n)
      return
    }
    if ((d === 'p' || d === 'P') && this.unicode) {
      // A property class; without the u flag a literal p or P.
      const n = at(/\{[^}]*\}/y)
      if (n < 0) this.inexact ??= 'property'
      this.i += 2 + Math.max(0, n)
      return
    }
    if (!d) this.inexact ??= 'escape'
    // \d \w \s \b \n ... or an identity escape: one character either way.
    this.i += 2
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
      // Any number of digits (V8 accepts leading zeros); counts too large for V8 mean no limit.
      const braces = /\{(\d+)(,(\d*))?\}/y
      braces.lastIndex = this.i
      const m = braces.exec(s)
      if (!m) return atom
      const count = (digits: string) => {
        const n = Number(digits)
        return n > MAX_COUNT ? Infinity : n
      }
      min = count(m[1])
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : count(m[3])
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

/** Capture groups V8 finds in a pattern (it has compiled already, so this cannot throw). */
function v8GroupCount(source: string, flags: string): number {
  // The empty alternative matches the empty text at once, after an attempt at the pattern itself
  // on an empty text, which does no work worth counting.
  return new RegExp(`(?:${source})|`, flags.replace(/[gyl]/g, '')).exec('')!.length - 1
}

/** Patterns analysed lately (a regex literal in a loop is created again on every pass). */
const recent = new Map<string, PatternInfo>()

/** Analyses a pattern (throws a ScriptError for ones that are too long or cannot be parsed). */
export function analysePattern(source: string, flags: string): PatternInfo {
  if (source.length > MAX_PATTERN) throw new ScriptError('The regular expression is too long', true)
  const key = `${flags}/${source}`
  const known = recent.get(key)
  if (known) return known
  const parser = new PatternParser(source, flags.includes('u'))
  const info = parser.parse()
  if (!parser.inexact && parser.groups !== v8GroupCount(source, flags)) parser.inexact = 'groups'
  if (parser.inexact) info.inexact = parser.inexact
  // The work per position is at least the length of the pattern, whatever the analysis says.
  info.size = Math.max(info.size, source.length)
  if (flags.includes('m')) info.anchored = false
  if (recent.size >= 500) recent.clear()
  recent.set(key, info)
  return info
}

/** Why the backtracking engine may not run a pattern (it could take too long), if so. */
function backtrackingRefusal(info: PatternInfo): string | undefined {
  return info.exponential ?? (info.inexact ? 'is not supported' : undefined)
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
    const refusal = this.linearEngine ? undefined : backtrackingRefusal(this.info)
    if (refusal) throw new ScriptError(`The regular expression /${this.source.slice(0, 60)}/ ${refusal}`, true)
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
  const refusal = re.linear ? undefined : backtrackingRefusal(info)
  if (refusal) throw new ScriptError(`The regular expression /${source.slice(0, 60)}/ ${refusal}`, true)
  re.info = info
  re.budget = budget
  return re
}
