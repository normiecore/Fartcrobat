/**
 * Parser for the subset of JavaScript used by PDF form scripts (Acrobat field calculation, format,
 * keystroke and validation scripts, and simple document-level helper functions).
 *
 * It produces a small AST that `interpreter.ts` evaluates. Nothing here ever uses eval or
 * new Function: scripts in PDF files are untrusted.
 */

export class ScriptError extends Error {
  constructor(
    message: string,
    /** True when the script uses something this interpreter does not support. */
    readonly unsupported = false
  ) {
    super(message)
    this.name = 'ScriptError'
  }
}

// ---- tokens -------------------------------------------------------------------------------

type TokType = 'num' | 'str' | 'id' | 'kw' | 'punc' | 'regex' | 'eof'

interface Token {
  type: TokType
  value: string
  num?: number
  flags?: string
  pos: number
  /** A line break came before this token (for automatic semicolon insertion). */
  nl: boolean
}

const KEYWORDS = new Set([
  'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'return', 'function',
  'true', 'false', 'null', 'undefined', 'this', 'new', 'typeof', 'switch', 'case', 'default', 'try', 'catch',
  'finally', 'throw', 'in', 'instanceof', 'delete', 'void'
])

// Longest first so that greedy matching works.
const PUNCTUATORS = [
  '===', '!==', '>>>', '<<=', '>>=', '**',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '=>', '??',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':',
  '=', '.'
]

function isIdStart(c: string) {
  return /[A-Za-z_$\u00c0-\uffff]/.test(c)
}

function isIdPart(c: string) {
  return /[A-Za-z0-9_$\u00c0-\uffff]/.test(c)
}

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let nl = false
  const n = src.length
  const regexAllowed = () => {
    const prev = out[out.length - 1]
    if (!prev) return true
    if (prev.type === 'num' || prev.type === 'str' || prev.type === 'regex') return false
    if (prev.type === 'id') return false
    if (prev.type === 'kw') return !['this', 'true', 'false', 'null', 'undefined'].includes(prev.value)
    return ![')', ']', '}', '++', '--'].includes(prev.value)
  }
  while (i < n) {
    const c = src[i]
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
      nl = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      if (/[\r\n]/.test(src.slice(i, stop))) nl = true
      i = stop
      continue
    }
    const start = i
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let text = ''
      if (c === '0' && /[xX]/.test(src[i + 1] ?? '')) {
        i += 2
        while (i < n && /[0-9a-fA-F]/.test(src[i])) i++
        text = src.slice(start, i)
        out.push({ type: 'num', value: text, num: parseInt(text.slice(2), 16), pos: start, nl })
      } else {
        while (i < n && /[0-9]/.test(src[i])) i++
        if (src[i] === '.') {
          i++
          while (i < n && /[0-9]/.test(src[i])) i++
        }
        if (/[eE]/.test(src[i] ?? '') && /[-+0-9]/.test(src[i + 1] ?? '')) {
          i++
          if (src[i] === '+' || src[i] === '-') i++
          while (i < n && /[0-9]/.test(src[i])) i++
        }
        text = src.slice(start, i)
        out.push({ type: 'num', value: text, num: parseFloat(text), pos: start, nl })
      }
      nl = false
      continue
    }
    if (c === '"' || c === "'") {
      i++
      let s = ''
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          const e = src[i + 1]
          i += 2
          switch (e) {
            case 'n':
              s += '\n'
              break
            case 'r':
              s += '\r'
              break
            case 't':
              s += '\t'
              break
            case 'b':
              s += '\b'
              break
            case 'f':
              s += '\f'
              break
            case 'v':
              s += '\v'
              break
            case '0':
              s += '\0'
              break
            case 'x':
              s += String.fromCharCode(parseInt(src.slice(i, i + 2), 16))
              i += 2
              break
            case 'u':
              if (src[i] === '{') {
                const close = src.indexOf('}', i)
                s += String.fromCodePoint(parseInt(src.slice(i + 1, close), 16))
                i = close + 1
              } else {
                s += String.fromCharCode(parseInt(src.slice(i, i + 4), 16))
                i += 4
              }
              break
            case '\r':
              if (src[i] === '\n') i++
              break
            case '\n':
              break
            case undefined:
              break
            default:
              s += e
          }
          continue
        }
        if (src[i] === '\n') throw new ScriptError('Unterminated string')
        s += src[i]
        i++
      }
      if (i >= n) throw new ScriptError('Unterminated string')
      i++
      out.push({ type: 'str', value: s, pos: start, nl })
      nl = false
      continue
    }
    if (c === '/' && regexAllowed()) {
      // regular expression literal
      i++
      let inClass = false
      let body = ''
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') {
          body += ch + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (ch === '\n') throw new ScriptError('Unterminated regular expression')
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        body += ch
        i++
      }
      if (i >= n) throw new ScriptError('Unterminated regular expression')
      i++
      let flags = ''
      while (i < n && /[a-z]/.test(src[i])) flags += src[i++]
      out.push({ type: 'regex', value: body, flags, pos: start, nl })
      nl = false
      continue
    }
    if (isIdStart(c)) {
      while (i < n && isIdPart(src[i])) i++
      const word = src.slice(start, i)
      out.push({ type: KEYWORDS.has(word) ? 'kw' : 'id', value: word, pos: start, nl })
      nl = false
      continue
    }
    const p = PUNCTUATORS.find((q) => src.startsWith(q, i))
    if (!p) throw new ScriptError(`Unexpected character “${c}”`)
    i += p.length
    out.push({ type: 'punc', value: p, pos: start, nl })
    nl = false
  }
  out.push({ type: 'eof', value: '', pos: n, nl: true })
  return out
}

// ---- AST ----------------------------------------------------------------------------------

export type Expr =
  | { t: 'lit'; v: number | string | boolean | null | undefined }
  | { t: 'regex'; source: string; flags: string }
  | { t: 'id'; name: string }
  | { t: 'this' }
  | { t: 'arr'; items: Expr[] }
  | { t: 'obj'; props: { key: string; value: Expr }[] }
  | { t: 'member'; obj: Expr; prop: Expr; computed: boolean }
  | { t: 'call'; callee: Expr; args: Expr[] }
  | { t: 'new'; callee: Expr; args: Expr[] }
  | { t: 'unary'; op: string; arg: Expr }
  | { t: 'update'; op: '++' | '--'; prefix: boolean; target: Expr }
  | { t: 'bin'; op: string; left: Expr; right: Expr }
  | { t: 'logic'; op: '&&' | '||' | '??'; left: Expr; right: Expr }
  | { t: 'cond'; test: Expr; cons: Expr; alt: Expr }
  | { t: 'assign'; op: string; target: Expr; value: Expr }
  | { t: 'seq'; items: Expr[] }
  | { t: 'fn'; name: string | null; params: string[]; body: Stmt[] }

export type Stmt =
  | { t: 'expr'; e: Expr }
  | { t: 'var'; decls: { name: string; init: Expr | null }[] }
  | { t: 'if'; test: Expr; cons: Stmt; alt: Stmt | null }
  | { t: 'block'; body: Stmt[] }
  | { t: 'for'; init: Stmt | null; test: Expr | null; update: Expr | null; body: Stmt }
  | { t: 'forin'; decl: string; obj: Expr; body: Stmt }
  | { t: 'while'; test: Expr; body: Stmt }
  | { t: 'do'; body: Stmt; test: Expr }
  | { t: 'break' }
  | { t: 'continue' }
  | { t: 'return'; arg: Expr | null }
  | { t: 'throw'; arg: Expr }
  | { t: 'fn'; name: string; params: string[]; body: Stmt[] }
  | { t: 'switch'; disc: Expr; cases: { test: Expr | null; body: Stmt[] }[] }
  | { t: 'try'; block: Stmt[]; param: string | null; handler: Stmt[] | null; finalizer: Stmt[] | null }
  | { t: 'empty' }

export type Program = Stmt[]

// ---- parser -------------------------------------------------------------------------------

const BINARY_PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '|': 4,
  '^': 5,
  '&': 6,
  '==': 7,
  '!=': 7,
  '===': 7,
  '!==': 7,
  '<': 8,
  '>': 8,
  '<=': 8,
  '>=': 8,
  instanceof: 8,
  in: 8,
  '<<': 9,
  '>>': 9,
  '>>>': 9,
  '+': 10,
  '-': 10,
  '*': 11,
  '/': 11,
  '%': 11,
  '**': 12
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>='])

class Parser {
  private i = 0
  constructor(private toks: Token[]) {}

  private peek(o = 0): Token {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]
  }

  private next(): Token {
    const t = this.toks[this.i]
    if (this.i < this.toks.length - 1) this.i++
    return t
  }

  private is(value: string, o = 0): boolean {
    const t = this.peek(o)
    return (t.type === 'punc' || t.type === 'kw') && t.value === value
  }

  private eat(value: string): boolean {
    if (this.is(value)) {
      this.next()
      return true
    }
    return false
  }

  private expect(value: string): Token {
    if (!this.is(value)) {
      const t = this.peek()
      throw new ScriptError(`Expected “${value}” but found “${t.value || 'end of script'}”`)
    }
    return this.next()
  }

  private ident(): string {
    const t = this.next()
    if (t.type !== 'id') throw new ScriptError(`Expected a name but found “${t.value || 'end of script'}”`)
    return t.value
  }

  private semicolon() {
    if (this.eat(';')) return
    const t = this.peek()
    if (t.type === 'eof' || this.is('}') || t.nl) return
    throw new ScriptError(`Unexpected “${t.value}”`)
  }

  program(): Program {
    const body: Stmt[] = []
    while (this.peek().type !== 'eof') body.push(this.statement())
    return body
  }

  private block(): Stmt[] {
    this.expect('{')
    const body: Stmt[] = []
    while (!this.is('}')) {
      if (this.peek().type === 'eof') throw new ScriptError('Missing “}”')
      body.push(this.statement())
    }
    this.expect('}')
    return body
  }

  private statement(): Stmt {
    const t = this.peek()
    if (t.type === 'punc') {
      if (t.value === '{') return { t: 'block', body: this.block() }
      if (t.value === ';') {
        this.next()
        return { t: 'empty' }
      }
    }
    if (t.type === 'kw') {
      switch (t.value) {
        case 'var':
        case 'let':
        case 'const': {
          const s = this.varDecl()
          this.semicolon()
          return s
        }
        case 'if': {
          this.next()
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          const cons = this.statement()
          const alt = this.eat('else') ? this.statement() : null
          return { t: 'if', test, cons, alt }
        }
        case 'for':
          return this.forStatement()
        case 'while': {
          this.next()
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          return { t: 'while', test, body: this.statement() }
        }
        case 'do': {
          this.next()
          const body = this.statement()
          this.expect('while')
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          this.eat(';')
          return { t: 'do', body, test }
        }
        case 'break':
          this.next()
          this.semicolon()
          return { t: 'break' }
        case 'continue':
          this.next()
          this.semicolon()
          return { t: 'continue' }
        case 'return': {
          this.next()
          const nt = this.peek()
          const arg = this.is(';') || this.is('}') || nt.type === 'eof' || nt.nl ? null : this.expression()
          this.semicolon()
          return { t: 'return', arg }
        }
        case 'throw': {
          this.next()
          const arg = this.expression()
          this.semicolon()
          return { t: 'throw', arg }
        }
        case 'function': {
          this.next()
          const name = this.ident()
          const { params, body } = this.functionRest()
          return { t: 'fn', name, params, body }
        }
        case 'switch':
          return this.switchStatement()
        case 'try':
          return this.tryStatement()
      }
    }
    const e = this.expression()
    this.semicolon()
    return { t: 'expr', e }
  }

  private varDecl(): Stmt {
    this.next()
    const decls: { name: string; init: Expr | null }[] = []
    do {
      const name = this.ident()
      const init = this.eat('=') ? this.assignment(true) : null
      decls.push({ name, init })
    } while (this.eat(','))
    return { t: 'var', decls }
  }

  private forStatement(): Stmt {
    this.next()
    this.expect('(')
    // for (var x in obj)
    if ((this.is('var') || this.is('let') || this.is('const')) && this.peek(1).type === 'id' && this.is('in', 2)) {
      this.next()
      const decl = this.ident()
      this.expect('in')
      const obj = this.expression()
      this.expect(')')
      return { t: 'forin', decl, obj, body: this.statement() }
    }
    if (this.peek().type === 'id' && this.is('in', 1)) {
      const decl = this.ident()
      this.expect('in')
      const obj = this.expression()
      this.expect(')')
      return { t: 'forin', decl, obj, body: this.statement() }
    }
    let init: Stmt | null = null
    if (!this.is(';')) {
      init = this.is('var') || this.is('let') || this.is('const') ? this.varDecl() : { t: 'expr', e: this.expression() }
    }
    this.expect(';')
    const test = this.is(';') ? null : this.expression()
    this.expect(';')
    const update = this.is(')') ? null : this.expression()
    this.expect(')')
    return { t: 'for', init, test, update, body: this.statement() }
  }

  private switchStatement(): Stmt {
    this.next()
    this.expect('(')
    const disc = this.expression()
    this.expect(')')
    this.expect('{')
    const cases: { test: Expr | null; body: Stmt[] }[] = []
    while (!this.eat('}')) {
      let test: Expr | null = null
      if (this.eat('case')) test = this.expression()
      else this.expect('default')
      this.expect(':')
      const body: Stmt[] = []
      while (!this.is('case') && !this.is('default') && !this.is('}')) {
        if (this.peek().type === 'eof') throw new ScriptError('Missing “}”')
        body.push(this.statement())
      }
      cases.push({ test, body })
    }
    return { t: 'switch', disc, cases }
  }

  private tryStatement(): Stmt {
    this.next()
    const block = this.block()
    let param: string | null = null
    let handler: Stmt[] | null = null
    let finalizer: Stmt[] | null = null
    if (this.eat('catch')) {
      if (this.eat('(')) {
        param = this.ident()
        this.expect(')')
      }
      handler = this.block()
    }
    if (this.eat('finally')) finalizer = this.block()
    if (!handler && !finalizer) throw new ScriptError('try without catch or finally')
    return { t: 'try', block, param, handler, finalizer }
  }

  private functionRest(): { params: string[]; body: Stmt[] } {
    this.expect('(')
    const params: string[] = []
    if (!this.is(')')) {
      do params.push(this.ident())
      while (this.eat(','))
    }
    this.expect(')')
    return { params, body: this.block() }
  }

  expression(): Expr {
    const first = this.assignment(false)
    if (!this.is(',')) return first
    const items = [first]
    while (this.eat(',')) items.push(this.assignment(false))
    return { t: 'seq', items }
  }

  private assignment(noIn: boolean): Expr {
    const left = this.conditional(noIn)
    const t = this.peek()
    if (t.type === 'punc' && ASSIGN_OPS.has(t.value)) {
      if (left.t !== 'id' && left.t !== 'member') throw new ScriptError('Invalid assignment target')
      this.next()
      const value = this.assignment(noIn)
      return { t: 'assign', op: t.value, target: left, value }
    }
    return left
  }

  private conditional(noIn: boolean): Expr {
    const test = this.binary(0, noIn)
    if (!this.eat('?')) return test
    const cons = this.assignment(false)
    this.expect(':')
    const alt = this.assignment(noIn)
    return { t: 'cond', test, cons, alt }
  }

  private binary(minPrec: number, noIn: boolean): Expr {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      if (t.type !== 'punc' && t.type !== 'kw') break
      const prec = BINARY_PRECEDENCE[t.value]
      if (prec === undefined || prec <= minPrec) break
      if (noIn && t.value === 'in') break
      this.next()
      // ** is right-associative
      const right = this.binary(t.value === '**' ? prec - 1 : prec, noIn)
      if (t.value === '&&' || t.value === '||' || t.value === '??') left = { t: 'logic', op: t.value, left, right }
      else left = { t: 'bin', op: t.value, left, right }
    }
    return left
  }

  private unary(): Expr {
    const t = this.peek()
    if ((t.type === 'punc' && ['!', '-', '+', '~'].includes(t.value)) || (t.type === 'kw' && ['typeof', 'void', 'delete'].includes(t.value))) {
      this.next()
      return { t: 'unary', op: t.value, arg: this.unary() }
    }
    if (t.type === 'punc' && (t.value === '++' || t.value === '--')) {
      this.next()
      const target = this.unary()
      if (target.t !== 'id' && target.t !== 'member') throw new ScriptError('Invalid increment target')
      return { t: 'update', op: t.value, prefix: true, target }
    }
    const e = this.postfix()
    return e
  }

  private postfix(): Expr {
    const e = this.callMember()
    const t = this.peek()
    if (t.type === 'punc' && (t.value === '++' || t.value === '--') && !t.nl) {
      if (e.t !== 'id' && e.t !== 'member') throw new ScriptError('Invalid increment target')
      this.next()
      return { t: 'update', op: t.value, prefix: false, target: e }
    }
    return e
  }

  private args(): Expr[] {
    this.expect('(')
    const args: Expr[] = []
    if (!this.is(')')) {
      do {
        if (this.is(')')) break
        args.push(this.assignment(false))
      } while (this.eat(','))
    }
    this.expect(')')
    return args
  }

  private callMember(): Expr {
    let e: Expr
    if (this.eat('new')) {
      const callee = this.memberOnly(this.primary())
      const args = this.is('(') ? this.args() : []
      e = { t: 'new', callee, args }
    } else {
      e = this.primary()
    }
    for (;;) {
      if (this.eat('.')) {
        const t = this.next()
        if (t.type !== 'id' && t.type !== 'kw') throw new ScriptError('Expected a property name')
        e = { t: 'member', obj: e, prop: { t: 'lit', v: t.value }, computed: false }
      } else if (this.eat('[')) {
        const prop = this.expression()
        this.expect(']')
        e = { t: 'member', obj: e, prop, computed: true }
      } else if (this.is('(')) {
        e = { t: 'call', callee: e, args: this.args() }
      } else break
    }
    return e
  }

  private memberOnly(e: Expr): Expr {
    for (;;) {
      if (this.eat('.')) {
        const t = this.next()
        e = { t: 'member', obj: e, prop: { t: 'lit', v: t.value }, computed: false }
      } else if (this.eat('[')) {
        const prop = this.expression()
        this.expect(']')
        e = { t: 'member', obj: e, prop, computed: true }
      } else return e
    }
  }

  private primary(): Expr {
    const t = this.next()
    switch (t.type) {
      case 'num':
        return { t: 'lit', v: t.num! }
      case 'str':
        return { t: 'lit', v: t.value }
      case 'regex':
        return { t: 'regex', source: t.value, flags: t.flags ?? '' }
      case 'id':
        return { t: 'id', name: t.value }
      case 'kw':
        switch (t.value) {
          case 'true':
            return { t: 'lit', v: true }
          case 'false':
            return { t: 'lit', v: false }
          case 'null':
            return { t: 'lit', v: null }
          case 'undefined':
            return { t: 'lit', v: undefined }
          case 'this':
            return { t: 'this' }
          case 'function': {
            const name = this.peek().type === 'id' ? this.ident() : null
            const { params, body } = this.functionRest()
            return { t: 'fn', name, params, body }
          }
        }
        break
      case 'punc':
        if (t.value === '(') {
          const e = this.expression()
          this.expect(')')
          return e
        }
        if (t.value === '[') {
          const items: Expr[] = []
          while (!this.is(']')) {
            if (this.is(',')) {
              this.next()
              items.push({ t: 'lit', v: undefined })
              continue
            }
            items.push(this.assignment(false))
            if (!this.is(']')) this.expect(',')
          }
          this.expect(']')
          return { t: 'arr', items }
        }
        if (t.value === '{') {
          const props: { key: string; value: Expr }[] = []
          while (!this.is('}')) {
            const k = this.next()
            if (k.type !== 'id' && k.type !== 'str' && k.type !== 'num' && k.type !== 'kw')
              throw new ScriptError('Expected a property name')
            this.expect(':')
            props.push({ key: k.type === 'num' ? String(k.num) : k.value, value: this.assignment(false) })
            if (!this.is('}')) this.expect(',')
          }
          this.expect('}')
          return { t: 'obj', props }
        }
        break
    }
    throw new ScriptError(t.type === 'eof' ? 'Unexpected end of script' : `Unexpected “${t.value}”`)
  }
}

const cache = new Map<string, Program>()

/** Parses a script (cached). Throws ScriptError on syntax errors. */
export function parse(src: string): Program {
  const hit = cache.get(src)
  if (hit) return hit
  const program = new Parser(tokenize(src)).program()
  if (cache.size > 500) cache.clear()
  cache.set(src, program)
  return program
}
