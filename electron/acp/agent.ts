// One ACP agent process (e.g. codex-acp) bound to one session, speaking pi's RPC to the renderer.
//
// The renderer drives every thread with pi RPC commands (get_state, prompt, abort, set_model, …) and
// reads pi events; this class answers those commands with ACP requests and turns ACP updates into pi
// events through AcpTranscript. Approvals become the approval capability's select dialog, so the
// existing prompt UI handles them.

import type { AcpAgentCaps, AcpAgentSpec, AcpConfigOption } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { ApprovalChoice, ApprovalRequest, AskQuestion, AskResponse, PlanDecision } from '@shared/capabilities'
import type { ImageContent, PiEvent, PiModel, RpcResponse, SlashCommand } from '@shared/pi'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PromptUsage } from './transcript'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from './adapter'
import { acpCaps, acpSessionKey } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { tr } from '../i18n'
import { AcpConnection, methodNotFound } from './connection'
import { AcpTranscript, askQuestions, piToolCalls, XAI_OTHER, xaiAskAnswer, xaiUsage } from './transcript'

const STDERR_LIMIT = 64 * 1024

const blocksOf = (message: string, images: ImageContent[]) => [
    ...(message ? [{ type: 'text', text: message }] : []),
    ...images.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
]
export const ACP_PROTOCOL_VERSION = 1

export interface AcpLaunch {
    file: string
    args: string[]
    /** Set when `file` is cmd.exe running a batch file (platform Command). */
    windowsVerbatimArguments?: boolean
    /** The command as found, when `file` is what runs it (Windows: node for an npm .cmd shim). */
    bin?: string
    env: Record<string, string>
    via?: 'path' | 'app' | 'override'
    /** The app's install predates the pinned version. */
    outdated?: boolean
}

interface PermissionWait {
    resolve: (outcome: unknown) => void
    options: { optionId: string, kind: string, name: string }[]
}

/** A Grok Build x.ai/ask_user_question or x.ai/exit_plan_mode waiting for the user. */
interface AskWait {
    resolve: (response: unknown) => void
    questions: AskQuestion[]
}
interface PlanWait {
    resolve: (response: unknown) => void
    plan: string
}

/** Grok Build turns it starts itself, for an interjection that missed the turn it was meant for. */
const XAI_FALLBACK_PREFIX = 'interject-fallback-'

/** Grok Build's session modes (SessionMode); it announces none, but takes them in session/set_mode. */
const xaiModeOption = (current = 'default'): AcpConfigOption => ({
    id: 'mode',
    name: tr('模式', 'Mode'),
    category: 'mode',
    currentValue: current,
    options: [
        { value: 'default', name: tr('默认', 'Default') },
        { value: 'plan', name: tr('计划', 'Plan'), description: tr('只读探索并写计划，你批准后再动手', 'Explores read-only and writes a plan; changes start once you approve it') },
    ],
})

/**
 * Client capabilities: the agent runs its own tools; we want plans and command output chunks
 * (codex-acp / Claude Code: terminal_output_delta; Grok Build: the output so far in each update).
 */
const CLIENT_CAPABILITIES = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    plan: {},
    _meta: { 'terminal_output_delta': true, 'x.ai/incrementalBashOutput': true },
}

function selectOptions(raw: unknown): AcpConfigOption[] {
    if (!Array.isArray(raw))
        return []
    return raw
        .filter((o: any) => o && typeof o.id === 'string' && (o.type === 'select' || Array.isArray(o.options)))
        .map((o: any) => ({
            id: o.id,
            name: String(o.name ?? o.id),
            description: typeof o.description === 'string' ? o.description : undefined,
            category: typeof o.category === 'string' ? o.category : undefined,
            currentValue: String(o.currentValue ?? ''),
            // Options may come grouped: { group, name, options: [...] }.
            options: (o.options ?? []).flatMap((v: any) => (Array.isArray(v?.options) ? v.options : [v]))
                .filter((v: any) => typeof v?.value === 'string')
                .map((v: any) => ({ value: v.value, name: String(v.name ?? v.value), description: typeof v.description === 'string' ? v.description : undefined })),
        }))
}

export class AcpAgent implements AgentAdapter {
    readonly id = randomUUID()
    private child: ChildProcessWithoutNullStreams
    private connection: AcpConnection
    private stderr = ''
    private exited = false
    readonly ready: Promise<void>
    sessionId = ''
    private initResult: any = {}
    private transcript: AcpTranscript
    private configOptions: AcpConfigOption[] = []
    /** Built from session models / modes, set with session/set_model and session/set_mode. */
    private legacyConfig = false
    private commands: SlashCommand[] = []
    private context: { used: number, size: number } | null = null
    private cost: number | undefined
    private running = false
    /** session/load is replaying history. */
    private loading = true
    private permissions = new Map<string, PermissionWait>()
    /** Typed mid-run where the agent cannot take it then: sent as the next prompts, in order. */
    private queued: { message: string, images: ImageContent[] }[] = []
    /** The session cwd as ACP knows it (real path). */
    private sessionCwd = ''
    /** Our session/prompt is out (`running` also covers turns the agent starts itself). */
    private prompting = false
    /** The last agent timestamp seen (Grok Build stamps every update); replayed messages take it. */
    private clock: number | undefined

    // Grok Build (caps.xai) ------------------------------------------------
    /** Prompt ids we sent, and turns Grok reported done (turn_completed), live or replayed. */
    private sentPrompts = new Set<string>()
    private doneTurns = new Set<string>()
    /** Turns Grok runs on its own (a stranded interjection's fallback), until prompt_complete. */
    private ownTurns = new Set<string>()
    /** Interjections sent with x.ai/interject, shown queued until Grok takes them in. */
    private steers: string[] = []
    /** Interjections shown when a run ended without them; a fallback turn for one adds no second message. */
    private strays: string[] = []
    /** A model call is streaming; an interjection joins before the next one. */
    private inModelCall = false
    private retrying = false
    private compactingByHand = false
    /** Context window per model id (`_meta.totalContextTokens`). */
    private contextWindows = new Map<string, number>()
    private asks = new Map<string, AskWait>()
    private plans = new Map<string, PlanWait>()

    /** The launch environment holds the agent's API key (from the environment or pi's providers). */
    private hasApiKey: boolean

    constructor(readonly spec: AcpAgentSpec, launch: AcpLaunch, private options: AgentAdapterOptions, private callbacks: AgentAdapterCallbacks) {
        this.hasApiKey = !!(spec.apiKey && launch.env[spec.apiKey.env])
        this.transcript = new AcpTranscript('', { model: () => this.modelStamp(), inputIncludesCache: spec.inputIncludesCache, now: () => (this.loading ? this.clock ?? options.replayTime ?? Date.now() : Date.now()) })
        this.child = spawn(launch.file, launch.args, { cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: launch.windowsVerbatimArguments })
        this.connection = new AcpConnection(this.child.stdin, this.child.stdout, {
            onNotification: (method, params) => this.notification(method, params),
            onRequest: (method, params) => this.agentRequest(method, params),
        })
        this.child.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
        })
        const finish = (code: number | null, signal: string | null) => {
            if (this.exited)
                return
            this.exited = true
            this.connection.close(new Error(this.lastError() || tr(`${spec.label} 已退出（${code ?? signal}）`, `${spec.label} exited (${code ?? signal})`)))
            for (const wait of this.permissions.values())
                wait.resolve({ outcome: { outcome: 'cancelled' } })
            this.permissions.clear()
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
        return this.sessionId ? acpSessionKey(this.spec.id, this.sessionId) : ''
    }

    get cwd(): string {
        return this.options.cwd
    }

    get caps(): AcpAgentCaps {
        return acpCaps(this.initResult)
    }

    snapshot(): SessionItem[] {
        return this.transcript.snapshot()
    }

    private lastError(): string {
        return this.stderr.trim().split('\n').slice(-5).join('\n')
    }

    private async open() {
        this.initResult = await this.connection.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: CLIENT_CAPABILITIES,
            clientInfo: { name: 'pi-gui', version: '0.1.0' },
        })
        // ACP sessions are keyed by the real path (macOS: /tmp → /private/tmp).
        const cwd = await realpath(this.options.cwd).catch(() => this.options.cwd)
        this.sessionCwd = cwd
        let result: any
        try {
            if (this.options.sessionId) {
                if (!this.initResult?.agentCapabilities?.loadSession)
                    throw new Error(tr(`${this.spec.label} 不支持打开旧会话`, `${this.spec.label} cannot reopen sessions`))
                // History arrives as updates before the response; it fills the transcript silently.
                this.sessionId = this.options.sessionId
                result = await this.signedIn(() => this.connection.request('session/load', { sessionId: this.sessionId, cwd, mcpServers: [] }))
            }
            else {
                result = await this.signedIn(() => this.connection.request('session/new', { cwd, mcpServers: [] }))
                this.sessionId = String(result?.sessionId ?? '')
            }
        }
        catch (error: any) {
            throw new Error(this.explain(error))
        }
        this.transcript.finish('end_turn')
        this.loading = false
        this.noteModels(this.initResult?._meta?.modelState?.availableModels)
        this.noteModels(result?.models?.availableModels)
        this.applyConfig(result)
        this.transcript.setEmitter(event => this.emit(event))
        if (!this.options.readOnly)
            this.callbacks.onSession?.(this, {})
    }

    /**
     * Runs `open`; when the agent wants a sign-in and an API key is at hand, picks its API-key method
     * (ACP authenticate) and tries once more. Gemini CLI asks for that even with GEMINI_API_KEY set.
     */
    private async signedIn<T>(open: () => Promise<T>): Promise<T> {
        try {
            return await open()
        }
        catch (error: any) {
            const methods: any[] = Array.isArray(this.initResult?.authMethods) ? this.initResult.authMethods : []
            const method = methods.find(m => m?._meta?.['api-key'] || /api[-_]?key/i.test(String(m?.id ?? '')))
            if (error?.code !== -32000 || !this.hasApiKey || !method)
                throw error
            await this.connection.request('authenticate', { methodId: method.id })
            return await open()
        }
    }

    /** Sign-in errors read as what to do about them. */
    private explain(error: any): string {
        const message = String(error?.message ?? error)
        if (error?.code === -32000 || /auth|sign in|log ?in/i.test(message))
            return tr(`${this.spec.label} 还没有登录：${this.spec.signIn.zh}。（${message}）`, `${this.spec.label} is not signed in: ${this.spec.signIn.en}. (${message})`)
        return message
    }

    private applyConfig(result: any) {
        const options = selectOptions(result?.configOptions)
        if (options.length) {
            this.configOptions = this.withModes(options)
            this.legacyConfig = false
            return
        }
        // Agents without config options: models and modes (older ACP surface) as two selects.
        const legacy: AcpConfigOption[] = []
        const models = result?.models
        if (Array.isArray(models?.availableModels) && models.availableModels.length) {
            legacy.push({ id: 'model', name: 'Model', category: 'model', currentValue: String(models.currentModelId ?? ''), options: models.availableModels.map((m: any) => ({ value: String(m.modelId), name: String(m.name ?? m.modelId), description: m.description })) })
        }
        const modes = result?.modes
        if (Array.isArray(modes?.availableModes) && modes.availableModes.length) {
            legacy.push({ id: 'mode', name: 'Mode', category: 'mode', currentValue: String(modes.currentModeId ?? ''), options: modes.availableModes.map((m: any) => ({ value: String(m.id), name: String(m.name ?? m.id), description: m.description })) })
        }
        if (legacy.length) {
            this.configOptions = this.withModes(legacy)
            this.legacyConfig = true
        }
    }

    /** Grok Build's modes join its config options (it lists none of its own). */
    private withModes(options: AcpConfigOption[]): AcpConfigOption[] {
        if (!this.caps.xai || options.some(o => o.category === 'mode' || o.id === 'mode'))
            return options
        return [...options, xaiModeOption(this.configOptions.find(o => o.id === 'mode')?.currentValue)]
    }

    /** Context windows from Grok Build's model list (initialize `_meta.modelState`, session models, x.ai/models/update). */
    private noteModels(models: unknown) {
        if (!Array.isArray(models))
            return
        for (const m of models) {
            const size = m?._meta?.contextWindow ?? m?._meta?.totalContextTokens
            if (typeof m?.modelId === 'string' && typeof size === 'number' && size > 0)
                this.contextWindows.set(m.modelId, size)
        }
    }

    private option(category: string): AcpConfigOption | undefined {
        return this.configOptions.find(o => o.category === category) ?? this.configOptions.find(o => o.id === category)
    }

    private currentModel(): PiModel | undefined {
        const model = this.option('model')
        if (!model)
            return undefined
        const choice = model.options.find(o => o.value === model.currentValue)
        return { id: model.currentValue, name: choice?.name ?? model.currentValue, provider: this.spec.label, reasoning: !!this.option('thought_level') }
    }

    private modelStamp() {
        return { provider: this.spec.label, model: this.option('model')?.currentValue, thinkingLevel: this.option('thought_level')?.currentValue }
    }

    private emit(event: PiEvent) {
        if (!this.options.readOnly)
            this.callbacks.onEvent(this.id, event)
    }

    // ---------------------------------------------------------------- agent → client

    private notification(method: string, params: any) {
        // Grok Build's extensions go out as `_x.ai/…` (ACP's leading underscore for extension methods).
        const name = method.replace(/^_/, '')
        if (name.startsWith('x.ai/')) {
            this.xaiNotification(name, params)
            return
        }
        if (method !== 'session/update' || (this.sessionId && params?.sessionId && params.sessionId !== this.sessionId))
            return
        this.noteMeta(params?._meta)
        const update = params?.update
        switch (update?.sessionUpdate) {
            case 'available_commands_update':
                this.commands = (update.availableCommands ?? [])
                    .filter((c: any) => typeof c?.name === 'string')
                    .map((c: any) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : undefined, source: 'prompt' as const }))
                this.emit({ type: 'acp_commands_changed' })
                break
            case 'config_option_update':
            case 'current_mode_update': {
                if (update.sessionUpdate === 'config_option_update')
                    this.configOptions = this.withModes(selectOptions(update.configOptions))
                else
                    this.setLocal('mode', String(update.currentModeId ?? update.modeId ?? ''))
                this.emit({ type: 'acp_config_changed', configOptions: this.configOptions })
                break
            }
            case 'usage_update':
                if (typeof update.used === 'number' && typeof update.size === 'number')
                    this.context = { used: update.used, size: update.size }
                // The session's running cost, when the agent knows it (Claude Code does, in USD).
                if (typeof update.cost?.amount === 'number' && (update.cost.currency ?? 'USD') === 'USD')
                    this.cost = update.cost.amount
                break
            case 'session_info_update':
                if (typeof update.title === 'string' && update.title) {
                    if (!this.options.readOnly)
                        this.callbacks.onSession?.(this, { title: update.title })
                }
                break
            default:
                if (this.caps.xai && !this.xaiContent(update, params))
                    break
                this.transcript.update(update)
                break
        }
    }

    /** Notification `_meta`: Grok Build stamps the agent's clock and the context it fills. */
    private noteMeta(meta: any) {
        if (typeof meta?.agentTimestampMs === 'number')
            this.clock = meta.agentTimestampMs
        if (this.caps.xai && typeof meta?.totalTokens === 'number' && meta.totalTokens > 0) {
            const size = this.contextWindows.get(this.option('model')?.currentValue ?? '') ?? this.context?.size ?? 0
            this.context = { used: meta.totalTokens, size }
        }
    }

    /**
     * A Grok Build session/update before it reaches the transcript; false drops it. The plan Grok sends
     * as a turn ends, to clear the list, has no eventId: it is never stored, so a replay would differ.
     */
    private xaiContent(update: any, params: any): boolean {
        const kind = update?.sessionUpdate
        if (kind === 'plan' && !params?._meta?.eventId)
            return false
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
            this.modelOutput()
        return true
    }

    /**
     * The model is streaming. Grok sends a response's tool calls after its response_completed, so only
     * text, thinking and tool-argument chunks mean a model call; interjections join right before one.
     */
    private modelOutput() {
        this.endRetry()
        if (!this.inModelCall && this.steers.length && !this.loading) {
            for (const steer of this.steers.splice(0))
                this.transcript.userPrompt(steer)
            this.emitQueue()
        }
        this.inModelCall = true
    }

    /** Grok Build's `x.ai/…` notifications; params come unwrapped, or wrapped once by older shells. */
    private xaiNotification(name: string, raw: any) {
        const params = raw?.sessionId === undefined && raw?.params && typeof raw.params === 'object' ? raw.params : raw
        if (this.sessionId && params?.sessionId && params.sessionId !== this.sessionId)
            return
        switch (name) {
            case 'x.ai/session_notification':
            case 'x.ai/session/update':
                this.noteMeta(params?._meta)
                this.xaiUpdate(params?.update ?? {})
                break
            case 'x.ai/queue/changed':
                this.queueChanged(params)
                break
            case 'x.ai/session/prompt_complete':
                this.ownTurnEnded(String(params?.promptId ?? ''), params?.stopReason)
                break
            case 'x.ai/models/update':
                this.noteModels(params?.availableModels)
                break
            default:
                break
        }
    }

    private xaiUpdate(update: any) {
        switch (update.sessionUpdate) {
            case 'response_completed':
                this.inModelCall = false
                break
            case 'tool_call_delta_chunk':
                this.modelOutput()
                break
            case 'turn_completed':
                this.turnCompleted(String(update.prompt_id ?? ''), update.stop_reason, xaiUsage(update.usage))
                break
            case 'auto_compact_started':
                if (!this.compactingByHand && !this.loading)
                    this.emit({ type: 'compaction_start', reason: 'threshold' })
                break
            case 'auto_compact_completed': {
                const before = typeof update.tokens_before === 'number' ? update.tokens_before : 0
                const after = typeof update.tokens_after === 'number' ? update.tokens_after : undefined
                const summary = typeof update.summary_preview === 'string' && update.summary_preview
                    ? update.summary_preview
                    : tr(`上下文从 ${before.toLocaleString()} 压缩到 ${after?.toLocaleString() ?? '?'} tokens。`, `Context compacted from ${before.toLocaleString()} to ${after?.toLocaleString() ?? '?'} tokens.`)
                this.transcript.compaction(summary, before)
                if (after !== undefined && this.context)
                    this.context = { ...this.context, used: after }
                if (!this.compactingByHand && !this.loading)
                    this.emit({ type: 'compaction_end', reason: 'threshold', aborted: false })
                break
            }
            case 'auto_compact_failed':
            case 'auto_compact_cancelled':
                if (!this.compactingByHand && !this.loading)
                    this.emit({ type: 'compaction_end', reason: 'threshold', aborted: update.sessionUpdate === 'auto_compact_cancelled', errorMessage: typeof update.error === 'string' ? update.error : undefined })
                break
            case 'retry_state':
                if (this.loading)
                    break
                if (update.type === 'retrying') {
                    this.retrying = true
                    this.emit({ type: 'auto_retry_start', attempt: update.attempt, maxAttempts: update.max_retries, delayMs: 0, errorMessage: String(update.reason ?? '') })
                }
                else if (update.type === 'exhausted' || update.type === 'failed') {
                    this.retrying = false
                    this.emit({ type: 'auto_retry_end', success: false, attempt: update.attempts, finalError: String(update.reason ?? update.message ?? '') })
                }
                break
            default:
                break
        }
    }

    private endRetry() {
        if (!this.retrying)
            return
        this.retrying = false
        this.emit({ type: 'auto_retry_end', success: true })
    }

    /** A turn ended (live or replayed): its messages close, with the turn's usage. */
    private turnCompleted(promptId: string, stopReason: string | undefined, usage: PromptUsage | undefined) {
        if (promptId && this.doneTurns.has(promptId))
            return
        if (promptId)
            this.doneTurns.add(promptId)
        this.inModelCall = false
        this.endRetry()
        this.transcript.finish(stopReason, usage)
    }

    /** Grok's prompt queue: a running prompt we did not send is a turn of its own (a stranded interjection). */
    private queueChanged(params: any) {
        const id = typeof params?.runningPromptId === 'string' ? params.runningPromptId : ''
        if (this.loading || !id || this.sentPrompts.has(id) || this.doneTurns.has(id) || this.ownTurns.has(id))
            return
        this.ownTurns.add(id)
        if (id.startsWith(XAI_FALLBACK_PREFIX)) {
            // Its user message is stored but not sent; it is the interjection we still show queued.
            const text = typeof params.runningText === 'string' ? params.runningText : ''
            const stray = this.strays.indexOf(text)
            if (stray >= 0) {
                // Already shown when the run ended without taking it in.
                this.strays.splice(stray, 1)
            }
            else {
                const at = this.steers.indexOf(text)
                if (at >= 0)
                    this.steers.splice(at, 1)
                this.emitQueue()
                this.transcript.userPrompt(text)
            }
        }
        if (!this.running) {
            this.running = true
            this.emit({ type: 'agent_start' })
        }
    }

    private ownTurnEnded(promptId: string, stopReason: string | undefined) {
        if (!this.ownTurns.delete(promptId))
            return
        if (!this.doneTurns.has(promptId))
            this.turnCompleted(promptId, stopReason, undefined)
        this.afterTurn(false)
    }

    private setLocal(id: string, value: string) {
        const option = this.option(id)
        if (option && value)
            option.currentValue = value
    }

    private async agentRequest(method: string, params: any): Promise<unknown> {
        if (method === 'session/request_permission')
            return this.permission(params)
        const name = method.replace(/^_/, '')
        if ((this.caps.xai || this.caps.ask) && name === 'x.ai/ask_user_question')
            return this.xaiAsk(params)
        if ((this.caps.xai || this.caps.plan) && name === 'x.ai/exit_plan_mode')
            return this.xaiPlan(params)
        throw methodNotFound(method)
    }

    /**
     * ask_user_question → the ask capability's form on the tool's row. Grok waits for the reply
     * (AskUserQuestionExtResponse); the form answers through `/gui-ask-answer`.
     */
    private xaiAsk(params: any): Promise<unknown> {
        const id = String(params?.toolCallId ?? '')
        const questions = askQuestions(params?.questions)
        if (this.options.readOnly || !questions.length || this.asks.has(id))
            return Promise.resolve({ outcome: 'cancelled' })
        return new Promise((resolve) => {
            this.asks.set(id, { resolve, questions })
            if (!this.transcript.setDetails(id, { kind: 'ask', status: 'pending', questions })) {
                this.asks.delete(id)
                resolve({ outcome: 'cancelled' })
            }
        })
    }

    private answerAsk(id: string, response: AskResponse) {
        const wait = this.asks.get(id)
        if (!wait)
            throw new Error(tr('这个问题已经不在等回答了', 'This question is no longer waiting for an answer'))
        this.asks.delete(id)
        // Grok keys answers by question text, as option labels; typed text rides as notes on "Other".
        const answers: Record<string, string[]> = {}
        const annotations: Record<string, { notes: string }> = {}
        if ('answers' in response) {
            for (const q of wait.questions) {
                const answer = response.answers[q.id]
                const text = answer?.text?.trim()
                const labels = answer?.selected.length ? answer.selected : text ? [XAI_OTHER] : []
                if (!labels.length)
                    continue
                answers[q.question] = labels
                if (text)
                    annotations[q.question] = { notes: text }
            }
        }
        if (!Object.keys(answers).length) {
            this.transcript.setDetails(id, { kind: 'ask', status: 'cancelled', questions: wait.questions })
            wait.resolve({ outcome: 'cancelled' })
            return
        }
        const shown = Object.fromEntries(wait.questions.filter(q => answers[q.question]).map(q => [q.id, xaiAskAnswer(answers[q.question], annotations[q.question]?.notes)]))
        this.transcript.setDetails(id, { kind: 'ask', status: 'answered', questions: wait.questions, answers: shown })
        wait.resolve({ outcome: 'accepted', answers, ...(Object.keys(annotations).length ? { annotations } : {}) })
    }

    /**
     * exit_plan_mode → the plan capability's approval on the tool's row (ExitPlanModeExtResponse).
     * Unanswered, Grok stays in plan mode; a cancel abandons the plan and leaves plan mode.
     */
    private xaiPlan(params: any): Promise<unknown> {
        const id = String(params?.toolCallId ?? '')
        const plan = typeof params?.planContent === 'string' ? params.planContent : ''
        if (this.options.readOnly || this.plans.has(id))
            return Promise.resolve({ outcome: 'cancelled' })
        return new Promise((resolve) => {
            this.plans.set(id, { resolve, plan })
            if (!this.transcript.setDetails(id, { kind: 'plan', status: 'pending', plan })) {
                this.plans.delete(id)
                resolve({ outcome: 'cancelled' })
            }
        })
    }

    private decidePlan(id: string, decision: PlanDecision) {
        const wait = this.plans.get(id)
        if (!wait)
            throw new Error(tr('这个计划已经不在等审批了', 'This plan is no longer waiting for a decision'))
        this.plans.delete(id)
        const { plan } = wait
        if ('approve' in decision) {
            this.transcript.setDetails(id, { kind: 'plan', status: 'approved', plan })
            wait.resolve({ outcome: 'approved' })
        }
        else if ('feedback' in decision && decision.feedback.trim()) {
            this.transcript.setDetails(id, { kind: 'plan', status: 'revised', plan, feedback: decision.feedback.trim() })
            wait.resolve({ outcome: 'cancelled', feedback: decision.feedback.trim() })
        }
        else {
            this.transcript.setDetails(id, { kind: 'plan', status: 'cancelled', plan })
            wait.resolve({ outcome: 'abandoned' })
        }
    }

    /** Questions and plans still waiting get a cancel (stop, exit). */
    private cancelWaits() {
        for (const [id] of this.asks)
            this.answerAsk(id, { cancelled: true })
        for (const [id, wait] of this.plans) {
            this.plans.delete(id)
            this.transcript.setDetails(id, { kind: 'plan', status: 'cancelled', plan: wait.plan })
            // Unanswered (not abandoned): Grok keeps plan mode and its plan.
            wait.resolve({ outcome: 'cancelled' })
        }
    }

    /** The capability forms' hidden commands (`/gui-ask-answer <id> <json>`, `/gui-plan-decide …`); false if not one. */
    private guiCommand(message: string): boolean {
        const m = /^\/(gui-ask-answer|gui-plan-decide) (\S+) ([\s\S]+)$/.exec(message)
        if (!m || !this.caps.xai)
            return false
        const payload = JSON.parse(m[3])
        if (m[1] === 'gui-ask-answer')
            this.answerAsk(m[2], payload as AskResponse)
        else
            this.decidePlan(m[2], payload as PlanDecision)
        return true
    }

    /** request_permission → the approval prompt; its choice maps back to the agent's option ids. */
    private permission(params: any): Promise<unknown> {
        const options = Array.isArray(params?.options) ? params.options : []
        if (this.options.readOnly || !options.length)
            return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        const toolCall = params.toolCall ?? {}
        const id = String(toolCall.toolCallId ?? '')
        // The call as the transcript shows it (a multi-file edit is one row per file); else from the request.
        const shown = this.transcript.callsOf(id)
        const calls = shown.length ? shown : piToolCalls({ ...toolCall, id, output: '', calls: [], done: false })
        const call = calls[0]
        const summary = calls.map((c) => {
            const args = c.arguments ?? {}
            return String(args.command ?? args.path ?? args.description ?? toolCall.title ?? '')
        }).join('\n')
        const always = options.find((o: any) => o.kind === 'allow_always')
        const approval: ApprovalRequest = {
            toolCallId: call?.id ?? id,
            tool: call?.name ?? 'tool',
            summary,
            scope: always ? call?.name ?? 'tool' : '',
            alwaysLabel: always?.name,
        }
        const requestId = `acp-permission-${randomUUID()}`
        return new Promise((resolve) => {
            this.permissions.set(requestId, { resolve, options })
            const choices: ApprovalChoice[] = always ? ['allow', 'always', 'deny'] : ['allow', 'deny']
            this.emit({ type: 'extension_ui_request', id: requestId, method: 'select', title: `${APPROVAL_TITLE_PREFIX}${JSON.stringify(approval)}`, options: choices })
        })
    }

    private answerPermission(id: string, payload: Record<string, unknown>) {
        const wait = this.permissions.get(id)
        if (!wait)
            return
        this.permissions.delete(id)
        if (payload.cancelled || typeof payload.value !== 'string') {
            wait.resolve({ outcome: { outcome: 'cancelled' } })
            return
        }
        const kinds: Record<string, string[]> = { allow: ['allow_once', 'allow_always'], always: ['allow_always', 'allow_once'], deny: ['reject_once', 'reject_always'] }
        const option = (kinds[payload.value] ?? []).map(k => wait.options.find(o => o.kind === k)).find(Boolean)
        wait.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } })
    }

    // ---------------------------------------------------------------- pi RPC

    /** Fire-and-forget records from the renderer (extension_ui_response). */
    write(record: Record<string, unknown>) {
        if (record.type === 'extension_ui_response' && typeof record.id === 'string')
            this.answerPermission(record.id, record)
    }

    async request(command: Record<string, unknown>): Promise<RpcResponse> {
        const type = String(command.type)
        const ok = (data?: unknown): RpcResponse => ({ type: 'response', command: type, success: true, data })
        try {
            await this.ready
            switch (type) {
                case 'get_state':
                    return ok({
                        model: this.currentModel(),
                        thinkingLevel: this.option('thought_level')?.currentValue,
                        isStreaming: this.running,
                        isCompacting: false,
                        sessionFile: this.key,
                        sessionId: this.sessionId,
                        sessionName: undefined,
                        configOptions: this.configOptions,
                        agentCaps: this.caps,
                    })
                case 'get_available_models': {
                    const model = this.option('model')
                    return ok({ models: (model?.options ?? []).map(o => ({ id: o.value, name: o.name, provider: this.spec.label })) })
                }
                case 'get_available_thinking_levels':
                    return ok({ levels: (this.option('thought_level')?.options ?? []).map(o => o.value) })
                case 'get_commands':
                    return ok({ commands: this.commands })
                case 'get_session_stats': {
                    const tokens = this.transcript.totals()
                    const context = this.context
                    return ok({
                        tokens,
                        cost: this.cost ?? (tokens.cost || undefined),
                        contextUsage: context ? { tokens: context.used, contextWindow: context.size, percent: context.size ? (context.used / context.size) * 100 : null } : undefined,
                    })
                }
                case 'prompt': {
                    const message = String(command.message ?? '')
                    if (this.guiCommand(message))
                        return ok({ disposition: 'handled' })
                    return ok(await this.prompt(message, Array.isArray(command.images) ? command.images as ImageContent[] : [], command.streamingBehavior === 'steer'))
                }
                case 'abort':
                    if (this.running)
                        this.connection.notify('session/cancel', { sessionId: this.sessionId })
                    for (const [id] of this.permissions)
                        this.answerPermission(id, { cancelled: true })
                    this.cancelWaits()
                    return ok()
                case 'clear_queue': {
                    const followUp = this.queued.map(q => q.message).filter(Boolean)
                    this.queued = []
                    this.emitQueue()
                    return ok({ steering: [], followUp })
                }
                case 'compact':
                    if (this.running)
                        throw new Error(tr('运行中不能压缩，等它结束或先停止', 'Cannot compact while running; wait or stop it first'))
                    if (this.caps.xai)
                        return ok(await this.xaiCompact())
                    // The agent's own command; it runs as a turn of the session.
                    if (!this.commands.some(c => c.name === 'compact'))
                        throw new Error(tr(`${this.spec.label} 没有 /compact 命令`, `${this.spec.label} has no /compact command`))
                    return ok(await this.prompt('/compact', [], false))
                case 'acp_fork': {
                    if (!this.caps.fork)
                        throw new Error(tr(`${this.spec.label} 不支持分叉会话`, `${this.spec.label} cannot fork sessions`))
                    if (this.running)
                        throw new Error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
                    const cwd = this.sessionCwd || this.options.cwd
                    const result: any = this.caps.xai
                        ? await this.connection.request('_x.ai/session/fork', { sourceSessionId: this.sessionId, sourceCwd: cwd, newCwd: cwd })
                        : await this.connection.request('session/fork', { sessionId: this.sessionId, cwd, mcpServers: [] })
                    const forked = String(result?.newSessionId ?? result?.sessionId ?? '')
                    if (!forked)
                        throw new Error(tr('分叉没有返回会话', 'The fork returned no session'))
                    return ok({ sessionFile: this.callbacks.onFork?.(this, forked) ?? acpSessionKey(this.spec.id, forked) })
                }
                case 'set_model':
                    await this.setConfig(this.option('model')?.id, String(command.modelId ?? ''))
                    return ok()
                case 'set_thinking_level':
                    await this.setConfig(this.option('thought_level')?.id, String(command.level ?? ''))
                    return ok()
                case 'set_config_option':
                    await this.setConfig(String(command.configId ?? ''), String(command.value ?? ''))
                    return ok({ configOptions: this.configOptions })
                case 'set_session_name': {
                    // The app keeps the name in its session index; Grok Build also titles its own history.
                    const name = String(command.name ?? '')
                    this.callbacks.onSession?.(this, { name })
                    if (this.caps.xai) {
                        await this.connection.request('_x.ai/session/rename', { sessionId: this.sessionId, cwd: this.sessionCwd || this.options.cwd, ...(name.trim() ? { title: name.trim() } : { resetToAuto: true }) })
                            .catch(error => console.warn(`[acp] ${this.spec.label} rename failed:`, error?.message ?? error))
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

    private async setConfig(configId: string | undefined, value: string) {
        if (!configId || !value)
            throw new Error(tr('没有这个选项', 'No such option'))
        let result: any
        if (this.legacyConfig && configId === 'model')
            result = await this.connection.request('session/set_model', { sessionId: this.sessionId, modelId: value })
        else if ((this.legacyConfig || this.caps.xai) && configId === 'mode')
            result = await this.connection.request('session/set_mode', { sessionId: this.sessionId, modeId: value })
        else
            result = await this.connection.request('session/set_config_option', { sessionId: this.sessionId, configId, value })
        const updated = selectOptions(result?.configOptions)
        if (updated.length)
            this.configOptions = this.withModes(updated)
        else
            this.setLocal(configId, value)
        this.emit({ type: 'acp_config_changed', configOptions: this.configOptions })
    }

    private async prompt(message: string, images: ImageContent[], steer: boolean) {
        if (images.length && !this.caps.images)
            throw new Error(tr(`${this.spec.label} 不接受图片`, `${this.spec.label} does not take images`))
        if (this.running) {
            if (steer && this.caps.xai) {
                // Grok takes it in before its next model call, or runs it as a turn of its own after this one.
                await this.connection.request('_x.ai/interject', { sessionId: this.sessionId, text: message, interjectionId: randomUUID() })
                this.steers.push(message)
                this.emitQueue()
                return {}
            }
            if (steer && this.caps.steering) {
                // promptRequired: the turn ended meanwhile, and the message is still ours to send.
                const result: any = await this.connection.request('_session/steering', { sessionId: this.sessionId, prompt: blocksOf(message, images), _meta: { steering: { idleBehavior: 'promptRequired' } } })
                if (result?.outcome === 'failed')
                    throw new Error(tr('插话没有送达', 'The message did not reach the agent'))
                if (result?.outcome !== 'promptRequired') {
                    this.transcript.userPrompt(message, images)
                    return {}
                }
            }
            if (this.running) {
                // Sent as the next prompt once this one ends, as pi does with follow-ups.
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

    /** One session/prompt; pi answers a prompt at once and streams the run, so this does not wait. */
    private run(message: string, images: ImageContent[]) {
        this.transcript.userPrompt(message, images)
        this.callbacks.onSession?.(this, { prompt: message })
        this.prompting = true
        // Grok Build tags the turn's updates with this id, and runs turns of its own under others.
        const promptId = this.caps.xai ? randomUUID() : undefined
        if (promptId)
            this.sentPrompts.add(promptId)
        this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: blocksOf(message, images), ...(promptId ? { _meta: { promptId } } : {}) }).then(
            (result: any) => {
                this.noteMeta(result?._meta)
                this.settle(result?.stopReason, result?.usage ?? xaiUsage(result?._meta?.usage), undefined, promptId)
            },
            (error: any) => this.settle(undefined, undefined, this.explain(error), promptId),
        )
    }

    /** Grok Build's compact (x.ai/compact_conversation); its auto_compact_completed leaves the note. */
    private async xaiCompact() {
        this.compactingByHand = true
        this.emit({ type: 'compaction_start', reason: 'manual' })
        try {
            await this.connection.request('_x.ai/compact_conversation', { sessionId: this.sessionId })
        }
        finally {
            this.compactingByHand = false
            // A failure reaches the user as this request's error.
            this.emit({ type: 'compaction_end', reason: 'manual', aborted: false })
        }
        return {}
    }

    private emitQueue() {
        this.emit({ type: 'queue_update', steering: [...this.steers], followUp: this.queued.map(q => q.message) })
    }

    private settle(stopReason?: string, usage?: PromptUsage, errorMessage?: string, promptId?: string) {
        // Grok Build closed the turn already (turn_completed); an error still gets its message.
        if (!promptId || !this.doneTurns.has(promptId) || errorMessage)
            this.transcript.finish(stopReason, usage, errorMessage)
        if (promptId)
            this.doneTurns.add(promptId)
        this.prompting = false
        this.afterTurn(stopReason === 'cancelled')
    }

    /** A turn ended: the next follow-up goes, or the run ends once no turn is left. */
    private afterTurn(cancelled: boolean) {
        if (this.prompting || this.ownTurns.size)
            return
        // A follow-up typed during the run goes next, in the same run (Stop pulls them back first).
        const next = cancelled ? undefined : this.queued.shift()
        if (next && !this.exited) {
            this.emitQueue()
            this.run(next.message, next.images)
            return
        }
        if (this.steers.length) {
            // Not taken in by the end of the run: shown as sent (the agent has them, and may still
            // run them as a turn of their own).
            for (const steer of this.steers.splice(0)) {
                this.transcript.userPrompt(steer)
                this.strays.push(steer)
            }
            this.transcript.finish('end_turn')
            this.emitQueue()
        }
        this.inModelCall = false
        this.running = false
        this.emit({ type: 'agent_end' })
        this.emit({ type: 'agent_settled' })
        this.callbacks.onSession?.(this, {})
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
