// Agent tools: apply_redactions, sign_document, protect_document, remove_security.
import type { AgentToolName } from '@shared/agent/tools'
import type { ToolHandler } from './common'

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {}
