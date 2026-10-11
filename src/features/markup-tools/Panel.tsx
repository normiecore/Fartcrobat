/** The "Add comments" tool panel (left pane), laid out like Acrobat's Comment tool. */
import {
  Checkbox,
  displayShortcut,
  registry,
  runCommand,
  Section,
  setPrefs,
  setTool,
  ToolPanelFrame,
  ToolRow,
  useApp,
  usePrefs,
  type CommandDefinition,
  type DocumentModel
} from '@renderer/sdk'
import { FOREIGN_COMMANDS, FOREIGN_TOOLS, SECTIONS, TOOLS } from './tools'

function firstShortcut(s: string | string[] | undefined): string | undefined {
  const v = Array.isArray(s) ? s[0] : s
  return v ? displayShortcut(v) : undefined
}

function commandLabel(cmd: CommandDefinition, doc: DocumentModel | null) {
  return typeof cmd.label === 'function' ? cmd.label({ doc }) : cmd.label
}

function commandEnabled(cmd: CommandDefinition, doc: DocumentModel | null) {
  if (cmd.requiresDocument !== false && !doc) return false
  try {
    return cmd.enabled ? cmd.enabled({ doc }) : true
  } catch {
    return false
  }
}

export function CommentPanel({ doc }: { doc: DocumentModel | null }) {
  const toolId = useApp((s) => s.toolId)
  const keep = usePrefs().keepToolSelected
  // Re-render when the document changes so command states (e.g. Show/Hide Comments) stay current.
  useApp((s) => s.activeDocId)
  const choose = (id: string) => setTool(toolId === id ? 'select' : id)
  const foreignTools = FOREIGN_TOOLS.map((id) => registry.tools.get(id)).filter((t) => !!t)
  const commands = FOREIGN_COMMANDS.map((id) => registry.commands.get(id)).filter((c) => !!c)

  return (
    <ToolPanelFrame
      title="Add comments"
      footer={
        <div className="fc-markup-tools-panel-footer">
          <Checkbox checked={keep} onChange={(v) => void setPrefs({ keepToolSelected: v })} label="Keep tool selected after adding a comment" />
        </div>
      }
    >
      <div className="fc-markup-tools-panel">
        {SECTIONS.map((sec) => (
          <Section key={sec.id} title={sec.label}>
            {TOOLS.filter((t) => t.section === sec.id).map((t) => (
              <ToolRow
                key={t.id}
                icon={t.icon}
                label={t.label}
                shortcut={t.shortcut ? displayShortcut(t.shortcut) : undefined}
                active={toolId === t.id}
                disabled={!doc}
                onClick={() => choose(t.id)}
              />
            ))}
          </Section>
        ))}
        {foreignTools.length > 0 && (
          <Section title="Stamps & measure">
            {foreignTools.map((t) => (
              <ToolRow
                key={t.id}
                icon={t.icon}
                label={t.label}
                shortcut={t.shortcut ? displayShortcut(t.shortcut) : undefined}
                active={toolId === t.id}
                disabled={!doc}
                onClick={() => choose(t.id)}
              />
            ))}
          </Section>
        )}
        {commands.length > 0 && (
          <Section title="Manage comments">
            {commands.map((c) => (
              <ToolRow
                key={c.id}
                icon={c.icon}
                label={commandLabel(c, doc)}
                shortcut={firstShortcut(c.shortcut)}
                disabled={!commandEnabled(c, doc)}
                onClick={() => void runCommand(c.id)}
              />
            ))}
          </Section>
        )}
      </div>
    </ToolPanelFrame>
  )
}
