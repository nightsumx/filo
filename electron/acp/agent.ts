// One ACP agent process (e.g. codex-acp) bound to one session, speaking pi's RPC to the renderer.
//
// The renderer drives every thread with pi RPC commands (get_state, prompt, abort, set_model, …) and
// reads pi events; this class answers those commands with ACP requests and turns ACP updates into pi
// events through AcpTranscript. Approvals become the approval capability's select dialog, so the
// existing prompt UI handles them.

import type { AcpAgentCaps, AcpAgentSpec, AcpConfigOption } from '@shared/agents'
import type { AgentExitInfo, SessionItem } from '@shared/ipc'
import type { ApprovalChoice, ApprovalRequest } from '@shared/capabilities'
import type { ImageContent, PiEvent, PiModel, RpcResponse, SlashCommand } from '@shared/pi'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PromptUsage } from './transcript'
import { acpCaps, acpSessionKey } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { tr } from '../i18n'
import { AcpConnection, methodNotFound } from './connection'
import { AcpTranscript, piToolCalls } from './transcript'

const STDERR_LIMIT = 64 * 1024

const blocksOf = (message: string, images: ImageContent[]) => [
    ...(message ? [{ type: 'text', text: message }] : []),
    ...images.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
]
export const ACP_PROTOCOL_VERSION = 1

export interface AcpLaunch {
    file: string
    args: string[]
    env: Record<string, string>
    via?: 'path' | 'npx' | 'override'
}

export interface AcpAgentOptions {
    cwd: string
    /** Resume this session (session/load replays it into the transcript); otherwise session/new. */
    sessionId?: string
    /** Only replay the session for reading, then stop: no events, no prompts. */
    readOnly?: boolean
    /** Replayed history carries no times; its messages get this one (the session's last update). */
    replayTime?: number
}

export interface AcpAgentCallbacks {
    onEvent: (agentId: string, event: PiEvent) => void
    onExit: (agentId: string, info: AgentExitInfo) => void
    /** The session exists (new or loaded); `prompt` is set when the user just sent one. */
    onSession?: (agent: AcpAgent, change: { prompt?: string, title?: string, name?: string }) => void
    /** The agent forked the session into `sessionId`; returns the fork's session key. */
    onFork?: (agent: AcpAgent, sessionId: string) => string
}

interface PermissionWait {
    resolve: (outcome: unknown) => void
    options: { optionId: string, kind: string, name: string }[]
}

/** Client capabilities: the agent runs its own tools; we want plans and command output chunks. */
const CLIENT_CAPABILITIES = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    plan: {},
    _meta: { terminal_output_delta: true },
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

export class AcpAgent {
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

    /** The launch environment holds the agent's API key (from the environment or pi's providers). */
    private hasApiKey: boolean

    constructor(readonly spec: AcpAgentSpec, launch: AcpLaunch, private options: AcpAgentOptions, private callbacks: AcpAgentCallbacks) {
        this.hasApiKey = !!(spec.apiKey && launch.env[spec.apiKey.env])
        this.transcript = new AcpTranscript('', { model: () => this.modelStamp(), inputIncludesCache: spec.inputIncludesCache, now: () => (this.loading && options.replayTime ? options.replayTime : Date.now()) })
        this.child = spawn(launch.file, launch.args, { cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
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
            this.configOptions = options
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
            this.configOptions = legacy
            this.legacyConfig = true
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
        if (method !== 'session/update' || (this.sessionId && params?.sessionId && params.sessionId !== this.sessionId))
            return
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
                    this.configOptions = selectOptions(update.configOptions)
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
                this.transcript.update(update)
                break
        }
    }

    private setLocal(id: string, value: string) {
        const option = this.option(id)
        if (option && value)
            option.currentValue = value
    }

    private async agentRequest(method: string, params: any): Promise<unknown> {
        if (method === 'session/request_permission')
            return this.permission(params)
        throw methodNotFound(method)
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
                        cost: this.cost,
                        contextUsage: context ? { tokens: context.used, contextWindow: context.size, percent: context.size ? (context.used / context.size) * 100 : null } : undefined,
                    })
                }
                case 'prompt':
                    return ok(await this.prompt(String(command.message ?? ''), Array.isArray(command.images) ? command.images as ImageContent[] : [], command.streamingBehavior === 'steer'))
                case 'abort':
                    if (this.running)
                        this.connection.notify('session/cancel', { sessionId: this.sessionId })
                    for (const [id] of this.permissions)
                        this.answerPermission(id, { cancelled: true })
                    return ok()
                case 'clear_queue': {
                    const followUp = this.queued.map(q => q.message).filter(Boolean)
                    this.queued = []
                    this.emitQueue()
                    return ok({ steering: [], followUp })
                }
                case 'compact':
                    // The agent's own command; it runs as a turn of the session.
                    if (!this.commands.some(c => c.name === 'compact'))
                        throw new Error(tr(`${this.spec.label} 没有 /compact 命令`, `${this.spec.label} has no /compact command`))
                    if (this.running)
                        throw new Error(tr('运行中不能压缩，等它结束或先停止', 'Cannot compact while running; wait or stop it first'))
                    return ok(await this.prompt('/compact', [], false))
                case 'acp_fork': {
                    if (!this.caps.fork)
                        throw new Error(tr(`${this.spec.label} 不支持分叉会话`, `${this.spec.label} cannot fork sessions`))
                    if (this.running)
                        throw new Error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
                    const result: any = await this.connection.request('session/fork', { sessionId: this.sessionId, cwd: this.sessionCwd || this.options.cwd, mcpServers: [] })
                    const forked = String(result?.sessionId ?? '')
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
                case 'set_session_name':
                    // ACP has no rename; the app keeps the name in its session index.
                    this.callbacks.onSession?.(this, { name: String(command.name ?? '') })
                    return ok()
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
        else if (this.legacyConfig && configId === 'mode')
            result = await this.connection.request('session/set_mode', { sessionId: this.sessionId, modeId: value })
        else
            result = await this.connection.request('session/set_config_option', { sessionId: this.sessionId, configId, value })
        const updated = selectOptions(result?.configOptions)
        if (updated.length)
            this.configOptions = updated
        else
            this.setLocal(configId, value)
        this.emit({ type: 'acp_config_changed', configOptions: this.configOptions })
    }

    private async prompt(message: string, images: ImageContent[], steer: boolean) {
        if (images.length && !this.caps.images)
            throw new Error(tr(`${this.spec.label} 不接受图片`, `${this.spec.label} does not take images`))
        if (this.running) {
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
        this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: blocksOf(message, images) }).then(
            // Grok Build reports the prompt's usage only under _meta.
            (result: any) => this.settle(result?.stopReason, result?.usage ?? result?._meta?.usage),
            (error: any) => this.settle(undefined, undefined, this.explain(error)),
        )
    }

    private emitQueue() {
        this.emit({ type: 'queue_update', steering: [], followUp: this.queued.map(q => q.message) })
    }

    private settle(stopReason?: string, usage?: PromptUsage, errorMessage?: string) {
        this.transcript.finish(stopReason, usage, errorMessage)
        // A follow-up typed during the run goes next, in the same run (Stop pulls them back first).
        const next = stopReason === 'cancelled' ? undefined : this.queued.shift()
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
