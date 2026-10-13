/**
 * A small, safe evaluator for the JavaScript subset parsed by `parser.ts`.
 *
 * Values are plain JS primitives, arrays, `JsObject` (object literals, backed by a Map so scripts
 * can never reach real prototypes), `JsFunction` (script functions), `NativeFunction` (functions
 * provided by the host) and `HostObject` (event, fields, util, app...). Scripts have no access to
 * anything the host does not hand them, and every run has a step and call-depth budget.
 */
import { parse, ScriptError, type Expr, type Program, type Stmt } from './parser'

export { ScriptError }

export type JsValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | JsValue[]
  | JsObject
  | JsFunction
  | NativeFunction
  | HostObject
  | RegExp

export class JsObject {
  readonly props = new Map<string, JsValue>()
  constructor(init?: Record<string, JsValue>) {
    if (init) for (const [k, v] of Object.entries(init)) this.props.set(k, v)
  }
}

export class JsFunction {
  constructor(
    readonly name: string,
    readonly params: string[],
    readonly body: Stmt[],
    readonly scope: Scope
  ) {}
}

export type NativeImpl = (thisArg: JsValue, args: JsValue[], interp: Interpreter) => JsValue

export class NativeFunction {
  constructor(
    readonly name: string,
    readonly fn: NativeImpl,
    /** Called for `new Name(...)`; defaults to calling fn. */
    readonly construct?: (args: JsValue[], interp: Interpreter) => JsValue,
    /** Static members, e.g. String.fromCharCode. */
    readonly statics: Record<string, JsValue> = {}
  ) {}
}

/** An object implemented by the host (event, field, util...). */
export abstract class HostObject {
  abstract get(name: string): JsValue
  set(name: string, _value: JsValue): void {
    throw new ScriptError(`Cannot set “${name}”`, true)
  }
  has(name: string): boolean {
    return this.get(name) !== undefined
  }
  /** Value used when the object takes part in arithmetic or string concatenation. */
  toPrimitive(): JsValue {
    return '[object Object]'
  }
}

/** A JS Date exposed to scripts. */
export class JsDate extends HostObject {
  constructor(public date: Date) {
    super()
  }
  get(name: string): JsValue {
    const d = this.date
    const m: Record<string, () => JsValue> = {
      getFullYear: () => d.getFullYear(),
      getYear: () => d.getFullYear() - 1900,
      getMonth: () => d.getMonth(),
      getDate: () => d.getDate(),
      getDay: () => d.getDay(),
      getHours: () => d.getHours(),
      getMinutes: () => d.getMinutes(),
      getSeconds: () => d.getSeconds(),
      getMilliseconds: () => d.getMilliseconds(),
      getTime: () => d.getTime(),
      valueOf: () => d.getTime(),
      toString: () => d.toString(),
      toDateString: () => d.toDateString(),
      toLocaleDateString: () => d.toLocaleDateString(),
      toLocaleTimeString: () => d.toLocaleTimeString(),
      toISOString: () => d.toISOString(),
      getTimezoneOffset: () => d.getTimezoneOffset()
    }
    const setters: Record<string, (v: number[]) => void> = {
      setFullYear: (v) => d.setFullYear(v[0], v[1] ?? d.getMonth(), v[2] ?? d.getDate()),
      setMonth: (v) => d.setMonth(v[0], v[1] ?? d.getDate()),
      setDate: (v) => d.setDate(v[0]),
      setHours: (v) => d.setHours(v[0], v[1] ?? d.getMinutes(), v[2] ?? d.getSeconds()),
      setMinutes: (v) => d.setMinutes(v[0], v[1] ?? d.getSeconds()),
      setSeconds: (v) => d.setSeconds(v[0]),
      setTime: (v) => d.setTime(v[0])
    }
    const getter = own(m, name)
    if (getter) return new NativeFunction(name, () => getter())
    const setter = own(setters, name)
    if (setter)
      return new NativeFunction(name, (_t, args) => {
        setter(args.map(toNumber))
        return d.getTime()
      })
    return undefined
  }
  toPrimitive(): JsValue {
    return this.date.toString()
  }
}

// ---- conversions --------------------------------------------------------------------------

export function isCallable(v: JsValue): v is JsFunction | NativeFunction {
  return v instanceof JsFunction || v instanceof NativeFunction
}

function isObjectLike(v: JsValue): boolean {
  return v !== null && typeof v === 'object'
}

export function toPrimitive(v: JsValue): string | number | boolean | null | undefined {
  if (v === null || v === undefined || typeof v !== 'object') {
    if (typeof v === 'function') return '[function]'
    return v as string | number | boolean | null | undefined
  }
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? '' : toStr(x))).join(',')
  if (v instanceof JsDate) return v.date.getTime()
  if (v instanceof HostObject) {
    const p = v.toPrimitive()
    return isObjectLike(p) ? '[object Object]' : (p as string | number | boolean | null | undefined)
  }
  if (v instanceof RegExp) return String(v)
  if (isCallable(v)) return `function ${v.name}() { [code] }`
  return '[object Object]'
}

export function toNumber(v: JsValue): number {
  return Number(toPrimitive(v))
}

export function toStr(v: JsValue): string {
  if (v instanceof JsDate) return v.date.toString()
  return String(toPrimitive(v))
}

export function truthy(v: JsValue): boolean {
  if (isObjectLike(v)) return true
  return !!v
}

export function typeOf(v: JsValue): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'object'
  if (isCallable(v)) return 'function'
  return typeof v === 'object' ? 'object' : typeof v
}

function looseEquals(a: JsValue, b: JsValue): boolean {
  if (isObjectLike(a) && isObjectLike(b)) return a === b
  const pa = isObjectLike(a) ? toPrimitive(a) : a
  const pb = isObjectLike(b) ? toPrimitive(b) : b
  return (pa as unknown) == (pb as unknown)
}

function strictEquals(a: JsValue, b: JsValue): boolean {
  return a === b
}

// ---- scopes & completions ------------------------------------------------------------------

export class Scope {
  readonly vars = new Map<string, JsValue>()
  constructor(
    readonly parent: Scope | null,
    readonly isFunction = false
  ) {}

  lookup(name: string): Scope | null {
    if (this.vars.has(name)) return this
    return this.parent ? this.parent.lookup(name) : null
  }

  functionScope(): Scope {
    if (this.isFunction || !this.parent) return this
    return this.parent.functionScope()
  }

  root(): Scope {
    return this.parent ? this.parent.root() : this
  }
}

type Completion = undefined | { type: 'break' } | { type: 'continue' } | { type: 'return'; value: JsValue }

class ThrowSignal {
  constructor(readonly value: JsValue) {}
}

// ---- built-in prototypes ------------------------------------------------------------------

/** Looks up a method table without ever reaching Object.prototype ("constructor", "__proto__"). */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

function nativeMethod(name: string, fn: NativeImpl) {
  return new NativeFunction(name, fn)
}

function argNum(args: JsValue[], i: number, fallback?: number): number | undefined {
  return args[i] === undefined ? fallback : toNumber(args[i])
}

function stringMember(s: string, key: string): JsValue {
  if (key === 'length') return s.length
  if (/^\d+$/.test(key)) return s[Number(key)]
  const m: Record<string, NativeImpl> = {
    toUpperCase: () => s.toUpperCase(),
    toLowerCase: () => s.toLowerCase(),
    toLocaleUpperCase: () => s.toUpperCase(),
    toLocaleLowerCase: () => s.toLowerCase(),
    trim: () => s.trim(),
    trimStart: () => s.trimStart(),
    trimEnd: () => s.trimEnd(),
    toString: () => s,
    valueOf: () => s,
    charAt: (_t, a) => s.charAt(argNum(a, 0, 0)!),
    charCodeAt: (_t, a) => s.charCodeAt(argNum(a, 0, 0)!),
    indexOf: (_t, a) => s.indexOf(toStr(a[0]), argNum(a, 1)),
    lastIndexOf: (_t, a) => s.lastIndexOf(toStr(a[0]), argNum(a, 1)),
    includes: (_t, a) => s.includes(toStr(a[0])),
    startsWith: (_t, a) => s.startsWith(toStr(a[0])),
    endsWith: (_t, a) => s.endsWith(toStr(a[0])),
    substring: (_t, a) => s.substring(argNum(a, 0, 0)!, argNum(a, 1)),
    substr: (_t, a) => {
      let start = argNum(a, 0, 0)!
      if (start < 0) start = Math.max(0, s.length + start)
      const len = argNum(a, 1, s.length - start)!
      return s.slice(start, start + Math.max(0, len))
    },
    slice: (_t, a) => s.slice(argNum(a, 0, 0), argNum(a, 1)),
    concat: (_t, a) => s + a.map(toStr).join(''),
    repeat: (_t, a) => s.repeat(Math.max(0, Math.min(10000, argNum(a, 0, 0)!))),
    padStart: (_t, a) => s.padStart(Math.min(10000, argNum(a, 0, 0)!), a[1] === undefined ? ' ' : toStr(a[1])),
    padEnd: (_t, a) => s.padEnd(Math.min(10000, argNum(a, 0, 0)!), a[1] === undefined ? ' ' : toStr(a[1])),
    split: (_t, a) => {
      if (a[0] === undefined) return [s]
      const sep = a[0] instanceof RegExp ? a[0] : toStr(a[0])
      return s.split(sep as string, argNum(a, 1))
    },
    search: (_t, a) => s.search(a[0] instanceof RegExp ? a[0] : toStr(a[0])),
    match: (_t, a) => {
      const re = a[0] instanceof RegExp ? a[0] : new RegExp(toStr(a[0]))
      const r = s.match(re)
      return r ? [...r] : null
    },
    replace: (_t, a, interp) => {
      const pattern = a[0] instanceof RegExp ? a[0] : toStr(a[0])
      const rep = a[1]
      if (isCallable(rep)) {
        return s.replace(pattern as RegExp, (...m: unknown[]) => {
          const groups = m.slice(0, -2).map((x) => (x === undefined ? undefined : String(x)))
          return toStr(interp.call(rep, undefined, [...groups, m[m.length - 2] as number, s]))
        })
      }
      return s.replace(pattern as RegExp, toStr(rep))
    },
    localeCompare: (_t, a) => s.localeCompare(toStr(a[0]))
  }
  const impl = own(m, key)
  return impl ? nativeMethod(key, impl) : undefined
}

function numberMember(n: number, key: string): JsValue {
  const m: Record<string, NativeImpl> = {
    toFixed: (_t, a) => n.toFixed(Math.max(0, Math.min(20, argNum(a, 0, 0)!))),
    toPrecision: (_t, a) => (a[0] === undefined ? String(n) : n.toPrecision(Math.max(1, Math.min(21, toNumber(a[0]))))),
    toString: (_t: JsValue, a: JsValue[]) => n.toString(a[0] === undefined ? 10 : Math.max(2, Math.min(36, toNumber(a[0])))),
    valueOf: () => n,
    toLocaleString: () => n.toLocaleString()
  }
  const impl = own(m, key)
  return impl ? nativeMethod(key, impl) : undefined
}

function arrayMember(arr: JsValue[], key: string): JsValue {
  if (key === 'length') return arr.length
  if (/^\d+$/.test(key)) return arr[Number(key)]
  const m: Record<string, NativeImpl> = {
    push: (_t, a) => arr.push(...a),
    pop: () => arr.pop(),
    shift: () => arr.shift(),
    unshift: (_t, a) => arr.unshift(...a),
    join: (_t, a) => arr.map((x) => (x === null || x === undefined ? '' : toStr(x))).join(a[0] === undefined ? ',' : toStr(a[0])),
    indexOf: (_t, a) => arr.findIndex((x) => strictEquals(x, a[0])),
    lastIndexOf: (_t, a) => {
      for (let i = arr.length - 1; i >= 0; i--) if (strictEquals(arr[i], a[0])) return i
      return -1
    },
    includes: (_t, a) => arr.some((x) => strictEquals(x, a[0])),
    slice: (_t, a) => arr.slice(argNum(a, 0, 0), argNum(a, 1)),
    splice: (_t, a) => arr.splice(argNum(a, 0, 0)!, argNum(a, 1, arr.length)!, ...a.slice(2)),
    concat: (_t, a) => arr.concat(...a.map((x) => (Array.isArray(x) ? x : [x]))),
    reverse: () => arr.reverse(),
    toString: () => toStr(arr),
    sort: (_t, a, interp) => {
      const cmp = a[0]
      if (isCallable(cmp)) return arr.sort((x, y) => toNumber(interp.call(cmp, undefined, [x, y])))
      return arr.sort((x, y) => {
        const sx = toStr(x)
        const sy = toStr(y)
        return sx < sy ? -1 : sx > sy ? 1 : 0
      })
    },
    forEach: (_t, a, interp) => {
      arr.forEach((x, i) => interp.call(a[0], undefined, [x, i, arr]))
      return undefined
    },
    map: (_t, a, interp) => arr.map((x, i) => interp.call(a[0], undefined, [x, i, arr])),
    filter: (_t, a, interp) => arr.filter((x, i) => truthy(interp.call(a[0], undefined, [x, i, arr]))),
    some: (_t, a, interp) => arr.some((x, i) => truthy(interp.call(a[0], undefined, [x, i, arr]))),
    every: (_t, a, interp) => arr.every((x, i) => truthy(interp.call(a[0], undefined, [x, i, arr]))),
    reduce: (_t, a, interp) => {
      if (a.length > 1) return arr.reduce((acc, x, i) => interp.call(a[0], undefined, [acc, x, i, arr]), a[1])
      return arr.reduce((acc, x, i) => interp.call(a[0], undefined, [acc, x, i, arr]))
    }
  }
  const impl = own(m, key)
  return impl ? nativeMethod(key, impl) : undefined
}

function regexMember(re: RegExp, key: string): JsValue {
  switch (key) {
    case 'test':
      return nativeMethod('test', (_t, a) => re.test(toStr(a[0])))
    case 'exec':
      return nativeMethod('exec', (_t, a) => {
        const r = re.exec(toStr(a[0]))
        return r ? [...r] : null
      })
    case 'source':
      return re.source
    case 'global':
      return re.global
    case 'lastIndex':
      return re.lastIndex
  }
  return undefined
}

// ---- interpreter --------------------------------------------------------------------------

export interface InterpreterOptions {
  /** Maximum evaluation steps per run (protects against endless loops). */
  maxSteps?: number
  maxDepth?: number
}

export class Interpreter {
  readonly global: Scope
  thisValue: JsValue = undefined
  /**
   * Acrobat runs scripts with the document as the global object: names that are not variables
   * (resetForm, getField, print...) are looked up on it.
   */
  globalObject: HostObject | null = null
  private steps = 0
  private depth = 0
  private readonly maxSteps: number
  private readonly maxDepth: number

  constructor(globals: Record<string, JsValue>, opts: InterpreterOptions = {}) {
    this.global = new Scope(null, true)
    for (const [k, v] of Object.entries({ ...standardGlobals(), ...globals })) this.global.vars.set(k, v)
    this.maxSteps = opts.maxSteps ?? 250_000
    this.maxDepth = opts.maxDepth ?? 64
  }

  /** Runs a script. Returns the value of the last expression statement. */
  run(src: string | Program, opts: { scope?: Scope; thisValue?: JsValue; globalObject?: HostObject } = {}): JsValue {
    const program = typeof src === 'string' ? parse(src) : src
    const scope = opts.scope ?? new Scope(this.global, true)
    const prevThis = this.thisValue
    const prevGlobal = this.globalObject
    if (opts.thisValue !== undefined) this.thisValue = opts.thisValue
    if (opts.globalObject) this.globalObject = opts.globalObject
    this.steps = 0
    this.depth = 0
    try {
      this.hoist(program, scope)
      let last: JsValue = undefined
      for (const st of program) {
        if (st.t === 'expr') {
          last = this.eval(st.e, scope)
          continue
        }
        const c = this.exec(st, scope)
        if (c?.type === 'return') return c.value
        if (c) break
      }
      return last
    } catch (err) {
      if (err instanceof ThrowSignal) throw new ScriptError(`Uncaught ${toStr(err.value)}`)
      if (err instanceof ScriptError) throw err
      if (err instanceof RangeError) throw new ScriptError('The script is too complex')
      throw new ScriptError(err instanceof Error ? err.message : String(err))
    } finally {
      this.thisValue = prevThis
      this.globalObject = prevGlobal
    }
  }

  /** Calls a script or native function. */
  call(fn: JsValue, thisArg: JsValue, args: JsValue[]): JsValue {
    if (fn instanceof NativeFunction) return fn.fn(thisArg, args, this)
    if (!(fn instanceof JsFunction)) throw new ScriptError(`${toStr(fn)} is not a function`)
    if (++this.depth > this.maxDepth) {
      this.depth--
      throw new ScriptError('Too much recursion')
    }
    const scope = new Scope(fn.scope, true)
    fn.params.forEach((p, i) => scope.vars.set(p, args[i]))
    scope.vars.set('arguments', [...args])
    const prevThis = this.thisValue
    this.thisValue = thisArg === undefined ? this.thisValue : thisArg
    try {
      this.hoist(fn.body, scope)
      for (const st of fn.body) {
        const c = this.exec(st, scope)
        if (c?.type === 'return') return c.value
        if (c) break
      }
      return undefined
    } finally {
      this.thisValue = prevThis
      this.depth--
    }
  }

  private tick() {
    if (++this.steps > this.maxSteps) throw new ScriptError('The script took too long to run')
  }

  private hoist(body: Stmt[], scope: Scope) {
    for (const st of body) {
      if (st.t === 'fn') scope.vars.set(st.name, new JsFunction(st.name, st.params, st.body, scope))
    }
  }

  // ---- statements

  private execBlock(body: Stmt[], scope: Scope): Completion {
    this.hoist(body, scope)
    for (const st of body) {
      const c = this.exec(st, scope)
      if (c) return c
    }
    return undefined
  }

  private exec(st: Stmt, scope: Scope): Completion {
    this.tick()
    switch (st.t) {
      case 'expr':
        this.eval(st.e, scope)
        return undefined
      case 'var':
        for (const d of st.decls) {
          const value = d.init ? this.eval(d.init, scope) : undefined
          const target = scope.functionScope()
          if (d.init || !target.vars.has(d.name)) target.vars.set(d.name, value)
        }
        return undefined
      case 'if':
        if (truthy(this.eval(st.test, scope))) return this.exec(st.cons, scope)
        return st.alt ? this.exec(st.alt, scope) : undefined
      case 'block':
        return this.execBlock(st.body, new Scope(scope))
      case 'for': {
        const s = new Scope(scope)
        if (st.init) this.exec(st.init, s)
        while (!st.test || truthy(this.eval(st.test, s))) {
          this.tick()
          const c = this.exec(st.body, s)
          if (c?.type === 'break') break
          if (c?.type === 'return') return c
          if (st.update) this.eval(st.update, s)
        }
        return undefined
      }
      case 'forin': {
        const obj = this.eval(st.obj, scope)
        let keys: string[] = []
        if (Array.isArray(obj)) keys = obj.map((_x, i) => String(i))
        else if (obj instanceof JsObject) keys = [...obj.props.keys()]
        else if (typeof obj === 'string') keys = [...obj].map((_x, i) => String(i))
        const target = scope.functionScope()
        for (const k of keys) {
          target.vars.set(st.decl, k)
          const c = this.exec(st.body, scope)
          if (c?.type === 'break') break
          if (c?.type === 'return') return c
        }
        return undefined
      }
      case 'while':
        while (truthy(this.eval(st.test, scope))) {
          this.tick()
          const c = this.exec(st.body, scope)
          if (c?.type === 'break') break
          if (c?.type === 'return') return c
        }
        return undefined
      case 'do':
        do {
          this.tick()
          const c = this.exec(st.body, scope)
          if (c?.type === 'break') break
          if (c?.type === 'return') return c
        } while (truthy(this.eval(st.test, scope)))
        return undefined
      case 'break':
        return { type: 'break' }
      case 'continue':
        return { type: 'continue' }
      case 'return':
        return { type: 'return', value: st.arg ? this.eval(st.arg, scope) : undefined }
      case 'throw':
        throw new ThrowSignal(this.eval(st.arg, scope))
      case 'fn':
        return undefined // hoisted
      case 'switch': {
        const d = this.eval(st.disc, scope)
        const s = new Scope(scope)
        let matched = false
        for (let pass = 0; pass < 2 && !matched; pass++) {
          for (const c of st.cases) {
            if (!matched) {
              if (pass === 0 && c.test && strictEquals(this.eval(c.test, s), d)) matched = true
              else if (pass === 1 && !c.test) matched = true
            }
            if (matched) {
              const r = this.execBlock(c.body, s)
              if (r?.type === 'break') return undefined
              if (r) return r
            }
          }
        }
        return undefined
      }
      case 'try': {
        try {
          return this.execBlock(st.block, new Scope(scope))
        } catch (err) {
          if (!st.handler) throw err
          if (err instanceof ScriptError && /took too long|too much recursion/i.test(err.message)) throw err
          const s = new Scope(scope)
          if (st.param) {
            const v = err instanceof ThrowSignal ? err.value : new JsObject({ message: (err as Error).message, name: 'Error' })
            s.vars.set(st.param, v)
          }
          return this.execBlock(st.handler, s)
        } finally {
          if (st.finalizer) this.execBlock(st.finalizer, new Scope(scope))
        }
      }
      case 'empty':
        return undefined
    }
  }

  // ---- expressions

  eval(e: Expr, scope: Scope): JsValue {
    this.tick()
    switch (e.t) {
      case 'lit':
        return e.v
      case 'regex':
        try {
          return new RegExp(e.source, e.flags.replace(/[^gimsuy]/g, ''))
        } catch {
          throw new ScriptError(`Invalid regular expression /${e.source}/`)
        }
      case 'id': {
        const s = scope.lookup(e.name)
        if (s) return s.vars.get(e.name)
        const g = this.globalObject?.get(e.name)
        if (g !== undefined) return g
        throw new ScriptError(`${e.name} is not defined`, true)
      }
      case 'this':
        return this.thisValue
      case 'arr':
        return e.items.map((x) => this.eval(x, scope))
      case 'obj': {
        const o = new JsObject()
        for (const p of e.props) o.props.set(p.key, this.eval(p.value, scope))
        return o
      }
      case 'fn': {
        const fn = new JsFunction(e.name ?? 'anonymous', e.params, e.body, scope)
        return fn
      }
      case 'member':
        return this.getMember(this.eval(e.obj, scope), this.propKey(e, scope))
      case 'call':
        return this.evalCall(e, scope)
      case 'new': {
        const callee = this.eval(e.callee, scope)
        const args = e.args.map((a) => this.eval(a, scope))
        if (callee instanceof NativeFunction) return callee.construct ? callee.construct(args, this) : callee.fn(undefined, args, this)
        if (callee instanceof JsFunction) {
          const obj = new JsObject()
          const r = this.call(callee, obj, args)
          return isObjectLike(r) ? r : obj
        }
        throw new ScriptError(`${toStr(callee)} is not a constructor`)
      }
      case 'unary': {
        if (e.op === 'typeof') {
          if (e.arg.t === 'id' && !scope.lookup(e.arg.name) && this.globalObject?.get(e.arg.name) === undefined) return 'undefined'
          return typeOf(this.eval(e.arg, scope))
        }
        if (e.op === 'delete') {
          if (e.arg.t === 'member') {
            const obj = this.eval(e.arg.obj, scope)
            const key = this.propKey(e.arg, scope)
            if (obj instanceof JsObject) obj.props.delete(key)
          }
          return true
        }
        const v = this.eval(e.arg, scope)
        switch (e.op) {
          case '!':
            return !truthy(v)
          case '-':
            return -toNumber(v)
          case '+':
            return toNumber(v)
          case '~':
            return ~toNumber(v)
          case 'void':
            return undefined
        }
        throw new ScriptError(`Unsupported operator ${e.op}`, true)
      }
      case 'update': {
        const old = toNumber(this.eval(e.target, scope))
        const nv = e.op === '++' ? old + 1 : old - 1
        this.assign(e.target, nv, scope)
        return e.prefix ? nv : old
      }
      case 'bin':
        return this.binary(e.op, this.eval(e.left, scope), this.eval(e.right, scope))
      case 'logic': {
        const l = this.eval(e.left, scope)
        if (e.op === '&&') return truthy(l) ? this.eval(e.right, scope) : l
        if (e.op === '||') return truthy(l) ? l : this.eval(e.right, scope)
        return l === null || l === undefined ? this.eval(e.right, scope) : l
      }
      case 'cond':
        return truthy(this.eval(e.test, scope)) ? this.eval(e.cons, scope) : this.eval(e.alt, scope)
      case 'assign': {
        if (e.op === '=') {
          const v = this.eval(e.value, scope)
          this.assign(e.target, v, scope)
          return v
        }
        const cur = this.eval(e.target, scope)
        const rhs = this.eval(e.value, scope)
        const v = this.binary(e.op.slice(0, -1), cur, rhs)
        this.assign(e.target, v, scope)
        return v
      }
      case 'seq': {
        let v: JsValue = undefined
        for (const x of e.items) v = this.eval(x, scope)
        return v
      }
    }
  }

  private propKey(e: Extract<Expr, { t: 'member' }>, scope: Scope): string {
    if (!e.computed) return String((e.prop as { v: string }).v)
    const k = this.eval(e.prop, scope)
    return typeof k === 'number' ? String(k) : toStr(k)
  }

  private evalCall(e: Extract<Expr, { t: 'call' }>, scope: Scope): JsValue {
    let thisArg: JsValue = undefined
    let fn: JsValue
    if (e.callee.t === 'member') {
      thisArg = this.eval(e.callee.obj, scope)
      const key = this.propKey(e.callee, scope)
      fn = this.getMember(thisArg, key)
      if (!isCallable(fn)) {
        if (thisArg instanceof HostObject || thisArg instanceof JsObject)
          throw new ScriptError(`${key}() is not supported`, thisArg instanceof HostObject)
        throw new ScriptError(`${key} is not a function`)
      }
    } else {
      fn = this.eval(e.callee, scope)
      if (!isCallable(fn)) throw new ScriptError(`${e.callee.t === 'id' ? e.callee.name : toStr(fn)} is not a function`)
      if (e.callee.t === 'id' && !scope.lookup(e.callee.name)) thisArg = this.globalObject ?? undefined
    }
    const args = e.args.map((a) => this.eval(a, scope))
    return this.call(fn, thisArg, args)
  }

  getMember(obj: JsValue, key: string): JsValue {
    if (obj === null || obj === undefined) throw new ScriptError(`Cannot read “${key}” of ${obj}`)
    if (typeof obj === 'string') return stringMember(obj, key)
    if (typeof obj === 'number') return numberMember(obj, key)
    if (typeof obj === 'boolean') return key === 'toString' ? nativeMethod('toString', () => String(obj)) : undefined
    if (Array.isArray(obj)) return arrayMember(obj, key)
    if (obj instanceof JsObject) {
      if (obj.props.has(key)) return obj.props.get(key)
      if (key === 'hasOwnProperty') return nativeMethod(key, (_t, a) => obj.props.has(toStr(a[0])))
      if (key === 'toString') return nativeMethod(key, () => '[object Object]')
      return undefined
    }
    if (obj instanceof HostObject) return obj.get(key)
    if (obj instanceof RegExp) return regexMember(obj, key)
    if (isCallable(obj)) {
      if (key === 'call') return nativeMethod('call', (_t, a, i) => i.call(obj, a[0], a.slice(1)))
      if (key === 'apply') return nativeMethod('apply', (_t, a, i) => i.call(obj, a[0], Array.isArray(a[1]) ? a[1] : []))
      if (key === 'name') return obj.name
      if (obj instanceof NativeFunction && Object.prototype.hasOwnProperty.call(obj.statics, key)) return obj.statics[key]
      return undefined
    }
    return undefined
  }

  private setMember(obj: JsValue, key: string, value: JsValue) {
    if (obj === null || obj === undefined) throw new ScriptError(`Cannot set “${key}” of ${obj}`)
    if (Array.isArray(obj)) {
      if (key === 'length') obj.length = Math.max(0, Math.min(100000, toNumber(value)))
      else if (/^\d+$/.test(key) && Number(key) < 100000) obj[Number(key)] = value
      return
    }
    if (obj instanceof JsObject) {
      obj.props.set(key, value)
      return
    }
    if (obj instanceof HostObject) {
      obj.set(key, value)
      return
    }
    // Assigning to primitives is silently ignored in sloppy-mode JavaScript.
  }

  private assign(target: Expr, value: JsValue, scope: Scope) {
    if (target.t === 'id') {
      const s = scope.lookup(target.name) ?? scope.root()
      s.vars.set(target.name, value)
      return
    }
    if (target.t === 'member') {
      const obj = this.eval(target.obj, scope)
      this.setMember(obj, this.propKey(target, scope), value)
      return
    }
    throw new ScriptError('Invalid assignment target')
  }

  binary(op: string, a: JsValue, b: JsValue): JsValue {
    switch (op) {
      case '+': {
        const pa = toPrimitive(a)
        const pb = toPrimitive(b)
        if (typeof pa === 'string' || typeof pb === 'string') return String(pa) + String(pb)
        return Number(pa) + Number(pb)
      }
      case '-':
        return toNumber(a) - toNumber(b)
      case '*':
        return toNumber(a) * toNumber(b)
      case '/':
        return toNumber(a) / toNumber(b)
      case '%':
        return toNumber(a) % toNumber(b)
      case '**':
        return toNumber(a) ** toNumber(b)
      case '==':
        return looseEquals(a, b)
      case '!=':
        return !looseEquals(a, b)
      case '===':
        return strictEquals(a, b)
      case '!==':
        return !strictEquals(a, b)
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const pa = toPrimitive(a)
        const pb = toPrimitive(b)
        if (typeof pa === 'string' && typeof pb === 'string') {
          return op === '<' ? pa < pb : op === '>' ? pa > pb : op === '<=' ? pa <= pb : pa >= pb
        }
        const na = Number(pa)
        const nb = Number(pb)
        return op === '<' ? na < nb : op === '>' ? na > nb : op === '<=' ? na <= nb : na >= nb
      }
      case '&':
        return toNumber(a) & toNumber(b)
      case '|':
        return toNumber(a) | toNumber(b)
      case '^':
        return toNumber(a) ^ toNumber(b)
      case '<<':
        return toNumber(a) << toNumber(b)
      case '>>':
        return toNumber(a) >> toNumber(b)
      case '>>>':
        return toNumber(a) >>> toNumber(b)
      case 'in':
        if (b instanceof JsObject) return b.props.has(toStr(a))
        if (Array.isArray(b)) return toNumber(a) < b.length
        if (b instanceof HostObject) return b.has(toStr(a))
        throw new ScriptError('Cannot use “in” here')
      case 'instanceof':
        if (b instanceof NativeFunction) {
          if (b.name === 'Array') return Array.isArray(a)
          if (b.name === 'Date') return a instanceof JsDate
          if (b.name === 'RegExp') return a instanceof RegExp
          if (b.name === 'Object') return isObjectLike(a)
        }
        return false
    }
    throw new ScriptError(`Unsupported operator ${op}`, true)
  }
}


// ---- standard library ------------------------------------------------------------------------

export function toDate(a: JsValue[]): Date {
  if (!a.length) return new Date()
  if (a.length === 1) {
    const v = a[0]
    if (v instanceof JsDate) return new Date(v.date.getTime())
    if (typeof v === 'string') return new Date(v)
    return new Date(toNumber(v))
  }
  const n = a.map(toNumber)
  return new Date(n[0], n[1], n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0)
}

function makeArray(a: JsValue[]): JsValue[] {
  if (a.length === 1 && typeof a[0] === 'number') return new Array<JsValue>(Math.max(0, Math.min(100000, a[0]))).fill(undefined)
  return [...a]
}

function makeRegExp(a: JsValue[]): RegExp {
  const src = a[0] instanceof RegExp ? a[0].source : toStr(a[0] ?? '')
  try {
    return new RegExp(src, toStr(a[1] ?? '').replace(/[^gimsuy]/g, ''))
  } catch {
    throw new ScriptError(`Invalid regular expression /${src}/`)
  }
}

/** Math, Number, String, Array, Date, RegExp, parseInt... available to every script. */
export function standardGlobals(): Record<string, JsValue> {
  const nf = (name: string, fn: (args: JsValue[]) => JsValue, construct?: (args: JsValue[]) => JsValue, statics?: Record<string, JsValue>) =>
    new NativeFunction(name, (_t, a) => fn(a), construct ? (a) => construct(a) : undefined, statics)
  const math = new JsObject({ PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, SQRT2: Math.SQRT2, LOG10E: Math.LOG10E })
  const fns = ['abs', 'ceil', 'floor', 'round', 'sqrt', 'pow', 'min', 'max', 'log', 'exp', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'trunc', 'sign', 'random', 'log10'] as const
  for (const k of fns) {
    const f = Math[k] as (...x: number[]) => number
    math.props.set(k, nf(k, (a) => f(...a.map(toNumber))))
  }
  const parseIntFn = nf('parseInt', (a) => parseInt(toStr(a[0]), a[1] === undefined ? undefined : toNumber(a[1])))
  const parseFloatFn = nf('parseFloat', (a) => parseFloat(toStr(a[0])))
  return {
    Math: math,
    parseInt: parseIntFn,
    parseFloat: parseFloatFn,
    isNaN: nf('isNaN', (a) => Number.isNaN(toNumber(a[0]))),
    isFinite: nf('isFinite', (a) => Number.isFinite(toNumber(a[0]))),
    NaN: NaN,
    Infinity: Infinity,
    Number: nf('Number', (a) => (a.length ? toNumber(a[0]) : 0), undefined, {
      MAX_VALUE: Number.MAX_VALUE,
      MIN_VALUE: Number.MIN_VALUE,
      NaN: NaN,
      POSITIVE_INFINITY: Infinity,
      NEGATIVE_INFINITY: -Infinity,
      isNaN: nf('isNaN', (a) => typeof a[0] === 'number' && Number.isNaN(a[0])),
      isInteger: nf('isInteger', (a) => Number.isInteger(a[0])),
      isFinite: nf('isFinite', (a) => typeof a[0] === 'number' && Number.isFinite(a[0])),
      parseFloat: parseFloatFn,
      parseInt: parseIntFn
    }),
    String: nf('String', (a) => (a.length ? toStr(a[0]) : ''), undefined, {
      fromCharCode: nf('fromCharCode', (a) => String.fromCharCode(...a.map(toNumber)))
    }),
    Boolean: nf('Boolean', (a) => truthy(a[0])),
    Array: nf('Array', makeArray, makeArray, { isArray: nf('isArray', (a) => Array.isArray(a[0])) }),
    Date: nf('Date', () => new Date().toString(), (a) => new JsDate(toDate(a)), {
      now: nf('now', () => Date.now()),
      parse: nf('parse', (a) => Date.parse(toStr(a[0])))
    }),
    RegExp: nf('RegExp', makeRegExp, makeRegExp),
    Object: nf('Object', () => new JsObject(), () => new JsObject(), {
      keys: nf('keys', (a) => (a[0] instanceof JsObject ? [...a[0].props.keys()] : Array.isArray(a[0]) ? a[0].map((_x, i) => String(i)) : []))
    }),
    Error: nf(
      'Error',
      (a) => new JsObject({ name: 'Error', message: toStr(a[0] ?? '') }),
      (a) => new JsObject({ name: 'Error', message: toStr(a[0] ?? '') })
    ),
    encodeURIComponent: nf('encodeURIComponent', (a) => encodeURIComponent(toStr(a[0]))),
    decodeURIComponent: nf('decodeURIComponent', (a) => {
      try {
        return decodeURIComponent(toStr(a[0]))
      } catch {
        return toStr(a[0])
      }
    })
  }
}
