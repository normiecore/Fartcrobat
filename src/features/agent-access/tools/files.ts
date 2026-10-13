// Agent tools: open_document, save_document, export_document, close_document, extract_pages, combine_files.
import type { AgentToolName } from '@shared/agent/tools'
import type { ToolHandler } from './common'

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {}
