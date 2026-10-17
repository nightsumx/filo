// builtins: pi's own editor commands (/compact, /tree, /fork, …) for the desktop app's pi. The terminal
// handles them in its editor; RPC runs only extension commands, so typed in the app they would reach
// the model as text. These are the same operations through the extension API, with the choices asked
// through ctx.ui, which the app shows in the thread. Commands that are the app's own (/new opens a
// tab, /settings, /copy) stay in the app.
//
// Also the app's "ask again from here" (/gui-rewind): /tree to before a prompt, without asking; and its
// "reload extensions and skills" (/gui-reload), which only an extension command's ctx can do.
//
// Not a capability: the app loads it whatever capabilities are on; pi-cc-tui does not load it.
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { GuiCommands } from '../protocol'
import { thinkingLevels } from '../lib/thinking.ts'

const MARK = 'gui-rewind'
const RELOAD_COMMAND: GuiCommands['reload'] = 'gui-reload'

const textOf = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''

const oneLine = (text: string) => {
    const line = text.split('\n').find(l => l.trim())?.trim() ?? ''
    return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** ctx.ui.select over labelled values; numbered so equal labels stay apart. */
async function pick<T>(ctx: ExtensionCommandContext, title: string, items: { label: string, value: T }[]): Promise<T | undefined> {
    const labels = items.map((item, i) => `${i + 1}. ${item.label}`)
    const choice = await ctx.ui.select(title, labels)
    return items[labels.indexOf(choice ?? '')]?.value
}

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

    pi.registerCommand('gui-rewind', {
        description: 'Internal: go back to before a prompt',
        handler: async (args, ctx) => {
            const entry = ctx.sessionManager.getEntry(args.trim())
            if (entry?.type !== 'message' || entry.message.role !== 'user')
                return ctx.ui.notify('找不到这条提问', 'error')
            await navigate(ctx, entry.id, { summarize: false })
        },
    })

    pi.registerCommand('compact', {
        description: '压缩上下文，后面可以写要保留什么',
        // Failures arrive as compaction_end, which the app shows.
        handler: (args, ctx) => new Promise(resolve => ctx.compact({ customInstructions: args.trim() || undefined, onComplete: () => resolve(), onError: () => resolve() })),
    })

    pi.registerCommand('name', {
        description: '给会话命名',
        handler: async (args, ctx) => {
            const name = (args.trim() || await ctx.ui.input('会话名称', pi.getSessionName()))?.trim()
            if (name)
                pi.setSessionName(name)
        },
    })

    pi.registerCommand('model', {
        description: '切换模型，后面可以写 provider/id',
        handler: async (args, ctx) => {
            const query = args.trim()
            const key = (m: { provider: string, id: string }) => `${m.provider}/${m.id}`
            const models = ctx.modelRegistry.getAvailable()
            const exact = models.find(m => key(m) === query || m.id === query)
            const options = models.map(key).filter(k => k.includes(query))
            if (!exact && !options.length)
                return ctx.ui.notify(`没有可用的模型叫 ${query}`, 'error')
            const picked = exact ? key(exact) : await ctx.ui.select(`模型（现在：${ctx.model ? key(ctx.model) : '无'}）`, options)
            const model = models.find(m => key(m) === picked)
            if (model && !(await pi.setModel(model)))
                ctx.ui.notify(`${picked} 没有可用的 API key`, 'error')
        },
    })

    pi.registerCommand('thinking', {
        description: '思考强度，后面可以写 off / low / medium / high …',
        handler: async (args, ctx) => {
            const levels = thinkingLevels(ctx.model)
            const choice = levels.find(l => l === args.trim()) ?? await ctx.ui.select(`思考强度（现在：${pi.getThinkingLevel()}）`, levels)
            const level = levels.find(l => l === choice)
            if (level)
                pi.setThinkingLevel(level)
        },
    })

    pi.registerCommand('tree', {
        description: '回到会话树里的任意一处（切换分支）',
        handler: async (_args, ctx) => {
            if (busy(ctx))
                return
            const leaf = ctx.sessionManager.getLeafId()
            const branch = new Set(ctx.sessionManager.getBranch().map(e => e.id))
            const items = ctx.sessionManager.getEntries().flatMap((e) => {
                if (e.type !== 'message' || e.id === leaf || (e.message.role !== 'user' && e.message.role !== 'assistant'))
                    return []
                const text = oneLine(textOf(e.message.content))
                return text ? [{ label: `${branch.has(e.id) ? '●' : '○'} ${e.message.role === 'user' ? '提问' : '回答'}：${text}`, value: e }] : []
            })
            if (!items.length)
                return ctx.ui.notify('会话里还没有可以回去的地方', 'info')
            const entry = await pick(ctx, '回到哪里（● 是当前分支；选提问会回到它之前，提问放回输入框）', items)
            if (!entry)
                return
            const summary = await ctx.ui.select('离开的这一支要总结吗', ['不总结', '总结', '按说明总结'])
            if (!summary)
                return
            const customInstructions = summary === '按说明总结' ? await ctx.ui.editor('总结时要注意什么') : undefined
            if (summary === '按说明总结' && customInstructions === undefined)
                return
            if (await navigate(ctx, entry.id, { summarize: summary !== '不总结', customInstructions }) && entry.message.role === 'user')
                ctx.ui.setEditorText(textOf(entry.message.content))
        },
    })

    pi.registerCommand('fork', {
        description: '从之前的一条提问分叉出新会话',
        handler: async (_args, ctx) => {
            if (busy(ctx))
                return
            // Every branch's prompts, oldest first, as pi's own /fork lists them.
            const items = ctx.sessionManager.getEntries().flatMap(e => e.type === 'message' && e.message.role === 'user' && oneLine(textOf(e.message.content))
                ? [{ label: oneLine(textOf(e.message.content)), value: { id: e.id, text: textOf(e.message.content) } }]
                : [])
            if (!items.length)
                return ctx.ui.notify('还没有可以分叉的提问', 'info')
            const prompt = await pick(ctx, '从哪条提问分叉（提问放回输入框）', items)
            if (prompt)
                await ctx.fork(prompt.id, { withSession: async c => c.ui.setEditorText(prompt.text) })
        },
    })

    pi.registerCommand('clone', {
        description: '在当前位置复制出一个新会话',
        handler: async (_args, ctx) => {
            if (busy(ctx))
                return
            const leaf = ctx.sessionManager.getLeafId()
            if (!leaf)
                return ctx.ui.notify('还没有可以复制的内容', 'info')
            await ctx.fork(leaf, { position: 'at' })
        },
    })

    pi.registerCommand('reload', {
        description: '重新加载扩展、技能、提示模板和上下文文件',
        handler: async (_args, ctx) => {
            if (busy(ctx))
                return
            await ctx.reload()
            ctx.ui.notify('已重新加载', 'info')
        },
    })

    // The app's "reload extensions and skills" menu item: the same as /reload, but the app words the success itself.
    pi.registerCommand(RELOAD_COMMAND, {
        description: 'Internal: reload extensions, skills, prompt templates and context files',
        handler: async (_args, ctx) => {
            if (busy(ctx))
                return
            await ctx.reload()
        },
    })
}
