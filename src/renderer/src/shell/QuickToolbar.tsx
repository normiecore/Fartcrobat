import { registry } from '../app/registry'
import { useApp } from '../app/store'
import { setTool } from '../app/actions'
import { displayShortcut, runCommand, commandLabel } from '../app/commands'

/** Vertical floating toolbar at the left edge of the document (Acrobat's quick actions). */
export function QuickToolbar() {
  const toolId = useApp((s) => s.toolId)
  const entries = registry.quickTools
  if (!entries.length) return null
  return (
    <div className="shell-quicktools" role="toolbar" aria-label="Quick tools" aria-orientation="vertical">
      {entries.map((e) => {
        const tool = registry.tools.get(e.id)
        if (tool) {
          return (
            <button
              key={e.id}
              className={`shell-quicktool ${toolId === tool.id ? 'is-active' : ''}`}
              title={tool.shortcut ? `${tool.label} (${displayShortcut(tool.shortcut)})` : tool.label}
              aria-label={tool.label}
              aria-pressed={toolId === tool.id}
              onClick={() => setTool(toolId === tool.id && tool.id !== 'select' ? 'select' : tool.id)}
            >
              <tool.icon size={20} />
            </button>
          )
        }
        const cmd = registry.commands.get(e.id)
        if (!cmd || !cmd.icon) return null
        const Icon = cmd.icon
        return (
          <button key={e.id} className="shell-quicktool" title={commandLabel(cmd)} aria-label={commandLabel(cmd)} onClick={() => void runCommand(cmd.id)}>
            <Icon size={20} />
          </button>
        )
      })}
    </div>
  )
}
