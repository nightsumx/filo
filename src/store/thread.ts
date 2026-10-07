import type { AcpConfigOption, AgentFeatures, AgentKind } from '@shared/agents'
import type { ApprovalChoice, ApprovalMode, ApprovalRequest, AskResponse, CapabilityId, GuiCommands, PlanDecision, ReviewApply, ReviewProgress, TodoDetails } from '@shared/capabilities'
import type { AgentExitInfo } from '@shared/ipc'
import type { Presence } from '@shared/capabilities'
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
import type { ThreadActivity } from '@/lib/threadActivity'
import type { BlockTime, Step, TimelineMessage, ToolExecState, ToolResultView } from '@/lib/timeline'
import { newThreadLabel, tr } from '@/lib/i18n'
import { parsePartialJson } from '@/lib/partialJson'
import { threadActivity } from '@/lib/threadActivity'
import { blockTimeKey, buildTurns, contentText } from '@/lib/timeline'
import type { WaitingKind } from '@/lib/threadActivity'
import { tuiTitle } from '@/lib/toolMeta'
import { agentFeatures, agentLabel, agentOfKey } from '@shared/agents'
import { APPROVAL_MODES, APPROVAL_TITLE_PREFIX, GUI_COMMAND_PREFIX, GUI_STATUS, REVIEW_TYPES } from '@shared/capabilities'
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
    /** Set for the approval capability's prompts (a select whose title carries the request). */
    approval?: ApprovalRequest
}

/** What the mode picker shows: plan mode, or the approval mode outside it. */
export type ThreadMode = ApprovalMode | 'plan'

function parseApproval(title?: string): ApprovalRequest | undefined {
    if (!title?.startsWith(APPROVAL_TITLE_PREFIX))
        return undefined
    try {
        const request = JSON.parse(title.slice(APPROVAL_TITLE_PREFIX.length))
        return typeof request?.toolCallId === 'string' ? request : undefined
    }
    catch {
        return undefined
    }
}

export interface ThreadHost {
    registerAgent: (agentId: string, thread: Thread) => void
    rekey: (thread: Thread, oldKey: string) => void
    onSettled: (thread: Thread) => void
    /** Plain copy (sent over IPC); the same for every project. */
    readonly enabledCapabilities: CapabilityId[]
    /** Approval mode new sessions start in (all projects); updated when a thread switches mode. */
    readonly approvalMode: ApprovalMode | undefined
    setApprovalMode: (mode: ApprovalMode) => void
    /** Bumps when pi's own settings.json changes from the app; pi reads it only at startup. */
    piSettingsEpoch: number
}

function toolView(result: any): ToolResultView | undefined {
    if (!result || typeof result !== 'object')
        return undefined
    return { content: Array.isArray(result.content) ? result.content : [], details: result.details, isError: !!result.isError }
}

/**
 * One conversation: a pi session file plus the live `pi --mode rpc` process driving it, or an ACP
 * agent's session (Codex, …) driven through the main process's pi-RPC bridge.
 */
export class Thread {
    key: string
    cwd: string
    /** Which agent runs it; fixed once the thread has history. */
    agent: AgentKind
    sessionPath?: string
    name?: string
    firstPrompt?: string

    /** Active branch read from the session file. */
    items: TimelineMessage[] = []
    /** Messages completed since the last snapshot reload. */
    live: TimelineMessage[] = []
    streaming: AssistantMessage | null = null
    tools = observable.map<string, ToolExecState>()
    /** Exact block start / end times seen while streaming; kept for the app session so reloads stay exact. */
    blockTimes = observable.map<string, BlockTime>()
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
    /** Hidden `/gui-…` commands the process registered: which capabilities it actually loaded. */
    guiCommands: string[] = []
    stats: SessionStats | null = null
    /** ACP agents' session settings (mode, model, effort, …) as they declare them. */
    configOptions: AcpConfigOption[] = []
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
    /** Last pi event; not observable (it changes per token). Read on a timer to spot stalled runs. */
    lastEventAt = 0

    private liveCounter = 0
    private partialArgs = new Map<number, string>()
    private startPromise: Promise<string> | null = null
    private stopping = false
    /** Capability set + settings epoch the running process was started with. */
    private loadedConfig = ''
    /** Config changed mid-run; restart once the run settles. */
    private restartPending = false
    /** The end-of-run reload in progress (see settle). */
    private settling: Promise<void> | null = null
    /** Following the session file a terminal pi writes (no bridge to join it); stops the watch. */
    private unfollow: (() => void) | null = null
    /** The session file changed under this thread's own pi: restart it before the next prompt. */
    private agentStale = false

    constructor(private host: ThreadHost, init: { key: string, cwd: string, sessionPath?: string, name?: string, firstPrompt?: string, agent?: AgentKind }) {
        this.key = init.key
        this.cwd = init.cwd
        this.agent = init.sessionPath ? agentOfKey(init.sessionPath) : init.agent ?? 'pi'
        this.sessionPath = init.sessionPath
        this.name = init.name
        this.firstPrompt = init.firstPrompt
        this.persisted = !!init.sessionPath
        makeAutoObservable<this, 'liveCounter' | 'partialArgs' | 'startPromise' | 'stopping' | 'loadedConfig' | 'restartPending' | 'settling' | 'unfollow' | 'agentStale' | 'host'>(this, {
            lastEventAt: false,
            liveCounter: false,
            partialArgs: false,
            startPromise: false,
            stopping: false,
            loadedConfig: false,
            restartPending: false,
            settling: false,
            unfollow: false,
            agentStale: false,
            host: false,
        }, { autoBind: true })
    }

    // ---------------------------------------------------------------- moving between windows

    /** Resolves once no process start or end-of-run reload is in flight, so a snapshot is complete. */
    async quiesce() {
        await this.startPromise?.catch(() => {})
        await this.settling?.catch(() => {})
    }

    /** Everything a window needs to carry on with this thread, its live process included. Structured-cloneable. */
    snapshot(): Record<string, unknown> {
        // toJS only converts observables themselves, not plain containers holding them: per field.
        const fields: Record<string, unknown> = {
            key: this.key,
            cwd: this.cwd,
            agent: this.agent,
            sessionPath: this.sessionPath,
            name: this.name,
            firstPrompt: this.firstPrompt,
            items: this.items,
            live: this.live,
            streaming: this.streaming,
            tools: this.tools,
            blockTimes: this.blockTimes,
            pendingPrompt: this.pendingPrompt,
            loaded: this.loaded,
            persisted: this.persisted,
            agentId: this.agentId,
            agentStatus: this.agentStatus,
            agentError: this.agentError,
            running: this.running,
            runStartedAt: this.runStartedAt,
            compacting: this.compacting,
            retry: this.retry,
            state: this.state,
            models: this.models,
            thinkingLevels: this.thinkingLevels,
            commands: this.commands,
            guiCommands: this.guiCommands,
            stats: this.stats,
            configOptions: this.configOptions,
            queue: this.queue,
            uiRequests: this.uiRequests,
            statuses: this.statuses,
            widgets: this.widgets,
            draft: this.draft,
            images: this.images,
            unread: this.unread,
            changeTick: this.changeTick,
            lastUsed: this.lastUsed,
            lastEventAt: this.lastEventAt,
            liveCounter: this.liveCounter,
            partialArgs: [...this.partialArgs],
            stopping: this.stopping,
            loadedConfig: this.loadedConfig,
            restartPending: this.restartPending,
        }
        return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, toJS(value)]))
    }

    /** Rebuilds a thread from another window's snapshot; the caller registers its process. */
    static restore(host: ThreadHost, s: Record<string, any>): Thread {
        const thread = new Thread(host, { key: s.key, cwd: s.cwd, sessionPath: s.sessionPath, name: s.name, firstPrompt: s.firstPrompt, agent: s.agent })
        const { tools, blockTimes, partialArgs, liveCounter, stopping, loadedConfig, restartPending, key: _key, cwd: _cwd, agent: _agent, sessionPath: _path, name: _name, firstPrompt: _first, ...fields } = s
        Object.assign(thread, fields)
        thread.tools.replace(tools ?? new Map())
        thread.blockTimes.replace(blockTimes ?? new Map())
        thread.partialArgs = new Map(partialArgs ?? [])
        thread.liveCounter = liveCounter ?? 0
        thread.stopping = !!stopping
        thread.loadedConfig = loadedConfig ?? ''
        thread.restartPending = !!restartPending
        if (!thread.loaded)
            void thread.load().catch(() => {})
        return thread
    }

    get title(): string {
        if (this.name)
            return this.name
        const first = [...this.items, ...this.live].find(m => m.message.role === 'user')
        const text = first ? contentText((first.message as any).content) : this.firstPrompt ?? this.pendingPrompt?.text
        return text?.trim().split('\n')[0].slice(0, 80) || newThreadLabel()
    }

    /** What the UI offers for this thread's agent. */
    get features(): AgentFeatures {
        return agentFeatures(this.agent, this.state?.agentCaps, this.commands)
    }

    get agentLabel(): string {
        return agentLabel(this.agent)
    }

    /** The agent can still be switched: nothing was said in the thread yet. */
    get agentSwitchable(): boolean {
        return !this.persisted && this.isEmpty && !this.uiRequests.length
    }

    /** The terminal pi this thread joined over pi-cc-tui's bridge, by pid; both show the same run. */
    get terminalPid(): number | undefined {
        return this.agentStatus === 'ready' ? this.state?.terminalPid : undefined
    }

    /**
     * What the terminal pi on this session is doing changed (pi-cc-tui's presence). With a bridge,
     * an idle own pi gives way to joining it; without one the thread follows the file it writes.
     */
    onTerminalPresence(terminal: Presence | undefined) {
        if (this.agent !== 'pi' || !this.sessionPath)
            return
        const follow = !!terminal && !terminal.bridge
        if (follow && !this.unfollow) {
            const path = this.sessionPath
            const off = api().onSessionChanged((changed) => {
                if (changed === this.sessionPath)
                    void this.reloadFollowed()
            })
            void api().followSession(path, true)
            this.unfollow = () => {
                off()
                void api().followSession(path, false)
            }
        }
        else if (!follow && this.unfollow) {
            this.unfollow()
            this.unfollow = null
        }
        if (terminal?.bridge && this.agentId && this.agentStatus === 'ready' && !this.terminalPid && !this.running && !this.uiRequests.length)
            void this.restartAgent()
    }

    /** The terminal pi wrote the session file: show it; this thread's own pi now lags behind it. */
    private async reloadFollowed() {
        if (this.running || this.settling || !this.loaded)
            return
        await this.load()
        if (this.agentId)
            this.agentStale = true
    }

    /** Picks the agent of a fresh thread; a started process of the old one stops. */
    async setAgent(agent: AgentKind) {
        if (agent === this.agent || !this.agentSwitchable)
            return
        const old = this.agentId
        if (old) {
            await this.stopAgent()
            runInAction(() => {
                if (this.agentId === old) {
                    this.agentId = null
                    this.agentStatus = 'none'
                    this.startPromise = null
                }
            })
        }
        runInAction(() => {
            this.agent = agent
            this.state = null
            this.models = []
            this.thinkingLevels = []
            this.commands = []
            this.guiCommands = []
            this.configOptions = []
            this.stats = null
            this.statuses = {}
            this.widgets = {}
            this.agentError = ''
            if (this.agentStatus === 'error' || this.agentStatus === 'exited')
                this.agentStatus = 'none'
        })
        await this.ensureAgent().catch(() => {})
    }

    get isEmpty(): boolean {
        return !this.items.length && !this.live.length && !this.pendingPrompt && !this.running
    }

    get turns() {
        return buildTurns([...this.items, ...this.live], {
            tools: this.tools,
            blockTimes: this.blockTimes,
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

    /** Approval mode the extension reported; undefined when the capability is not loaded. */
    get approvalMode(): ApprovalMode | undefined {
        const mode = this.statuses[GUI_STATUS.approval] as ApprovalMode | undefined
        return mode && APPROVAL_MODES.includes(mode) ? mode : undefined
    }

    get planMode(): boolean {
        return this.statuses[GUI_STATUS.plan] === 'on'
    }

    /** The review capability is loaded in this thread's pi. */
    get reviewAvailable(): boolean {
        return this.guiCommands.includes('gui-review' satisfies GuiCommands['review'])
    }

    /** The running review, from its status; null when none runs. */
    get reviewProgress(): ReviewProgress | null {
        const raw = this.statuses[GUI_STATUS.review]
        if (!raw)
            return null
        try {
            return JSON.parse(raw) as ReviewProgress
        }
        catch {
            return null
        }
    }

    /** The turn whose footer holds Review: the latest finished turn that did work. */
    get reviewTurnKey(): string | undefined {
        const turns = this.turns
        for (let i = turns.length - 1; i >= 0; i--) {
            const turn = turns[i]
            if (turn.running)
                continue
            if (turn.steps.some(s => s.kind === 'tool' || s.kind === 'text' || s.kind === 'thinking'))
                return turn.key
        }
        return undefined
    }

    get mode(): ThreadMode | undefined {
        return this.planMode ? 'plan' : this.approvalMode
    }

    /** Extension status entries for display; `gui-` keys carry mode state instead. */
    get visibleStatuses(): [string, string][] {
        return Object.entries(this.statuses).filter(([key]) => !key.startsWith(GUI_COMMAND_PREFIX))
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
        return this.waitingFor !== undefined
    }

    /** The question or dialog title pi is blocked on, or undefined when it is not waiting. */
    /** What kind of answer pi waits for, worded in the tree and notifications. */
    get waitingKind(): WaitingKind | undefined {
        if (this.waitingFor === undefined)
            return undefined
        if (this.uiRequests[0]?.approval)
            return 'approval'
        if (!this.uiRequests.length && [...this.tools.values()].some(s => s.running && s.partial?.details?.kind === 'plan'))
            return 'plan'
        return 'question'
    }

    /** The approval prompt pi is blocked on for a tool call, if any. */
    approvalFor(toolCallId: string): UiRequest | undefined {
        return this.uiRequests.find(r => r.approval?.toolCallId === toolCallId)
    }

    get waitingFor(): string | undefined {
        const request = this.uiRequests[0]
        if (request?.approval)
            return `${tuiTitle(request.approval.tool)} ${request.approval.summary}`
        if (request)
            return request.title || request.message || ''
        for (const state of this.tools.values()) {
            const details = state.partial?.details
            if (state.running && details?.kind === 'ask' && details.status === 'pending')
                return details.questions?.[0]?.question ?? ''
            if (state.running && details?.kind === 'plan' && details.status === 'pending')
                return ''
        }
        return undefined
    }

    /** One-line status for the project tree: what it is doing, waiting on, or failed with. */
    get activity(): ThreadActivity {
        const turns = this.turns
        return threadActivity({
            running: this.running,
            starting: this.agentStatus === 'starting',
            compacting: this.compacting,
            retry: this.retry,
            waitingFor: this.waitingFor,
            waitingKind: this.waitingKind,
            agentError: this.agentError,
            steps: [...(turns[turns.length - 1]?.steps ?? []), ...this.streamingSteps],
            todo: this.todo,
            cwd: this.cwd,
        })
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
            this.items = snapshot.items.map(i => ({ key: i.entryId, message: i.message, endedAt: i.endedAt }))
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
                this.agentError = String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
                this.startPromise = null
            })
            throw error
        })
        return this.startPromise
    }

    private async startAgent(): Promise<string> {
        runInAction(() => {
            this.agentStatus = 'starting'
            this.agentError = ''
        })
        // A path pi never wrote (thread left empty) cannot be resumed; start fresh instead.
        const resumable = this.persisted ? this.sessionPath : undefined
        const capabilities = this.host.enabledCapabilities
        this.loadedConfig = this.configKey()
        this.restartPending = false
        const agentId = await api().agentStart({ cwd: this.cwd, agent: this.agent, sessionPath: resumable, capabilities, approvalMode: this.host.approvalMode })
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
            this.agentStale = false
        })
        // Joined a terminal pi: entries it wrote since this thread read the file come in now.
        if (this.state?.terminalPid)
            await this.load()
        return agentId
    }

    async stopAgent() {
        const id = this.agentId
        if (!id)
            return
        this.stopping = true
        await api().agentStop(id)
    }

    private configKey(): string {
        // Capabilities and pi's settings mean nothing to other agents: never restart those for them.
        if (this.agent !== 'pi')
            return this.agent
        return `${this.host.enabledCapabilities.join(',')}#${this.host.piSettingsEpoch}`
    }

    /**
     * Extensions and pi's settings load at startup, so a changed capability set or settings file
     * needs a new process. It resumes the same session file; mid-run changes wait for the run to settle.
     */
    async applyConfig() {
        if (!this.agentId || this.configKey() === this.loadedConfig) {
            this.restartPending = false
            return
        }
        if (this.running || this.uiRequests.length) {
            this.restartPending = true
            return
        }
        await this.restartAgent()
    }

    /** A new process (or joining the terminal pi) for the same session file. */
    private async restartAgent() {
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
            throw new Error(response.error || tr(`${command.type} 失败`, `${command.type} failed`))
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
            if (Array.isArray(state.configOptions))
                this.configOptions = state.configOptions
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
        if (data) {
            runInAction(() => {
                this.commands = data.commands.filter(c => !c.name.startsWith(GUI_COMMAND_PREFIX))
                this.guiCommands = data.commands.filter(c => c.name.startsWith(GUI_COMMAND_PREFIX)).map(c => c.name)
            })
        }
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

        // The terminal pi moved the session on: a fresh process reads it before this prompt.
        if (this.agentStale && this.agentId)
            await this.restartAgent()
        runInAction(() => {
            this.pendingPrompt = { text, images, timestamp: Date.now() }
            this.running = true
            this.runStartedAt = Date.now()
        })
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

    /** An ACP agent's session setting (mode, model, effort, …). */
    async setConfigOption(configId: string, value: string) {
        try {
            const response = await this.request<{ configOptions?: AcpConfigOption[] }>({ type: 'set_config_option', configId, value })
            runInAction(() => {
                if (response.data?.configOptions)
                    this.configOptions = response.data.configOptions
            })
            await this.syncState()
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

    /**
     * pi's fork: this process moves to a new session holding the branch before `entryId` (a user
     * prompt), and the prompt comes back into the composer to edit. The old session stays as it was.
     */
    async fork(entryId: string): Promise<boolean> {
        if (this.running) {
            toast.error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
            return false
        }
        try {
            const response = await this.request<{ text?: string, cancelled?: boolean }>({ type: 'fork', entryId })
            if (response.data?.cancelled)
                return false
            await this.syncState()
            // Forking at the first prompt leaves no conversation, and pi writes no file until there is one.
            await this.load().catch(() => runInAction(() => {
                this.items = []
                this.loaded = true
            }))
            runInAction(() => {
                // Otherwise the fork's file already holds the earlier turns: the tab survives a restart.
                if (this.items.length)
                    this.persisted = true
                this.draft = response.data?.text ?? ''
            })
            await this.refreshStats()
            return true
        }
        catch (error: any) {
            toast.error(`${tr('分叉失败：', 'Fork failed: ')}${error.message}`)
            return false
        }
    }

    /** ACP: the agent copies the whole session; resolves to the copy's session key. */
    async forkSession(): Promise<string | undefined> {
        try {
            const response = await this.request<{ sessionFile?: string }>({ type: 'acp_fork' })
            return response.data?.sessionFile
        }
        catch (error: any) {
            toast.error(`${tr('分叉失败：', 'Fork failed: ')}${error.message}`)
            return undefined
        }
    }

    async compact() {
        try {
            await this.request({ type: 'compact' })
            // ACP agents compact as a turn of their own: it streams in and settles like any other.
            if (this.agent !== 'pi')
                return
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
            throw new Error(tr(`/${name} 未被处理，能力扩展可能没有加载`, `/${name} was not handled; the capability extension may not be loaded`))
    }

    async answerAsk(toolCallId: string, response: AskResponse) {
        try {
            await this.guiCommand('gui-ask-answer', `${toolCallId} ${JSON.stringify(response)}`)
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    /** Plan mode, or an approval mode (leaving plan mode first). Approval modes become the project default. */
    async setMode(mode: ThreadMode) {
        try {
            if (mode === 'plan') {
                await this.guiCommand('gui-plan', 'on')
                return
            }
            if (this.planMode)
                await this.guiCommand('gui-plan', 'off')
            if (this.approvalMode !== undefined) {
                await this.guiCommand('gui-approval', mode)
                this.host.setApprovalMode(mode)
            }
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    answerApproval(request: UiRequest, choice: ApprovalChoice) {
        this.respondUi(request, { value: choice })
    }

    async decidePlan(toolCallId: string, decision: PlanDecision) {
        try {
            await this.guiCommand('gui-plan-decide', `${toolCallId} ${JSON.stringify(decision)}`)
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    async steerSubagent(toolCallId: string, message: string): Promise<boolean> {
        try {
            await this.guiCommand('gui-subagent-steer', `${toolCallId} ${message}`)
            return true
        }
        catch (error: any) {
            toast.error(error.message)
            return false
        }
    }

    /** Starts a review in pi's background; progress comes back as the gui-review status. */
    async startReview(focus = '') {
        try {
            await this.guiCommand('gui-review', focus)
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    async cancelReview() {
        try {
            await this.guiCommand('gui-review-cancel', '')
        }
        catch (error: any) {
            toast.error(error.message)
        }
    }

    /** Sends picked items to the agent: a new turn when idle, a follow-up mid-run. */
    async applyReview(reviewId: string, apply: ReviewApply): Promise<boolean> {
        try {
            await this.guiCommand('gui-review-apply', `${reviewId} ${JSON.stringify(apply)}`)
            return true
        }
        catch (error: any) {
            toast.error(error.message)
            return false
        }
    }

    async cancelSubagent(toolCallId: string) {
        try {
            await this.guiCommand('gui-subagent-cancel', toolCallId)
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
        this.live.push({ key: `live-${this.liveCounter++}`, message, endedAt: Date.now() })
    }

    handleEvent(event: PiEvent) {
        this.lastEventAt = Date.now()
        switch (event.type) {
            case 'agent_start':
                if (!this.running) {
                    this.running = true
                    this.runStartedAt = Date.now()
                }
                this.agentError = ''
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
                this.tools.set(event.toolCallId, { running: true, startedAt: Date.now() })
                break
            case 'tool_execution_update':
                this.tools.set(event.toolCallId, { ...this.tools.get(event.toolCallId), running: true, partial: toolView(event.partialResult) })
                break
            case 'tool_execution_end':
                this.tools.set(event.toolCallId, { startedAt: this.tools.get(event.toolCallId)?.startedAt, endedAt: Date.now(), running: false, result: toolView({ ...event.result, isError: event.isError }) })
                if (['edit', 'write', 'bash'].includes(event.toolName))
                    this.changeTick++
                // pi dismissed the approval itself (abort); drop the prompt with it.
                this.uiRequests = this.uiRequests.filter(r => r.approval?.toolCallId !== event.toolCallId)
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
                    toast.error(`${tr('压缩失败：', 'Compaction failed: ')}${readableError(event.errorMessage)}`)
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
            // A review report: appended while the agent may be idle, when no settle reloads the session.
            case 'entry_appended':
                if (event.entry?.customType === REVIEW_TYPES.report && event.entry.data?.kind === 'review') {
                    this.pushLive({ role: 'custom', customType: REVIEW_TYPES.report, content: '', display: true, details: event.entry.data, timestamp: Date.now() })
                    if (!this.running && !this.settling)
                        void this.load()
                }
                break
            case 'acp_config_changed':
                if (Array.isArray(event.configOptions)) {
                    this.configOptions = event.configOptions
                    void this.syncState()
                }
                break
            case 'acp_commands_changed':
                void this.refreshCommands()
                break
            // Not pi's: a joined terminal pi (cc-bridge) changed model, or settled a dialog itself.
            case 'state_changed':
                void this.syncState()
                break
            case 'extension_ui_cancel':
                this.uiRequests = this.uiRequests.filter(r => r.id !== event.id)
                break
            case 'extension_error':
                toast.error(`${tr('扩展出错：', 'Extension error: ')}${event.error}`, { description: event.extensionPath })
                break
            case 'agent_settled':
                this.settling = this.settle().finally(() => {
                    this.settling = null
                })
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
        if (typeof update.type === 'string' && typeof i === 'number') {
            const timeKey = blockTimeKey(message.timestamp, i)
            if (update.type.endsWith('_start'))
                this.blockTimes.set(timeKey, { start: Date.now() })
            else if (update.type.endsWith('_end'))
                this.blockTimes.set(timeKey, { start: this.blockTimes.get(timeKey)?.start ?? Date.now(), end: Date.now() })
        }
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
                    approval: event.method === 'select' ? parseApproval(event.title) : undefined,
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
            // Approvals belong to tool calls, and none run once settled (a subagent's child included).
            this.uiRequests = this.uiRequests.filter(r => !r.approval)
        })
        await this.refreshStats()
        this.host.onSettled(this)
        if (this.restartPending)
            await this.applyConfig()
    }

    handleExit(info: AgentExitInfo) {
        if (info.detached) {
            this.detached()
            return
        }
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
            const label = this.agentLabel
            this.agentError = info.stderr.trim().split('\n').slice(-6).join('\n') || tr(`${label} 进程退出（${info.code ?? info.signal}）`, `${label} exited (${info.code ?? info.signal})`)
            toast.error(tr(`${label} 进程意外退出`, `${label} exited unexpectedly`), { description: this.agentError.slice(0, 300) })
        }
    }

    /** The joined terminal pi quit or moved to another session: what it wrote is in the file. */
    private detached() {
        this.agentId = null
        this.agentStatus = 'none'
        this.startPromise = null
        this.running = false
        this.streaming = null
        this.pendingPrompt = null
        this.uiRequests = []
        this.tools.clear()
        if (this.state)
            this.state = { ...this.state, terminalPid: undefined, isStreaming: false }
        void this.load().catch(() => {})
    }
}
