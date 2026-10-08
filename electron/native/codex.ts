// Codex app-server native adapter: drives `codex app-server` (JSON-RPC over stdio, checked against
// codex 0.160) and speaks pi RPC to the renderer through AcpTranscript. Over codex-acp it adds
// asking again from a message (thread/revert), forking at a message (thread/fork beforeTurnId),
// Codex's questions (item/tool/requestUserInput) and plan mode (collaborationMode 'plan', the
// proposed plan reviewed in the thread), and steering a running turn (turn/steer).
//
// Codex items map to ACP-shaped tool calls whose pi calls the adapter sets itself (`_meta.piCalls`):
// commands are bash (or read / ls / grep when Codex parsed them so), file changes are one write /
// edit / delete per file with the unified diff as the edit's patch.

import type { AcpAgentCaps, AcpAgentSpec, AcpConfigOption } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { ImageContent, PiEvent, PiModel, RpcResponse, ToolCall } from '@shared/pi'
import type { ApprovalChoice, ApprovalRequest, AskAnswer, AskQuestion, AskResponse, PlanDecision } from '@shared/capabilities'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from '../acp/adapter'
import type { PromptUsage } from '../acp/transcript'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { acpSessionKey } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tr } from '../i18n'
import { AcpConnection, RpcError } from '../acp/connection'
import { AcpTranscript } from '../acp/transcript'

const STDERR_LIMIT = 64 * 1024

export interface CodexLaunch {
    file: string
    args: string[]
    env: Record<string, string>
}

/** What the native adapter does; the renderer gates features on it. */
export const CODEX_CAPS: AcpAgentCaps = {
    images: true,
    steering: true,
    fork: true,
    delete: true,
    list: true,
    xai: false,
    forkAt: true,
    rewind: true,
    ask: true,
    plan: true,
}

const CLIENT_INFO = { name: 'filo', title: 'Filo', version: '1' }

/** What Codex TUI sends when the user accepts a proposed plan. */
const IMPLEMENT_PLAN = 'Implement the plan.'

/** Sessions Codex started for itself (subagents, reviews, compaction) stay out of the list. */
const LISTED_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'unknown']

// ---------------------------------------------------------------- modes

type ModeId = 'read-only' | 'auto' | 'full-access' | 'plan'

/** Approval and sandbox per mode, sent with every turn (Codex keeps them for the turns after). */
const MODES: Record<ModeId, { approvalPolicy: string, sandboxPolicy: { type: string } }> = {
    'read-only': { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
    'auto': { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } },
    'full-access': { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
    // Codex's plan mode explores and asks, and makes no changes until the plan is accepted.
    'plan': { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
}

const modeOption = (current: ModeId): AcpConfigOption => ({
    id: 'mode',
    name: tr('模式', 'Mode'),
    category: 'mode',
    currentValue: current,
    options: [
        { value: 'read-only', name: tr('只读', 'Read only'), description: tr('能读文件；改文件、跑命令前先问你', 'Reads files; asks before edits and commands') },
        { value: 'auto', name: tr('自动', 'Auto'), description: tr('在项目里改文件、跑命令；越出项目或联网前问你', 'Edits and runs commands in the project; asks before going outside it or online') },
        { value: 'full-access', name: tr('完全访问', 'Full access'), description: tr('不问，不受沙箱限制', 'Never asks, no sandbox') },
        { value: 'plan', name: tr('计划', 'Plan'), description: tr('只读探索并写计划，你批准后再动手', 'Explores read-only and writes a plan; changes start once you approve it') },
    ],
})

/** The mode a thread opens in, from the sandbox Codex reports (the user's own config). */
function modeOf(sandbox: any, collaboration: any): ModeId {
    if (collaboration?.mode === 'plan')
        return 'plan'
    const type = typeof sandbox === 'string' ? sandbox : sandbox?.type
    if (type === 'dangerFullAccess' || type === 'danger-full-access')
        return 'full-access'
    if (type === 'readOnly' || type === 'read-only')
        return 'read-only'
    return 'auto'
}

// ---------------------------------------------------------------- items → pi calls

const call = (id: string, name: string, args: Record<string, any>): ToolCall => ({ type: 'toolCall', id, name, arguments: args })
const textBlock = (t: string) => [{ type: 'content', content: { type: 'text', text: t } }]

/** `/bin/zsh -lc 'cmd'` → `cmd`: the shell wrapper Codex runs every command in. */
export function displayCommand(command: string): string {
    const m = /^(?:\/\S+\/)?(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(command)
    return m ? m[1].replaceAll(`'\\''`, `'`) : command
}

/** A command as pi shows it: a read / listing / search when Codex parsed it as exactly one. */
function commandCall(item: any): ToolCall {
    const actions: any[] = Array.isArray(item.commandActions) ? item.commandActions : []
    const command = displayCommand(String(item.command ?? ''))
    if (actions.length === 1) {
        const a = actions[0]
        if (a?.type === 'read' && typeof a.path === 'string')
            return call(item.id, 'read', { path: a.path })
        if (a?.type === 'listFiles')
            return call(item.id, 'ls', { path: a.path ?? '.' })
        if (a?.type === 'search' && a.query)
            return call(item.id, 'grep', { pattern: a.query, ...(a.path ? { path: a.path } : {}) })
    }
    return call(item.id, 'bash', { command })
}

/** A unified diff's hunks as the edits pi's edit view diffs while the change is pending. */
function hunkEdits(diff: string): { oldText: string, newText: string }[] {
    const edits: { oldText: string, newText: string }[] = []
    let current: { old: string[], new: string[] } | null = null
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) {
            current = { old: [], new: [] }
            edits.push(current as any)
            continue
        }
        if (!current || line.startsWith('\\'))
            continue
        if (line.startsWith('-'))
            current.old.push(line.slice(1))
        else if (line.startsWith('+'))
            current.new.push(line.slice(1))
        else {
            current.old.push(line.slice(1))
            current.new.push(line.slice(1))
        }
    }
    return (edits as any[]).map(e => ({ oldText: e.old.join('\n'), newText: e.new.join('\n') }))
}

/** One pi call per changed file: an add is a write, an update an edit (its diff the patch), a delete a delete. */
function fileChangeCalls(item: any): { calls: ToolCall[], details: Record<string, unknown> } {
    const calls: ToolCall[] = []
    const details: Record<string, unknown> = {}
    const changes: any[] = Array.isArray(item.changes) ? item.changes : []
    changes.forEach((c, i) => {
        const id = i ? `${item.id}#${i}` : item.id
        const path = String(c?.path ?? '')
        const diff = String(c?.diff ?? '')
        switch (c?.kind?.type) {
            case 'add':
                calls.push(call(id, 'write', { path, content: diff }))
                break
            case 'delete':
                calls.push(call(id, 'delete', { path }))
                break
            default: {
                const to = c?.kind?.move_path
                calls.push(call(id, 'edit', { path: to || path, ...(to ? { from: path } : {}), edits: hunkEdits(diff) }))
                details[id] = { patch: diff }
            }
        }
    })
    if (!calls.length)
        calls.push(call(item.id, 'edit', { path: '' }))
    return { calls, details }
}

const STATUS: Record<string, string> = { inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'failed' }

/** A thread item that is a tool call, as an ACP tool_call update; undefined for the rest. */
function itemUpdate(item: any): Record<string, any> | undefined {
    const id = String(item?.id ?? '')
    const status = STATUS[item?.status] ?? (item?.status === undefined ? undefined : 'failed')
    switch (item?.type) {
        case 'commandExecution': {
            const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : item.status === 'declined' ? tr('用户拒绝了这条命令', 'The user declined this command') : ''
            return {
                toolCallId: id,
                kind: 'execute',
                status,
                rawInput: { command: displayCommand(String(item.command ?? '')) },
                ...(typeof item.exitCode === 'number' ? { rawOutput: { exitCode: item.exitCode } } : {}),
                ...(output ? { content: textBlock(output) } : {}),
                _meta: { piCalls: [commandCall(item)] },
            }
        }
        case 'fileChange': {
            const { calls, details } = fileChangeCalls(item)
            const declined = item.status === 'declined'
            return {
                toolCallId: id,
                kind: 'edit',
                status,
                ...(declined ? { content: textBlock(tr('用户拒绝了这次修改', 'The user declined this change')) } : {}),
                _meta: { piCalls: calls, piDetails: declined ? {} : details },
            }
        }
        case 'mcpToolCall': {
            const text = (item.result?.content ?? []).map((c: any) => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
            const failed = !!item.error
            return {
                toolCallId: id,
                status: failed ? 'failed' : status,
                content: textBlock(failed ? String(item.error?.message ?? 'MCP error') : text),
                _meta: { piCalls: [call(id, `${item.server}.${item.tool}`, item.arguments && typeof item.arguments === 'object' ? item.arguments : {})] },
            }
        }
        case 'dynamicToolCall': {
            const text = (item.contentItems ?? []).map((c: any) => c?.text ?? '').filter(Boolean).join('\n')
            return {
                toolCallId: id,
                status: item.success === false ? 'failed' : status,
                ...(text ? { content: textBlock(text) } : {}),
                _meta: { piCalls: [call(id, String(item.tool ?? 'tool'), item.arguments && typeof item.arguments === 'object' ? item.arguments : {})] },
            }
        }
        case 'webSearch':
            return {
                toolCallId: id,
                status: 'completed',
                content: textBlock((item.results ?? []).map((r: any) => r?.url).filter(Boolean).join('\n')),
                _meta: { piCalls: [call(id, 'web_search', { query: String(item.query ?? '') })] },
            }
        case 'imageView':
            return { toolCallId: id, status: 'completed', _meta: { piCalls: [call(id, 'read', { path: String(item.path ?? '') })] } }
        case 'collabAgentToolCall': {
            const states = Object.values(item.agentsStates ?? {}) as any[]
            const text = states.map(s => s?.message).filter(Boolean).join('\n\n')
            const failed = states.some(s => s?.status === 'errored')
            return {
                toolCallId: id,
                status: failed ? 'failed' : status,
                ...(text ? { content: textBlock(text) } : {}),
                _meta: { piCalls: [call(id, 'agent', { action: String(item.tool ?? ''), ...(item.prompt ? { task: item.prompt } : {}), ...(item.model ? { model: item.model } : {}) })] },
            }
        }
        default:
            return undefined
    }
}

const askQuestionsOf = (raw: unknown): AskQuestion[] => (Array.isArray(raw) ? raw : [])
    .filter((q: any) => typeof q?.id === 'string' && typeof q.question === 'string')
    .map((q: any) => ({ id: q.id, question: q.question, options: (q.options ?? []).map((o: any) => String(o?.label ?? '')).filter(Boolean) }))

/** Codex keys answers by question id, each a list of strings: the picked labels, then typed text. */
function codexAnswers(questions: AskQuestion[], response: AskResponse): { codex: Record<string, { answers: string[] }>, shown: Record<string, AskAnswer> } {
    const codex: Record<string, { answers: string[] }> = {}
    const shown: Record<string, AskAnswer> = {}
    if ('answers' in response) {
        for (const q of questions) {
            const answer = response.answers[q.id]
            const text = answer?.text?.trim()
            const answers = [...(answer?.selected ?? []), ...(text ? [text] : [])]
            if (!answers.length)
                continue
            codex[q.id] = { answers }
            shown[q.id] = text ? { selected: answer!.selected, text } : { selected: answer!.selected }
        }
    }
    return { codex, shown }
}

const inputOf = (message: string, images: ImageContent[]) => [
    ...(message ? [{ type: 'text', text: message, text_elements: [] }] : []),
    ...images.map(i => ({ type: 'image', url: `data:${i.mimeType};base64,${i.data}` })),
]

/** Token counts Codex reports (TokenUsageBreakdown). */
interface Tokens {
    inputTokens: number
    cachedInputTokens: number
    cacheWriteInputTokens?: number
    outputTokens: number
    reasoningOutputTokens: number
    totalTokens: number
}

const usageBetween = (from: Tokens | null, to: Tokens): PromptUsage => {
    const d = (k: keyof Tokens) => (to[k] ?? 0) - (from?.[k] ?? 0)
    return { inputTokens: d('inputTokens'), cachedReadTokens: d('cachedInputTokens'), cachedWriteTokens: d('cacheWriteInputTokens'), outputTokens: d('outputTokens'), thoughtTokens: d('reasoningOutputTokens'), totalTokens: d('totalTokens') }
}

interface ModelInfo {
    id: string
    name: string
    efforts: { value: string, description?: string }[]
    defaultEffort?: string
    images: boolean
}

interface ApprovalWait {
    resolve: (result: unknown) => void
    /** The decision "always" sends; undefined when Codex offers none. */
    always?: unknown
    itemId: string
}

interface AskWait {
    resolve: (result: unknown) => void
    questions: AskQuestion[]
}

/** A proposed plan the user reviews; the turn that wrote it has ended, its run has not. */
interface PlanWait {
    id: string
    plan: string
    usage?: PromptUsage
}

// ---------------------------------------------------------------- adapter

/** One `codex app-server` process bound to one thread (Codex's word for a session). */
export class CodexAgent implements AgentAdapter {
    readonly id = randomUUID()
    readonly ready: Promise<void>
    readonly caps = CODEX_CAPS
    private child: ChildProcessWithoutNullStreams
    private connection: AcpConnection
    private stderr = ''
    private exited = false
    private transcript: AcpTranscript
    private threadId = ''
    /** Replaying the thread's history: no events, the session's own time on messages. */
    private loading = true

    private models: ModelInfo[] = []
    private model = ''
    private effort = ''
    private mode: ModeId = 'auto'
    /** The mode before plan mode, which an accepted plan goes back to. */
    private workMode: ModeId = 'auto'
    private context: { used: number, size: number } | null = null
    private tokens: Tokens | null = null
    private turnBase: Tokens | null = null

    /** A run: from the prompt until no turn, follow-up or plan review is left (agent_start … agent_end). */
    private running = false
    /** The turn in flight: its id once turn/start answered (or turn/started came). */
    private turnId: string | null = null
    private turnStarting = false
    private abortWanted = false
    private turnError = ''
    /** Items whose text streamed in deltas (the rest arrive whole on item/completed). */
    private streamed = new Set<string>()
    private planItem: { id: string, text: string } | null = null
    private queued: { message: string, images: ImageContent[] }[] = []
    /** The transcript position of each turn's prompt → the turn's id, for asking again and forking. */
    private turnAt = new Map<number, string>()

    private approvals = new Map<string, ApprovalWait>()
    private asks = new Map<string, AskWait>()
    private planWait: PlanWait | null = null

    constructor(readonly spec: AcpAgentSpec, launch: CodexLaunch, private options: AgentAdapterOptions, private callbacks: AgentAdapterCallbacks) {
        this.threadId = options.sessionId ?? ''
        this.transcript = new AcpTranscript('', {
            model: () => ({ provider: spec.label, model: this.model || undefined, thinkingLevel: this.effort || undefined }),
            inputIncludesCache: true,
            now: () => (this.loading ? options.replayTime ?? Date.now() : Date.now()),
        })
        this.child = spawn(launch.file, launch.args, { cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
        this.connection = new AcpConnection(this.child.stdin, this.child.stdout, {
            onNotification: (method, params) => this.notification(method, params),
            onRequest: (method, params) => this.serverRequest(method, params),
        })
        this.child.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
        })
        const finish = (code: number | null, signal: string | null) => {
            if (this.exited)
                return
            this.exited = true
            this.connection.close(new Error(this.lastError() || tr(`${spec.label} 已退出（${code ?? signal}）`, `${spec.label} exited (${code ?? signal})`)))
            this.cancelWaits()
            callbacks.onExit(this.id, { code, signal, stderr: this.stderr })
        }
        this.child.on('exit', finish)
        this.child.on('error', (error) => {
            this.stderr += `\n${error.message}`
            finish(null, null)
        })
        this.ready = this.open()
        // A failed start ends the process; the exit carries the reason to the thread.
        this.ready.catch((error) => {
            this.stderr += `\n${error?.message ?? error}`
            this.child.kill('SIGTERM')
        })
    }

    get key(): string {
        return this.threadId ? acpSessionKey(this.spec.id, this.threadId) : ''
    }

    get cwd(): string {
        return this.options.cwd
    }

    get sessionId(): string {
        return this.threadId
    }

    snapshot(): SessionItem[] {
        return this.transcript.snapshot()
    }

    private lastError(): string {
        return this.stderr.trim().split('\n').slice(-5).join('\n')
    }

    private emit(event: PiEvent) {
        if (!this.options.readOnly && !this.loading)
            this.callbacks.onEvent(this.id, event)
    }

    private rpc<T = any>(method: string, params: unknown): Promise<T> {
        return this.connection.request<T>(method, params)
    }

    /** Sign-in failures read as what to do about them. */
    private explain(error: any): string {
        const message = String(error?.message ?? error)
        if (/active writer/i.test(message))
            return tr(`这个线程正在别处打开着（Codex 终端、VS Code 或另一个标签页），关掉那边再试。（${message}）`, `This thread is open elsewhere (the Codex TUI, VS Code or another tab); close it there and try again. (${message})`)
        if (/\b401\b|unauthori[sz]ed|not (signed|logged) in|login|api key/i.test(message))
            return tr(`${this.spec.label} 还没有登录：${this.spec.signIn.zh}。（${message}）`, `${this.spec.label} is not signed in: ${this.spec.signIn.en}. (${message})`)
        return message
    }

    private async open() {
        await this.rpc('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } })
        this.connection.notify('initialized', undefined)
        let info: any
        if (this.options.sessionId && this.options.readOnly) {
            // Reading only: Codex lets one process write a thread, and another (a tab, the Codex
            // TUI) may have it open; thread/read and thread/turns/list do not take it over.
            info = await this.rpc('thread/read', { threadId: this.options.sessionId })
            await this.loadHistory()
        }
        else if (this.options.sessionId) {
            // The turns come from thread/turns/list, page by page.
            info = await this.rpc('thread/resume', { threadId: this.options.sessionId, excludeTurns: true }).catch((error) => {
                throw new Error(this.explain(error))
            })
            await this.loadHistory()
        }
        else {
            info = await this.rpc('thread/start', { cwd: this.options.cwd })
            this.threadId = String(info?.thread?.id ?? '')
            if (!this.threadId)
                throw new Error(tr(`${this.spec.label} 没有返回线程`, `${this.spec.label} returned no thread`))
        }
        this.model = String(info?.model ?? '')
        this.effort = String(info?.reasoningEffort ?? '')
        this.mode = modeOf(info?.sandbox, info?.collaborationMode)
        if (this.mode !== 'plan')
            this.workMode = this.mode
        this.transcript.finish('end_turn')
        this.loading = false
        if (this.options.readOnly)
            return
        await this.loadModels().catch(error => console.warn(`[codex] model/list failed:`, error?.message ?? error))
        this.transcript.setEmitter(event => this.emit(event))
        this.callbacks.onSession?.(this, info?.thread?.name ? { title: info.thread.name } : {})
    }

    private async loadModels() {
        const models: ModelInfo[] = []
        let cursor: string | undefined
        for (let page = 0; page < 5; page++) {
            const result: any = await this.rpc('model/list', cursor ? { cursor } : {})
            for (const m of result?.data ?? []) {
                if (typeof m?.id !== 'string' || m.hidden)
                    continue
                models.push({
                    id: m.model ?? m.id,
                    name: String(m.displayName ?? m.id),
                    efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => ({ value: String(e.reasoningEffort), description: e.description })),
                    defaultEffort: m.defaultReasoningEffort,
                    images: !Array.isArray(m.inputModalities) || m.inputModalities.includes('image'),
                })
            }
            cursor = result?.nextCursor || undefined
            if (!cursor)
                break
        }
        this.models = models
        if (!this.effort)
            this.effort = this.currentModel()?.defaultEffort ?? ''
    }

    private currentModel(): ModelInfo | undefined {
        return this.models.find(m => m.id === this.model)
    }

    /** Model, reasoning effort and mode as the composer's selects. */
    private configOptions(): AcpConfigOption[] {
        const options: AcpConfigOption[] = []
        const models = this.models.some(m => m.id === this.model) || !this.model ? this.models : [{ id: this.model, name: this.model, efforts: [], images: true }, ...this.models]
        if (models.length)
            options.push({ id: 'model', name: tr('模型', 'Model'), category: 'model', currentValue: this.model, options: models.map(m => ({ value: m.id, name: m.name })) })
        const efforts = this.currentModel()?.efforts ?? []
        if (efforts.length)
            options.push({ id: 'reasoning_effort', name: tr('思考强度', 'Reasoning'), category: 'thought_level', currentValue: this.effort, options: efforts.map(e => ({ value: e.value, name: e.value, description: e.description })) })
        options.push(modeOption(this.mode))
        return options
    }

    private configChanged() {
        this.emit({ type: 'acp_config_changed', configOptions: this.configOptions() })
    }

    private setConfig(configId: string, value: string) {
        if (configId === 'model') {
            if (!this.models.some(m => m.id === value))
                throw new Error(tr(`没有这个模型：${value}`, `No such model: ${value}`))
            this.model = value
            const model = this.currentModel()
            if (model && !model.efforts.some(e => e.value === this.effort))
                this.effort = model.defaultEffort ?? model.efforts[0]?.value ?? ''
        }
        else if (configId === 'reasoning_effort') {
            if (!(this.currentModel()?.efforts ?? []).some(e => e.value === value))
                throw new Error(tr(`这个模型没有 ${value} 思考强度`, `This model has no ${value} reasoning effort`))
            this.effort = value
        }
        else if (configId === 'mode') {
            if (!(value in MODES))
                throw new Error(tr(`没有这个模式：${value}`, `No such mode: ${value}`))
            this.mode = value as ModeId
            if (this.mode !== 'plan')
                this.workMode = this.mode
        }
        else {
            throw new Error(tr('没有这个选项', 'No such option'))
        }
        // Taken up by the next turn (turn/start carries them).
        this.configChanged()
    }

    /** The settings every turn carries: Codex applies them to it and the turns after. */
    private turnSettings() {
        const mode = MODES[this.mode]
        return {
            approvalPolicy: mode.approvalPolicy,
            sandboxPolicy: mode.sandboxPolicy,
            ...(this.model ? { model: this.model } : {}),
            ...(this.effort ? { effort: this.effort } : {}),
            ...(this.model
                ? { collaborationMode: { mode: this.mode === 'plan' ? 'plan' : 'default', settings: { model: this.model, reasoning_effort: this.effort || null, developer_instructions: null } } }
                : {}),
        }
    }

    // ---------------------------------------------------------------- history

    /**
     * The thread's turns, oldest first, page by page (codex 0.160: `asc`, `data`, `nextCursor`),
     * with every item. A failure throws: an empty thread would look like a session with no history.
     */
    private async loadHistory() {
        const turns: any[] = []
        let cursor: string | null | undefined
        do {
            const page: any = await this.rpc('thread/turns/list', { threadId: this.threadId, sortDirection: 'asc', itemsView: 'full', cursor })
            turns.push(...(page?.data ?? []))
            cursor = page?.nextCursor
        } while (cursor)
        turns.forEach((turn, i) => {
            let prompted = false
            for (const item of turn.items ?? []) {
                if (item?.type === 'userMessage' && !prompted) {
                    prompted = true
                    this.historyItem(item)
                    if (turn.id)
                        this.turnAt.set(this.transcript.messages.length - 1, turn.id)
                    continue
                }
                if (item?.type === 'plan')
                    this.historyPlan(item, turns[i + 1])
                else
                    this.historyItem(item)
            }
            this.transcript.finish(turn.status === 'interrupted' ? 'cancelled' : 'end_turn', undefined, turn.status === 'failed' ? String(turn.error?.message ?? 'Failed') : undefined)
        })
    }

    private historyItem(item: any) {
        switch (item?.type) {
            case 'userMessage':
                for (const input of item.content ?? []) {
                    if (input?.type === 'text' && typeof input.text === 'string')
                        this.transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: input.text } })
                    else if (input?.type === 'image' && typeof input.url === 'string') {
                        const m = /^data:([^;]+);base64,(.*)$/s.exec(input.url)
                        if (m)
                            this.transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: m[1], data: m[2] } })
                    }
                }
                break
            case 'agentMessage':
                this.transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: item.text ?? '' } })
                break
            case 'reasoning': {
                // The raw reasoning when Codex kept it, else its summary.
                const parts: string[] = item.content?.length ? item.content : item.summary ?? []
                for (const part of parts)
                    this.transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part } })
                break
            }
            case 'contextCompaction':
                this.transcript.compaction('', 0)
                break
            default: {
                const update = itemUpdate(item)
                if (update)
                    this.transcript.update({ sessionUpdate: 'tool_call', ...update, status: update.status === 'in_progress' ? 'failed' : update.status })
            }
        }
    }

    /** A plan read back: what the next turn did with it (accepted it, asked for changes) is its outcome. */
    private historyPlan(item: any, next: any) {
        const plan = String(item.text ?? '')
        const reply = (next?.items ?? []).find((i: any) => i?.type === 'userMessage')
        const text = (reply?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
        const details = !reply
            ? { kind: 'plan', status: 'cancelled', plan }
            : text.trim() === IMPLEMENT_PLAN ? { kind: 'plan', status: 'approved', plan } : { kind: 'plan', status: 'revised', plan, feedback: text }
        this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: item.id, status: 'completed', _meta: { piCalls: [call(item.id, 'propose_plan', { plan })], piDetails: { [item.id]: details } } })
    }

    // ---------------------------------------------------------------- server → client

    private notification(method: string, params: any) {
        // Subagents run as threads of their own; their events are not this thread's.
        if (params?.threadId && this.threadId && params.threadId !== this.threadId)
            return
        if (this.loading)
            return
        switch (method) {
            case 'turn/started':
                this.turnId ??= String(params?.turn?.id ?? '') || null
                break
            case 'turn/completed':
                this.turnCompleted(params?.turn)
                break
            case 'error':
                if (!params?.willRetry)
                    this.turnError = String(params?.error?.message ?? '')
                break
            case 'thread/tokenUsage/updated': {
                const usage = params?.tokenUsage
                if (usage?.total)
                    this.tokens = usage.total
                const size = usage?.modelContextWindow
                if (usage?.last && typeof size === 'number' && size > 0)
                    this.context = { used: usage.last.totalTokens ?? 0, size }
                break
            }
            case 'thread/name/updated':
                if (typeof params?.threadName === 'string' && params.threadName)
                    this.callbacks.onSession?.(this, { title: params.threadName })
                break
            case 'turn/plan/updated':
                this.transcript.update({
                    sessionUpdate: 'plan',
                    entries: (params?.plan ?? []).map((s: any) => ({ content: String(s?.step ?? ''), status: s?.status === 'inProgress' ? 'in_progress' : s?.status })),
                })
                break
            case 'item/started':
                this.itemStarted(params?.item)
                break
            case 'item/completed':
                this.itemCompleted(params?.item)
                break
            case 'item/agentMessage/delta':
                this.streamed.add(params?.itemId)
                this.transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(params?.delta ?? '') } })
                break
            case 'item/reasoning/textDelta':
            case 'item/reasoning/summaryTextDelta':
                this.streamed.add(params?.itemId)
                this.transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(params?.delta ?? '') } })
                break
            case 'item/reasoning/summaryPartAdded':
                if (this.streamed.has(params?.itemId))
                    this.transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '\n\n' } })
                break
            case 'item/plan/delta':
                if (this.planItem && this.planItem.id === params?.itemId) {
                    this.planItem.text += String(params?.delta ?? '')
                    this.showPlan()
                }
                break
            case 'item/commandExecution/outputDelta':
            case 'item/fileChange/outputDelta':
                this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: params?.itemId, _meta: { terminal_output_delta: { data: String(params?.delta ?? '') } } })
                break
            default:
                break
        }
    }

    private itemStarted(item: any) {
        if (!item?.id)
            return
        if (item.type === 'plan') {
            this.planItem = { id: item.id, text: String(item.text ?? '') }
            this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: item.id, status: 'in_progress', _meta: { piCalls: [call(item.id, 'propose_plan', { plan: this.planItem.text })] } })
            return
        }
        const update = itemUpdate(item)
        if (update)
            this.transcript.update({ sessionUpdate: 'tool_call', ...update, status: 'in_progress' })
    }

    private itemCompleted(item: any) {
        if (!item?.id)
            return
        switch (item.type) {
            case 'userMessage':
                // Shown when it was sent (prompt, steer).
                return
            case 'agentMessage':
                if (!this.streamed.has(item.id) && item.text)
                    this.transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: item.text } })
                return
            case 'reasoning':
                if (!this.streamed.has(item.id)) {
                    for (const part of (item.content?.length ? item.content : item.summary ?? []) as string[])
                        this.transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part } })
                }
                return
            case 'plan':
                // Stays open: the user reviews it once the turn ends.
                if (this.planItem && this.planItem.id === item.id) {
                    this.planItem.text = String(item.text ?? this.planItem.text)
                    this.showPlan()
                }
                return
            case 'contextCompaction':
                this.transcript.compaction('', 0)
                return
        }
        const update = itemUpdate(item)
        if (update)
            this.transcript.update({ sessionUpdate: 'tool_call_update', ...update })
    }

    private showPlan() {
        const item = this.planItem!
        this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: item.id, _meta: { piCalls: [call(item.id, 'propose_plan', { plan: item.text })] } })
    }

    private serverRequest(method: string, params: any): Promise<unknown> {
        if (params?.threadId && this.threadId && params.threadId !== this.threadId)
            return Promise.reject(new RpcError(`Not this thread: ${params.threadId}`, -32602))
        switch (method) {
            case 'item/commandExecution/requestApproval':
                return this.approval(params, 'command')
            case 'item/fileChange/requestApproval':
                return this.approval(params, 'file')
            case 'item/tool/requestUserInput':
                return this.ask(params)
            case 'mcpServer/elicitation/request':
                return Promise.resolve({ action: 'decline', content: null })
            default:
                // Permission profiles, client-side tools, auth refresh: not something this app provides.
                return Promise.reject(new RpcError(`Method not found: ${method}`, -32601))
        }
    }

    /** A command or file change waiting on the user → the approval prompt. */
    private approval(params: any, kind: 'command' | 'file'): Promise<unknown> {
        if (this.options.readOnly)
            return Promise.resolve({ decision: 'cancel' })
        const itemId = String(params?.itemId ?? '')
        const shown = this.transcript.callsOf(itemId)
        let always: unknown
        let alwaysLabel: string | undefined
        if (kind === 'command') {
            const decisions: any[] = Array.isArray(params?.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline']
            const amendment = decisions.find(d => d && typeof d === 'object' && d.acceptWithExecpolicyAmendment)
            if (decisions.includes('acceptForSession')) {
                always = 'acceptForSession'
                alwaysLabel = tr('本会话都允许', 'Allow for this session')
            }
            else if (amendment) {
                always = amendment
                const prefix = (amendment.acceptWithExecpolicyAmendment.execpolicy_amendment ?? []).join(' ')
                alwaysLabel = tr(`总是允许 ${prefix}`, `Always allow ${prefix}`)
            }
        }
        else {
            always = 'acceptForSession'
            alwaysLabel = tr('本会话都允许改这些文件', 'Allow these files for this session')
        }
        const summary = kind === 'command'
            ? displayCommand(String(params?.command ?? shown[0]?.arguments?.command ?? ''))
            : shown.map(c => String(c.arguments?.path ?? '')).filter(Boolean).join('\n') || String(params?.reason ?? '')
        const reason = typeof params?.reason === 'string' && params.reason && kind === 'command' ? `\n${params.reason}` : ''
        const approval: ApprovalRequest = {
            toolCallId: shown[0]?.id ?? itemId,
            tool: shown[0]?.name ?? (kind === 'command' ? 'bash' : 'edit'),
            summary: summary + reason,
            scope: always ? 'codex' : '',
            alwaysLabel,
        }
        const requestId = `codex-approval-${randomUUID()}`
        const choices: ApprovalChoice[] = always ? ['allow', 'always', 'deny'] : ['allow', 'deny']
        return new Promise((resolve) => {
            this.approvals.set(requestId, { resolve, always, itemId })
            this.emit({ type: 'extension_ui_request', id: requestId, method: 'select', title: `${APPROVAL_TITLE_PREFIX}${JSON.stringify(approval)}`, options: choices })
        })
    }

    private answerApproval(requestId: string, payload: Record<string, unknown>) {
        const wait = this.approvals.get(requestId)
        if (!wait)
            return
        this.approvals.delete(requestId)
        const value = payload.cancelled ? undefined : payload.value
        const decision = value === 'allow' ? 'accept' : value === 'always' ? wait.always ?? 'accept' : value === 'deny' ? 'decline' : 'cancel'
        wait.resolve({ decision })
    }

    /** request_user_input (plan mode) → the ask capability's form, as a call of its own on the turn. */
    private ask(params: any): Promise<unknown> {
        const id = String(params?.itemId ?? '') || `codex-ask-${randomUUID()}`
        const questions = askQuestionsOf(params?.questions)
        if (this.options.readOnly || !questions.length || this.asks.has(id))
            return Promise.resolve({ answers: {} })
        this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress', _meta: { piCalls: [call(id, 'ask', { questions })] } })
        return new Promise((resolve) => {
            this.asks.set(id, { resolve, questions })
            if (!this.transcript.setDetails(id, { kind: 'ask', status: 'pending', questions })) {
                this.asks.delete(id)
                resolve({ answers: {} })
            }
        })
    }

    private answerAsk(id: string, response: AskResponse) {
        const wait = this.asks.get(id)
        if (!wait)
            throw new Error(tr('这个问题已经不在等回答了', 'This question is no longer waiting for an answer'))
        this.asks.delete(id)
        const { codex, shown } = codexAnswers(wait.questions, response)
        const answered = Object.keys(codex).length > 0
        this.transcript.setDetails(id, answered ? { kind: 'ask', status: 'answered', questions: wait.questions, answers: shown } : { kind: 'ask', status: 'cancelled', questions: wait.questions })
        this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
        wait.resolve({ answers: codex })
    }

    /** The proposed plan's review: accept leaves plan mode and starts on it, feedback revises it. */
    private decidePlan(id: string, decision: PlanDecision) {
        const wait = this.planWait
        if (!wait || wait.id !== id)
            throw new Error(tr('这个计划已经不在等审批了', 'This plan is no longer waiting for a decision'))
        this.planWait = null
        const feedback = 'feedback' in decision ? decision.feedback.trim() : ''
        const details = 'approve' in decision
            ? { kind: 'plan' as const, status: 'approved' as const, plan: wait.plan }
            : feedback ? { kind: 'plan' as const, status: 'revised' as const, plan: wait.plan, feedback } : { kind: 'plan' as const, status: 'cancelled' as const, plan: wait.plan }
        this.transcript.setDetails(id, details)
        this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
        this.transcript.finish('end_turn', wait.usage)
        if (details.status === 'approved') {
            this.mode = this.workMode
            this.configChanged()
            this.run(IMPLEMENT_PLAN, [])
        }
        else if (details.status === 'revised') {
            this.run(feedback, [])
        }
        else {
            this.afterTurn(false)
        }
    }

    /** Approvals, questions and a plan still waiting get a cancel (stop, exit). */
    private cancelWaits() {
        for (const [id] of this.approvals)
            this.answerApproval(id, { cancelled: true })
        for (const [id] of this.asks)
            this.answerAsk(id, { cancelled: true })
        if (this.planWait && !this.exited)
            this.decidePlan(this.planWait.id, { cancelled: true })
        this.planWait = null
    }

    /** The capability forms' hidden commands (`/gui-ask-answer <id> <json>`, …); false if not one. */
    private async guiCommand(message: string): Promise<boolean> {
        const m = /^\/(gui-ask-answer|gui-plan-decide|gui-rewind) (\S+)(?: ([\s\S]+))?$/.exec(message)
        if (!m)
            return false
        if (m[1] === 'gui-rewind')
            await this.rewind(m[2])
        else if (m[1] === 'gui-ask-answer')
            this.answerAsk(m[2], JSON.parse(m[3] ?? '{}') as AskResponse)
        else
            this.decidePlan(m[2], JSON.parse(m[3] ?? '{}') as PlanDecision)
        return true
    }

    // ---------------------------------------------------------------- turns

    private emitQueue() {
        this.emit({ type: 'queue_update', steering: [], followUp: this.queued.map(q => q.message) })
    }

    private async prompt(message: string, images: ImageContent[], steer: boolean) {
        if (images.length && this.currentModel()?.images === false)
            throw new Error(tr(`${this.currentModel()!.name} 不接受图片`, `${this.currentModel()!.name} does not take images`))
        // Typed while a plan waits for review: that is feedback on it.
        if (this.planWait) {
            this.decidePlan(this.planWait.id, { feedback: message })
            return {}
        }
        if (this.running) {
            if (steer && this.turnId) {
                try {
                    await this.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: inputOf(message, images) })
                    this.transcript.userPrompt(message, images)
                    return {}
                }
                catch {
                    // The turn ended meanwhile: the message goes as the next one.
                }
            }
            if (this.running) {
                this.queued.push({ message, images })
                this.emitQueue()
                return {}
            }
        }
        this.running = true
        this.emit({ type: 'agent_start' })
        this.run(message, images)
        return {}
    }

    /** One turn/start; the turn streams in and ends with turn/completed. */
    private run(message: string, images: ImageContent[]) {
        this.transcript.userPrompt(message, images)
        const at = this.transcript.messages.length - 1
        this.callbacks.onSession?.(this, { prompt: message })
        this.turnId = null
        this.turnStarting = true
        this.turnError = ''
        this.planItem = null
        this.turnBase = this.tokens
        this.rpc('turn/start', { threadId: this.threadId, input: inputOf(message, images), ...this.turnSettings() }).then(
            (result: any) => {
                this.turnStarting = false
                const id = String(result?.turn?.id ?? '')
                if (id) {
                    this.turnId ??= id
                    this.turnAt.set(at, id)
                }
                if (this.abortWanted)
                    void this.interrupt()
            },
            (error: any) => {
                this.turnStarting = false
                this.transcript.finish(undefined, undefined, this.explain(error))
                this.afterTurn(true)
            },
        )
    }

    private turnCompleted(turn: any) {
        if (!this.running)
            return
        const status = String(turn?.status ?? '')
        const usage = this.tokens ? usageBetween(this.turnBase, this.tokens) : undefined
        this.turnId = null
        this.abortWanted = false
        // Approvals and questions belong to the turn; Codex has dropped any still open.
        for (const [id] of this.approvals) {
            this.answerApproval(id, { cancelled: true })
            this.emit({ type: 'extension_ui_cancel', id })
        }
        for (const [id] of this.asks)
            this.answerAsk(id, { cancelled: true })
        const plan = this.planItem
        this.planItem = null
        if (status === 'completed' && plan && plan.text.trim()) {
            this.planWait = { id: plan.id, plan: plan.text, usage }
            this.transcript.setDetails(plan.id, { kind: 'plan', status: 'pending', plan: plan.text })
            return
        }
        const error = status === 'failed' ? this.explain(turn?.error?.message || this.turnError || tr('这一轮失败了', 'The turn failed')) : undefined
        this.transcript.finish(status === 'interrupted' ? 'cancelled' : 'end_turn', usage, error)
        this.afterTurn(status === 'interrupted')
    }

    /** A turn ended: the next follow-up goes, or the run ends. */
    private afterTurn(cancelled: boolean) {
        const next = cancelled ? undefined : this.queued.shift()
        if (next && !this.exited) {
            this.emitQueue()
            this.run(next.message, next.images)
            return
        }
        this.running = false
        this.emit({ type: 'agent_end' })
        this.emit({ type: 'agent_settled' })
        this.callbacks.onSession?.(this, {})
    }

    private async interrupt() {
        this.abortWanted = false
        if (this.turnId)
            await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
    }

    /** Ask again: the thread goes back to before the prompt at `entryId`; the files stay as they are. */
    private async rewind(entryId: string) {
        if (this.running)
            throw new Error(tr('运行中不能重问，先停止或等它结束', 'Cannot ask again while running; stop it or wait for it to finish'))
        const at = Number(entryId)
        const turnId = this.turnAt.get(at)
        if (!turnId)
            throw new Error(tr('这条消息不是一轮的开头，不能从这里重问', 'This message does not start a turn; cannot ask again from here'))
        await this.rpc('thread/revert', { threadId: this.threadId, beforeTurnId: turnId })
        this.cut(at)
        this.callbacks.onSession?.(this, {})
    }

    /** Forget the transcript from position `at` on. */
    private cut(at: number) {
        this.transcript.truncate(at)
        for (const position of [...this.turnAt.keys()]) {
            if (position >= at)
                this.turnAt.delete(position)
        }
    }

    /**
     * pi's fork: this process moves to a new thread holding the turns before `entryId` (a prompt),
     * and the prompt comes back to edit. The thread it came from stays as it was.
     */
    private async forkAt(entryId: string) {
        if (this.running)
            throw new Error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
        const at = Number(entryId)
        const turnId = this.turnAt.get(at)
        const prompt = this.transcript.messages[at]?.message
        if (!turnId || prompt?.role !== 'user')
            throw new Error(tr('这条消息不是一轮的开头，不能从这里分叉', 'This message does not start a turn; cannot fork from here'))
        const content = prompt.content
        const text = typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => (c as any).text).join('')
        const result: any = await this.rpc('thread/fork', { threadId: this.threadId, beforeTurnId: turnId, excludeTurns: true })
        const forked = String(result?.thread?.id ?? '')
        if (!forked)
            throw new Error(tr('分叉没有返回线程', 'The fork returned no thread'))
        this.cut(at)
        // Listed under its own key, with the transcript before the prompt; then this process is it.
        this.callbacks.onFork?.(this, forked)
        this.threadId = forked
        this.callbacks.onSession?.(this, {})
        return { text }
    }

    // ---------------------------------------------------------------- pi RPC

    /** Fire-and-forget records from the renderer (extension_ui_response). */
    write(record: Record<string, unknown>) {
        if (record.type === 'extension_ui_response' && typeof record.id === 'string')
            this.answerApproval(record.id, record)
    }

    async request(command: Record<string, unknown>): Promise<RpcResponse> {
        const type = String(command.type)
        const ok = (data?: unknown): RpcResponse => ({ type: 'response', command: type, success: true, data })
        try {
            await this.ready
            switch (type) {
                case 'get_state':
                    return ok({
                        model: this.piModel(),
                        thinkingLevel: this.effort || undefined,
                        isStreaming: this.running,
                        isCompacting: false,
                        sessionFile: this.key,
                        sessionId: this.threadId,
                        sessionName: undefined,
                        configOptions: this.configOptions(),
                        agentCaps: this.caps,
                    })
                case 'get_available_models':
                    return ok({ models: this.models.map(m => ({ id: m.id, name: m.name, provider: this.spec.label })) })
                case 'get_available_thinking_levels':
                    return ok({ levels: (this.currentModel()?.efforts ?? []).map(e => e.value) })
                case 'get_commands':
                    return ok({ commands: [] })
                case 'get_session_stats': {
                    const tokens = this.transcript.totals()
                    const context = this.context
                    return ok({
                        tokens,
                        cost: undefined,
                        contextUsage: context ? { tokens: context.used, contextWindow: context.size, percent: context.size ? (context.used / context.size) * 100 : null } : undefined,
                    })
                }
                case 'prompt': {
                    const message = String(command.message ?? '')
                    if (await this.guiCommand(message))
                        return ok({ disposition: 'handled' })
                    return ok(await this.prompt(message, Array.isArray(command.images) ? command.images as ImageContent[] : [], command.streamingBehavior === 'steer'))
                }
                case 'abort':
                    this.cancelWaits()
                    if (this.turnId)
                        await this.interrupt()
                    else if (this.turnStarting)
                        this.abortWanted = true
                    return ok()
                case 'clear_queue': {
                    const followUp = this.queued.map(q => q.message)
                    this.queued = []
                    this.emitQueue()
                    return ok({ steering: [], followUp })
                }
                case 'compact':
                    return ok(await this.compact())
                case 'fork':
                    return ok(await this.forkAt(String(command.entryId ?? '')))
                case 'acp_fork': {
                    if (this.running)
                        throw new Error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
                    const result: any = await this.rpc('thread/fork', { threadId: this.threadId, excludeTurns: true })
                    const forked = String(result?.thread?.id ?? '')
                    if (!forked)
                        throw new Error(tr('分叉没有返回线程', 'The fork returned no thread'))
                    return ok({ sessionFile: this.callbacks.onFork?.(this, forked) ?? acpSessionKey(this.spec.id, forked) })
                }
                case 'set_model':
                    this.setConfig('model', String(command.modelId ?? ''))
                    return ok()
                case 'set_thinking_level':
                    this.setConfig('reasoning_effort', String(command.level ?? ''))
                    return ok()
                case 'set_config_option':
                    this.setConfig(String(command.configId ?? ''), String(command.value ?? ''))
                    return ok({ configOptions: this.configOptions() })
                case 'set_session_name': {
                    const name = String(command.name ?? '')
                    this.callbacks.onSession?.(this, { name })
                    if (name.trim()) {
                        await this.rpc('thread/name/set', { threadId: this.threadId, name: name.trim() })
                            .catch(error => console.warn(`[codex] rename failed:`, error?.message ?? error))
                    }
                    return ok()
                }
                default:
                    return { type: 'response', command: type, success: false, error: tr(`${this.spec.label} 不支持这个操作（${type}）`, `${this.spec.label} does not support this (${type})`) }
            }
        }
        catch (error: any) {
            return { type: 'response', command: type, success: false, error: String(error?.message ?? error) }
        }
    }

    private piModel(): PiModel | undefined {
        if (!this.model)
            return undefined
        return { id: this.model, name: this.currentModel()?.name ?? this.model, provider: this.spec.label, reasoning: !!this.currentModel()?.efforts.length } as PiModel
    }

    /** Codex compacts as a turn of its own (a contextCompaction item); it streams in and settles like one. */
    private async compact() {
        if (this.running)
            throw new Error(tr('运行中不能压缩，等它结束或先停止', 'Cannot compact while running; wait or stop it first'))
        this.running = true
        this.turnBase = this.tokens
        this.emit({ type: 'agent_start' })
        try {
            await this.rpc('thread/compact/start', { threadId: this.threadId })
        }
        catch (error) {
            this.running = false
            this.emit({ type: 'agent_end' })
            this.emit({ type: 'agent_settled' })
            throw error
        }
        return {}
    }

    stop(): Promise<void> {
        if (this.exited)
            return Promise.resolve()
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000)
            this.child.once('exit', () => {
                clearTimeout(timer)
                resolve()
            })
            this.child.stdin.end()
            this.child.kill('SIGTERM')
        })
    }
}

// ---------------------------------------------------------------- outside a thread

/** A short-lived app-server for one piece of work (the thread list, a delete). */
async function withAppServer<T>(launch: CodexLaunch, work: (rpc: (method: string, params: unknown) => Promise<any>) => Promise<T>, timeoutMs = 20_000): Promise<T> {
    const child = spawn(launch.file, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'ignore'] })
    const connection = new AcpConnection(child.stdin, child.stdout, {
        onNotification: () => {},
        onRequest: async method => Promise.reject(new RpcError(`Method not found: ${method}`, -32601)),
    })
    const exited = new Promise<never>((_resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => reject(new Error(`codex app-server exited (${code})`)))
    })
    exited.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('codex app-server: timed out')), timeoutMs)
    })
    const run = async () => {
        await connection.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } })
        connection.notify('initialized', undefined)
        return work((method, params) => connection.request(method, params))
    }
    try {
        return await Promise.race([run(), exited, timeout])
    }
    finally {
        clearTimeout(timer)
        connection.close(new Error('closed'))
        child.stdin.end()
        child.kill('SIGTERM')
    }
}

export interface CodexThreadSummary {
    sessionId: string
    cwd: string
    title?: string
    updatedAt: number
}

/** Codex's own thread list (thread/list), newest first; `complete` when every page was read. */
export function listCodexThreads(launch: CodexLaunch, maxPages = 8): Promise<{ sessions: CodexThreadSummary[], complete: boolean }> {
    return withAppServer(launch, async (rpc) => {
        const sessions: CodexThreadSummary[] = []
        let cursor: string | undefined
        for (let page = 0; page < maxPages; page++) {
            const result = await rpc('thread/list', { limit: 100, sourceKinds: LISTED_SOURCES, ...(cursor ? { cursor } : {}) })
            for (const t of result?.data ?? []) {
                if (typeof t?.id !== 'string' || !t.id || typeof t.cwd !== 'string' || !t.cwd)
                    continue
                const title = (typeof t.name === 'string' && t.name.trim()) || (typeof t.preview === 'string' && t.preview.trim()) || ''
                // Seconds.
                const at = typeof t.updatedAt === 'number' ? t.updatedAt : typeof t.createdAt === 'number' ? t.createdAt : 0
                sessions.push({ sessionId: t.id, cwd: t.cwd, title: title ? title.slice(0, 200) : undefined, updatedAt: at * 1000 })
            }
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
            if (!cursor)
                return { sessions, complete: true }
        }
        return { sessions, complete: false }
    })
}

/** Deletes a thread from Codex's own history. */
export function deleteCodexThread(launch: CodexLaunch, threadId: string): Promise<void> {
    return withAppServer(launch, async (rpc) => {
        await rpc('thread/delete', { threadId })
    })
}
