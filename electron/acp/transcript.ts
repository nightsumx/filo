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
import type { TodoItem } from '@shared/capabilities'

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
    /** Command output streamed through `_meta.terminal_output_delta` / `terminal_output`. */
    output: string
    exitCode?: number | null
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
}

export interface TranscriptOptions {
    emit?: (event: PiEvent) => void
    now?: () => number
    /** Provider / model stamped on finished assistant messages. */
    model?: () => { provider?: string, model?: string, thinkingLevel?: string }
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
        .map(c => c.content.text)
        .join('\n')
}

/** How an ACP tool call reads as pi tool calls, so the transcript's tool views apply. */
export function piToolCalls(tool: ToolState): ToolCall[] {
    const call = (id: string, name: string, args: Record<string, any>): ToolCall => ({ type: 'toolCall', id, name, arguments: args })
    const diffs = (tool.content ?? []).filter(c => c?.type === 'diff' && typeof c.path === 'string')
    if (diffs.length) {
        return diffs.map((d, i) => {
            const id = i ? `${tool.id}#${i}` : tool.id
            return d.oldText == null
                ? call(id, 'write', { path: d.path, content: String(d.newText ?? '') })
                : call(id, 'edit', { path: d.path, oldText: String(d.oldText), newText: String(d.newText ?? '') })
        })
    }
    const title = str(tool.title)
    const input = tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput) ? tool.rawInput : {}
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

    constructor(private prefix: string, options: TranscriptOptions = {}) {
        this.emit = options.emit ?? (() => {})
        this.now = options.now ?? Date.now
        this.modelInfo = options.model
    }

    setEmitter(emit: (event: PiEvent) => void) {
        this.emit = emit
    }

    /** The pi calls an ACP tool call was shown as (empty when it was never announced). */
    callsOf(toolCallId: string): ToolCall[] {
        return this.tools.get(toolCallId)?.calls ?? []
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
                this.userChunk(update.content)
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

    private userChunk(content: any) {
        const t = content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
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
            const partial = tool.output || contentText(tool.content)
            if (partial)
                this.emit({ type: 'tool_execution_update', toolCallId: tool.calls[0].id, toolName: tool.calls[0].name, partialResult: { content: [text(partial)] } })
        }
    }

    private merge(tool: ToolState, update: any) {
        for (const key of ['kind', 'title', 'name', 'rawInput', 'rawOutput', 'locations', 'content', 'status'] as const) {
            if (update[key] !== undefined && update[key] !== null)
                (tool as any)[key] = update[key]
        }
        const meta = update._meta ?? {}
        const delta = meta.terminal_output_delta?.data ?? meta.terminal_output?.data
        if (typeof delta === 'string')
            tool.output += delta
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
        const output = tool.output || contentText(tool.content) || (typeof tool.rawOutput === 'string' ? tool.rawOutput : '')
        this.completeTool(tool, status, output)
        return true
    }

    private completeTool(tool: ToolState, status: string, output: string) {
        tool.done = true
        // The result follows the message holding the call.
        if (this.open?.content.some(b => b.type === 'toolCall' && tool.calls.some(c => c.id === b.id)))
            this.closeAssistant('toolUse')
        const isError = status === 'failed' || (typeof tool.exitCode === 'number' && tool.exitCode !== 0)
        for (const call of tool.calls) {
            const details = call.name === 'todo' ? { kind: 'todo', items: call.arguments.items } : undefined
            const message: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: output ? [text(output)] : [], details, isError, timestamp: this.now() }
            this.emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: message.content, details }, isError })
            this.push(message)
        }
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
            const usage: Usage = {
                input: Math.max(0, (u.inputTokens ?? 0) - cacheRead),
                output: u.outputTokens ?? 0,
                cacheRead,
                cacheWrite: u.cachedWriteTokens ?? 0,
                totalTokens: u.totalTokens ?? 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            }
            if (typeof u.thoughtTokens === 'number')
                usage.reasoning = u.thoughtTokens
            m.usage = usage
            return
        }
    }

    /** Token totals over the session, for get_session_stats. */
    totals(): { input: number, output: number, cacheRead: number, cacheWrite: number, total: number } {
        const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        for (const { message } of this.messages) {
            if (message.role !== 'assistant' || !message.usage)
                continue
            t.input += message.usage.input
            t.output += message.usage.output
            t.cacheRead += message.usage.cacheRead
            t.cacheWrite += message.usage.cacheWrite
            t.total += message.usage.totalTokens
        }
        return t
    }
}
