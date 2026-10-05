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
    /** Wording inside the conversation (tool rows, diffs, status lines). */
    transcriptLang?: TranscriptLang
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

export interface AgentStartOptions {
    cwd: string
    sessionPath?: string
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
    /** App menu → 设置… (⌘,). */
    onOpenSettings: (listener: () => void) => () => void

    gitStatus: (cwd: string) => Promise<GitStatus>
    /** Current branch per folder (null when not a repo); cheap, used by the project popup. */
    gitBranches: (cwds: string[]) => Promise<Record<string, string | null>>
    gitFileDiff: (cwd: string, path: string, status: string) => Promise<GitFileDiff>

    openFolder: (path: string) => Promise<void>
    /** Sets nativeTheme.themeSource, which drives prefers-color-scheme and the window chrome. */
    setTheme: (theme: ThemePref) => Promise<void>
    openExternal: (url: string) => Promise<void>
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
    gitStatus: 'git:status',
    gitBranches: 'git:branches',
    gitFileDiff: 'git:file-diff',
    openFolder: 'shell:open-folder',
    setTheme: 'theme:set',
    openExternal: 'shell:open-external',
} as const
