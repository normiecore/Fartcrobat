// Agent tools: add_annotations, update_annotations, reply_to_comment, set_form_values, mark_redactions, organize_pages, recognize_text, set_metadata, undo, redo.
import type { AgentToolName } from '@shared/agent/tools'
import type { ToolHandler } from './common'

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {}
