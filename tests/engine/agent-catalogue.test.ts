// Agent access: the tool catalogue (src/shared/agent/tools.ts) the shim advertises and the
// window's handlers for it (src/features/agent-access/tools/).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_TOOLS, AGENT_TOOL_NAMES, type JsonSchema } from '@shared/agent/tools'

let handlers: typeof import('@features/agent-access/tools').TOOL_HANDLERS

beforeAll(async () => {
  vi.stubGlobal('window', {})
  await import('@renderer/app/registry')
  ;({ TOOL_HANDLERS: handlers } = await import('@features/agent-access/tools'))
})

/** Every property of a schema, nested ones included, with its path. */
function properties(schema: JsonSchema, path = ''): [string, JsonSchema][] {
  const out: [string, JsonSchema][] = []
  for (const [name, s] of Object.entries(schema.properties ?? {})) {
    out.push([`${path}${name}`, s], ...properties(s, `${path}${name}.`))
    if (s.items) out.push(...properties(s.items, `${path}${name}[].`))
  }
  return out
}

describe('agent tool catalogue', () => {
  it('has unique names and closed object schemas', () => {
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOLS.length)
    for (const t of AGENT_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z_]*$/)
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.additionalProperties).toBe(false)
      for (const name of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties)).toContain(name)
      expect(t.description.length).toBeGreaterThan(20)
    }
  })

  it('takes no secrets: passwords and PINs are typed by the person in Fartcrobat', () => {
    // A yes/no option such as protect_document's require_open_password carries no secret.
    const secretLike = AGENT_TOOLS.flatMap((t) =>
      properties(t.inputSchema)
        .filter(([name, s]) => /pass|pin|secret|token/i.test(name.split(/[.[\]]+/).filter(Boolean).pop()!) && s.type !== 'boolean')
        .map(([name]) => `${t.name}.${name}`)
    )
    expect(secretLike).toEqual([])
  })

  it('has a handler for every tool and none for tools it does not advertise', () => {
    expect(Object.keys(handlers).filter((n) => !AGENT_TOOL_NAMES.includes(n as never))).toEqual([])
    // wait_for_result answers for another call rather than acting on a document, so the window's
    // runner may answer it without a handler.
    expect(AGENT_TOOL_NAMES.filter((n) => !handlers[n] && n !== 'wait_for_result')).toEqual([])
  })
})
