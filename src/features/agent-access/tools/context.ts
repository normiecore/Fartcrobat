// Agent tools: list_documents, get_context, get_document_info, get_page_text, render_page, find_text, list_annotations, list_form_fields, list_signatures.
import type { AgentToolName } from '@shared/agent/tools'
import type { ToolHandler } from './common'

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {}
