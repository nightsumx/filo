import type { ApprovalMode, CapabilityId } from './capabilities'
import type { LangPref } from './i18n'
import type { AgentMessage, PiEvent, RpcResponse } from './pi'

export interface PiEnv {
    nodePath: string
    piPath: string
    version: string
}

export type PiEnvResult = { ok: true, env: PiEnv } | { ok: false, error: string }

export interface SessionSummary {
    path: string
    id: string
    cwd: string
    /** Display name from session_info, if set. */
    name?: string
    /** First user prompt, used when no name is set. */
    firstPrompt?: string
    createdAt: number
    updatedAt: number
}

export interface SessionItem {
    /** Stable entry id from the session file. */
    entryId: string
    message: AgentMessage
    /** Entry write time (ms): when pi finished the message. */
    endedAt?: number
}

export interface SessionSnapshot {
    path: string
    id: string
    cwd: string
    name?: string
    items: SessionItem[]
}

export interface GitFileChange {
    path: string
    /** Porcelain XY status, e.g. " M", "??", "A ", " D". */
    status: string
    additions: number
    deletions: number
    binary: boolean
    /** Renames and copies: the path in HEAD. */
    origPath?: string
}

export type GitStatus =
    | { isRepo: false }
    | { isRepo: true, root: string, branch: string, files: GitFileChange[] }

/** A pi session that edited a file (edit / write tool calls; bash changes cannot be attributed). */
export interface FileEditor {
    /** Session file path; a GUI thread's key once saved. */
    session: string
    title: string
    /** Last edit, ms. */
    at: number
}

/**
 * Which sessions edited each uncommitted file since the last commit, keyed by path relative to the
 * repository root. Two sessions on one file is a collision.
 */
export interface RepoEdits {
    files: Record<string, FileEditor[]>
}

export interface GitFileDiff { oldText: string, newText: string }

/** Settings shared by every window; a change in one window reaches the others. */
export interface GlobalPrefs {
    /** Project list order (cwds), including folders added manually. */
    projects: string[]
    /** Session-derived projects the user removed from the list. */
    hiddenProjects: string[]
    /** split: open tabs tile across the window; single: one pane. */
    layout: 'split' | 'single'
    /** Appearance; `system` follows macOS. */
    theme?: ThemePref
    /** App UI language; absent or `system` follows the OS preferred languages. */
    lang?: LangPref
    /** Wording inside the conversation (tool rows, diffs, status lines). */
    transcriptLang?: TranscriptLang
    /** Changes panel: files in a folder tree (default) or a flat list. */
    reviewView?: ReviewView
    /** Capabilities every pi process loads; absent means DEFAULT_CAPABILITIES. Older state has a map per project cwd. */
    capabilities?: CapabilityId[] | Record<string, CapabilityId[]>
    /** Approval mode new threads start in: the last one chosen in any thread. */
    approvalMode?: ApprovalMode
    /** Tokens at which every model compacts (see lib/compactAt); null: none, absent: not decided yet. */
    compactAt?: number | null
}

export const GLOBAL_PREF_KEYS = ['projects', 'hiddenProjects', 'layout', 'theme', 'lang', 'transcriptLang', 'reviewView', 'capabilities', 'approvalMode', 'compactAt'] as const satisfies readonly (keyof GlobalPrefs)[]

/** A project window as saved for the next launch. */
export interface SavedWindow {
    /** One project, or several after the user merged windows. */
    projects: string[]
    active?: string
}

export interface WindowBounds { x: number, y: number, width: number, height: number }

export interface AppState extends GlobalPrefs {
    /** Open tabs per project, as session file paths in tab order. */
    tabs: Record<string, string[]>
    /** Focused tab per project (session file path). */
    activeTabs: Record<string, string>
    /** Project windows open at quit, reopened on launch. Absent in older state (one window, activeProject). */
    windows?: SavedWindow[]
    /** Last window frame per project (a merged window is keyed by its first project). */
    windowBounds?: Record<string, WindowBounds>
    /** Older state: the project the single window showed. */
    activeProject?: string
    /** Older state: the same, per project cwd. Read once, then dropped. */
    approvalModes?: Record<string, ApprovalMode>
}

/** What a window writes: changed shared settings, plus the tabs of the projects it shows. */
export interface StateSave {
    prefs: Partial<GlobalPrefs>
    tabs: Record<string, string[]>
    activeTabs: Record<string, string>
}

export interface ProjectActivity {
    open: number
    running: number
    unread: number
    waiting: number
}

/** The projects a window shows; empty for the welcome window. */
export interface WindowInit {
    id: number
    projects: string[]
    active?: string
}

/** A window's live summary, for other windows' project lists, the Dock badge and close prompts. */
export interface WindowReport {
    active: string | null
    activity: Record<string, ProjectActivity>
}

/** A project shown in some window. */
export interface OpenProject {
    cwd: string
    windowId: number
    activity: ProjectActivity
}

/** A project handed from one window to another, live threads included (see Thread.snapshot). */
export interface ProjectTransfer {
    cwd: string
    tabs: string[]
    activeTab?: string
    threads: Record<string, unknown>[]
}

/** Global compaction settings as the Settings page shows them (pi defaults filled in). */
export interface GlobalCompaction {
    enabled: boolean
    reserveTokens: number
    keepRecentTokens: number
    /** compaction.modelOverrides[provider/id].reserveTokens: models that compact at their own point. */
    modelReserves: Record<string, number>
    /** The given project's .pi/settings.json sets compaction fields of its own. */
    projectOverride: boolean
}

export type GlobalCompactionPatch = Partial<Pick<GlobalCompaction, 'enabled' | 'reserveTokens' | 'keepRecentTokens'>> & {
    /** Per-model reserves to set; null removes one so the model follows reserveTokens again. */
    modelReserves?: Record<string, number | null>
}

/** pi's effective auto-compaction settings for a project + model. */
export interface CompactionInfo {
    enabled: boolean
    reserveTokens: number
}

export type ReviewView = 'tree' | 'list'
export const REVIEW_VIEWS: readonly ReviewView[] = ['tree', 'list']

export type TranscriptLang = 'en' | 'zh'
export const TRANSCRIPT_LANGS: readonly TranscriptLang[] = ['en', 'zh']

export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']
/** Used until the user picks an appearance in Settings. */
export const DEFAULT_THEME: ThemePref = 'dark'

export interface AgentStartOptions {
    cwd: string
    sessionPath?: string
    /** Capability extensions to load with `-e`. */
    capabilities?: CapabilityId[]
    /** Approval mode for a session that has not chosen one yet. */
    approvalMode?: ApprovalMode
}

export interface AgentExitInfo {
    code: number | null
    signal: string | null
    stderr: string
}

/** The API preload exposes on window.pi. */
export interface PiBridge {
    resolveEnv: () => Promise<PiEnvResult>
    listSessions: () => Promise<SessionSummary[]>
    readSession: (path: string) => Promise<SessionSnapshot>
    trashSession: (path: string) => Promise<void>

    loadState: () => Promise<AppState>
    saveState: (save: StateSave) => Promise<void>
    pickFolder: () => Promise<string | null>
    /** Shared settings another window changed. */
    onPrefsChanged: (listener: (prefs: Partial<GlobalPrefs>) => void) => () => void

    /** This window's projects; call windowReady once the store can take transfers. */
    windowInit: () => Promise<WindowInit>
    windowReady: () => Promise<void>
    reportWindow: (report: WindowReport) => Promise<void>
    /** Main changed this window's project list (transfer, close). */
    onWindowProjects: (listener: (projects: string[]) => void) => () => void
    /** Every window's projects and activity. */
    onOpenProjects: (listener: (projects: OpenProject[]) => void) => () => void
    /** Main asks this window to show one of its projects. */
    onSelectProject: (listener: (cwd: string) => void) => () => void
    /**
     * "here": this window was empty (or already shows it) and now shows it; "elsewhere": the
     * window showing it was focused, or a new window opened for it.
     */
    openProject: (cwd: string) => Promise<'here' | 'elsewhere'>
    /** Shows a project in this window too, taking it (and its live threads) from its window. */
    attachProject: (cwd: string) => Promise<void>
    /** Moves one of this window's projects into a window of its own. */
    detachProject: (cwd: string) => Promise<void>
    /** Drops a project from this window; a window left empty closes, the last one turns into the welcome window. */
    closeProject: (cwd: string) => Promise<void>
    mergeAllWindows: () => Promise<void>
    focusWindow: () => Promise<void>
    /** Main collects a project's threads before handing it to another window. */
    onExportProjects: (handler: (cwds: string[]) => Promise<ProjectTransfer[]>) => () => void
    onImportProjects: (handler: (projects: ProjectTransfer[]) => Promise<void>) => () => void

    agentStart: (options: AgentStartOptions) => Promise<string>
    agentRequest: <T = any>(agentId: string, command: Record<string, unknown>) => Promise<RpcResponse<T>>
    agentSend: (agentId: string, record: Record<string, unknown>) => Promise<void>
    agentStop: (agentId: string) => Promise<void>
    onAgentEvent: (listener: (agentId: string, event: PiEvent) => void) => () => void
    onAgentExit: (listener: (agentId: string, info: AgentExitInfo) => void) => () => void
    /** Resolved compaction settings; modelKey is "provider/id". */
    compactionInfo: (cwd: string, modelKey?: string) => Promise<CompactionInfo>
    /** compaction.* in pi's global settings.json; cwd only reports whether that project overrides it. */
    globalCompaction: (cwd?: string) => Promise<GlobalCompaction>
    setGlobalCompaction: (patch: GlobalCompactionPatch) => Promise<void>
    /** Another window wrote pi's settings.json. */
    onPiSettingsChanged: (listener: (patch: GlobalCompactionPatch) => void) => () => void
    /** App menu → 设置… (⌘,). */
    onOpenSettings: (listener: () => void) => () => void

    gitStatus: (cwd: string) => Promise<GitStatus>
    /** Current branch per folder (null when not a repo); cheap, used by the project popup. */
    gitBranches: (cwds: string[]) => Promise<Record<string, string | null>>
    gitFileDiff: (cwd: string, path: string, status: string) => Promise<GitFileDiff>
    /** Which sessions edited each uncommitted file of the repository holding cwd. */
    repoEdits: (cwd: string) => Promise<RepoEdits>
    /** Rollback: tracked files back to HEAD; files HEAD lacks go to the Trash. */
    gitDiscard: (cwd: string, files: Pick<GitFileChange, 'path' | 'status' | 'origPath'>[]) => Promise<void>
    /** Commits exactly these paths (relative to the repository root); returns the short hash. */
    gitCommit: (cwd: string, message: string, paths: string[]) => Promise<string>

    openFolder: (path: string) => Promise<void>
    /** The given folders that no longer exist (deleted or moved since they were added). */
    missingFolders: (paths: string[]) => Promise<string[]>
    /** Sets nativeTheme.themeSource, which drives prefers-color-scheme and the window chrome. */
    setTheme: (theme: ThemePref) => Promise<void>
    /** Main process wording (menus, errors) follows the UI language. */
    setLang: (lang: LangPref) => Promise<void>
    openExternal: (url: string) => Promise<void>

    /** System notification; clicking it focuses the window and reports `key` back. */
    notify: (notice: AppNotice) => Promise<void>
    onNotificationClick: (listener: (key: string) => void) => () => void
}

export interface AppNotice {
    title: string
    body: string
    /** Thread key reported back on click. */
    key: string
    /** Waiting for the user: also bounce the Dock icon once. */
    urgent?: boolean
}

export const IPC = {
    resolveEnv: 'pi:resolve-env',
    listSessions: 'sessions:list',
    readSession: 'sessions:read',
    trashSession: 'sessions:trash',
    loadState: 'state:load',
    saveState: 'state:save',
    pickFolder: 'dialog:pick-folder',
    agentStart: 'agent:start',
    agentRequest: 'agent:request',
    agentSend: 'agent:send',
    agentStop: 'agent:stop',
    agentEvent: 'agent:event',
    agentExit: 'agent:exit',
    openSettings: 'menu:settings',
    compactionInfo: 'pi:compaction-info',
    globalCompaction: 'pi:global-compaction',
    setGlobalCompaction: 'pi:set-global-compaction',
    gitStatus: 'git:status',
    gitBranches: 'git:branches',
    gitFileDiff: 'git:file-diff',
    repoEdits: 'git:repo-edits',
    gitDiscard: 'git:discard',
    gitCommit: 'git:commit',
    openFolder: 'shell:open-folder',
    missingFolders: 'fs:missing-folders',
    setTheme: 'theme:set',
    setLang: 'lang:set',
    openExternal: 'shell:open-external',
    notify: 'app:notify',
    notificationClick: 'app:notification-click',
    prefsChanged: 'state:prefs-changed',
    piSettingsChanged: 'pi:settings-changed',
    windowInit: 'window:init',
    windowReady: 'window:ready',
    reportWindow: 'window:report',
    windowProjects: 'window:projects',
    openProjects: 'window:open-projects',
    selectProject: 'window:select-project',
    openProject: 'window:open-project',
    attachProject: 'window:attach-project',
    detachProject: 'window:detach-project',
    closeProject: 'window:close-project',
    mergeAllWindows: 'window:merge-all',
    focusWindow: 'window:focus',
    exportProjects: 'window:export-projects',
    importProjects: 'window:import-projects',
    /** Renderer → main answer to a main → renderer request (export/import). */
    reply: 'window:reply',
} as const
