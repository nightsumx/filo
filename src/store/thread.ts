import type { AskResponse, CapabilityId, GuiCommands, TodoDetails } from '@shared/capabilities'
import type { AgentExitInfo } from '@shared/ipc'
import type {
    AgentMessage,
    AssistantMessage,
    ImageContent,
    PiEvent,
    PiModel,
    RpcResponse,
    RpcSessionState,
    SessionStats,
    SlashCommand,
    ThinkingLevel,
} from '@shared/pi'
import type { Step, TimelineMessage, ToolExecState, ToolResultView } from '@/lib/timeline'
import { parsePartialJson } from '@/lib/partialJson'
import { buildTurns, contentText } from '@/lib/timeline'
import { GUI_COMMAND_PREFIX } from '@shared/capabilities'
import { readableError } from '@/lib/utils'
import { makeAutoObservable, observable, runInAction, toJS } from 'mobx'
import { toast } from 'sonner'

const api = () => window.pi

export type AgentStatus = 'none' | 'starting' | 'ready' | 'exited' | 'error'

export interface UiRequest {
    id: string
    method: 'select' | 'confirm' | 'input' | 'editor'
    title?: string
    message?: string
    options?: string[]
    placeholder?: string
    prefill?: string
}

export interface ThreadHost {
    registerAgent: (agentId: string, thread: Thread) => void
    rekey: (thread: Thread, oldKey: string) => void
    onSettled: (thread: Thread) => void
    reserveAgentSlot: (thread: Thread) => Promise<void>
    capabilitiesOf: (cwd: string) => CapabilityId[]
}

function toolView(result: any): ToolResultView | undefined {
    if (!result || typeof result !== 'object')
        return undefined
    return { content: Array.isArray(result.content) ? result.content : [], details: result.details, isError: !!result.isError }
}

/** One conversation: a pi session file plus the live `pi --mode rpc` process driving it. */
export class Thread {
    key: string
    cwd: string
    sessionPath?: string
    name?: string
    firstPrompt?: string

    /** Active branch read from the session file. */
    items: TimelineMessage[] = []
    /** Messages completed since the last snapshot reload. */
    live: TimelineMessage[] = []
    streaming: AssistantMessage | null = null
    tools = observable.map<string, ToolExecState>()
    pendingPrompt: { text: string, images: ImageContent[], timestamp: number } | null = null
    loaded = false
    /** True once the session exists on disk (opened from the list, or after a completed run). */
    persisted: boolean

    agentId: string | null = null
    agentStatus: AgentStatus = 'none'
    agentError = ''
    running = false
    runStartedAt = 0
    compacting = false
    retry: { attempt: number, maxAttempts: number, errorMessage: string } | null = null

    state: RpcSessionState | null = null
    models: PiModel[] = []
    thinkingLevels: ThinkingLevel[] = []
    commands: SlashCommand[] = []
    stats: SessionStats | null = null
    queue: { steering: string[], followUp: string[] } = { steering: [], followUp: [] }

    uiRequests: UiRequest[] = []
    statuses: Record<string, string> = {}
    widgets: Record<string, { lines: string[], placement: 'aboveEditor' | 'belowEditor' }> = {}

    draft = ''
    images: ImageContent[] = []
    unread = false
    /** Bumps whenever files may have changed (tool writes, run end) so the review pane refetches. */
    changeTick = 0
    lastUsed = Date.now()

    private liveCounter = 0
    private partialArgs = new Map<number, string>()
    private startPromise: Promise<string> | null = null
    private stopping = false
    /** Capability set the running process was started with (comma-joined ids). */
    private loadedCapabilities = ''
    /** Capabilities changed mid-run; restart once the run settles. */
    private restartPending = false

    constructor(private host: ThreadHost, init: { key: string, cwd: string, sessionPath?: string, name?: string, firstPrompt?: string }) {
        this.key = init.key
        this.cwd = init.cwd
        this.sessionPath = init.sessionPath
        this.name = init.name
        this.firstPrompt = init.firstPrompt
        this.persisted = !!init.sessionPath
        makeAutoObservable<this, 'liveCounter' | 'partialArgs' | 'startPromise' | 'stopping' | 'loadedCapabilities' | 'restartPending' | 'host'>(this, {
            liveCounter: false,
            partialArgs: false,
            startPromise: false,
            stopping: false,
            loadedCapabilities: false,
            restartPending: false,
            host: false,
        }, { autoBind: true })
    }

    get title(): string {
        if (this.name)
            return this.name
        const first = [...this.items, ...this.live].find(m => m.message.role === 'user')
        const text = first ? contentText((first.message as any).content) : this.firstPrompt ?? this.pendingPrompt?.text
        return text?.trim().split('\n')[0].slice(0, 80) || '新线程'
    }

    get isEmpty(): boolean {
        return !this.items.length && !this.live.length && !this.pendingPrompt && !this.running
    }

    get turns() {
        return buildTurns([...this.items, ...this.live], {
            tools: this.tools,
            pendingPrompt: this.pendingPrompt,
            running: this.running,
        })
    }

    /** Steps of the assistant message still streaming; rendered under the last turn. */
    get streamingSteps(): Step[] {
        if (!this.streaming)
            return []
        return buildTurns([{ key: 'streaming', message: this.streaming }], { tools: this.tools, running: true })[0]?.steps ?? []
    }

    get contextPercent(): number | null {
        return this.stats?.contextUsage?.percent ?? null
    }

    /** Latest todo list on the branch; every todo call carries the full list. */
    get todo(): TodoDetails | null {
        const messages = [...this.items, ...this.live]
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i].message
            if (m.role === 'toolResult' && m.toolName === 'todo' && m.details?.kind === 'todo')
                return m.details as TodoDetails
        }
        return null
    }

    /** pi is blocked on the user: an extension dialog or an unanswered ask. */
    get waitingForUser(): boolean {
        if (this.uiRequests.length)
            return true
        for (const state of this.tools.values()) {
            const details = state.partial?.details
            if (state.running && details?.kind === 'ask' && details.status === 'pending')
                return true
        }
        return false
    }

    // ---------------------------------------------------------------- loading

    async load() {
        if (!this.sessionPath) {
            this.loaded = true
            return
        }
        const consumed = this.live.length
        const snapshot = await api().readSession(this.sessionPath)
        runInAction(() => {
            this.items = snapshot.items.map(i => ({ key: i.entryId, message: i.message }))
            this.live.splice(0, consumed)
            if (snapshot.name)
                this.name = snapshot.name
            this.loaded = true
        })
    }

    // ---------------------------------------------------------------- process

    ensureAgent(): Promise<string> {
        if (this.agentId && this.agentStatus === 'ready')
            return Promise.resolve(this.agentId)
        this.startPromise ??= this.startAgent().catch((error) => {
            runInAction(() => {
                this.agentStatus = 'error'
                this.agentError = String(error?.message ?? error)
                this.startPromise = null
            })
            throw error
        })
        return this.startPromise
    }

    private async startAgent(): Promise<string> {
        await this.host.reserveAgentSlot(this)
        runInAction(() => {
            this.agentStatus = 'starting'
            this.agentError = ''
        })
        // A path pi never wrote (thread left empty) cannot be resumed; start fresh instead.
        const resumable = this.persisted ? this.sessionPath : undefined
        const capabilities = this.host.capabilitiesOf(this.cwd)
        this.loadedCapabilities = capabilities.join(',')
        this.restartPending = false
        const agentId = await api().agentStart({ cwd: this.cwd, sessionPath: resumable, capabilities })
        runInAction(() => {
            this.agentId = agentId
            this.stopping = false
        })
        this.host.registerAgent(agentId, this)
        await Promise.all([
            this.syncState(),
            this.refreshModels(),
            this.refreshCommands(),
            this.refreshStats(),
        ])
        runInAction(() => {
            this.agentStatus = 'ready'
        })
        return agentId
    }

    async stopAgent() {
        const id = this.agentId
        if (!id)
            return
        this.stopping = true
        await api().agentStop(id)
    }

    /**
     * Extensions load at startup, so a changed capability set needs a new process. It resumes the
     * same session file; mid-run changes wait for the run to settle.
     */
    async applyCapabilities() {
        if (!this.agentId || this.host.capabilitiesOf(this.cwd).join(',') === this.loadedCapabilities) {
            this.restartPending = false
            return
        }
        if (this.running || this.uiRequests.length) {
            this.restartPending = true
            return
        }
        const old = this.agentId
        await this.stopAgent()
        runInAction(() => {
            // The exit event may arrive after agentStop resolves; do not wait for it.
            if (this.agentId === old) {
                this.agentId = null
                this.agentStatus = 'none'
                this.startPromise = null
            }
        })
        await this.ensureAgent().catch(() => {})
    }

    async request<T = any>(command: Record<string, unknown>): Promise<RpcResponse<T>> {
        const agentId = await this.ensureAgent()
        this.lastUsed = Date.now()
        // Observables (e.g. the images array) are proxies that IPC structured clone rejects.
        const response = await api().agentRequest<T>(agentId, toJS(command))
        if (!response.success)
            throw new Error(response.error || `${command.type} 失败`)
        return response
    }

    /** Raw request used during startup, before ensureAgent resolves. */
    private async call<T = any>(command: Record<string, unknown>): Promise<T | undefined> {
        if (!this.agentId)
            return undefined
        const response = await api().agentRequest<T>(this.agentId, command)
        return response.success ? response.data : undefined
    }

    async syncState() {
        const state = await this.call<RpcSessionState>({ type: 'get_state' })
        if (!state)
            return
        const oldKey = this.key
        const sessionChanged = !!state.sessionFile && state.sessionFile !== this.sessionPath
        runInAction(() => {
            this.state = state
            if (state.sessionName)
                this.name = state.sessionName
            if (state.isStreaming)
                this.running = true
            if (sessionChanged) {
                const hadHistory = this.persisted
                this.sessionPath = state.sessionFile
                this.key = state.sessionFile!
                // An extension command (e.g. /new) switched sessions inside the process.
                if (hadHistory) {
                    this.items = []
                    this.live = []
                    this.name = state.sessionName
                    this.persisted = false
                }
            }
        })
        if (sessionChanged)
            this.host.rekey(this, oldKey)
    }

    async refreshModels() {
        const [models, levels] = await Promise.all([
            this.call<{ models: PiModel[] }>({ type: 'get_available_models' }),
            this.call<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' }),
        ])
        runInAction(() => {
            if (models)
                this.models = models.models
            if (levels)
                this.thinkingLevels = levels.levels
        })
    }

    async refreshCommands() {
        const data = await this.call<{ commands: SlashCommand[] }>({ type: 'get_commands' })
        if (data)
            runInAction(() => (this.commands = data.commands.filter(c => !c.name.startsWith(GUI_COMMAND_PREFIX))))
    }

    async refreshStats() {
        const stats = await this.call<SessionStats>({ type: 'get_session_stats' })
        if (stats)
            runInAction(() => (this.stats = stats))
    }

    // ---------------------------------------------------------------- actions

    async send() {
        const text = this.draft.trim()
        const images = toJS(this.images)
        if (!text && !images.length)
            return
        this.draft = ''
        this.images = []

        if (this.running) {
            // Codex-style: typing during a run steers the agent after its current tool calls.
            try {
                await this.request({ type: 'prompt', message: text, images, streamingBehavior: 'steer' })
            }
            catch (error: any) {
                runInAction(() => (this.draft = text))
                toast.error(error.message)
            }
            return
        }

        this.pendingPrompt = { text, images, timestamp: Date.now() }
        this.running = true
        this.runStartedAt = Date.now()
        try {
            const response = await this.request<{ disposition: string }>({ type: 'prompt', message: text, images })
            if (response.data?.disposition === 'handled') {
                runInAction(() => {
                    this.pendingPrompt = null
                    this.running = false
                })
                await this.syncState()
            }
        }
        catch (error: any) {
            runInAction(() => {
                this.pendingPrompt = null
                this.running = false
                this.draft = text
                this.images = images
            })
            toast.error(error.message)
        }
    }

    /** Esc: pull queued messages back into the editor, then abort the run. */
    async abort() {
        if (!this.agentId)
            return
        try {
            const queued = await this.request<{ steering: string[], followUp: string[] }>({ type: 'clear_queue' })
            const restored = [...(queued.data?.steering ?? []), ...(queued.data?.followUp ?? [])]
            if (restored.length)
                runInAction(() => (this.draft = [...restored, this.draft].filter(Boolean).join('\n')))
            await this.request({ type: 'abort' })
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    async setModel(model: PiModel) {
        try {
            await this.request({ type: 'set_model', provider: model.provider, modelId: model.id })
            await Promise.all([this.syncState(), this.refreshModels(), this.refreshStats()])
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    async setThinkingLevel(level: ThinkingLevel) {
        try {
            await this.request({ type: 'set_thinking_level', level })
            runInAction(() => {
                if (this.state)
                    this.state.thinkingLevel = level
            })
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    async rename(name: string) {
        try {
            await this.request({ type: 'set_session_name', name })
            runInAction(() => (this.name = name || undefined))
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    async compact() {
        try {
            await this.request({ type: 'compact' })
            await Promise.all([this.load(), this.refreshStats()])
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    /** Hidden `/gui-…` capability command; pi runs extension commands immediately, even mid-run. */
    private async guiCommand(name: GuiCommands[keyof GuiCommands], args: string) {
        const response = await this.request<{ disposition: string }>({ type: 'prompt', message: `/${name} ${args}` })
        if (response.data?.disposition !== 'handled')
            throw new Error(`/${name} 未被处理，能力扩展可能没有加载`)
    }

    async answerAsk(toolCallId: string, response: AskResponse) {
        try {
            await this.guiCommand('gui-ask-answer', `${toolCallId} ${JSON.stringify(response)}`)
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    respondUi(request: UiRequest, payload: { value?: string, confirmed?: boolean, cancelled?: boolean }) {
        this.uiRequests = this.uiRequests.filter(r => r.id !== request.id)
        if (this.agentId)
            void api().agentSend(this.agentId, { type: 'extension_ui_response', id: request.id, ...payload })
    }

    // ---------------------------------------------------------------- events

    private pushLive(message: AgentMessage) {
        this.live.push({ key: `live-${this.liveCounter++}`, message })
    }

    handleEvent(event: PiEvent) {
        switch (event.type) {
            case 'agent_start':
                if (!this.running) {
                    this.running = true
                    this.runStartedAt = Date.now()
                }
                this.retry = null
                break
            case 'message_start':
                if (event.message?.role === 'assistant') {
                    this.streaming = { ...event.message, content: [], stopReason: 'pending' }
                    this.partialArgs.clear()
                }
                break
            case 'message_update':
                this.applyDelta(event.assistantMessageEvent)
                break
            case 'message_end': {
                const message = event.message as AgentMessage
                if (message.role === 'assistant')
                    this.streaming = null
                if (message.role === 'user')
                    this.pendingPrompt = null
                this.pushLive(message)
                break
            }
            case 'tool_execution_start':
                this.tools.set(event.toolCallId, { running: true })
                break
            case 'tool_execution_update':
                this.tools.set(event.toolCallId, { running: true, partial: toolView(event.partialResult) })
                break
            case 'tool_execution_end':
                this.tools.set(event.toolCallId, { running: false, result: toolView({ ...event.result, isError: event.isError }) })
                if (['edit', 'write', 'bash'].includes(event.toolName))
                    this.changeTick++
                break
            case 'queue_update':
                this.queue = { steering: event.steering ?? [], followUp: event.followUp ?? [] }
                break
            case 'compaction_start':
                this.compacting = true
                break
            case 'compaction_end':
                this.compacting = false
                if (event.errorMessage)
                    toast.error(`压缩失败：${readableError(event.errorMessage)}`)
                break
            case 'auto_retry_start':
                this.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: readableError(event.errorMessage ?? '') }
                break
            case 'auto_retry_end':
                this.retry = null
                if (!event.success && event.finalError)
                    toast.error(readableError(event.finalError))
                break
            case 'session_info_changed':
                this.name = event.name || undefined
                break
            case 'thinking_level_changed':
                if (this.state)
                    this.state.thinkingLevel = event.level
                break
            case 'extension_ui_request':
                this.handleUiRequest(event)
                break
            case 'extension_error':
                toast.error(`扩展出错：${event.error}`, { description: event.extensionPath })
                break
            case 'agent_settled':
                void this.settle()
                break
            default:
                break
        }
    }

    private applyDelta(update: any) {
        if (!update)
            return
        const message = this.streaming ??= { role: 'assistant', content: [], stopReason: 'pending', timestamp: Date.now() }
        const i: number = update.contentIndex
        const block: any = message.content[i]
        switch (update.type) {
            case 'text_start':
                message.content[i] = { type: 'text', text: '' }
                break
            case 'text_delta':
                if (block?.type === 'text')
                    block.text += update.delta
                else
                    message.content[i] = { type: 'text', text: update.delta }
                break
            case 'text_end':
                if (typeof update.content === 'string')
                    message.content[i] = { type: 'text', text: update.content }
                break
            case 'thinking_start':
                message.content[i] = { type: 'thinking', thinking: '' }
                break
            case 'thinking_delta':
                if (block?.type === 'thinking')
                    block.thinking += update.delta
                else
                    message.content[i] = { type: 'thinking', thinking: update.delta }
                break
            case 'thinking_end':
                if (typeof update.content === 'string')
                    message.content[i] = { type: 'thinking', thinking: update.content }
                break
            case 'toolcall_start':
                this.partialArgs.set(i, '')
                message.content[i] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {} }
                break
            case 'toolcall_delta': {
                const json = (this.partialArgs.get(i) ?? '') + update.delta
                this.partialArgs.set(i, json)
                const args = parsePartialJson(json)
                if (block?.type === 'toolCall' && args)
                    block.arguments = args
                break
            }
            case 'toolcall_end':
                if (update.toolCall)
                    message.content[i] = update.toolCall
                break
            default:
                break
        }
    }

    private handleUiRequest(event: PiEvent) {
        switch (event.method) {
            case 'select':
            case 'confirm':
            case 'input':
            case 'editor': {
                const request: UiRequest = {
                    id: event.id,
                    method: event.method,
                    title: event.title,
                    message: event.message,
                    options: event.options,
                    placeholder: event.placeholder,
                    prefill: event.prefill,
                }
                this.uiRequests.push(request)
                // pi resolves timed-out dialogs itself; drop ours to match.
                if (typeof event.timeout === 'number') {
                    setTimeout(() => runInAction(() => {
                        this.uiRequests = this.uiRequests.filter(r => r.id !== request.id)
                    }), event.timeout)
                }
                break
            }
            case 'notify': {
                const show = event.notifyType === 'error' ? toast.error : event.notifyType === 'warning' ? toast.warning : toast
                show(event.message)
                break
            }
            case 'setStatus':
                if (event.statusText)
                    this.statuses[event.statusKey] = event.statusText
                else
                    delete this.statuses[event.statusKey]
                break
            case 'setWidget':
                if (Array.isArray(event.widgetLines))
                    this.widgets[event.widgetKey] = { lines: event.widgetLines, placement: event.widgetPlacement ?? 'aboveEditor' }
                else
                    delete this.widgets[event.widgetKey]
                break
            case 'set_editor_text':
                this.draft = event.text ?? ''
                break
            default:
                break
        }
    }

    private async settle() {
        await this.syncState()
        await this.load()
        runInAction(() => {
            this.running = false
            this.streaming = null
            this.pendingPrompt = null
            this.retry = null
            this.tools.clear()
            this.changeTick++
            this.persisted = true
        })
        await this.refreshStats()
        this.host.onSettled(this)
        if (this.restartPending)
            await this.applyCapabilities()
    }

    handleExit(info: AgentExitInfo) {
        const unexpected = !this.stopping
        this.agentId = null
        this.agentStatus = unexpected ? 'exited' : 'none'
        this.startPromise = null
        this.running = false
        this.streaming = null
        this.pendingPrompt = null
        this.uiRequests = []
        this.tools.clear()
        if (unexpected) {
            this.agentError = info.stderr.trim().split('\n').slice(-6).join('\n') || `pi 进程退出（${info.code ?? info.signal}）`
            toast.error('pi 进程意外退出', { description: this.agentError.slice(0, 300) })
        }
    }
}
