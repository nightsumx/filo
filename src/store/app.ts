import type { ApprovalMode, CapabilityId, Presence } from '@shared/capabilities'
import type { LangPref } from '@shared/i18n'
import type { AppState, GlobalCompactionPatch, GlobalPrefs, OpenProject, PiEnvResult, ProjectActivity, ProjectTransfer, RepoEdits, ReviewView, SearchResult, SessionSummary, StateSave, ThemePref, ThreadTransfer, TranscriptLang, WindowReport } from '@shared/ipc'
import { APPROVAL_MODES, DEFAULT_CAPABILITIES, normalizeCapabilities } from '@shared/capabilities'
import { LANG_PREFS } from '@shared/i18n'
import { DEFAULT_THEME, GLOBAL_PREF_KEYS, REVIEW_VIEWS, THEME_PREFS, TRANSCRIPT_LANGS } from '@shared/ipc'
import type { PiEvent, PiModel } from '@shared/pi'
import type { ThreadHost } from './thread'
import type { ModelWindow } from '@/lib/compactAt'
import type { Conflict } from '@/lib/edits'
import { conflictsOf } from '@/lib/edits'
import { autoReserve, inferCompactAt, syncReserves } from '@/lib/compactAt'
import { applyLangPref, tr } from '@/lib/i18n'
import { waitingLabel } from '@/lib/threadActivity'
import { basename, uid } from '@/lib/utils'
import { makeAutoObservable, observable, reaction, runInAction } from 'mobx'
import { toast } from 'sonner'
import { Thread } from './thread'

const api = () => window.pi

/** Terminal pi's edits are only seen on disk; how often a visible window re-reads them. */
const EDITS_POLL_MS = 15_000

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

export type { ProjectActivity }

const NO_ACTIVITY: ProjectActivity = { open: 0, running: 0, unread: 0, waiting: 0 }

/** What a dragged tab carries (application/x-pi-tab), readable by every window of the app. */
export interface TabDrag {
    window: number
    key: string
    cwd: string
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

    /** Main's id for this window. */
    windowId = 0
    /** Projects this window shows: one, several after a merge, none in the welcome window. */
    windowProjects: string[] = []
    /** Projects every window shows, with their activity (this window's included). */
    openProjects: OpenProject[] = []

    threads = observable.map<string, Thread>()
    /** Tab order per project (thread keys). New threads use "new:<uuid>" until pi writes a file. */
    tabsByProject: Record<string, string[]> = {}
    activeTabByProject: Record<string, string> = {}
    activeProject: string | null = null
    layout: 'split' | 'single' = 'split'
    /** Appearance preference; the resolved scheme lives in lib/theme. */
    themePref: ThemePref = DEFAULT_THEME
    /** UI language preference; the resolved language lives in lib/i18n. */
    langPref: LangPref = 'system'
    /** Conversation wording; English matches pi's TUI. */
    transcriptLang: TranscriptLang = 'en'
    /** Changes panel layout, the same in every window. */
    reviewView: ReviewView = 'tree'
    /** Capability extensions every pi process loads, the same for all projects. */
    capabilities: CapabilityId[] = [...DEFAULT_CAPABILITIES]
    /** Mode new threads start in, the same for all projects; undefined until one is chosen. */
    /** Mode new threads start in; 全自动 until the user picks another. */
    approvalMode: ApprovalMode = 'auto'
    settingsOpen = false
    /** Page shown in Settings; kept while the app runs so reopening returns to it. */
    settingsPage: SettingsPageId = 'appearance'
    /** See ThreadHost.piSettingsEpoch. */
    piSettingsEpoch = 0
    /** Bumps on every compaction write, including ones no running thread needs a restart for. */
    compactionRevision = 0
    /** Tokens at which every model compacts (lib/compactAt); null: none, undefined: not decided yet. */
    compactAt: number | null | undefined = undefined
    private reconciling = false
    /** How many panes fit side by side; measured by the pane container. */
    paneCapacity = 1
    /** Bumped to move keyboard focus into a thread's composer. */
    composerFocus = { key: '', n: 0 }

    reviewOpen = false
    sidebarOpen = true
    searchOpen = false
    /** A message to scroll a thread's transcript to (search result); `n` bumps per request. */
    reveal: { key: string, entryId: string, n: number } | null = null
    /** Per project: the sessions that edited each uncommitted file (this app's threads and terminal pi alike). */
    edits = observable.map<string, RepoEdits['files']>()
    /** Session file → the window showing it as a tab (all windows, from main). */
    tabWindows: Record<string, number> = {}
    /** Terminal pi processes (pi-cc-tui's presence extension). */
    presence: Presence[] = []

    private agentThreads = new Map<string, Thread>()
    /** Pending edit-log refreshes per project (debounced; one request in flight at a time). */
    private editsQueued = new Map<string, ReturnType<typeof setTimeout>>()
    private editsLoading = new Set<string>()
    private eventQueue: [string, PiEvent][] = []
    private flushTimer: ReturnType<typeof setTimeout> | null = null
    /** JSON of each shared setting as main last has it, so saves carry only what this window changed. */
    private sentPrefs: Record<string, string> = {}
    private sentTabs = ''
    /** Saved state has been applied; nothing is persisted before that. */
    private ready = false

    constructor() {
        makeAutoObservable<this, 'agentThreads' | 'eventQueue' | 'flushTimer' | 'sentPrefs' | 'sentTabs' | 'ready' | 'reconciling' | 'editsQueued' | 'editsLoading'>(this, {
            agentThreads: false,
            editsQueued: false,
            editsLoading: false,
            reconciling: false,
            eventQueue: false,
            flushTimer: false,
            sentPrefs: false,
            sentTabs: false,
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
        return this.windowProjectList.find(p => p.cwd === this.activeProject) ?? null
    }

    /** This window's projects, in the window's order. */
    get windowProjectList(): Project[] {
        const all = this.projects
        return this.windowProjects.map(cwd => all.find(p => p.cwd === cwd) ?? { cwd, name: basename(cwd), sessions: [], latest: 0 })
    }

    /** Shown in some window (this one included). */
    isOpen(cwd: string): boolean {
        return this.windowProjects.includes(cwd) || this.openProjects.some(p => p.cwd === cwd)
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

    /**
     * Models pi offers and the focused thread's model, for Settings. Every pi process lists the
     * same models, so any thread that has loaded them will do.
     */
    get modelCatalog(): { models: PiModel[], current?: PiModel } {
        const current = this.active?.state?.model
        const models = this.active?.models.length ? this.active.models : [...this.threads.values()].find(t => t.models.length)?.models ?? []
        return { models, current }
    }

    /** Context windows of the models pi offers, plus the focused thread's model. */
    get modelWindows(): ModelWindow[] {
        const { models, current } = this.modelCatalog
        const windows = new Map(models.map(m => [`${m.provider}/${m.id}`, m.contextWindow]))
        if (current?.contextWindow)
            windows.set(`${current.provider}/${current.id}`, current.contextWindow)
        return [...windows].map(([key, contextWindow]) => ({ key, contextWindow }))
    }

    /** Files a session (thread) changed that another session changed too since the last commit. */
    conflictsOf(cwd: string, session: string | undefined): Conflict[] {
        return conflictsOf(this.edits.get(cwd), session)
    }

    isVisible(thread: Thread): boolean {
        return this.visibleTabs.includes(thread)
    }

    /** Live counts for this window's projects; other windows report theirs through main. */
    activity(cwd: string): ProjectActivity {
        if (!this.windowProjects.includes(cwd))
            return this.openProjects.find(p => p.cwd === cwd)?.activity ?? NO_ACTIVITY
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
                    this.notify(thread, tr('出错', 'Error'), thread.activity.text)
            }
        })
        // Every window hears the click; the one holding the thread comes forward.
        api().onNotificationClick((key) => {
            if (!this.threads.has(key))
                return
            void api().focusWindow()
            runInAction(() => this.focus(key, true))
        })
        api().onPrefsChanged(prefs => runInAction(() => this.applyPrefs(prefs, true)))
        api().onPiSettingsChanged(patch => runInAction(() => this.piSettingsChanged(patch)))
        api().onWindowProjects(projects => runInAction(() => this.setWindowProjects(projects)))
        api().onOpenProjects(projects => runInAction(() => (this.openProjects = projects)))
        api().onSelectProject(cwd => runInAction(() => this.windowProjects.includes(cwd) && this.showProject(cwd)))
        api().onRevealSession((session, entryId) => void this.revealHere(session, entryId))
        api().onOpenTabs(tabs => runInAction(() => (this.tabWindows = tabs)))
        api().onExportThreads(this.exportThreads)
        api().onImportThreads(this.importThreads)
        api().onPresence(list => this.setPresence(list))
        void api().getPresence().then(list => this.setPresence(list))
        api().onExportProjects(this.exportProjects)
        api().onImportProjects(this.importProjects)
        // A thread starts waiting for the user: notify once. The Dock badge counts every window's.
        let waiting = new Set<string>()
        reaction(
            () => [...this.threads.values()].filter(t => t.waitingForUser).map(t => t.key),
            (keys) => {
                for (const key of keys) {
                    const thread = this.threads.get(key)
                    if (thread && !waiting.has(key))
                        this.notify(thread, waitingLabel(thread.waitingKind), thread.waitingFor || tr('需要你的确认', 'Needs your approval'), true)
                }
                waiting = new Set(keys)
            },
        )
        // Gives models pi lists for the first time (or after an update) the global compaction point.
        reaction(() => [this.modelWindows.length, this.compactAt], () => void this.reconcileCompaction())
        window.addEventListener('focus', () => {
            void this.refreshSessions()
            this.windowProjects.forEach(cwd => this.refreshEdits(cwd))
        })
        // Edits by this window's threads show up as they land; terminal pi's on the poll.
        reaction(
            () => this.windowProjects.map(cwd => [cwd, this.tabsOf(cwd).reduce((n, t) => n + t.changeTick, 0)] as const),
            (ticks, previous) => {
                const before = new Map(previous ?? [])
                for (const [cwd, tick] of ticks) {
                    if (before.get(cwd) !== tick)
                        this.refreshEdits(cwd)
                }
            },
            { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b), fireImmediately: true },
        )
        setInterval(() => {
            if (document.visibilityState === 'visible')
                this.windowProjects.forEach(cwd => this.refreshEdits(cwd))
        }, EDITS_POLL_MS)
        setInterval(this.stopIdleAgents, IDLE_SWEEP_MS)

        const [env, state, win] = await Promise.all([api().resolveEnv(), api().loadState(), api().windowInit()])
        await this.refreshSessions()
        runInAction(() => {
            this.env = env
            this.windowId = win.id
            this.windowProjects = win.projects
            this.restoreState(state)
            this.activeProject = win.active && win.projects.includes(win.active) ? win.active : win.projects[0] ?? null
            this.ready = true
            this.projectOrder = this.projects.map(p => p.cwd)
        })
        await this.refreshMissing()
        if (env.ok && this.activeProject)
            this.showProject(this.activeProject)
        // Main tells other windows (project lists, Dock badge, close prompt) what this one is doing.
        reaction(() => this.windowReport, report => void api().reportWindow(report), { fireImmediately: true, equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
        reaction(() => this.project?.name, (name) => {
            document.title = name ?? 'Pi'
        }, { fireImmediately: true })
        await api().windowReady()
    }

    get windowReport(): WindowReport {
        return { active: this.activeProject, activity: Object.fromEntries(this.windowProjects.map(cwd => [cwd, this.activity(cwd)])) }
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

    /** By session file: what the terminal pi on it is doing. */
    get terminalSessions(): Map<string, Presence> {
        return new Map(this.presence.filter(p => p.session).map(p => [p.session!, p]))
    }

    /**
     * A terminal pi changed state: a run that ended or began wrote its session file (titles, times)
     * and maybe files in the repo, so both lists refresh.
     */
    setPresence(list: Presence[]) {
        const before = new Map(this.presence.map(p => [p.pid, p]))
        runInAction(() => (this.presence = list))
        const changed = list.filter(p => before.get(p.pid)?.state !== p.state || before.get(p.pid)?.session !== p.session)
        const gone = [...before.values()].filter(p => !list.some(q => q.pid === p.pid))
        if (!changed.length && !gone.length)
            return
        void this.refreshSessions()
        for (const cwd of new Set([...changed, ...gone].map(p => p.cwd))) {
            if (this.windowProjects.includes(cwd))
                this.refreshEdits(cwd)
        }
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
            toast.error(`${tr('读取会话失败：', 'Could not read sessions: ')}${error.message}`)
        }
        if (this.ready)
            await this.refreshMissing()
    }

    /** Re-reads the edit log for a project soon; bursts of tool calls collapse into one read. */
    refreshEdits(cwd: string) {
        clearTimeout(this.editsQueued.get(cwd))
        this.editsQueued.set(cwd, setTimeout(async () => {
            this.editsQueued.delete(cwd)
            if (this.editsLoading.has(cwd)) {
                this.refreshEdits(cwd)
                return
            }
            this.editsLoading.add(cwd)
            try {
                const { files } = await api().repoEdits(cwd)
                runInAction(() => {
                    if (JSON.stringify(files) !== JSON.stringify(this.edits.get(cwd)))
                        this.edits.set(cwd, files)
                })
            }
            catch {
                // Not a repo, or the folder is gone: nothing to show.
            }
            finally {
                this.editsLoading.delete(cwd)
            }
        }, 300))
    }

    private async refreshMissing() {
        const missing = await api().missingFolders(this.projects.map(p => p.cwd)).catch(() => [])
        runInAction(() => (this.missingProjects = missing))
    }

    // ---------------------------------------------------------------- persistence

    private restoreState(state: AppState) {
        this.applyPrefs(state, false)
        this.capabilities = restoreCapabilities(state)
        this.approvalMode = restoreApprovalMode(state)
        // Thread objects are created lazily per project (restoreTabs); keep the saved order for now.
        this.tabsByProject = { ...state.tabs }
        this.activeTabByProject = { ...state.activeTabs }
    }

    /**
     * Shared settings, from state.json at startup or from another window. `live`: another window
     * changed them while this one runs, so side effects (language, process restarts) follow.
     */
    private applyPrefs(prefs: Partial<GlobalPrefs>, live: boolean) {
        const has = (key: keyof GlobalPrefs) => !live || Object.hasOwn(prefs, key)
        if (has('projects'))
            this.projectOrder = prefs.projects ?? []
        if (has('hiddenProjects'))
            this.hiddenProjects = prefs.hiddenProjects ?? []
        if (has('layout'))
            this.layout = prefs.layout === 'single' ? 'single' : 'split'
        if (has('theme'))
            this.themePref = THEME_PREFS.includes(prefs.theme as ThemePref) ? prefs.theme! : DEFAULT_THEME
        if (has('lang')) {
            this.langPref = LANG_PREFS.includes(prefs.lang as LangPref) ? prefs.lang! : 'system'
            applyLangPref(this.langPref)
        }
        if (has('transcriptLang'))
            this.transcriptLang = TRANSCRIPT_LANGS.includes(prefs.transcriptLang as TranscriptLang) ? prefs.transcriptLang! : 'en'
        if (has('reviewView'))
            this.reviewView = REVIEW_VIEWS.includes(prefs.reviewView as ReviewView) ? prefs.reviewView! : 'tree'
        if (has('compactAt'))
            this.compactAt = prefs.compactAt === null || (typeof prefs.compactAt === 'number' && prefs.compactAt > 0) ? prefs.compactAt : undefined
        if (live && Object.hasOwn(prefs, 'capabilities') && Array.isArray(prefs.capabilities)) {
            this.capabilities = normalizeCapabilities(prefs.capabilities)
            for (const thread of this.threads.values())
                void thread.applyConfig()
        }
        if (live && APPROVAL_MODES.includes(prefs.approvalMode as ApprovalMode))
            this.approvalMode = prefs.approvalMode!
        // Main has these values now; only later changes need sending.
        for (const key of GLOBAL_PREF_KEYS) {
            if (!live || Object.hasOwn(prefs, key))
                this.sentPrefs[key] = JSON.stringify(prefs[key]) ?? ''
        }
    }

    /** Another window wrote pi's settings.json; processes it affects restart once idle. */
    private piSettingsChanged(patch: GlobalCompactionPatch) {
        this.compactionRevision++
        const models = Object.keys(patch?.modelReserves ?? {})
        const global = Object.keys(patch ?? {}).some(k => k !== 'modelReserves')
        const affected = global || [...this.threads.values()].some(t => t.state?.model && models.includes(`${t.state.model.provider}/${t.state.model.id}`))
        if (!affected)
            return
        this.piSettingsEpoch++
        for (const thread of this.threads.values())
            void thread.applyConfig()
    }

    private persist() {
        if (!this.ready)
            return
        // Only tabs backed by a session file survive a restart.
        const keep = (key: string) => {
            const thread = this.threads.get(key)
            return thread ? thread.persisted && thread.key === thread.sessionPath : !key.startsWith('new:')
        }
        // Tabs of this window's projects only; other windows save their own.
        const tabs: Record<string, string[]> = {}
        const activeTabs: Record<string, string> = {}
        for (const cwd of this.windowProjects) {
            const kept = (this.tabsByProject[cwd] ?? []).filter(keep)
            if (kept.length)
                tabs[cwd] = kept
            const active = this.activeTabByProject[cwd]
            if (active && kept.includes(active))
                activeTabs[cwd] = active
        }
        const current: GlobalPrefs = {
            projects: this.projectOrder,
            hiddenProjects: this.hiddenProjects,
            layout: this.layout,
            theme: this.themePref,
            lang: this.langPref,
            transcriptLang: this.transcriptLang,
            reviewView: this.reviewView,
            capabilities: this.capabilities,
            approvalMode: this.approvalMode,
            compactAt: this.compactAt,
        }
        const prefs: Partial<GlobalPrefs> = {}
        for (const key of GLOBAL_PREF_KEYS) {
            const json = JSON.stringify(current[key]) ?? ''
            if (json !== this.sentPrefs[key]) {
                this.sentPrefs[key] = json
                Object.assign(prefs, { [key]: current[key] })
            }
        }
        const tabsJson = JSON.stringify([tabs, activeTabs])
        if (!Object.keys(prefs).length && tabsJson === this.sentTabs)
            return
        this.sentTabs = tabsJson
        const save: StateSave = { prefs, tabs, activeTabs }
        void api().saveState(JSON.parse(JSON.stringify(save)))
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
            if (!session || this.elsewhere(key))
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
        void thread.load().catch(error => toast.error(`${tr('打开线程失败：', 'Could not open thread: ')}${error.message}`))
        return thread
    }

    // ---------------------------------------------------------------- ThreadHost

    /** A plain copy: it is sent over IPC, which cannot clone MobX arrays. */
    get enabledCapabilities(): CapabilityId[] {
        return [...this.capabilities]
    }

    setApprovalMode(mode: ApprovalMode) {
        this.approvalMode = mode
        this.persist()
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
            this.notify(thread, tr('出错', 'Error'), activity.text)
        else
            this.notify(thread, tr('已完成', 'Done'), lastAnswer(thread))
        if (!this.isVisible(thread)) {
            thread.unread = true
            toast.success(tr(`「${thread.title}」已完成`, `“${thread.title}” is done`), {
                action: { label: tr('查看', 'View'), onClick: () => this.focus(thread.key, true) },
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

    /**
     * Go to a project: shown here if this window has it (or is the empty welcome window), else its
     * own window comes forward, or a new one opens for it.
     */
    selectProject(cwd: string) {
        if (this.windowProjects.includes(cwd)) {
            this.showProject(cwd)
            return
        }
        void api().openProject(cwd).then((where) => {
            if (where === 'here')
                runInAction(() => this.addWindowProject(cwd))
        }).catch(error => toast.error(error.message))
    }

    private addWindowProject(cwd: string) {
        if (!this.windowProjects.includes(cwd))
            this.windowProjects = [...this.windowProjects, cwd]
        this.showProject(cwd)
    }

    /** Main changed this window's project list. */
    private setWindowProjects(projects: string[]) {
        this.windowProjects = projects
        if (!this.activeProject || !projects.includes(this.activeProject)) {
            this.activeProject = null
            if (projects[0])
                this.showProject(projects[0])
        }
    }

    /** Switch this window to one of its projects. */
    showProject(cwd: string) {
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
        // A session is a tab in one window: the one that has it comes forward.
        if (!this.threads.has(session.path) && this.elsewhere(session.path)) {
            void api().revealSession(session.cwd, session.path).catch(error => toast.error(error.message))
            return
        }
        this.activeProject = session.cwd
        this.restoreTabs(session.cwd)
        const thread = this.threads.get(session.path) ?? this.createSessionThread(session)
        this.insertTab(thread)
        this.focus(thread.key, true)
    }

    /** New tab in a project; reuses an untouched new tab instead of stacking empty ones. */
    newThread(cwd: string) {
        if (this.missingProjects.includes(cwd)) {
            toast.error(tr('项目目录不存在', 'Project folder not found'), { description: tr(`${cwd} 已被删除或移动。可以在侧边栏的项目菜单里“从列表移除”。`, `${cwd} was deleted or moved. You can remove it from the list in the sidebar's project menu.`) })
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

    /**
     * Edit an earlier prompt. In place: this tab moves to a fork of its session. Otherwise a new tab
     * forks it (its own pi process resumes the session, then forks), and this tab carries on as is.
     */
    async forkThread(thread: Thread, entryId: string, inPlace: boolean) {
        if (inPlace) {
            if (await thread.fork(entryId))
                this.focus(thread.key, true)
            return
        }
        if (!thread.sessionPath)
            return
        const fork = new Thread(this, { key: `new:${uid()}`, cwd: thread.cwd, sessionPath: thread.sessionPath, name: thread.name, firstPrompt: thread.firstPrompt })
        // Shows the transcript it forks from until pi has made the fork.
        fork.items = thread.items.slice()
        fork.loaded = true
        this.threads.set(fork.key, fork)
        this.insertTab(fork)
        this.focus(fork.key)
        if (await fork.fork(entryId)) {
            this.focus(fork.key, true)
            this.persist()
            void this.refreshSessions()
        }
        else {
            await this.closeTab(fork.key)
        }
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

    setLangPref(pref: LangPref) {
        this.langPref = pref
        applyLangPref(pref)
        void api().setLang(pref)
        this.persist()
    }

    setReviewView(view: ReviewView) {
        this.reviewView = view
        this.persist()
    }

    setTranscriptLang(lang: TranscriptLang) {
        this.transcriptLang = lang
        this.persist()
    }

    /** Live threads restart with the new set once idle, resuming their session. */
    setCapabilities(ids: CapabilityId[]) {
        this.capabilities = normalizeCapabilities(ids)
        this.persist()
        for (const thread of this.threads.values())
            void thread.applyConfig()
    }

    /**
     * Writes compaction.* into pi's global settings.json. Every pi process reads it only at startup,
     * so live threads restart once idle (resuming their session), like a capability change.
     */
    async setGlobalCompaction(patch: GlobalCompactionPatch) {
        await api().setGlobalCompaction(patch)
        runInAction(() => {
            this.compactionRevision++
            this.piSettingsEpoch++
        })
        for (const thread of this.threads.values())
            void thread.applyConfig()
    }

    /** Moves every model that follows the global point to `at` (null: back to pi's reserve). */
    async setCompactAt(at: number | null) {
        const from = this.compactAt ?? null
        const info = await api().globalCompaction()
        const patch = syncReserves(this.modelWindows, info.modelReserves, from, at)
        runInAction(() => {
            this.compactAt = at
            this.persist()
        })
        await this.writeReserves(patch)
    }

    /** A per-model exception; null puts the model back on the global point. */
    async setModelCompactAt(key: string, contextWindow: number, at: number | null) {
        const global = this.compactAt ?? null
        const reserve = at !== null ? contextWindow - at : global !== null ? autoReserve(contextWindow, global) : null
        await this.writeReserves({ [key]: reserve })
    }

    private async reconcileCompaction() {
        // Wait for pi's model list; the focused thread's model alone shows up first and is too few
        // to tell a global point from one exception.
        const models = this.modelWindows
        if (!this.modelCatalog.models.length || this.reconciling || !this.ready)
            return
        this.reconciling = true
        try {
            const info = await api().globalCompaction()
            if (this.compactAt === undefined) {
                runInAction(() => {
                    this.compactAt = inferCompactAt(models, info.modelReserves)
                    this.persist()
                })
            }
            const at = this.compactAt ?? null
            if (at !== null)
                await this.writeReserves(syncReserves(models, info.modelReserves, at, at))
        }
        catch {
            // Settings page shows the error when the user edits; nothing to do in the background.
        }
        finally {
            this.reconciling = false
        }
    }

    /** Only threads whose model changed need a restart to pick the new reserve up. */
    private async writeReserves(patch: Record<string, number | null>) {
        const keys = Object.keys(patch)
        if (!keys.length)
            return
        await api().setGlobalCompaction({ modelReserves: patch })
        const affected = [...this.threads.values()].some(t => t.state?.model && keys.includes(`${t.state.model.provider}/${t.state.model.id}`))
        runInAction(() => {
            this.compactionRevision++
            if (affected)
                this.piSettingsEpoch++
        })
        if (affected) {
            for (const thread of this.threads.values())
                void thread.applyConfig()
        }
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
            toast.error(`${tr('删除失败：', 'Delete failed: ')}${error.message}`)
        }
        await this.refreshSessions()
    }

    // ---------------------------------------------------------------- projects

    /** Picks a folder and puts it on top of the project list. */
    private async pickProject(): Promise<string | null> {
        const folder = await api().pickFolder()
        if (!folder)
            return null
        runInAction(() => {
            this.projectOrder = [folder, ...this.projectOrder.filter(p => p !== folder)]
            this.hiddenProjects = this.hiddenProjects.filter(p => p !== folder)
        })
        this.persist()
        return folder
    }

    /** Open folder…: a window of its own (this one if it is the welcome window). */
    async addProject() {
        const folder = await this.pickProject()
        if (folder)
            this.selectProject(folder)
    }

    /** The project tree's "add": the folder joins this window. */
    async addProjectHere() {
        const folder = await this.pickProject()
        if (folder)
            await this.attachProject(folder)
    }

    /** Show a project in this window as well, taking it from the window that has it. */
    async attachProject(cwd: string) {
        try {
            await api().attachProject(cwd)
            runInAction(() => this.addWindowProject(cwd))
        }
        catch (error: any) {
            toast.error(`${tr('无法移入此窗口：', 'Could not move the project here: ')}${error.message}`)
        }
    }

    /** One of a merged window's projects into a window of its own. */
    async detachProject(cwd: string) {
        try {
            await api().detachProject(cwd)
        }
        catch (error: any) {
            toast.error(`${tr('无法移到新窗口：', 'Could not move the project to a new window: ')}${error.message}`)
        }
    }

    async mergeAllWindows() {
        try {
            await api().mergeAllWindows()
        }
        catch (error: any) {
            toast.error(`${tr('合并窗口失败：', 'Could not merge windows: ')}${error.message}`)
        }
    }

    /**
     * Close a project in this window. Its tabs are kept for the next time it opens, as WebStorm
     * reopens a project's editors; its pi processes stop. The window closes if nothing is left in it.
     */
    async closeProject(cwd: string) {
        if (!this.windowProjects.includes(cwd))
            return
        this.persist()
        const threads = this.tabsOf(cwd)
        runInAction(() => {
            for (const thread of threads)
                this.threads.delete(thread.key)
            this.windowProjects = this.windowProjects.filter(p => p !== cwd)
            if (this.activeProject === cwd) {
                this.activeProject = null
                if (this.windowProjects[0])
                    this.showProject(this.windowProjects[0])
            }
        })
        await Promise.all(threads.map(async (thread) => {
            if (thread.running)
                await thread.abort()
            await thread.stopAgent()
        }))
        await api().closeProject(cwd)
    }

    /** Off the project list (until a session or the user brings it back); closed first if open here. */
    async removeProject(cwd: string) {
        await this.closeProject(cwd)
        runInAction(() => {
            this.projectOrder = this.projectOrder.filter(p => p !== cwd)
            if (!this.hiddenProjects.includes(cwd))
                this.hiddenProjects.push(cwd)
            delete this.tabsByProject[cwd]
            delete this.activeTabByProject[cwd]
        })
        this.persist()
    }

    // ---------------------------------------------------------------- moving projects between windows

    /**
     * Hands projects to another window. Main holds back their processes' events from here on; apply
     * the ones already received, let in-flight starts and end-of-run reloads finish, then snapshot
     * and drop the threads without stopping their processes.
     */
    async exportProjects(cwds: string[]): Promise<ProjectTransfer[]> {
        this.flushEvents()
        await Promise.all(cwds.flatMap(cwd => this.tabsOf(cwd)).map(t => t.quiesce()))
        this.flushEvents()
        const projects = cwds.map(cwd => ({
            cwd,
            tabs: [...(this.tabsByProject[cwd] ?? [])],
            activeTab: this.activeTabByProject[cwd],
            threads: this.tabsOf(cwd).map(t => t.snapshot()),
        }))
        runInAction(() => {
            for (const cwd of cwds) {
                for (const thread of this.tabsOf(cwd)) {
                    this.threads.delete(thread.key)
                    if (thread.agentId)
                        this.agentThreads.delete(thread.agentId)
                }
                delete this.tabsByProject[cwd]
                delete this.activeTabByProject[cwd]
            }
            this.windowProjects = this.windowProjects.filter(p => !cwds.includes(p))
            if (this.activeProject && cwds.includes(this.activeProject)) {
                this.activeProject = null
                if (this.windowProjects[0])
                    this.showProject(this.windowProjects[0])
            }
        })
        return projects
    }

    /** Takes projects from another window, live threads and their processes included. */
    async importProjects(projects: ProjectTransfer[]) {
        runInAction(() => {
            for (const project of projects) {
                for (const snapshot of project.threads) {
                    const thread = Thread.restore(this, snapshot)
                    this.threads.set(thread.key, thread)
                    if (thread.agentId)
                        this.agentThreads.set(thread.agentId, thread)
                }
                // Shown here already (it was in both windows): its tabs from there go after these.
                if (project.merge) {
                    const here = this.tabsByProject[project.cwd] ?? []
                    this.tabsByProject[project.cwd] = [...here, ...project.tabs.filter(k => !here.includes(k))]
                    continue
                }
                // Main listed the project here just before this, and showing it opened a blank tab.
                for (const key of this.tabsByProject[project.cwd] ?? []) {
                    const blank = this.threads.get(key)
                    if (blank && !project.tabs.includes(key) && blank.isEmpty && !blank.persisted) {
                        this.threads.delete(key)
                        void blank.stopAgent()
                    }
                }
                this.tabsByProject[project.cwd] = project.tabs
                if (project.activeTab)
                    this.activeTabByProject[project.cwd] = project.activeTab
                else
                    delete this.activeTabByProject[project.cwd]
                if (!this.windowProjects.includes(project.cwd))
                    this.windowProjects = [...this.windowProjects, project.cwd]
            }
            if (!this.activeProject && projects[0])
                this.showProject(projects[0].cwd)
        })
        this.persist()
    }

    // ---------------------------------------------------------------- moving tabs between windows

    /** Another window shows this session as a tab. */
    elsewhere(session: string): boolean {
        const id = this.tabWindows[session]
        return id != null && id !== this.windowId
    }

    /** Other windows, labelled by their projects (for "move tab to"). */
    get otherWindows(): { id: number, label: string }[] {
        const byWindow = new Map<number, string[]>()
        for (const p of this.openProjects) {
            if (p.windowId !== this.windowId)
                byWindow.set(p.windowId, [...byWindow.get(p.windowId) ?? [], basename(p.cwd)])
        }
        return [...byWindow].map(([id, names]) => ({ id, label: names.join(', ') }))
    }

    /** Sends a tab to another window, or (`to` null) into a new one, opened at `at` if given. */
    async moveTabToWindow(key: string, to: number | null, options: { index?: number, at?: { x: number, y: number } } = {}) {
        const thread = this.threads.get(key)
        if (!thread)
            return
        try {
            await api().moveTab({ key, cwd: thread.cwd, to, ...options })
        }
        catch (error: any) {
            toast.error(`${tr('移动标签失败：', 'Could not move the tab: ')}${error.message}`)
        }
    }

    /** A tab dragged in from another window, dropped at `index` among this project's tabs. */
    async pullTab(drag: TabDrag, index?: number) {
        if (drag.window === this.windowId)
            return
        try {
            await api().moveTab({ key: drag.key, cwd: drag.cwd, from: drag.window, to: this.windowId, index })
        }
        catch (error: any) {
            toast.error(`${tr('移动标签失败：', 'Could not move the tab: ')}${error.message}`)
        }
    }

    /** Main asks for tabs that another window takes over (see exportProjects for the hand-over rules). */
    async exportThreads(keys: string[]): Promise<ThreadTransfer> {
        const threads = keys.map(k => this.threads.get(k)).filter((t): t is Thread => !!t)
        const cwd = threads[0]?.cwd
        if (!cwd || threads.some(t => t.cwd !== cwd))
            throw new Error('no such tab')
        this.flushEvents()
        await Promise.all(threads.map(t => t.quiesce()))
        this.flushEvents()
        const transfer: ThreadTransfer = {
            cwd,
            threads: threads.map(t => t.snapshot()),
            agents: threads.map(t => t.agentId).filter((id): id is string => !!id),
            remaining: false,
        }
        runInAction(() => {
            for (const thread of threads) {
                this.threads.delete(thread.key)
                if (thread.agentId)
                    this.agentThreads.delete(thread.agentId)
            }
            const moved = new Set(threads.map(t => t.key))
            const tabs = (this.tabsByProject[cwd] ?? []).filter(k => !moved.has(k))
            const index = (this.tabsByProject[cwd] ?? []).indexOf(this.activeTabByProject[cwd] ?? '')
            this.tabsByProject[cwd] = tabs
            transfer.remaining = tabs.some(k => this.threads.has(k))
            if (moved.has(this.activeTabByProject[cwd] ?? '') && tabs.length)
                this.activeTabByProject[cwd] = tabs[Math.min(Math.max(index, 0), tabs.length - 1)]
            // Its last tab gone, the project leaves this window too (main drops it there as well).
            if (!transfer.remaining) {
                delete this.tabsByProject[cwd]
                delete this.activeTabByProject[cwd]
                this.windowProjects = this.windowProjects.filter(p => p !== cwd)
                if (this.activeProject === cwd) {
                    this.activeProject = null
                    if (this.windowProjects[0])
                        this.showProject(this.windowProjects[0])
                }
            }
        })
        this.persist()
        return transfer
    }

    /** Takes tabs from another window, at `index` among the project's tabs here. */
    async importThreads({ transfer, index }: { transfer: ThreadTransfer, index?: number }) {
        runInAction(() => {
            const keys: string[] = []
            for (const snapshot of transfer.threads) {
                const thread = Thread.restore(this, snapshot)
                this.threads.set(thread.key, thread)
                if (thread.agentId)
                    this.agentThreads.set(thread.agentId, thread)
                keys.push(thread.key)
            }
            const { cwd } = transfer
            // Not shown here yet: whatever tab list this window remembers for it belongs to others.
            const here = this.windowProjects.includes(cwd) ? (this.tabsByProject[cwd] ?? []).filter(k => !keys.includes(k)) : []
            const at = index == null ? here.length : Math.max(0, Math.min(index, here.length))
            this.tabsByProject[cwd] = [...here.slice(0, at), ...keys, ...here.slice(at)]
            if (!this.windowProjects.includes(cwd))
                this.windowProjects = [...this.windowProjects, cwd]
            if (keys[0])
                this.focus(keys[0], true)
        })
        this.persist()
    }

    setSearchOpen(open: boolean) {
        this.searchOpen = open
    }

    /** A search result: its thread opens (in the window of its project) at the matching message. */
    openSearchResult(result: SearchResult, entryId?: string) {
        if (this.windowProjects.includes(result.cwd)) {
            void this.revealHere(result.session, entryId)
            return
        }
        void api().revealSession(result.cwd, result.session, entryId).catch(error => toast.error(error.message))
    }

    /** Opens a session of this window's projects as a tab, scrolled to `entryId` if given. */
    async revealHere(session: string, entryId?: string) {
        let summary = this.sessions.find(s => s.path === session)
        if (!summary) {
            await this.refreshSessions()
            summary = this.sessions.find(s => s.path === session)
        }
        if (!summary || !this.windowProjects.includes(summary.cwd))
            return
        runInAction(() => {
            this.openSession(summary)
            if (entryId)
                this.reveal = { key: summary.path, entryId, n: (this.reveal?.n ?? 0) + 1 }
        })
    }

    toggleReview() {
        this.reviewOpen = !this.reviewOpen
    }

    toggleSidebar() {
        this.sidebarOpen = !this.sidebarOpen
    }
}

export const appStore = new AppStore()

/**
 * Older state kept a set per project. Keep the active project's set (the one the user last saw in
 * Settings), else the most recently saved one.
 */
function restoreCapabilities(state: AppState): CapabilityId[] {
    const saved = state.capabilities
    if (Array.isArray(saved))
        return normalizeCapabilities(saved)
    if (!saved || typeof saved !== 'object')
        return [...DEFAULT_CAPABILITIES]
    const ids = (state.activeProject && saved[state.activeProject]) || Object.values(saved).at(-1)
    return ids ? normalizeCapabilities(ids) : [...DEFAULT_CAPABILITIES]
}

/** Older state kept the mode per project; same choice as restoreCapabilities. */
function restoreApprovalMode(state: AppState): ApprovalMode {
    const valid = (mode: unknown): mode is ApprovalMode => APPROVAL_MODES.includes(mode as ApprovalMode)
    if (valid(state.approvalMode))
        return state.approvalMode
    const old = state.approvalModes ?? {}
    const mode = (state.activeProject && old[state.activeProject]) || Object.values(old).at(-1)
    return valid(mode) ? mode : 'auto'
}
