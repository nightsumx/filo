// approval: confirm tool calls that can change something before they run. The confirmation is an
// extension `select` whose title carries ApprovalRequest JSON, so the GUI can render a real prompt
// (and a subagent can forward its child's prompts unchanged). The mode is per session:
//   /gui-approval ask|edits|auto      switch mode (the GUI's mode picker)
//   --gui-approval <mode>             mode for sessions that never chose one
// The current mode goes down as status `gui-approval`; "always" choices last for the session.
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { ApprovalChoice, ApprovalMode, ApprovalRequest, GuiCommands } from '../shared/capabilities'
import path from 'node:path'

const COMMAND: GuiCommands['approval'] = 'gui-approval'
const STATUS = 'gui-approval'
const ENTRY = 'gui-approval'
const TITLE_PREFIX = 'gui-approval '
const MODES: ApprovalMode[] = ['ask', 'edits', 'auto']
const DEFAULT_MODE: ApprovalMode = 'ask'

/** Built-in tools that only read; pi does not annotate its own tools. */
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls'])
/** Built-in tools that write one file named by `path`. */
const FILE_TOOLS = new Set(['edit', 'write'])

interface State {
    mode: ApprovalMode
    /** Tool names, or `bash:<program>` for bash, approved for the rest of the session. */
    always: string[]
}

const isMode = (v: unknown): v is ApprovalMode => MODES.includes(v as ApprovalMode)

/** The program a bash command runs, e.g. `git` for `cd x && git push`; undefined for compound shell. */
export function bashProgram(command: string): string | undefined {
    const words = command.trim().split(/\s+/)
    // Leading env assignments (FOO=1 cmd) do not name the program.
    const first = words.find(w => !/^\w+=/.test(w))
    if (!first || /[|;&<>()$`]/.test(command))
        return undefined
    return path.basename(first)
}

/** One line describing the call, for the prompt. */
function summarize(event: ToolCallEvent): string {
    const input = event.input as Record<string, unknown>
    if (typeof input.command === 'string')
        return input.command
    if (typeof input.path === 'string')
        return input.path
    const json = JSON.stringify(input)
    return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

function scopeOf(event: ToolCallEvent): string {
    if (event.toolName === 'bash') {
        const program = bashProgram(String((event.input as any).command ?? ''))
        return program ? `bash:${program}` : ''
    }
    return event.toolName
}

function inside(cwd: string, file: string): boolean {
    const rel = path.relative(cwd, path.resolve(cwd, file))
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export default function (pi: ExtensionAPI) {
    pi.registerFlag(COMMAND, { type: 'string', description: 'Approval mode for new sessions: ask, edits or auto' })

    const state: State = { mode: DEFAULT_MODE, always: [] }

    // Status for the GUI; the event for other extensions (subagent starts its child in the same mode).
    const publish = (ctx: ExtensionContext) => {
        ctx.ui.setStatus(STATUS, state.mode)
        pi.events.emit('gui-approval:mode', state.mode)
    }
    const persist = () => pi.appendEntry<State>(ENTRY, { mode: state.mode, always: [...state.always] })

    /** Whether this call needs the user, from the mode, tool hints and earlier "always" choices. */
    function needsApproval(event: ToolCallEvent, cwd: string): boolean {
        if (state.mode === 'auto' || READ_ONLY.has(event.toolName))
            return false
        // MCP hint semantics, as pi's docs suggest: unannotated tools may change things.
        const hints = pi.getAllTools().find(t => t.name === event.toolName)?.annotations
        if (hints?.readOnlyHint && hints.destructiveHint !== true)
            return false
        if (hints && hints.destructiveHint === false && hints.openWorldHint === false)
            return false
        if (state.mode === 'edits' && FILE_TOOLS.has(event.toolName) && typeof (event.input as any).path === 'string' && inside(cwd, (event.input as any).path))
            return false
        const scope = scopeOf(event)
        return !(scope && state.always.includes(scope))
    }

    pi.on('session_start', async (_event, ctx) => {
        const saved = ctx.sessionManager.getBranch()
            .filter((e: any) => e.type === 'custom' && e.customType === ENTRY)
            .pop() as { data?: Partial<State> } | undefined
        const flag = pi.getFlag(COMMAND)
        state.mode = isMode(saved?.data?.mode) ? saved.data.mode : isMode(flag) ? flag : DEFAULT_MODE
        state.always = Array.isArray(saved?.data?.always) ? saved.data.always.filter(s => typeof s === 'string') : []
        publish(ctx)
    })

    pi.on('tool_call', async (event, ctx) => {
        if (!needsApproval(event, ctx.cwd))
            return undefined
        if (!ctx.hasUI)
            return { block: true, reason: `${event.toolName} needs the user's approval, and no UI is available.` }

        const scope = scopeOf(event)
        const request: ApprovalRequest = {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            summary: summarize(event),
            scope: scope.startsWith('bash:') ? scope.slice(5) : scope,
        }
        const options: ApprovalChoice[] = scope ? ['allow', 'always', 'deny'] : ['allow', 'deny']
        const choice = ctx.mode === 'tui'
            ? await ctx.ui.select(`Allow ${event.toolName}: ${request.summary}?`, options, { signal: ctx.signal })
            : await ctx.ui.select(TITLE_PREFIX + JSON.stringify(request), options, { signal: ctx.signal })

        if (choice === 'allow')
            return undefined
        if (choice === 'always') {
            state.always.push(scope)
            persist()
            return undefined
        }
        if (choice === 'deny')
            return { block: true, reason: `The user declined this ${event.toolName} call. Do not retry it as is; change approach or ask the user.` }
        return { block: true, reason: 'The approval prompt was dismissed.' }
    })

    pi.registerCommand(COMMAND, {
        description: 'Internal: set the approval mode',
        handler: async (args, ctx) => {
            const mode = args.trim()
            if (!isMode(mode))
                return ctx.ui.notify(`未知的确认模式：${mode}`, 'error')
            state.mode = mode
            persist()
            publish(ctx)
        },
    })
}
