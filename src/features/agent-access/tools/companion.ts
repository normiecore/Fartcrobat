import { exchangeCompanion } from '../ui/companionStore'
import { appLabel } from '../ui/store'
import { BOOT, ToolError, type ToolHandler } from './common'

export const handlers: { companion_chat: ToolHandler } = {
  companion_chat: async (args, ctx) => {
    if (args.session !== undefined && (typeof args.session !== 'string' || args.session.length > 100))
      throw new ToolError('invalid_args', 'Invalid session.')
    if (args.message !== undefined && typeof args.message !== 'string')
      throw new ToolError('invalid_args', 'message must be text.')
    if (args.reply_to !== undefined && (!Number.isSafeInteger(args.reply_to) || Number(args.reply_to) < 1))
      throw new ToolError('invalid_args', 'reply_to must be a message id.')
    const wait = args.wait_seconds ?? 25
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0 || wait > 30)
      throw new ToolError('invalid_args', 'wait_seconds must be from 0 to 30.')
    if (!args.session && (args.message !== undefined || args.reply_to !== undefined))
      throw new ToolError('invalid_args', 'Join first without message or reply_to.')
    try {
      return {
        data: await exchangeCompanion({
          connectionId: ctx.request.connectionId,
          name: appLabel(ctx.request.client.name),
          session: (args.session as string) || `${ctx.request.windowId}-chat-${BOOT}-${crypto.randomUUID()}`,
          joining: !args.session,
          message: args.message as string | undefined,
          replyTo: args.reply_to as number | undefined,
          signal: ctx.signal,
          waitMs: wait * 1000
        })
      }
    } catch (e) {
      throw new ToolError(ctx.signal.aborted ? 'aborted' : 'invalid_args', (e as Error).message)
    }
  }
}
