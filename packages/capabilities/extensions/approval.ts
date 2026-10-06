// approval: confirm tool calls that can change something before they run. The confirmation is an
// extension `select` whose title carries ApprovalRequest JSON, so the GUI can render a real prompt
// (and a subagent can forward its child's prompts unchanged). The mode is per session:
//   /gui-approval ask|edits|auto       switch mode (the GUI's mode picker)
//   pi.events gui-approval:set <mode>  switch mode from another extension (pi-cc-tui's mode key)
//   --gui-approval <mode>              mode for sessions that never chose one (or PI_KIT_APPROVAL_MODE)
// The current mode goes down as status `gui-approval` and event `gui-approval:mode`. In the terminal
// the prompt is Claude Code's permission dialog. Both hosts follow Claude Code's rules:
// - No (or dismissing the prompt) ends the turn, and the rest of the tool batch is declined unasked,
//   so the user can say what to do instead of the model working around the refusal.
// - "Always" on a project file edit switches to the edits mode; on a bash program it lasts for the
//   session. Files outside the project are asked about one at a time.
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { ApprovalChoice, ApprovalMode, ApprovalRequest, GuiCommands } from '../protocol'
import path from 'node:path'
import process from 'node:process'
import { isReadOnlyCommand } from '../lib/readonly'
import { promptApproval } from '../tui/approval'
import { serialized } from '../tui/dialog'

const COMMAND: GuiCommands['approval'] = 'gui-approval'
const STATUS = 'gui-approval'
const ENTRY = 'gui-approval'
const TITLE_PREFIX = 'gui-approval '
const MODES: ApprovalMode[] = ['ask', 'edits', 'auto']
const DEFAULT_MODE: ApprovalMode = 'auto'
const SET_EVENT = 'gui-approval:set'
const MODE_EVENT = 'gui-approval:mode'
const ENV_MODE = 'PI_KIT_APPROVAL_MODE'

/** Built-in tools that only read; pi does not annotate its own tools. */
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls'])
/** Built-in tools that write one file named by `path`. */
const FILE_TOOLS = new Set(['edit', 'write'])
/** The scope of a project file edit: "always" switches to the edits mode. */
const EDITS_SCOPE = 'edits'

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

function inside(cwd: string, file: string): boolean {
    const rel = path.relative(cwd, path.resolve(cwd, file))
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const projectFile = (event: ToolCallEvent, cwd: string) =>
    FILE_TOOLS.has(event.toolName) && typeof (event.input as any).path === 'string' && inside(cwd, (event.input as any).path)

/** What "always" covers: `bash:<program>`, `edits`, a tool name, or '' when it isn't offered. */
function scopeOf(event: ToolCallEvent, cwd: string): string {
    if (event.toolName === 'bash') {
        const program = bashProgram(String((event.input as any).command ?? ''))
        return program ? `bash:${program}` : ''
    }
    if (FILE_TOOLS.has(event.toolName))
        return projectFile(event, cwd) ? EDITS_SCOPE : ''
    return event.toolName
}

const DECLINED = (tool: string) => `The user declined this ${tool} call. Stop and wait for the user to say how to proceed.`
const SKIPPED = `Not run: the user declined an earlier call in this batch. Stop and wait for the user to say how to proceed.`

export default function (pi: ExtensionAPI) {
    pi.registerFlag(COMMAND, { type: 'string', description: 'Approval mode for new sessions: ask, edits or auto' })

    const state: State = { mode: DEFAULT_MODE, always: [] }
    let current: ExtensionContext | undefined
    /** Set by a No: the rest of this assistant message's tool calls are declined too. */
    let declined = false
    pi.on('turn_start', () => {
        declined = false
    })

    // Status for the GUI; the event for other extensions (subagent starts its child in the same mode,
    // pi-cc-tui shows it under the input).
    const publish = (ctx: ExtensionContext) => {
        ctx.ui.setStatus(STATUS, state.mode)
        pi.events.emit(MODE_EVENT, state.mode)
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
        // Like Claude Code, commands that only read (ls, git status, rg …) run without asking.
        if (event.toolName === 'bash' && isReadOnlyCommand(String((event.input as any).command ?? '')))
            return false
        if (state.mode === 'edits' && projectFile(event, cwd))
            return false
        const scope = scopeOf(event, cwd)
        return !(scope && scope !== EDITS_SCOPE && state.always.includes(scope))
    }

    pi.on('session_start', async (_event, ctx) => {
        const saved = ctx.sessionManager.getBranch()
            .filter((e: any) => e.type === 'custom' && e.customType === ENTRY)
            .pop() as { data?: Partial<State> } | undefined
        current = ctx
        const flag = pi.getFlag(COMMAND) ?? process.env[ENV_MODE]
        state.mode = isMode(saved?.data?.mode) ? saved.data.mode : isMode(flag) ? flag : DEFAULT_MODE
        state.always = Array.isArray(saved?.data?.always) ? saved.data.always.filter(s => typeof s === 'string') : []
        publish(ctx)
    })

    const setMode = (mode: ApprovalMode, ctx: ExtensionContext) => {
        state.mode = mode
        persist()
        publish(ctx)
    }

    pi.events.on(SET_EVENT, (mode) => {
        if (isMode(mode) && current)
            setMode(mode, current)
    })

    // pi prepares a batch's calls one after another, so prompts never overlap; serialized() only
    // guards against other prompts in the terminal (plan, questions, a subagent's approvals).
    pi.on('tool_call', async (event, ctx) => {
        if (!needsApproval(event, ctx.cwd))
            return undefined
        if (!ctx.hasUI)
            return { block: true, reason: `${event.toolName} needs the user's approval, and no UI is available.` }
        return ctx.mode === 'tui' ? serialized(() => ask(event, ctx)) : ask(event, ctx)
    })

    async function ask(event: ToolCallEvent, ctx: ExtensionContext) {
        // An earlier answer may have switched the mode or declined the batch.
        if (declined)
            return { block: true, reason: SKIPPED, terminate: true }
        if (!needsApproval(event, ctx.cwd))
            return undefined
        const scope = scopeOf(event, ctx.cwd)
        const request: ApprovalRequest = {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            summary: summarize(event),
            scope: scope.startsWith('bash:') ? scope.slice(5) : scope,
        }
        const options: ApprovalChoice[] = scope ? ['allow', 'always', 'deny'] : ['allow', 'deny']
        const choice = ctx.mode === 'tui'
            ? await promptApproval(ctx, request, event.input as Record<string, unknown>, options)
            : await ctx.ui.select(TITLE_PREFIX + JSON.stringify(request), options, { signal: ctx.signal }) as ApprovalChoice | undefined

        if (choice === 'allow')
            return undefined
        if (choice === 'always') {
            if (scope === EDITS_SCOPE)
                setMode('edits', ctx)
            else {
                state.always.push(scope)
                persist()
            }
            return undefined
        }
        // Stopping the run dismisses the prompt too; that is no answer from the user.
        if (choice === undefined && ctx.signal?.aborted)
            return { block: true, reason: 'The approval prompt was dismissed.' }
        declined = true
        return { block: true, reason: DECLINED(event.toolName), terminate: true }
    }

    pi.registerCommand(COMMAND, {
        description: 'Internal: set the approval mode',
        handler: async (args, ctx) => {
            const mode = args.trim()
            if (!isMode(mode))
                return ctx.ui.notify(`未知的确认模式：${mode}`, 'error')
            setMode(mode, ctx)
        },
    })
}
