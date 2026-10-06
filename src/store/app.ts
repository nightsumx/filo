import type { CapabilityId } from '@shared/capabilities'
import type { AppState, GlobalCompactionPatch, PiEnvResult, SessionSummary, ThemePref, TranscriptLang } from '@shared/ipc'
import { DEFAULT_CAPABILITIES, normalizeCapabilities } from '@shared/capabilities'
import { DEFAULT_THEME, THEME_PREFS, TRANSCRIPT_LANGS } from '@shared/ipc'
import type { PiEvent } from '@shared/pi'
import type { ThreadHost } from './thread'
import { basename, uid } from '@/lib/utils'
import { makeAutoObservable, observable, reaction, runInAction } from 'mobx'
import { toast } from 'sonner'
import { Thread } from './thread'

const api = () => window.pi

/** First line of the final answer of a thread's last turn, for the "done" notification. */
function lastAnswer(thread: Thread): string {
    const steps = thread.turns[thread.turns.length - 1]?.steps ?? []
    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]
        if (step.kind === 'text' && step.text.trim())
            return step.text.trim().split('\n')[0].replace(/[*_`#>]/g, '').slice(0, 200)
    }
    return ''
}

/**
 * No cap on pi processes. One that has sat idle off screen this long is stopped; the next message
 * resumes the same session file. Running, waiting-for-user and on-screen threads are never stopped.
 */
export const AGENT_IDLE_MS = 60 * 60_000
const IDLE_SWEEP_MS = 60_000
/** Auto split: a pane needs this much width, and at most this many panes are shown. */
export const MIN_PANE_WIDTH = 520
export const MAX_PANES = 3

export type SettingsPageId = 'appearance' | 'capabilities' | 'compaction'

export interface Project {
    cwd: string
    name: string
    sessions: SessionSummary[]
    latest: number
}

export interface ProjectActivity {
    open: number
    running: number
    unread: number
    waiting: number
}

class AppStore implements ThreadHost {
    env: PiEnvResult | null = null
    sessions: SessionSummary[] = []
    /** Sidebar order (cwds); see `projects`. */
    projectOrder: string[] = []
    /** Session-derived projects the user removed from the sidebar. */
    hiddenProjects: string[] = []
    /** Project folders that no longer exist on disk; refreshed with the session list. */
    missingProjects: string[] = []

    threads = observable.map<string, Thread>()
    /** Tab order per project (thread keys). New threads use "new:<uuid>" until pi writes a file. */
    tabsByProject: Record<string, string[]> = {}
    activeTabByProject: Record<string, string> = {}
    activeProject: string | null = null
    layout: 'split' | 'single' = 'split'
    /** Appearance preference; the resolved scheme lives in lib/theme. */
    themePref: ThemePref = DEFAULT_THEME
    /** Conversation wording; English matches pi's TUI. */
    transcriptLang: TranscriptLang = 'en'
    /** Capabilities chosen per project; absent means DEFAULT_CAPABILITIES. */
    capabilitiesByProject: Record<string, CapabilityId[]> = {}
    settingsOpen = false
    /** Page shown in Settings; kept while the app runs so reopening returns to it. */
    settingsPage: SettingsPageId = 'appearance'
    /** See ThreadHost.piSettingsEpoch. */
    piSettingsEpoch = 0
    /** How many panes fit side by side; measured by the pane container. */
    paneCapacity = 1
    /** Bumped to move keyboard focus into a thread's composer. */
    composerFocus = { key: '', n: 0 }

    reviewOpen = false
    sidebarOpen = true

    private agentThreads = new Map<string, Thread>()
    private eventQueue: [string, PiEvent][] = []
    private flushTimer: ReturnType<typeof setTimeout> | null = null
    private savedState = ''
    /** Saved state has been applied; nothing is persisted before that. */
    private ready = false

    constructor() {
        makeAutoObservable<this, 'agentThreads' | 'eventQueue' | 'flushTimer' | 'savedState' | 'ready'>(this, {
            agentThreads: false,
            eventQueue: false,
            flushTimer: false,
            savedState: false,
            ready: false,
        }, { autoBind: true })
    }

    // ---------------------------------------------------------------- derived

    /**
     * Sidebar order is sticky so rows (and their ⌃1–9 shortcuts) do not jump around while other
     * pi instances write sessions. Known projects keep their saved position; newly seen ones are
     * placed on top, most recent first.
     */
    get projects(): Project[] {
        const hidden = new Set(this.hiddenProjects)
        const byCwd = new Map<string, Project>()
        const add = (cwd: string) => {
            let project = byCwd.get(cwd)
            if (!project) {
                project = { cwd, name: basename(cwd), sessions: [], latest: 0 }
                byCwd.set(cwd, project)
            }
            return project
        }
        for (const cwd of this.projectOrder)
            add(cwd)
        for (const session of this.sessions) {
            if (!session.cwd || hidden.has(session.cwd))
                continue
            const project = add(session.cwd)
            project.sessions.push(session)
            project.latest = Math.max(project.latest, session.updatedAt)
        }
        for (const [cwd, keys] of Object.entries(this.tabsByProject)) {
            if (keys.length && !hidden.has(cwd))
                add(cwd)
        }
        const known = new Set(this.projectOrder)
        const fresh = [...byCwd.values()].filter(p => !known.has(p.cwd)).sort((a, b) => b.latest - a.latest)
        return [...fresh, ...this.projectOrder.map(cwd => byCwd.get(cwd)!).filter(Boolean)]
    }

    get project(): Project | null {
        return this.projects.find(p => p.cwd === this.activeProject) ?? null
    }

    tabsOf(cwd: string): Thread[] {
        return (this.tabsByProject[cwd] ?? []).map(k => this.threads.get(k)).filter((t): t is Thread => !!t)
    }

    /** Tabs of the active project, in order. */
    get tabs(): Thread[] {
        return this.activeProject ? this.tabsOf(this.activeProject) : []
    }

    get activeKey(): string | null {
        const tabs = this.tabs
        const key = this.activeProject ? this.activeTabByProject[this.activeProject] : undefined
        return tabs.some(t => t.key === key) ? key! : tabs[0]?.key ?? null
    }

    get active(): Thread | null {
        return this.activeKey ? this.threads.get(this.activeKey) ?? null : null
    }

    /** Tabs on screen: as many as fit, in tab order, always including the focused one. */
    get visibleTabs(): Thread[] {
        const tabs = this.tabs
        const capacity = this.layout === 'single' ? 1 : Math.max(1, Math.min(MAX_PANES, this.paneCapacity))
        if (tabs.length <= capacity)
            return tabs
        const index = Math.max(0, tabs.findIndex(t => t.key === this.activeKey))
        const start = index < capacity ? 0 : index - capacity + 1
        return tabs.slice(start, start + capacity)
    }

    isVisible(thread: Thread): boolean {
        return this.visibleTabs.includes(thread)
    }

    activity(cwd: string): ProjectActivity {
        const tabs = this.tabsOf(cwd)
        return {
            open: tabs.filter(t => !t.isEmpty || t.persisted).length,
            running: tabs.filter(t => t.running).length,
            unread: tabs.filter(t => t.unread).length,
            waiting: tabs.filter(t => t.waitingForUser).length,
        }
    }

    // ---------------------------------------------------------------- lifecycle

    async init() {
        api().onAgentEvent((agentId, event) => {
            this.eventQueue.push([agentId, event])
            // Token deltas arrive one IPC message each; apply them in batches.
            this.flushTimer ??= setTimeout(this.flushEvents, 16)
        })
        api().onOpenSettings(() => runInAction(() => this.setSettingsOpen(true)))
        api().onAgentExit((agentId, info) => {
            this.flushEvents()
            const thread = this.agentThreads.get(agentId)
            this.agentThreads.delete(agentId)
            if (thread?.agentId === agentId) {
                runInAction(() => thread.handleExit(info))
                if (thread.agentStatus === 'exited')
                    this.notify(thread, '出错', thread.activity.text)
            }
        })
        api().onNotificationClick(key => runInAction(() => this.focus(key, true)))
        // A thread starts waiting for the user: notify once, and keep the Dock badge at the count.
        let waiting = new Set<string>()
        reaction(
            () => [...this.threads.values()].filter(t => t.waitingForUser).map(t => t.key),
            (keys) => {
                for (const key of keys) {
                    const thread = this.threads.get(key)
                    if (thread && !waiting.has(key))
                        this.notify(thread, '等你回答', thread.waitingFor || '需要你的确认', true)
                }
                waiting = new Set(keys)
                void api().setBadge(keys.length)
            },
        )
        window.addEventListener('focus', () => void this.refreshSessions())
        setInterval(this.stopIdleAgents, IDLE_SWEEP_MS)

        const [env, state] = await Promise.all([api().resolveEnv(), api().loadState()])
        await this.refreshSessions()
        runInAction(() => {
            this.env = env
            this.restoreState(state)
            this.ready = true
            this.projectOrder = this.projects.map(p => p.cwd)
        })
        await this.refreshMissing()
        const cwd = this.activeProject ?? this.projects[0]?.cwd
        if (env.ok && cwd)
            this.selectProject(cwd)
    }

    async retryEnv() {
        this.env = null
        const env = await api().resolveEnv()
        runInAction(() => (this.env = env))
    }

    private flushEvents() {
        this.flushTimer = null
        const batch = this.eventQueue
        this.eventQueue = []
        if (!batch.length)
            return
        runInAction(() => {
            for (const [agentId, event] of batch)
                this.agentThreads.get(agentId)?.handleEvent(event)
        })
    }

    async refreshSessions() {
        try {
            const sessions = await api().listSessions()
            runInAction(() => {
                this.sessions = sessions
                // Freeze the position of newly seen projects.
                if (this.ready)
                    this.projectOrder = this.projects.map(p => p.cwd)
            })
            this.persist()
        }
        catch (error: any) {
            toast.error(`读取会话失败：${error.message}`)
        }
        if (this.ready)
            await this.refreshMissing()
    }

    private async refreshMissing() {
        const missing = await api().missingFolders(this.projects.map(p => p.cwd)).catch(() => [])
        runInAction(() => (this.missingProjects = missing))
    }

    // ---------------------------------------------------------------- persistence

    private restoreState(state: AppState) {
        this.projectOrder = state.projects ?? []
        this.hiddenProjects = state.hiddenProjects ?? []
        this.layout = state.layout === 'single' ? 'single' : 'split'
        this.themePref = THEME_PREFS.includes(state.theme as ThemePref) ? state.theme! : DEFAULT_THEME
        this.transcriptLang = TRANSCRIPT_LANGS.includes(state.transcriptLang as TranscriptLang) ? state.transcriptLang! : 'en'
        this.activeProject = state.activeProject ?? null
        this.capabilitiesByProject = Object.fromEntries(Object.entries(state.capabilities ?? {}).map(([cwd, ids]) => [cwd, normalizeCapabilities(ids)]))
        // Thread objects are created lazily per project (restoreTabs); keep the saved order for now.
        this.tabsByProject = { ...state.tabs }
        this.activeTabByProject = { ...state.activeTabs }
    }

    private persist() {
        if (!this.ready)
            return
        // Only tabs backed by a session file survive a restart.
        const keep = (key: string) => {
            const thread = this.threads.get(key)
            return thread ? thread.persisted && thread.key === thread.sessionPath : !key.startsWith('new:')
        }
        const tabs: Record<string, string[]> = {}
        for (const [cwd, keys] of Object.entries(this.tabsByProject)) {
            const kept = keys.filter(keep)
            if (kept.length)
                tabs[cwd] = kept
        }
        const activeTabs: Record<string, string> = {}
        for (const [cwd, key] of Object.entries(this.activeTabByProject)) {
            if (tabs[cwd]?.includes(key))
                activeTabs[cwd] = key
        }
        const state: AppState = {
            projects: this.projectOrder,
            hiddenProjects: this.hiddenProjects,
            activeProject: this.activeProject ?? undefined,
            tabs,
            activeTabs,
            layout: this.layout,
            theme: this.themePref,
            transcriptLang: this.transcriptLang,
            capabilities: this.capabilitiesByProject,
        }
        const json = JSON.stringify(state)
        if (json === this.savedState)
            return
        this.savedState = json
        void api().saveState(JSON.parse(json))
    }

    /** Create Thread objects for a project's saved tabs, dropping sessions that no longer exist. */
    private restoreTabs(cwd: string) {
        const keys = this.tabsByProject[cwd] ?? []
        const restored: string[] = []
        for (const key of keys) {
            if (this.threads.has(key)) {
                restored.push(key)
                continue
            }
            const session = this.sessions.find(s => s.path === key)
            if (!session)
                continue
            this.createSessionThread(session)
            restored.push(key)
        }
        this.tabsByProject[cwd] = restored
    }

    private createSessionThread(session: SessionSummary): Thread {
        const thread = new Thread(this, {
            key: session.path,
            cwd: session.cwd,
            sessionPath: session.path,
            name: session.name,
            firstPrompt: session.firstPrompt,
        })
        this.threads.set(thread.key, thread)
        void thread.load().catch(error => toast.error(`打开线程失败：${error.message}`))
        return thread
    }

    // ---------------------------------------------------------------- ThreadHost

    /** A plain copy: it is sent over IPC, which cannot clone MobX arrays. */
    capabilitiesOf(cwd: string): CapabilityId[] {
        return [...(this.capabilitiesByProject[cwd] ?? DEFAULT_CAPABILITIES)]
    }

    registerAgent(agentId: string, thread: Thread) {
        this.agentThreads.set(agentId, thread)
    }

    rekey(thread: Thread, oldKey: string) {
        if (this.threads.get(oldKey) === thread)
            this.threads.delete(oldKey)
        this.threads.set(thread.key, thread)
        const tabs = this.tabsByProject[thread.cwd]
        if (tabs)
            this.tabsByProject[thread.cwd] = tabs.map(k => (k === oldKey ? thread.key : k))
        if (this.activeTabByProject[thread.cwd] === oldKey)
            this.activeTabByProject[thread.cwd] = thread.key
        if (this.composerFocus.key === oldKey)
            this.composerFocus = { key: thread.key, n: this.composerFocus.n }
        this.persist()
    }

    /** System notification for a thread, only while the window is in the background. */
    private notify(thread: Thread, what: string, body: string, urgent = false) {
        if (document.hasFocus())
            return
        void api().notify({ title: `${thread.title} · ${what}`, body: body || thread.title, key: thread.key, urgent })
    }

    onSettled(thread: Thread) {
        thread.lastUsed = Date.now()
        const activity = thread.activity
        if (activity.phase === 'error')
            this.notify(thread, '出错', activity.text)
        else
            this.notify(thread, '已完成', lastAnswer(thread))
        if (!this.isVisible(thread)) {
            thread.unread = true
            toast.success(`「${thread.title}」已完成`, {
                action: { label: '查看', onClick: () => this.focus(thread.key, true) },
            })
        }
        this.persist()
        void this.refreshSessions()
    }

    /** Stops pi processes idle for AGENT_IDLE_MS. Idle time counts from when a thread was last in use. */
    stopIdleAgents(now = Date.now()) {
        for (const thread of this.threads.values()) {
            if (!thread.agentId || thread.agentStatus !== 'ready')
                continue
            if (thread.running || thread.waitingForUser || this.isVisible(thread)) {
                thread.lastUsed = now
                continue
            }
            if (now - thread.lastUsed >= AGENT_IDLE_MS)
                void thread.stopAgent()
        }
    }

    // ---------------------------------------------------------------- navigation

    selectProject(cwd: string) {
        this.activeProject = cwd
        this.restoreTabs(cwd)
        if (!this.tabsOf(cwd).length)
            this.newThread(cwd)
        else
            this.requestComposerFocus(this.activeKey)
        this.persist()
    }

    /** Make a tab the focused one (switching project if needed). */
    focus(key: string, focusComposer = false) {
        const thread = this.threads.get(key)
        if (!thread)
            return
        this.activeProject = thread.cwd
        this.activeTabByProject[thread.cwd] = key
        thread.unread = false
        thread.lastUsed = Date.now()
        if (focusComposer)
            this.requestComposerFocus(key)
        this.persist()
    }

    private requestComposerFocus(key: string | null) {
        if (key)
            this.composerFocus = { key, n: this.composerFocus.n + 1 }
    }

    private insertTab(thread: Thread) {
        const tabs = [...(this.tabsByProject[thread.cwd] ?? [])]
        if (!tabs.includes(thread.key)) {
            const after = tabs.indexOf(this.activeTabByProject[thread.cwd] ?? '')
            tabs.splice(after === -1 ? tabs.length : after + 1, 0, thread.key)
            this.tabsByProject[thread.cwd] = tabs
        }
    }

    /** Open a session in a tab of its project, or focus the tab already showing it. */
    openSession(session: SessionSummary) {
        this.activeProject = session.cwd
        this.restoreTabs(session.cwd)
        const thread = this.threads.get(session.path) ?? this.createSessionThread(session)
        this.insertTab(thread)
        this.focus(thread.key, true)
    }

    /** New tab in a project; reuses an untouched new tab instead of stacking empty ones. */
    newThread(cwd: string) {
        if (this.missingProjects.includes(cwd)) {
            toast.error('项目目录不存在', { description: `${cwd} 已被删除或移动。可以在侧边栏的项目菜单里“从列表移除”。` })
            return
        }
        this.restoreTabs(cwd)
        const blank = this.tabsOf(cwd).find(t => t.isEmpty && !t.persisted)
        if (blank) {
            this.focus(blank.key, true)
            return
        }
        const thread = new Thread(this, { key: `new:${uid()}`, cwd })
        thread.loaded = true
        this.threads.set(thread.key, thread)
        this.insertTab(thread)
        this.focus(thread.key, true)
    }

    async closeTab(key: string) {
        const thread = this.threads.get(key)
        if (!thread)
            return
        const tabs = this.tabsByProject[thread.cwd] ?? []
        const index = tabs.indexOf(key)
        const remaining = tabs.filter(k => k !== key)
        this.tabsByProject[thread.cwd] = remaining
        if (this.activeTabByProject[thread.cwd] === key && remaining.length)
            this.activeTabByProject[thread.cwd] = remaining[Math.min(index, remaining.length - 1)]
        this.threads.delete(key)
        this.persist()
        if (thread.agentId) {
            if (thread.running)
                await thread.abort()
            await thread.stopAgent()
        }
    }

    cycleTab(step: number) {
        const tabs = this.tabs
        if (tabs.length < 2)
            return
        const index = tabs.findIndex(t => t.key === this.activeKey)
        this.focus(tabs[(index + step + tabs.length) % tabs.length].key, true)
    }

    focusTabAt(index: number) {
        const tab = index < 0 ? this.tabs[this.tabs.length - 1] : this.tabs[index]
        if (tab)
            this.focus(tab.key, true)
    }

    moveTab(key: string, toIndex: number) {
        const thread = this.threads.get(key)
        if (!thread)
            return
        const tabs = (this.tabsByProject[thread.cwd] ?? []).filter(k => k !== key)
        tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, key)
        this.tabsByProject[thread.cwd] = tabs
        this.persist()
    }

    setPaneCapacity(width: number) {
        const capacity = Math.max(1, Math.min(MAX_PANES, Math.floor(width / MIN_PANE_WIDTH)))
        if (capacity !== this.paneCapacity)
            this.paneCapacity = capacity
    }

    setTheme(pref: ThemePref) {
        this.themePref = pref
        void api().setTheme(pref)
        this.persist()
    }

    setTranscriptLang(lang: TranscriptLang) {
        this.transcriptLang = lang
        this.persist()
    }

    /** Live threads of the project restart with the new set once idle, resuming their session. */
    setCapabilities(cwd: string, ids: CapabilityId[]) {
        this.capabilitiesByProject[cwd] = normalizeCapabilities(ids)
        this.persist()
        for (const thread of this.tabsOf(cwd))
            void thread.applyConfig()
    }

    /**
     * Writes compaction.* into pi's global settings.json. Every pi process reads it only at startup,
     * so live threads restart once idle (resuming their session), like a capability change.
     */
    async setGlobalCompaction(patch: GlobalCompactionPatch) {
        await api().setGlobalCompaction(patch)
        runInAction(() => {
            this.piSettingsEpoch++
        })
        for (const thread of this.threads.values())
            void thread.applyConfig()
    }

    setSettingsOpen(open: boolean) {
        this.settingsOpen = open
    }

    setSettingsPage(page: SettingsPageId) {
        this.settingsPage = page
    }

    toggleLayout() {
        this.layout = this.layout === 'split' ? 'single' : 'split'
        this.persist()
    }

    async deleteSession(session: SessionSummary) {
        await this.closeTab(session.path)
        try {
            await api().trashSession(session.path)
        }
        catch (error: any) {
            toast.error(`删除失败：${error.message}`)
        }
        await this.refreshSessions()
    }

    // ---------------------------------------------------------------- projects

    async addProject() {
        const folder = await api().pickFolder()
        if (!folder)
            return
        runInAction(() => {
            this.projectOrder = [folder, ...this.projectOrder.filter(p => p !== folder)]
            this.hiddenProjects = this.hiddenProjects.filter(p => p !== folder)
        })
        this.selectProject(folder)
    }

    async removeProject(cwd: string) {
        for (const thread of this.tabsOf(cwd))
            await this.closeTab(thread.key)
        runInAction(() => {
            this.projectOrder = this.projectOrder.filter(p => p !== cwd)
            if (!this.hiddenProjects.includes(cwd))
                this.hiddenProjects.push(cwd)
            delete this.tabsByProject[cwd]
            if (this.activeProject === cwd)
                this.activeProject = null
        })
        this.persist()
        const next = this.projects[0]?.cwd
        if (!this.activeProject && next)
            this.selectProject(next)
    }

    toggleReview() {
        this.reviewOpen = !this.reviewOpen
    }

    toggleSidebar() {
        this.sidebarOpen = !this.sidebarOpen
    }
}

export const appStore = new AppStore()
