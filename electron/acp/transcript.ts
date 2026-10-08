// ACP `session/update` notifications → pi's live events and transcript messages.
//
// ACP streams loose pieces (text / thought chunks, tool calls and their updates, plans) with no
// message boundaries; pi's renderer works on assistant messages holding text, thinking and toolCall
// blocks, followed by toolResult messages. The rules here:
//   - an assistant message opens on the first chunk or tool call of a run;
//   - it closes when a tool it holds completes (its result must follow it), when text or thinking
//     arrives after one of its tool calls, when the user speaks, and when the prompt ends;
//   - each finished message gets a stable entry id from its position, so a replayed session
//     (session/load) and the live one produce the same keys.
// Events go to `emit` exactly as pi would send them (message_start / message_update / message_end,
// tool_execution_*); a replay passes a no-op emitter and reads the snapshot afterwards.

import type { SessionItem } from '@shared/ipc'
import type { AgentMessage, AssistantMessage, ImageContent, PiEvent, TextContent, ToolCall, ToolResultMessage, Usage } from '@shared/pi'
import type { AskAnswer, AskDetails, AskQuestion, PlanDetails, TodoItem } from '@shared/capabilities'

/** ACP stop reasons → pi's. */
const STOP_REASONS: Record<string, AssistantMessage['stopReason']> = {
    end_turn: 'stop',
    max_tokens: 'length',
    max_turn_requests: 'length',
    refusal: 'error',
    cancelled: 'aborted',
}

/** ACP tool kinds without a pi counterpart print under these names. */
const KIND_NAMES: Record<string, string> = {
    search: 'search',
    fetch: 'fetch',
    think: 'think',
    delete: 'delete',
    move: 'move',
    switch_mode: 'mode',
}

/**
 * Grok Build's tool identity, `_meta["x.ai/tool"]` on its tool calls: the model's tool name and a
 * kind finer than ACP's (`list_dir`, `ask_user`, `exit_plan`, `plan`, …). Only the first updates carry it.
 */
export interface XaiTool {
    name: string
    kind: string
}

export interface ToolState {
    id: string
    kind?: string
    title?: string
    name?: string
    rawInput?: any
    rawOutput?: any
    locations?: { path: string }[]
    content?: any[]
    status?: string
    xai?: XaiTool
    /**
     * Command output: streamed through `_meta.terminal_output_delta` / `terminal_output` (codex-acp,
     * Claude Code), or the whole output so far in each update's content (Grok Build's Bash rawOutput).
     */
    output: string
    exitCode?: number | null
    /** Result details for the capability views (ask, plan), set while the agent waits for the user. */
    details?: unknown
    /** The pi tool calls standing for it: one, or one per file for a multi-file edit. */
    calls: ToolCall[]
    done: boolean
}

export interface PromptUsage {
    inputTokens?: number
    outputTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
    thoughtTokens?: number
    totalTokens?: number
    /** USD, when the agent prices its turns (Grok Build). */
    cost?: number
}

/**
 * Grok Build's turn usage (`turn_completed.usage`, the prompt result's `_meta.usage`): summed over the
 * turn's model calls, input including the cache reads, cost in 1e-10 USD ticks.
 */
export function xaiUsage(raw: any): PromptUsage | undefined {
    if (!raw || typeof raw !== 'object' || typeof raw.inputTokens !== 'number')
        return undefined
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    return {
        inputTokens: raw.inputTokens,
        outputTokens: num(raw.outputTokens),
        cachedReadTokens: num(raw.cachedReadTokens),
        cachedWriteTokens: num(raw.cacheCreationTokens),
        thoughtTokens: num(raw.reasoningTokens),
        totalTokens: num(raw.totalTokens),
        cost: typeof raw.costUsdTicks === 'number' ? raw.costUsdTicks / 1e10 : undefined,
    }
}

export interface TranscriptOptions {
    emit?: (event: PiEvent) => void
    now?: () => number
    /** Provider / model stamped on finished assistant messages. */
    model?: () => { provider?: string, model?: string, thinkingLevel?: string }
    /** ACP inputTokens counts cache reads too (Codex) or not (Claude); undefined: judge by totalTokens. */
    inputIncludesCache?: boolean
}

const text = (t: string): TextContent => ({ type: 'text', text: t })

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined
}

/** A command from rawInput: a string, or argv. */
function commandOf(raw: any): string | undefined {
    const command = raw?.command ?? raw?.cmd
    if (Array.isArray(command))
        return command.map(String).join(' ')
    return str(command)
}

function exitCodeOf(update: any): number | null | undefined {
    const raw = update.rawOutput
    const code = raw?.exit_code ?? raw?.exitCode ?? update._meta?.terminal_exit?.exit_code
    return typeof code === 'number' || code === null ? code : undefined
}

/** Text of ACP tool call content blocks (`{ type: 'content', content: { type: 'text' } }`). */
function contentText(content: any[] | undefined): string {
    return (content ?? [])
        .filter(c => c?.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string')
        .map(c => unfence(c.content.text))
        .join('\n')
}

/** Claude Code wraps command output as a Markdown block (```console … ```); the tool row wants the text. */
function unfence(t: string): string {
    const m = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(t)
    return m ? m[1] : t
}

const utf8 = (bytes: unknown) => (Array.isArray(bytes) ? new TextDecoder().decode(Uint8Array.from(bytes)) : '')

/**
 * The text of a Grok Build rawOutput (serde of its ToolOutput, tagged by `type`) for the tools whose
 * content holds none or only a summary ("found 27 matches"); '' for the rest.
 */
function xaiOutput(raw: any): string {
    switch (raw?.type) {
        case 'GrepSearch':
            // As ripgrep prints them: path:line:text.
            return Array.isArray(raw.file_matches)
                ? raw.file_matches.flatMap((f: any) => (f?.matches ?? []).map((m: any) => `${f.path}:${m.line_number}:${m.content}`)).join('\n')
                : utf8(raw.stdout)
        case 'ListDir':
            return str(raw.Content?.content) ?? ''
        case 'TaskOutput':
            return str(raw.Result?.output) ?? (raw.MultiResult?.results ?? []).map((r: any) => str(r?.output)).filter(Boolean).join('\n\n')
        case 'KillTask':
            return str(raw.Result?.message) ?? ''
        default:
            // The server-side web search: its sources.
            return Array.isArray(raw?.action?.sources) ? raw.action.sources.map((s: any) => str(s?.url)).filter(Boolean).join('\n') : ''
    }
}

/** What a finished call printed: streamed terminal output, else its content, else a plain rawOutput. */
function outputOf(tool: ToolState): string {
    const raw = typeof tool.rawOutput === 'string' ? tool.rawOutput : ''
    // A command's content can still be its description (Claude Code) while rawOutput is the output.
    if (tool.kind === 'execute')
        return tool.output || raw || contentText(tool.content)
    return tool.output || xaiOutput(tool.rawOutput) || contentText(tool.content) || raw
}

/** Images a call returned (a read of a picture); Grok sends JPEG and PNG without a mime type. */
function contentImages(content: any[] | undefined): ImageContent[] {
    const sniff = (data: string) => (data.startsWith('/9j/') ? 'image/jpeg' : data.startsWith('R0lG') ? 'image/gif' : data.startsWith('UklG') ? 'image/webp' : 'image/png')
    return (content ?? [])
        .filter(c => c?.type === 'content' && c.content?.type === 'image' && typeof c.content.data === 'string')
        .map(c => ({ type: 'image', data: c.content.data, mimeType: str(c.content.mimeType) ?? sniff(c.content.data) }))
}

/** rawInput as tool arguments: Grok Build tags its second, normalized copy with `variant`. */
function inputOf(tool: ToolState): Record<string, any> {
    const raw = tool.rawInput
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {}
    const { variant: _variant, ...input } = raw
    return input
}

/** Grok Build's ask_user_question questions as the ask capability's; answers are keyed by question text. */
export function askQuestions(raw: unknown): AskQuestion[] {
    return (Array.isArray(raw) ? raw : [])
        .filter((q: any) => typeof q?.question === 'string')
        .map((q: any) => ({
            id: q.question,
            question: q.question,
            options: (Array.isArray(q.options) ? q.options : []).map((o: any) => String(o?.label ?? o)).filter(Boolean),
            multiple: q.multiSelect === true || q.multi_select === true || undefined,
        }))
}

/** The label Grok's ask_user_question answers with when the user typed their own (the text goes in notes). */
export const XAI_OTHER = 'Other'

/** One Grok answer (selected labels, typed notes) as the ask capability's. */
export function xaiAskAnswer(labels: string[], notes?: string): AskAnswer {
    const selected = labels.filter(l => l !== XAI_OTHER)
    return notes ? { selected, text: notes } : { selected }
}

const ASK_ANSWERED = 'User has answered your questions: '
const ASK_TRAILER = '. You can now continue with the user\'s answers in mind.'
const ASK_NOTES = ' user notes: '

/**
 * A finished ask_user_question read back from its result (a replayed session). Grok formats each
 * answered question as `"<question>"="<label>, <label>"`, then optionally ` user notes: <text>`,
 * joined by `, ` (format_accepted_tool_result). Any other result (cancel, chat, skip) is not an answer.
 */
export function askDetailsOf(questions: AskQuestion[], message: string): AskDetails {
    if (!message.startsWith(ASK_ANSWERED))
        return { kind: 'ask', status: 'cancelled', questions }
    const body = message.endsWith(ASK_TRAILER) ? message.slice(0, -ASK_TRAILER.length) : message
    const starts = questions
        .map(q => ({ q, at: body.indexOf(`"${q.question}"="`) }))
        .filter(s => s.at >= 0)
        .sort((a, b) => a.at - b.at)
    const answers: Record<string, AskAnswer> = {}
    starts.forEach(({ q, at }, i) => {
        const valueAt = at + q.question.length + 4
        // An entry runs to the next one's `, ` separator, or to the end.
        const entry = body.slice(valueAt, i + 1 < starts.length ? starts[i + 1].at - 2 : undefined)
        // The labels end at the closing quote, before an optional preview and notes.
        const ends = [entry.indexOf('" selected preview:\n'), entry.indexOf(`"${ASK_NOTES}`), entry.endsWith('"') ? entry.length - 1 : -1].filter(n => n >= 0)
        const end = ends.length ? Math.min(...ends) : entry.length
        const value = entry.slice(0, end)
        const rest = entry.slice(end + 1)
        const notesAt = rest.indexOf(ASK_NOTES)
        const notes = notesAt >= 0 ? rest.slice(notesAt + ASK_NOTES.length) : undefined
        answers[q.id] = xaiAskAnswer(value ? value.split(', ') : [], notes)
    })
    return starts.length ? { kind: 'ask', status: 'answered', questions, answers } : { kind: 'ask', status: 'cancelled', questions }
}

/**
 * A finished exit_plan_mode read back from its result (replay): an approved one ran and returned the
 * plan; the others were answered with Grok's revise / abandon text instead.
 */
export function planDetailsOf(raw: any, message: string): PlanDetails {
    const ready = raw?.PlanReady ?? raw?.EmptyPlan
    if (ready)
        return { kind: 'plan', status: 'approved', plan: str(ready.plan_content) ?? '' }
    const said = 'The user said:\n'
    const at = message.indexOf(said)
    if (message.startsWith('The user wants to revise the plan') && at >= 0)
        return { kind: 'plan', status: 'revised', plan: '', feedback: message.slice(at + said.length) }
    return { kind: 'plan', status: 'cancelled', plan: '' }
}

/** Grok Build calls by their x.ai kind; undefined leaves the call to the generic mapping. */
function xaiCalls(tool: ToolState, xai: XaiTool, input: Record<string, any>): ToolCall[] | undefined {
    const call = (name: string, args: Record<string, any>): ToolCall => ({ type: 'toolCall', id: tool.id, name, arguments: args })
    const path = str(input.target_file) ?? str(input.file_path) ?? str(input.path) ?? tool.locations?.[0]?.path
    switch (xai.kind) {
        // todo_write: the `plan` update that follows it shows the list.
        case 'plan':
            return []
        case 'read':
            return path ? [call('read', { path, ...(input.offset != null ? { offset: input.offset } : {}), ...(input.limit != null ? { limit: input.limit } : {}) })] : undefined
        case 'execute':
            return [call('bash', { command: commandOf(input) ?? '', ...(str(input.description) ? { description: input.description } : {}) })]
        case 'search':
            return [call('grep', input)]
        case 'list':
        case 'list_dir':
            return [call('ls', { path: str(input.target_directory) ?? str(input.directory) ?? path ?? '' })]
        case 'write':
            return path && typeof input.content === 'string' ? [call('write', { path, content: input.content })] : undefined
        case 'edit':
            return path && typeof input.old_string === 'string' ? [call('edit', { path, oldText: input.old_string, newText: String(input.new_string ?? '') })] : undefined
        case 'ask_user':
            return [call('ask', { questions: askQuestions(input.questions) })]
        case 'exit_plan':
            return [call('propose_plan', {})]
        default:
            return undefined
    }
}

/** How an ACP tool call reads as pi tool calls, so the transcript's tool views apply. */
export function piToolCalls(tool: ToolState): ToolCall[] {
    const call = (id: string, name: string, args: Record<string, any>): ToolCall => ({ type: 'toolCall', id, name, arguments: args })
    const diffs = (tool.content ?? []).filter(c => c?.type === 'diff' && typeof c.path === 'string')
    if (diffs.length) {
        return diffs.map((d, i) => {
            const id = i ? `${tool.id}#${i}` : tool.id
            // Grok's write shows the file it wrote, whatever its diff was against.
            return d.oldText == null || tool.xai?.kind === 'write'
                ? call(id, 'write', { path: d.path, content: String(d.newText ?? '') })
                : call(id, 'edit', { path: d.path, oldText: String(d.oldText), newText: String(d.newText ?? '') })
        })
    }
    const title = str(tool.title)
    const input = inputOf(tool)
    if (tool.xai) {
        const calls = xaiCalls(tool, tool.xai, input)
        if (calls)
            return calls
        // Grok's first announcement titles a call with the tool name; later ones describe it.
        const args: Record<string, any> = title && title !== tool.xai.name ? { description: title } : {}
        return [call(tool.id, tool.xai.name, { ...args, ...input })]
    }
    // Grok's server-side searches: no x.ai tool, the query (or page opened) comes with the result.
    if (tool.rawInput?.variant === 'WebSearch') {
        const action = tool.rawOutput?.action
        if ((action?.type === 'open_page' || action?.type === 'find_in_page') && str(action.url))
            return [call(tool.id, 'web_fetch', { url: action.url, ...(str(action.pattern) ? { pattern: action.pattern } : {}) })]
        return [call(tool.id, 'web_search', { query: str(action?.query) ?? '' })]
    }
    if (tool.rawInput?.variant === 'XSearch') {
        let args: Record<string, any> = {}
        try {
            args = JSON.parse(tool.rawOutput?.input ?? '{}')
        }
        catch {}
        return [call(tool.id, 'x_search', args && typeof args === 'object' ? args : {})]
    }
    if (tool.kind === 'execute')
        return [call(tool.id, 'bash', { command: commandOf(input) ?? title ?? '' })]
    const paths = (tool.locations ?? []).map(l => l.path).filter(Boolean)
    if (tool.kind === 'read' && paths.length === 1 && (!title || /^read\b/i.test(title)))
        return [call(tool.id, 'read', { path: paths[0] })]
    const name = tool.kind === 'read' ? 'list' : KIND_NAMES[tool.kind ?? ''] ?? (str(tool.name) || 'tool')
    const args: Record<string, any> = title ? { description: title } : {}
    for (const [k, v] of Object.entries(input)) {
        if (v !== undefined && k !== 'cwd')
            args[k] = v
    }
    if (!args.path && paths.length)
        args.path = paths.join(', ')
    return [call(tool.id, name, args)]
}

export class AcpTranscript {
    /** Finished messages, in order. */
    readonly messages: { message: AgentMessage, endedAt: number }[] = []
    private open: AssistantMessage | null = null
    /** Index of the block the next delta of each kind appends to; -1 when a new block must start. */
    private openBlock = -1
    private tools = new Map<string, ToolState>()
    private userOpen = false
    private planCount = 0
    /**
     * A call announced as already finished (session/load replays them so) gets its output in the
     * updates right after; its result waits until something else arrives.
     */
    private deferred: ToolState | null = null
    /** Assistant messages finished during the current prompt; the last gets the prompt's usage. */
    private promptStart = 0
    private emit: (event: PiEvent) => void
    private now: () => number
    private modelInfo: TranscriptOptions['model']
    private inputIncludesCache: boolean | undefined

    constructor(private prefix: string, options: TranscriptOptions = {}) {
        this.emit = options.emit ?? (() => {})
        this.now = options.now ?? Date.now
        this.modelInfo = options.model
        this.inputIncludesCache = options.inputIncludesCache
    }

    setEmitter(emit: (event: PiEvent) => void) {
        this.emit = emit
    }

    /** The pi calls an ACP tool call was shown as (empty when it was never announced). */
    callsOf(toolCallId: string): ToolCall[] {
        return this.tools.get(toolCallId)?.calls ?? []
    }

    /**
     * Details for a call's capability view while it waits on the user (an ask's questions, a plan to
     * approve), or once they answered; the result carries the last ones. False if the call is unknown.
     */
    setDetails(toolCallId: string, details: AskDetails | PlanDetails): boolean {
        const tool = this.tools.get(toolCallId)
        const call = tool?.calls[0]
        if (!tool || !call || tool.done)
            return false
        tool.details = details
        this.emit({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, partialResult: { content: [], details } })
        return true
    }

    get running(): boolean {
        return !!this.open || [...this.tools.values()].some(t => !t.done)
    }

    snapshot(): SessionItem[] {
        return this.messages.map((m, i) => ({ entryId: `${this.prefix}${i}`, message: m.message, endedAt: m.endedAt }))
    }

    /** The user's prompt, sent by this client (ACP does not echo it live). */
    userPrompt(prompt: string, images: ImageContent[] = []) {
        this.closeAssistant('stop')
        this.userOpen = false
        const content: (TextContent | ImageContent)[] = [...(prompt ? [text(prompt)] : []), ...images]
        this.push({ role: 'user', content, timestamp: this.now() })
        this.promptStart = this.messages.length
    }

    /** One `session/update` payload (`params.update`). */
    update(update: any) {
        if (this.deferred && !(update?.sessionUpdate === 'tool_call_update' && update.toolCallId === this.deferred.id))
            this.flushDeferred()
        switch (update?.sessionUpdate) {
            case 'user_message_chunk':
                this.userChunk(update)
                break
            case 'agent_message_chunk':
                this.chunk('text', update.content)
                break
            case 'agent_thought_chunk':
                this.chunk('thinking', update.content)
                break
            case 'tool_call':
                this.toolCall(update)
                break
            case 'tool_call_update':
                this.toolUpdate(update)
                break
            case 'plan':
                this.plan(update.entries)
                break
            default:
                break
        }
    }

    /** The agent compacted its context: a note in the timeline, as pi's compaction leaves one. */
    compaction(summary: string, tokensBefore: number) {
        this.flushDeferred()
        this.closeAssistant('stop')
        this.userOpen = false
        this.push({ role: 'compactionSummary', summary, tokensBefore, timestamp: this.now() })
    }

    /** The prompt request returned (or failed): close what is open and attach the usage. */
    finish(stopReason: string | undefined, usage?: PromptUsage, errorMessage?: string) {
        this.flushDeferred()
        // Calls the agent never finished (cancelled, crashed) would otherwise spin forever.
        for (const tool of this.tools.values()) {
            if (!tool.done)
                this.completeTool(tool, 'failed', tool.output || (stopReason === 'cancelled' ? 'Interrupted' : 'No result'))
        }
        const reason = errorMessage ? 'error' : STOP_REASONS[stopReason ?? ''] ?? 'stop'
        if (!this.open && (reason === 'error' || reason === 'aborted')) {
            this.startAssistant()
        }
        if (this.open && errorMessage)
            this.open.errorMessage = errorMessage
        this.closeAssistant(reason)
        if (usage)
            this.applyUsage(usage)
        this.userOpen = false
    }

    // ---------------------------------------------------------------- pieces

    private userChunk(update: any) {
        // Grok Build's own turns (a background task's wake-up note) are not the user's words.
        if (update._meta?.hideFromScrollback)
            return
        const content = update.content
        // A mid-turn interjection is stored wrapped for the model; displayText is what the user typed.
        const typed = content?._meta?.displayText
        const t = typeof typed === 'string' ? typed : content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
        const image = content?.type === 'image' && typeof content.data === 'string' ? { type: 'image' as const, data: content.data, mimeType: String(content.mimeType ?? 'image/png') } : null
        const last = this.messages[this.messages.length - 1]?.message
        if (this.userOpen && last?.role === 'user' && Array.isArray(last.content)) {
            const block = last.content[last.content.length - 1]
            if (t && block?.type === 'text')
                block.text += t
            else if (t)
                last.content.push(text(t))
            if (image)
                last.content.push(image)
            return
        }
        this.closeAssistant('stop')
        this.push({ role: 'user', content: [...(t ? [text(t)] : []), ...(image ? [image] : [])], timestamp: this.now() })
        this.userOpen = true
        this.promptStart = this.messages.length
    }

    private chunk(kind: 'text' | 'thinking', content: any) {
        if (content?.type !== 'text' || typeof content.text !== 'string')
            return
        this.userOpen = false
        const delta = content.text
        if (this.open?.content.some(b => b.type === 'toolCall'))
            this.closeAssistant('toolUse')
        const message = this.open ?? this.startAssistant()
        const current = this.openBlock >= 0 ? message.content[this.openBlock] : undefined
        if (current?.type === kind) {
            if (current.type === 'text')
                current.text += delta
            else if (current.type === 'thinking')
                current.thinking += delta
            this.emit({ type: 'message_update', assistantMessageEvent: { type: `${kind}_delta`, contentIndex: this.openBlock, delta } })
            return
        }
        this.endBlock()
        const index = message.content.length
        message.content.push(kind === 'text' ? text(delta) : { type: 'thinking', thinking: delta })
        this.openBlock = index
        this.emit({ type: 'message_update', assistantMessageEvent: { type: `${kind}_start`, contentIndex: index } })
        this.emit({ type: 'message_update', assistantMessageEvent: { type: `${kind}_delta`, contentIndex: index, delta } })
    }

    private toolCall(update: any) {
        this.userOpen = false
        const known = this.tools.get(update.toolCallId)
        if (known) {
            this.toolUpdate(update)
            return
        }
        const tool: ToolState = { id: String(update.toolCallId), output: '', calls: [], done: false }
        this.tools.set(tool.id, tool)
        this.merge(tool, update)
        this.addCalls(tool)
        if (tool.status === 'completed' || tool.status === 'failed')
            this.deferred = tool
    }

    private flushDeferred() {
        const tool = this.deferred
        this.deferred = null
        if (tool && !tool.done)
            this.settleIfFinished(tool, {})
    }

    private toolUpdate(update: any) {
        const tool = this.tools.get(update.toolCallId)
        if (!tool) {
            // An update for a call never announced: treat it as the announcement.
            if (update.toolCallId)
                this.toolCall({ ...update, sessionUpdate: 'tool_call' })
            return
        }
        if (tool.done)
            return
        if (tool === this.deferred) {
            this.merge(tool, update)
            return
        }
        const before = JSON.stringify(piToolCalls(tool))
        this.merge(tool, update)
        // Arguments can arrive late (rawInput, diffs); refresh them while the message is open.
        const after = piToolCalls(tool)
        if (JSON.stringify(after) !== before && this.open && after.length === tool.calls.length) {
            for (const call of after) {
                const index = this.open.content.findIndex(b => b.type === 'toolCall' && b.id === call.id)
                if (index >= 0) {
                    this.open.content[index] = call
                    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: index, toolCall: call } })
                }
            }
            tool.calls = after
        }
        if (!this.settleIfFinished(tool, update) && tool.calls[0]) {
            const partial = tool.kind === 'execute' || tool.xai?.kind === 'execute' ? tool.output : tool.output || contentText(tool.content)
            if (partial)
                this.emit({ type: 'tool_execution_update', toolCallId: tool.calls[0].id, toolName: tool.calls[0].name, partialResult: { content: [text(partial)], ...(tool.details ? { details: tool.details } : {}) } })
        }
    }

    private merge(tool: ToolState, update: any) {
        for (const key of ['kind', 'title', 'name', 'rawInput', 'rawOutput', 'locations', 'content', 'status'] as const) {
            if (update[key] !== undefined && update[key] !== null)
                (tool as any)[key] = update[key]
        }
        const meta = update._meta ?? {}
        const xai = meta['x.ai/tool']
        if (typeof xai?.name === 'string')
            tool.xai = { name: xai.name, kind: String(xai.kind ?? '') }
        const delta = meta.terminal_output_delta?.data ?? meta.terminal_output?.data
        if (typeof delta === 'string')
            tool.output += delta
        // Grok Build (x.ai/incrementalBashOutput): each update's content is the whole output so far.
        if (update.rawOutput?.type === 'Bash')
            tool.output = contentText(update.content)
        const code = exitCodeOf(update)
        if (code !== undefined)
            tool.exitCode = code
    }

    private addCalls(tool: ToolState) {
        const message = this.open ?? this.startAssistant()
        this.endBlock()
        tool.calls = piToolCalls(tool)
        for (const call of tool.calls) {
            const index = message.content.length
            message.content.push(call)
            this.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: index, toolCall: call } })
        }
        for (const call of tool.calls)
            this.emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments })
    }

    /** Completes the tool when this update finished it; true if it did. */
    private settleIfFinished(tool: ToolState, update: any): boolean {
        const status = update.status ?? tool.status
        if (status !== 'completed' && status !== 'failed')
            return false
        this.completeTool(tool, status, outputOf(tool))
        return true
    }

    private completeTool(tool: ToolState, status: string, output: string) {
        tool.done = true
        // The result follows the message holding the call.
        if (this.open?.content.some(b => b.type === 'toolCall' && tool.calls.some(c => c.id === b.id)))
            this.closeAssistant('toolUse')
        // Grok's grep reports ripgrep's exit code too (1: no matches); only a command's means failure.
        const exitCounts = !tool.xai || tool.xai.kind === 'execute'
        const isError = status === 'failed' || (exitCounts && typeof tool.exitCode === 'number' && tool.exitCode !== 0)
        const images = contentImages(tool.content)
        for (const call of tool.calls) {
            const details = this.resultDetails(tool, call, output)
            // A question or a plan the user turned down is an answer, not a failure.
            const failed = isError && !details
            const content: (TextContent | ImageContent)[] = [...(output ? [text(output)] : []), ...images]
            const message: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content, details, isError: failed, timestamp: this.now() }
            this.emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: message.content, details }, isError: failed })
            this.push(message)
        }
    }

    /** The capability view's result details: todo items, an ask's answers, a plan's outcome. */
    private resultDetails(tool: ToolState, call: ToolCall, output: string): unknown {
        if (call.name === 'todo')
            return { kind: 'todo', items: call.arguments.items }
        const live = tool.details as AskDetails | PlanDetails | undefined
        if (call.name === 'ask' && tool.xai) {
            const questions: AskQuestion[] = call.arguments.questions ?? []
            return live && live.status !== 'pending' ? live : askDetailsOf(questions, output)
        }
        if (call.name === 'propose_plan' && tool.xai) {
            const derived = planDetailsOf(tool.rawOutput, output)
            const plan = live?.kind === 'plan' ? live : undefined
            // The approved plan comes back in the result; the one asked about stays for the others.
            return plan && plan.status !== 'pending' ? { ...plan, plan: derived.plan || plan.plan } : derived
        }
        return undefined
    }

    /** An ACP plan replaces the whole list, like pi's todo tool: show it as one. */
    private plan(entries: any) {
        if (!Array.isArray(entries))
            return
        const items: TodoItem[] = entries
            .filter(e => typeof e?.content === 'string')
            .map(e => ({ text: e.content, status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending' }))
        const id = `${this.prefix}plan-${this.planCount++}`
        const tool: ToolState = { id, output: '', calls: [], done: false }
        this.tools.set(id, tool)
        const message = this.open ?? this.startAssistant()
        this.endBlock()
        const call: ToolCall = { type: 'toolCall', id, name: 'todo', arguments: { items } }
        tool.calls = [call]
        message.content.push(call)
        this.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: message.content.length - 1, toolCall: call } })
        this.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'todo', args: call.arguments })
        this.completeTool(tool, 'completed', '')
    }

    // ---------------------------------------------------------------- messages

    private startAssistant(): AssistantMessage {
        this.userOpen = false
        const message: AssistantMessage = { role: 'assistant', content: [], stopReason: 'pending', timestamp: this.now(), ...this.modelInfo?.() }
        this.open = message
        this.openBlock = -1
        this.emit({ type: 'message_start', message: { ...message, content: [] } })
        return message
    }

    private endBlock() {
        if (!this.open || this.openBlock < 0)
            return
        const block = this.open.content[this.openBlock]
        if (block?.type === 'text')
            this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: this.openBlock, content: block.text } })
        else if (block?.type === 'thinking')
            this.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: this.openBlock, content: block.thinking } })
        this.openBlock = -1
    }

    private closeAssistant(reason: AssistantMessage['stopReason']) {
        const message = this.open
        if (!message)
            return
        this.endBlock()
        this.open = null
        message.stopReason = reason
        this.push(message)
    }

    private push(message: AgentMessage) {
        const endedAt = this.now()
        this.messages.push({ message, endedAt })
        if (message.role !== 'assistant')
            this.emit({ type: 'message_start', message })
        this.emit({ type: 'message_end', message })
    }

    private applyUsage(u: PromptUsage) {
        for (let i = this.messages.length - 1; i >= this.promptStart; i--) {
            const m = this.messages[i].message
            if (m.role !== 'assistant')
                continue
            const cacheRead = u.cachedReadTokens ?? 0
            const cacheWrite = u.cachedWriteTokens ?? 0
            const input = u.inputTokens ?? 0
            // pi's input excludes cache reads. Anthropic-style totals add the cache on top of input.
            const includes = this.inputIncludesCache ?? !(typeof u.totalTokens === 'number' && cacheRead > 0 && u.totalTokens >= input + cacheRead + (u.outputTokens ?? 0))
            const usage: Usage = {
                input: includes ? Math.max(0, input - cacheRead) : input,
                output: u.outputTokens ?? 0,
                cacheRead,
                cacheWrite,
                totalTokens: u.totalTokens ?? 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost ?? 0 },
            }
            if (typeof u.thoughtTokens === 'number')
                usage.reasoning = u.thoughtTokens
            m.usage = usage
            return
        }
    }

    /** Token totals over the session, for get_session_stats. */
    totals(): { input: number, output: number, cacheRead: number, cacheWrite: number, total: number, cost: number } {
        const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }
        for (const { message } of this.messages) {
            if (message.role !== 'assistant' || !message.usage)
                continue
            t.input += message.usage.input
            t.output += message.usage.output
            t.cacheRead += message.usage.cacheRead
            t.cacheWrite += message.usage.cacheWrite
            t.total += message.usage.totalTokens
            t.cost += message.usage.cost?.total ?? 0
        }
        return t
    }
}
