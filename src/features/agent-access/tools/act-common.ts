// Small pure helpers shared by the agent tools that change things. No DOM or app imports, so the
// argument checks can be unit-tested in Node; handlers turn InvalidArgs into ToolError.

/** An argument the agent got wrong. Handlers report it as "[invalid_args] message". */
export class InvalidArgs extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgs'
  }
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`
}

/** 0-based page indices as 1-based ranges: [0, 1, 2, 4] -> "1-3, 5". */
export function pageList(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i] + 1}-${sorted[j] + 1}` : `${sorted[i] + 1}`)
    i = j
  }
  return parts.join(', ')
}

/** "page 3" or "pages 1-3, 5". */
export function pagesPhrase(indices: number[]): string {
  const n = new Set(indices).size
  return `${n === 1 ? 'page' : 'pages'} ${pageList(indices)}`
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** An optional string argument. */
export function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new InvalidArgs(`${name} must be a string`)
  return v
}

/** An optional boolean argument. */
export function optBoolean(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new InvalidArgs(`${name} must be true or false`)
  return v
}

/** An optional whole number argument within [min, max]. */
export function optInteger(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new InvalidArgs(`${name} must be a whole number`)
  if (v < min || v > max) throw new InvalidArgs(`${name} must be from ${min} to ${max}`)
  return v
}

/** An array of annotation ids (whole numbers). */
export function idList(v: unknown, name: string): number[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x)))
    throw new InvalidArgs(`${name} must be a list of ids (whole numbers)`)
  return [...new Set(v as number[])]
}

/** "#ffd400" (or "ffd400", "#fd0") as "#FFD400"; undefined when not given. */
export function colorArg(v: unknown, name = 'color'): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new InvalidArgs(`${name} must be a hex colour such as "#ffd400"`)
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim())
  if (!m) throw new InvalidArgs(`${name} must be a hex colour such as "#ffd400"`)
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return `#${hex.toUpperCase()}`
}
