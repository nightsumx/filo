// rewind: the desktop app's "ask again from here". Moves the session back to before a user prompt in
// the same session file, as pi's /tree does, instead of forking a new session for every retry. The
// answers after the prompt stay in the file as an abandoned branch.
//
// Not a capability: the app loads it whatever capabilities are on. RPC has no command for moving
// in the tree; extension commands get `ctx.navigateTree`.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const COMMAND = 'gui-rewind'
const MARK = 'gui-rewind'

export default function rewind(pi: ExtensionAPI) {
    pi.registerCommand(COMMAND, {
        description: 'Internal: go back to before a prompt',
        handler: async (args, ctx) => {
            const entryId = args.trim()
            const entry = ctx.sessionManager.getEntry(entryId)
            if (entry?.type !== 'message' || entry.message.role !== 'user')
                return ctx.ui.notify('找不到这条提问', 'error')
            const { cancelled } = await ctx.navigateTree(entryId, { summarize: false })
            if (cancelled)
                return
            // pi keeps the new position in memory only: resumed from the file (restart, idle stop) it
            // would be back on the abandoned branch. An entry at the new position persists it; it is
            // outside the model's context.
            pi.appendEntry(MARK, { from: entryId })
        },
    })
}
