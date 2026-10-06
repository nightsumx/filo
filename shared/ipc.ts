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
}

export type GitStatus =
    | { isRepo: false }
    | { isRepo: true, branch: string, files: GitFileChange[] }

export interface GitFileDiff { oldText: string, newText: string }

export interface AppState {
    /** Sidebar project order (cwds), including folders added manually. */
    projects: string[]
    /** Session-derived projects the user removed from the sidebar. */
    hiddenProjects: string[]
    activeProject?: string
    /** Open tabs per project, as session file paths in tab order. */
    tabs: Record<string, string[]>
    /** Focused tab per project (session file path). */
    activeTabs: Record<string, string>
    /** split: open tabs tile across the window; single: one pane. */
    layout: 'split' | 'single'
    /** Appearance; `system` follows macOS. */
    theme?: ThemePref
    /** App UI language; absent or `system` follows the OS preferred languages. */
    lang?: LangPref
    /** Wording inside the conversation (tool rows, diffs, status lines). */
    transcriptLang?: TranscriptLang
    /** Capabilities every pi process loads; absent means DEFAULT_CAPABILITIES. Older state has a map per project cwd. */
    capabilities?: CapabilityId[] | Record<string, CapabilityId[]>
    /** Approval mode new threads start in: the last one chosen in any thread. */
    approvalMode?: ApprovalMode
    /** Older state: the same, per project cwd. Read once, then dropped. */
    approvalModes?: Record<string, ApprovalMode>
    /** Tokens at which every model compacts (see lib/compactAt); null: none, absent: not decided yet. */
    compactAt?: number | null
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
    saveState: (state: AppState) => Promise<void>
    pickFolder: () => Promise<string | null>

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
    /** App menu → 设置… (⌘,). */
    onOpenSettings: (listener: () => void) => () => void

    gitStatus: (cwd: string) => Promise<GitStatus>
    /** Current branch per folder (null when not a repo); cheap, used by the project popup. */
    gitBranches: (cwds: string[]) => Promise<Record<string, string | null>>
    gitFileDiff: (cwd: string, path: string, status: string) => Promise<GitFileDiff>

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
    /** Dock badge: threads waiting for the user (0 clears it). */
    setBadge: (count: number) => Promise<void>
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
    openFolder: 'shell:open-folder',
    missingFolders: 'fs:missing-folders',
    setTheme: 'theme:set',
    setLang: 'lang:set',
    openExternal: 'shell:open-external',
    notify: 'app:notify',
    notificationClick: 'app:notification-click',
    setBadge: 'app:set-badge',
} as const
