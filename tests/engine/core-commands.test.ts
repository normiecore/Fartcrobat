// runCommand and editors registered with registerActiveEditor (no DOM, no engine).
import { beforeAll, describe, expect, it, vi } from 'vitest'

let commands: typeof import('@renderer/app/commands')

const order: string[] = []
const later = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  // the platform module reads the preload bridge from window when it loads
  vi.stubGlobal('window', {})
  commands = await import('@renderer/app/commands')
  const { registry } = await import('@renderer/app/registry')
  registry.register({
    id: 'test-editors',
    commands: [
      { id: 'test.rotate', label: 'Rotate', requiresDocument: false, run: () => void order.push('rotate') },
      {
        id: 'test.deleteBox',
        label: 'Delete Box',
        requiresDocument: false,
        keepEditing: true,
        run: () => void order.push('deleteBox')
      }
    ]
  })
})

describe('commands and text being edited in place', () => {
  it('commits every open editor before a command runs, and only open ones', async () => {
    order.length = 0
    const offSlow = commands.registerActiveEditor({
      commit: async () => {
        await later(20)
        order.push('text box')
      }
    })
    const offField = commands.registerActiveEditor({ commit: () => void order.push('form field') })
    await commands.runCommand('test.rotate')
    expect(order).toEqual(['form field', 'text box', 'rotate'])

    offSlow()
    offField()
    order.length = 0
    // with nothing being edited the command starts right away, in the same task
    const done = commands.runCommand('test.rotate')
    expect(order).toEqual(['rotate'])
    await done
  })

  it('leaves the editor open for commands that act on it', async () => {
    order.length = 0
    const off = commands.registerActiveEditor({ commit: () => void order.push('text box') })
    await commands.runCommand('test.deleteBox')
    expect(order).toEqual(['deleteBox'])
    off()
  })

  it('still runs the command when an editor cannot commit', async () => {
    order.length = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const off = commands.registerActiveEditor({
      commit: () => {
        throw new Error('invalid value')
      }
    })
    await commands.runCommand('test.rotate')
    expect(order).toEqual(['rotate'])
    expect(warn).toHaveBeenCalled()
    off()
    warn.mockRestore()
  })
})
