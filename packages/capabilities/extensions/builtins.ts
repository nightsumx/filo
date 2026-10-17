// builtins: what the desktop app's pi needs from an extension command's ctx, which RPC gives only there.
// The app calls them itself (thread.guiCommand), the user never types them:
//   /gui-rewind     "ask again from here": /tree to before a prompt, without asking
//   /gui-rewind-to  "rewind to here" on an answer: /tree to an assistant entry, optionally summarising the branch left
//   /gui-clone      "clone thread": /clone
//   /gui-reload     "reload extensions and skills"
// pi's other editor commands (/compact, /model, /tree, …) have a control in the app and are not served.
//
// Not a capability: the app loads it whatever capabilities are on; pi-cc-tui does not load it.
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { GuiCommands } from '../protocol'

const MARK = 'gui-rewind'
const RELOAD_COMMAND: GuiCommands['reload'] = 'gui-reload'

function busy(ctx: ExtensionCommandContext) {
    if (ctx.isIdle())
        return false
    ctx.ui.notify('等这一轮结束再操作会话', 'warning')
    return true
}

export default function builtins(pi: ExtensionAPI) {
    /**
     * pi keeps a new tree position in memory only: resumed from the file (restart, idle stop) it would
     * be back on the old branch. An entry at the new position persists it; it is outside the model's context.
     */
    const navigate = async (ctx: ExtensionCommandContext, entryId: string, options: { summarize: boolean, customInstructions?: string }) => {
        const { cancelled } = await ctx.navigateTree(entryId, options)
        if (!cancelled)
            pi.appendEntry(MARK, { from: entryId })
        return !cancelled
    }

    const cloneHere = async (ctx: ExtensionCommandContext) => {
        if (busy(ctx))
            return
        const leaf = ctx.sessionManager.getLeafId()
        if (!leaf)
            return ctx.ui.notify('还没有可以复制的内容', 'info')
        await ctx.fork(leaf, { position: 'at' })
    }

    pi.registerCommand('gui-rewind', {
        description: 'Internal: go back to before a prompt',
        handler: async (args, ctx) => {
            const entry = ctx.sessionManager.getEntry(args.trim())
            if (entry?.type !== 'message' || entry.message.role !== 'user')
                return ctx.ui.notify('找不到这条提问', 'error')
            await navigate(ctx, entry.id, { summarize: false })
        },
    })

    // /tree onto an assistant answer: the leaf becomes it, so the answers after it are another branch (still in the file).
    pi.registerCommand('gui-rewind-to', {
        description: 'Internal: go back to just after an answer, optionally summarising the branch left',
        handler: async (args, ctx) => {
            if (busy(ctx))
                return
            const [id, flag] = args.trim().split(/\s+/)
            const entry = ctx.sessionManager.getEntry(id ?? '')
            if (entry?.type !== 'message' || entry.message.role !== 'assistant')
                return ctx.ui.notify('找不到这条回答', 'error')
            try {
                await navigate(ctx, entry.id, { summarize: flag === 'summarize' })
            }
            catch (error) {
                ctx.ui.notify(`回到这条回答失败：${error instanceof Error ? error.message : String(error)}`, 'error')
            }
        },
    })

    pi.registerCommand('gui-clone', {
        description: 'Internal: copy the current branch into a new session',
        handler: async (_args, ctx) => cloneHere(ctx),
    })

    // The app's "reload extensions and skills" menu item.
    pi.registerCommand(RELOAD_COMMAND, {
        description: 'Internal: reload extensions, skills, prompt templates and context files',
        handler: async (_args, ctx) => {
            if (busy(ctx))
                return
            await ctx.reload()
        },
    })
}
