// Every agent tool's handler, by name (see src/shared/agent/tools.ts for the definitions).
import type { AgentToolName } from '@shared/agent/tools'
import type { ToolHandler } from './common'
import { handlers as context } from './context'
import { handlers as view } from './view'
import { handlers as files } from './files'
import { handlers as edits } from './edits'
import { handlers as irreversible } from './irreversible'

export const TOOL_HANDLERS: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  ...context,
  ...view,
  ...files,
  ...edits,
  ...irreversible
}
