// Agent tools: show_in_app.
import type { AgentToolName } from '@shared/agent/tools'
import type { ToolHandler } from './common'

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {}
