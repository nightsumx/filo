import type { AcpAgentCaps, AgentAvailability, AgentKind } from './agents'
import type { Ledger } from 'pi-capabilities/lib/ledger.ts'
import type { CapabilityChoice, CapabilityId, CapabilityState, Presence } from './capabilities'
import type { LangPref } from './i18n'
import type { AgentMessage, PiEvent, RpcResponse, ThinkingLevel } from './pi'
import type { AuthMethod, ChannelHealth, ChannelModel, ChannelSave, ChannelTestUpdate, EndpointModel, EndpointSave, LoginUpdate, ProvidersState } from './providers'
import type { AgentChannel, RouteCatalog, RoutesState, TerminalAgent, ThreadRoute, ThreadRouteInfo } from './routes'
import type { SetupProbe } from './setup'

export interface PiEnv {
    nodePath: string
    /** pi's CLI (a JS file, or a compiled binary). */
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
    /** The agent that ran it; absent for pi's own session files. */
    agent?: AgentKind
    /** What that ACP agent can do, as it last said. */
    agentCaps?: AcpAgentCaps
}

/** A message that matched a full-text search. */
export interface SearchHit {
    entryId: string
    role: 'user' | 'assistant'
    at: number
    /** Text around the first match. */
    snippet: string
}

/** One session with matches, most recently active first. */
export interface SearchResult {
    session: string
    cwd: string
    title: string
    updatedAt: number
    /** The first few matching messages. */
    hits: SearchHit[]
    /** Matching messages in all. */
    total: number
}

/** A skill folder (with a SKILL.md) in the agents' skill folders, by name; see electron/skills.ts. */
export interface SkillInfo {
    name: string
    description: string
    /** The agents whose folders hold it (a link counts). */
    agents: AgentKind[]
    /** The folders behind it; more than one means different copies under one name. */
    paths: string[]
    /** One copy, in ~/.agents/skills and linked into Claude Code's folder when it has one. */
    shared: boolean
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
    /** A chat the agent continues only in a terminal: the command that does it. */
    terminalOnly?: string
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

/**
 * Raw bytes of a changed file for previews (images, PDF, audio, video): the last commit's copy and
 * the working copy. null where that side does not exist; `tooLarge` where it exceeds the preview cap.
 */
export interface GitFileBytes {
    old: Uint8Array | null
    new: Uint8Array | null
    oldSize: number
    newSize: number
    tooLarge: boolean
}

/** QuickLook thumbnails (PNG) of both sides of a changed file; null where a side or a thumbnail is missing. */
export interface GitFileThumbs {
    old: Uint8Array | null
    new: Uint8Array | null
    oldSize: number
    newSize: number
}

/** Entry names of both sides of a changed archive, capped; the counts are the full totals. */
export interface GitFileEntries {
    old: string[] | null
    new: string[] | null
    oldCount: number
    newCount: number
}

/** One entry of a folder in the file tree. `ignored`: git ignores it (shown dimmed). */
export interface DirEntry {
    name: string
    dir: boolean
    ignored: boolean
    /** A symbolic link (to a folder when `dir`). */
    link?: boolean
}

/** A folder's entries, folders first; `more` counts the ones past the cap. */
export interface DirListing {
    entries: DirEntry[]
    more: number
}

/** A file for the editor: UTF-8 text (without its byte order mark), or why it cannot be edited. */
export type FileRead =
    | { kind: 'text', text: string, bom: boolean, size: number }
    | { kind: 'binary', size: number }
    | { kind: 'tooLarge', size: number }
    | { kind: 'missing' }

/**
 * Entries that changed in a watched folder; an empty name: the folder itself (or entries unknown).
 * `listed`: entries came, went or were renamed, so the folder's listing changed too.
 */
export interface DirChange {
    dir: string
    names: string[]
    listed: boolean
}

/** A save; refused when the file changed on disk since the editor read it (`disk` is what is there). */
export type FileWrite = { ok: true } | { ok: false, disk: FileRead }

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
    /** How much the file editor knows about TypeScript/JavaScript projects; absent: standard. */
    editorIntel?: EditorIntel
    /** The agent a new thread starts with; absent: pi. */
    defaultAgent?: AgentKind
    /** The setup assistant's version the user went through (shared/setup.ts SETUP_VERSION); absent: never. */
    setupDone?: number
}

export const GLOBAL_PREF_KEYS = ['projects', 'hiddenProjects', 'layout', 'theme', 'lang', 'transcriptLang', 'reviewView', 'editorIntel', 'defaultAgent', 'setupDone'] as const satisfies readonly (keyof GlobalPrefs)[]

/** settings.json as running pi processes see it (piSettings.ts). */
export interface PiSettingsState {
    /** Changes when something they read at startup does (resources, compaction): they restart once idle. */
    fingerprint: string
    /** compaction.modelOverrides: a change restarts only the threads on that model. */
    modelOverrides: Record<string, unknown>
    capabilities: CapabilityState
    /** pi-web-access (electron/piPackages.ts). */
    webAccess: PiPackageState
    /** pi's `cacheWarming`. */
    cacheWarming: CacheWarming
}

/** What pi starts a new session in a project on: settings.json, the project's .pi/settings.json over it. */
export interface PiDefaults {
    /** modelKey; absent: pi picks one by itself. */
    model?: string
    thinkingLevel: ThinkingLevel
}

/** pi's cache warming: off; while the agent runs; also between runs while a reply stays likely enough to pay for it. */
export type CacheWarming = 'off' | 'streaming' | 'idle'
export const CACHE_WARMING: readonly CacheWarming[] = ['off', 'streaming', 'idle']

/** A pi package as settings.json lists it. */
export interface PiPackageState {
    installed: boolean
    /** Its extensions load (installed and not filtered to none). */
    enabled: boolean
}

/** A project window as saved for the next launch. */
export interface SavedWindow {
    /** One project, or several after the user merged windows. A project can show in several windows. */
    projects: string[]
    active?: string
    /** This window's own tabs per project (state.tabs is the fallback for windows without). */
    tabs?: Record<string, string[]>
    activeTabs?: Record<string, string>
}

export interface WindowBounds { x: number, y: number, width: number, height: number }

export interface AppState extends GlobalPrefs {
    /** Open tabs per project, as session file paths in tab order. */
    tabs: Record<string, string[]>
    /** Focused tab per project (session file path). */
    activeTabs: Record<string, string>
    /** Project windows open at quit, reopened on launch. */
    windows?: SavedWindow[]
    /** Last window frame per project (a merged window is keyed by its first project). */
    windowBounds?: Record<string, WindowBounds>
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

/** Tabs dragged from one window to another, live threads included (see Thread.snapshot). */
export interface ThreadTransfer {
    cwd: string
    threads: Record<string, unknown>[]
    /** pi processes of those threads, re-routed by main. */
    agents: string[]
    /** The source window still has tabs of the project (else it drops the project). */
    remaining: boolean
}

/** Drag a tab to another window (`to`), or tear it off into a new window at a screen point. */
export interface TabMove {
    key: string
    cwd: string
    /** Source window, when the target asks (a drop); else the asking window. */
    from?: number
    to: number | null
    /** Position among the target's tabs of that project; the end if absent. */
    index?: number
    at?: { x: number, y: number }
}

/** A project handed from one window to another, live threads included (see Thread.snapshot). */
export interface ProjectTransfer {
    cwd: string
    tabs: string[]
    activeTab?: string
    threads: Record<string, unknown>[]
    /** Set by main: the target already showed the project (it was in both windows); tabs are added to its own. */
    merge?: boolean
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

/**
 * light: highlighting and editing only, no TypeScript service. standard: types, completion and errors for
 * the open file and what it imports. full: the whole project is read, so references, rename and errors
 * reach files that are not open.
 */
export type EditorIntel = 'light' | 'standard' | 'full'
export const EDITOR_INTELS: readonly EditorIntel[] = ['light', 'standard', 'full']
export const DEFAULT_EDITOR_INTEL: EditorIntel = 'standard'

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
    /** pi (default) or an ACP agent; a resumed ACP session's key names its agent too. */
    agent?: AgentKind
    sessionPath?: string
    /** Capability extensions to load with `-e`. */
    capabilities?: CapabilityId[]
    /** The thread's own routing choice (composer), when its agent runs through the gateway. */
    route?: ThreadRoute
    /** pi's `--approve` / `--no-approve`: the answer to its trust question, for a project trust.json has none for. */
    trust?: boolean
}

/** pi's trust question (its TUI's select), as the thread asks it. */
export interface PiTrustQuestion {
    title: string
    message: string
    options: string[]
}

/** Settings → Models (pi's /scoped-models): the models pi has a login for, and which of them enabledModels covers. */
export interface ScopedModels {
    /** enabledModels as the merged settings have it; null when there is none (every model is in). */
    patterns: string[] | null
    models: { provider: string, id: string, name: string }[]
    /** `provider/id` of the models the patterns cover (all of them when there are no patterns). */
    scoped: string[]
    warnings: string[]
}

/** An MCP server Claude Code has (Settings → Claude Code); `scope` is where it is kept, as in `claude mcp add -s`. */
export interface ClaudeMcpServer {
    name: string
    scope: 'local' | 'project' | 'user'
    transport: string
    /** The URL, or the command with its arguments. */
    target: string
}

/** An MCP server of Grok Build (its /mcps): `user` is in ~/.grok/config.toml, `project` in ./.grok/config.toml. */
export interface GrokMcpServer {
    name: string
    scope: 'user' | 'project'
    transport: 'stdio' | 'http' | 'sse'
    target: string
    enabled: boolean
}

export interface GrokMcpAdd {
    cwd: string
    name: string
    scope: GrokMcpServer['scope']
    transport: GrokMcpServer['transport']
    /** The command line (stdio) or the URL. */
    target: string
    env?: string[]
}

/** An MCP server of pi (its /mcp): `user` is in the agent folder's mcp.json, `project` in the project's .pi/mcp.json. */
export interface PiMcpServer {
    name: string
    scope: 'user' | 'project'
    /** `override` is a project entry that only switches a user-level server on or off. */
    transport: 'stdio' | 'http' | 'override'
    target: string
    enabled: boolean
    exposure: string
}

export interface PiMcpAdd {
    cwd: string
    name: string
    scope: PiMcpServer['scope']
    transport: 'stdio' | 'http'
    /** The command line (stdio) or the URL. */
    target: string
    env?: string[]
}

/** An MCP server in Codex's config (Settings → Codex). */
export interface CodexMcpServer {
    name: string
    transport: 'stdio' | 'http'
    target: string
    enabled: boolean
    error?: string
    tools: number
}

export interface CodexMcpAdd {
    cwd: string
    name: string
    transport: 'stdio' | 'http'
    /** The command line (stdio) or the URL. */
    target: string
    /** NAME=value, for stdio servers. */
    env?: string[]
}

export interface CodexPlugin {
    /** `name@marketplace`, what uninstalling and `plugins.<id>` in config.toml use. */
    id: string
    name: string
    description: string
    version: string
    installed: boolean
    enabled: boolean
    /** Whether it can be installed here: not blocked by policy or the workspace admin. */
    available: boolean
}

export interface CodexMarketplace {
    name: string
    /** The marketplace file, when it is a local one. */
    path?: string
    plugins: CodexPlugin[]
}

/** The plugins of the marketplaces Codex knows (its own, the home ones, the project's) and the ones that failed to load. */
export interface CodexPlugins {
    marketplaces: CodexMarketplace[]
    errors: string[]
}

/** One change to the plugins (Settings → Codex, Codex's /plugins). */
export type CodexPluginChange
    = { action: 'install', marketplacePath: string, name: string }
    | { action: 'uninstall', id: string }
    | { action: 'enable', id: string, enabled: boolean }
    | { action: 'addMarketplace', source: string }
    | { action: 'removeMarketplace', name: string }

/** A beta feature Codex lists in its /experimental. */
export interface CodexFeature {
    name: string
    title: string
    description: string
    enabled: boolean
}

/** An app (connector) Codex lists in its /apps; it needs a ChatGPT sign-in, so an API-key user sees none. */
export interface CodexApp {
    id: string
    name: string
    description: string
    /** Whether the app can be used (it is installed and connected). */
    accessible: boolean
    /** `apps.<id>.enabled` in config.toml; on unless that says off. */
    enabled: boolean
}

/** Codex's memories (its /memories): how many conversations it has consolidated, and whether that is enough to use them. */
export interface CodexMemory {
    consolidated: number
    ready: boolean
}

/** Claude Code's memory (its /memory): the switch for auto memory, and the files it reads and writes. */
export interface ClaudeMemory {
    enabled: boolean
    /** Your CLAUDE.md, when there is one. */
    userFile?: string
    /** Claude Code's own folder, where your CLAUDE.md goes. */
    userFolder: string
    /** The project's CLAUDE.md, when there is one. */
    projectFile?: string
    /** The folder of notes Claude Code keeps for the project, once it has written some. */
    dir?: string
}

export interface ClaudeMcpAdd {
    cwd: string
    name: string
    scope: ClaudeMcpServer['scope']
    transport: 'stdio' | 'http' | 'sse'
    /** The command line (stdio) or the URL. */
    target: string
    /** NAME=value, for stdio servers. */
    env?: string[]
}

export interface ClaudeMcpRemove {
    cwd: string
    name: string
    scope: ClaudeMcpServer['scope']
}

/** What pi's trust.json and defaultProjectTrust say of a project (Settings → Project trust). */
export interface ProjectTrust {
    cwd: string
    /** The nearest folder at or above the project that trust.json decides for; null when there is none. */
    decision: boolean | null
    /** That folder, when it is above the project rather than the project itself. */
    inheritedFrom?: string
    /** pi's defaultProjectTrust: what applies when there is no decision. */
    fallback: 'ask' | 'always' | 'never'
    /** The project has something trust gates (.pi settings or extensions, .agents/skills); without it the decision changes nothing. */
    gated: boolean
}

export interface AgentExitInfo {
    code: number | null
    signal: string | null
    stderr: string
    /** A joined terminal pi went away (it quit or switched session); not an error of the thread. */
    detached?: boolean
}

/** A terminal in the app's Terminal tool window: a shell, or a command run in one. Lives in main, per project. */
export interface TerminalInfo {
    id: string
    cwd: string
    /** Tab label: the label it started with, else the foreground program (zsh, bun, node…). */
    title: string
    /** Something other than the shell runs in the foreground (a command terminal: while it lives). */
    busy: boolean
    /** Started to run this command; the terminal ends with it and can run it again. */
    command?: string
    /** setup: an installer the setup assistant runs; no project's Terminal tool window lists it. */
    by: 'user' | 'agent' | 'setup'
    /** Set once its process has ended (command terminals stay open to show the output). */
    exit?: { code: number, signal?: number }
    createdAt: number
}

export interface TerminalCreate {
    cwd: string
    cols?: number
    rows?: number
    /** Runs this in the user's interactive login shell instead of opening a shell. */
    command?: string
    label?: string
}

/** The screen and scrollback as escape sequences, up to output chunk `seq`. */
export interface TerminalSnapshot {
    data: string
    seq: number
    cols: number
    rows: number
}

/** The API preload exposes on window.pi. */
export interface PiBridge {
    resolveEnv: () => Promise<PiEnvResult>
    /** ACP agents (Codex, …) and whether each can start here. */
    listAgents: () => Promise<AgentAvailability[]>
    /** Installs (or updates) an ACP agent in the app's own folder. */
    installAgent: (id: string) => Promise<void>
    /** An agent install started or ended (any window). */
    onAgentsChanged: (listener: () => void) => () => void
    /** The setup assistant's tools, after asking the login shell for PATH again. */
    setupProbe: () => Promise<SetupProbe>
    /** Runs a tool's official installer in a terminal of its own (`by: 'setup'`, in the home folder). */
    setupInstall: (id: string, size?: { cols: number, rows: number }) => Promise<TerminalInfo>
    listSessions: () => Promise<SessionSummary[]>
    /** pi's /import: a session JSONL (asked for with a file dialog when `file` is left out) copied into the sessions folder; null when the dialog is cancelled. */
    importSession: (into: string, projects: string[], file?: string) => Promise<{ summary: SessionSummary, movedTo?: string } | null>
    readSession: (path: string) => Promise<SessionSnapshot>
    /** What pi sessions cost over the last `days` days (pi-capabilities/lib/ledger.ts). */
    spendLedger: (days: number) => Promise<Ledger>
    /** pi: the file goes to the Trash. ACP: off the app's list; `history` deletes it in the agent too. */
    trashSession: (path: string, options?: { history?: boolean }) => Promise<void>
    /** Full-text search of prompts and replies in every session; every word must appear. */
    searchSessions: (query: string) => Promise<SearchResult[]>
    /** Terminal pi sessions (pi-cc-tui's presence extension), and their changes. */
    getPresence: () => Promise<Presence[]>
    onPresence: (listener: (list: Presence[]) => void) => () => void
    /** Reports changes to a session file a terminal pi writes (no bridge to join it). */
    followSession: (path: string, on: boolean) => Promise<void>
    onSessionChanged: (listener: (path: string) => void) => () => void

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
    /**
     * Opens a session in the window showing its project (focused), or in a new window; the window
     * then gets onRevealSession. Used when the project is not in this window.
     */
    revealSession: (cwd: string, session: string, entryId?: string) => Promise<void>
    /** Main asks this window to open a session of one of its projects and scroll to a message. */
    onRevealSession: (listener: (session: string, entryId?: string) => void) => () => void
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
    /** Moves a tab of this window (live thread and pi process included). */
    moveTab: (move: TabMove) => Promise<void>
    onExportThreads: (handler: (keys: string[]) => Promise<ThreadTransfer>) => () => void
    onImportThreads: (handler: (arg: { transfer: ThreadTransfer, index?: number }) => Promise<void>) => () => void
    /** Session file → id of the window showing it as a tab (every window). */
    onOpenTabs: (listener: (tabs: Record<string, number>) => void) => () => void

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
    setGlobalCompaction: (patch: GlobalCompactionPatch) => Promise<PiSettingsState>
    /** What running pi processes read from settings.json, and the capability choice kept there. */
    piSettings: () => Promise<PiSettingsState>
    /** Merges into the capability choice in settings.json (shared with pi-cc-tui). */
    setCapabilities: (patch: CapabilityChoice) => Promise<PiSettingsState>
    /** `pi install` of pi-web-access, for pi in the app and in a terminal. */
    installWebAccess: () => Promise<PiSettingsState>
    setWebAccess: (enabled: boolean) => Promise<PiSettingsState>
    setCacheWarming: (mode: CacheWarming) => Promise<PiSettingsState>
    piDefaults: (cwd: string) => Promise<PiDefaults>
    /** What pi's TUI would ask before starting in `cwd`; null when it would not ask, or the session's terminal pi is joined instead. */
    piTrust: (cwd: string, sessionPath?: string) => Promise<PiTrustQuestion | null>
    /** Saves the choice in pi's trust.json as its TUI does: whether pi trusts the project this time, and whether it was saved. */
    answerPiTrust: (cwd: string, label?: string) => Promise<{ trusted: boolean, saved: boolean }>
    /** What trust.json says of each project, by pi's own rules (the nearest folder's decision, else defaultProjectTrust). */
    projectTrust: (cwds: string[]) => Promise<ProjectTrust[]>
    /** Writes a project's decision through pi's ProjectTrustStore (null forgets it). Threads already running keep the trust they started with. */
    setProjectTrust: (cwd: string, decision: boolean | null) => Promise<ProjectTrust>
    /** The MCP servers Claude Code has for a project (its .claude.json and the project's .mcp.json). */
    claudeMcp: (cwd: string) => Promise<ClaudeMcpServer[]>
    grokMcp: (cwd: string) => Promise<GrokMcpServer[]>
    addGrokMcp: (input: GrokMcpAdd) => Promise<GrokMcpServer[]>
    removeGrokMcp: (cwd: string, scope: GrokMcpServer['scope'], name: string) => Promise<GrokMcpServer[]>
    setGrokMcp: (cwd: string, name: string, enabled: boolean) => Promise<GrokMcpServer[]>
    piMcp: (cwd: string) => Promise<PiMcpServer[]>
    addPiMcp: (input: PiMcpAdd) => Promise<PiMcpServer[]>
    removePiMcp: (cwd: string, scope: PiMcpServer['scope'], name: string) => Promise<PiMcpServer[]>
    setPiMcp: (cwd: string, scope: PiMcpServer['scope'], name: string, patch: { enabled?: boolean, exposure?: string }) => Promise<PiMcpServer[]>
    codexMcp: (cwd: string) => Promise<CodexMcpServer[]>
    addCodexMcp: (input: CodexMcpAdd) => Promise<CodexMcpServer[]>
    removeCodexMcp: (cwd: string, name: string) => Promise<CodexMcpServer[]>
    codexPlugins: (cwd: string) => Promise<CodexPlugins>
    changeCodexPlugins: (cwd: string, change: CodexPluginChange) => Promise<CodexPlugins>
    codexFeatures: () => Promise<CodexFeature[]>
    setCodexFeature: (name: string, enabled: boolean) => Promise<CodexFeature[]>
    codexApps: () => Promise<CodexApp[]>
    setCodexApp: (id: string, enabled: boolean) => Promise<CodexApp[]>
    codexMemory: () => Promise<CodexMemory>
    resetCodexMemory: () => Promise<CodexMemory>
    claudeMemory: (cwd: string) => Promise<ClaudeMemory>
    /** autoMemoryEnabled in Claude Code's settings.json. */
    setClaudeAutoMemory: (enabled: boolean) => Promise<void>
    /** `claude mcp add`, with the user's own claude; resolves to the list afterwards. */
    addClaudeMcp: (input: ClaudeMcpAdd) => Promise<ClaudeMcpServer[]>
    /** `claude mcp remove`. */
    removeClaudeMcp: (input: ClaudeMcpRemove) => Promise<ClaudeMcpServer[]>
    /** The models pi has, and which ones enabledModels (pi's /scoped-models) covers. */
    scopedModels: (cwd: string) => Promise<ScopedModels>
    /** Saves enabledModels as pi's /scoped-models does; null removes it (all models). */
    setScopedModels: (cwd: string, patterns: string[] | null) => Promise<ScopedModels>
    /** pi's CHANGELOG.md (pi's /changelog), or null when the install has none. */
    piChangelog: () => Promise<string | null>
    /** pi's `defaultProvider` + `defaultModel`, as its TUI's "set as default" writes them. */
    setDefaultModel: (cwd: string, provider: string, model: string) => Promise<PiDefaults>
    /** pi's `defaultThinkingLevel`. */
    setDefaultThinkingLevel: (cwd: string, level: ThinkingLevel) => Promise<PiDefaults>
    /** settings.json changed (this app, pi in a terminal, an editor). */
    onPiSettingsChanged: (listener: (state: PiSettingsState) => void) => () => void
    /** App menu → 设置… (⌘,). */
    onOpenSettings: (listener: () => void) => () => void

    gitStatus: (cwd: string) => Promise<GitStatus>
    /** Current branch per folder (null when not a repo); cheap, used by the project popup. */
    gitBranches: (cwds: string[]) => Promise<Record<string, string | null>>
    gitFileDiff: (cwd: string, path: string, status: string) => Promise<GitFileDiff>
    /** Both sides of a changed file as bytes, for previews; a rename reads HEAD at `origPath`. */
    gitFileBytes: (cwd: string, path: string, status: string, origPath?: string) => Promise<GitFileBytes>
    /** QuickLook thumbnails of both sides (documents, HEIC, PSD...), for types the browser cannot show. */
    gitFileThumbs: (cwd: string, path: string, status: string, origPath?: string) => Promise<GitFileThumbs>
    /** Entry lists of both sides of an archive. */
    gitFileEntries: (cwd: string, path: string, status: string, origPath?: string) => Promise<GitFileEntries>
    /** Which sessions edited each uncommitted file of the repository holding cwd. */
    repoEdits: (cwd: string) => Promise<RepoEdits>
    /** Rollback: tracked files back to HEAD; files HEAD lacks go to the Trash. */
    gitDiscard: (cwd: string, files: Pick<GitFileChange, 'path' | 'status' | 'origPath'>[]) => Promise<void>
    /** Commits exactly these paths (relative to the repository root); returns the short hash. */
    gitCommit: (cwd: string, message: string, paths: string[]) => Promise<string>
    skills: () => Promise<SkillInfo[]>
    /** Moves or links each into ~/.agents/skills and links it for Claude Code; returns the new list. */
    shareSkills: (names: string[]) => Promise<SkillInfo[]>
    /** The main checkout of each folder that is a linked worktree; others are left out. */
    worktreeParents: (cwds: string[]) => Promise<Record<string, string>>
    /** A detached worktree of the folder's repository at HEAD, outside it; returns its path. */
    createWorktree: (cwd: string) => Promise<string>
    /** The worktree's changes as unstaged changes in its main checkout; see applyWorktree in electron/git.ts. */
    applyWorktree: (cwd: string) => Promise<{ files: number, conflicts: string[] }>
    removeWorktree: (cwd: string) => Promise<void>
    /** What another agent's new thread is told to review or take over a thread (its pi-format messages); see threadTask in electron/git.ts. */
    threadTask: (cwd: string, messages: unknown[], kind: 'review' | 'handoff', from: string) => Promise<string>

    openFolder: (path: string) => Promise<void>
    /** Selects a file or folder in Finder / Explorer. */
    revealPath: (path: string) => Promise<void>
    /** A folder of the file tree. */
    listDir: (dir: string) => Promise<DirListing>
    readFile: (file: string) => Promise<FileRead>
    /** Where links lead (the file itself when there are none or it is gone); TypeScript needs it to find a package's own dependencies. */
    realPath: (file: string) => Promise<string>
    /** The TypeScript and JavaScript files under a folder, absolute: git's own list (ignored files left out) or a walk that skips node_modules and build output. Capped. */
    projectSources: (root: string) => Promise<string[]>
    /** See FileWrite; `expected` null overwrites whatever is on disk. */
    writeFile: (file: string, text: string, options: { expected: string | null, bom: boolean }) => Promise<FileWrite>
    /** The folders this window watches (tree folders, folders of open files); replaces the last set. */
    watchDirs: (dirs: string[]) => void
    onDirsChanged: (listener: (changes: DirChange[]) => void) => () => void
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

    /** Every terminal (all projects); the list again on every change. */
    terminals: () => Promise<TerminalInfo[]>
    onTerminals: (listener: (list: TerminalInfo[]) => void) => () => void
    terminalCreate: (create: TerminalCreate) => Promise<TerminalInfo>
    /** Starts output delivery to this window; returns what came before (see TerminalSnapshot.seq). */
    terminalAttach: (id: string) => Promise<TerminalSnapshot>
    terminalDetach: (id: string) => void
    /** Output chunks; `seq` counts chunks, so ones the snapshot already holds can be skipped. */
    onTerminalData: (listener: (id: string, seq: number, data: string) => void) => () => void
    terminalWrite: (id: string, data: string) => void
    terminalResize: (id: string, cols: number, rows: number) => void
    /** Ends the terminal and every process started in it, and drops it. */
    terminalClose: (id: string) => Promise<void>
    /** A command terminal runs its command again (stopping it first if it still runs). */
    terminalRestart: (id: string) => Promise<void>
    /** Plain text of the last lines, for sending output to a thread. */
    terminalText: (id: string, lines?: number) => Promise<string>

    /** Settings → 供应商: pi's providers and the models.json entries the page edits. */
    providers: () => Promise<ProvidersState>
    /** Starts a sign-in; its prompts and outcome arrive on onProviderLogin under the returned id. */
    providerLogin: (provider: string, method: AuthMethod) => Promise<string>
    providerAnswer: (login: string, promptId: string, value: string) => Promise<void>
    providerCancel: (login: string) => Promise<void>
    /** Removes the credential saved in auth.json. */
    providerLogout: (provider: string) => Promise<void>
    saveEndpoint: (save: EndpointSave) => Promise<void>
    removeEndpoint: (id: string) => Promise<void>
    /**
     * Adds a provider from an address and key (an agent's model picker) and points the agent's config
     * at its first model (useChannel). listError: the endpoint did not list its models, so it needs one named.
     */
    addChannel: (agent: TerminalAgent, save: Omit<ChannelSave, 'api'>) => Promise<AgentChannel | { listError: string }>
    /** The endpoint's own model list; without apiKey, the key pi has for `provider` is used. */
    endpointModels: (baseUrl: string, api: string, apiKey?: string, provider?: string) => Promise<EndpointModel[]>
    onProviderLogin: (listener: (update: LoginUpdate) => void) => () => void
    /** Credentials or endpoints changed (any window). */
    onProvidersChanged: (listener: () => void) => () => void
    /** Channel test (pi-capabilities/lib/channelTest.ts): a provider's models with prices. */
    channelModels: (provider: string) => Promise<ChannelModel[]>
    /** Last results, the past week's cache record and runs under way, per "provider/model". */
    channelHealth: () => Promise<ChannelHealth>
    /** Starts a run (or returns the one already running on this model); updates arrive on onChannelTest. */
    channelTest: (provider: string, model: string, idleMs?: number) => Promise<string>
    channelCancel: (test: string) => Promise<void>
    onChannelTest: (listener: (update: ChannelTestUpdate) => void) => () => void

    /** Settings → 路由: groups, which agents use them, and the gateway's live status. */
    routes: () => Promise<RoutesState>
    routesSave: (config: RoutesState['config']) => Promise<void>
    /** Models groups can name (pi's, signed in with a key); `force` reads them again. */
    routeCatalog: (force?: boolean) => Promise<RouteCatalog>
    /** A running thread's routing; undefined when its process does not run through the gateway. */
    threadRoute: (agentId: string) => Promise<ThreadRouteInfo | undefined>
    setThreadRoute: (agentId: string, route: ThreadRoute) => Promise<ThreadRouteInfo | undefined>
    /** The group a Claude Code / Codex / Gemini / Grok session was last on, to resume it there. */
    sessionRoute: (sessionKey: string) => Promise<string | undefined>
    setSessionRoute: (sessionKey: string, group: string | undefined) => Promise<void>
    /** What Claude Code's / Codex's own config points at. */
    agentChannel: (agent: TerminalAgent) => Promise<AgentChannel>
    /** Writes a provider model into the agent's own config, or with null, puts back what it had before. */
    useChannel: (agent: TerminalAgent, pick: { provider: string, model: string } | null) => Promise<AgentChannel>
    onRoutesChanged: (listener: (state: RoutesState) => void) => () => void
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
    listAgents: 'agents:list',
    installAgent: 'agents:install',
    agentsChanged: 'agents:changed',
    setupProbe: 'setup:probe',
    setupInstall: 'setup:install',
    listSessions: 'sessions:list',
    readSession: 'sessions:read',
    spendLedger: 'sessions:spend-ledger',
    trashSession: 'sessions:trash',
    searchSessions: 'sessions:search',
    presence: 'sessions:presence',
    followSession: 'sessions:follow',
    sessionChanged: 'sessions:changed',
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
    piSettings: 'pi:settings',
    setCapabilities: 'pi:set-capabilities',
    installWebAccess: 'pi:install-web-access',
    setWebAccess: 'pi:set-web-access',
    setCacheWarming: 'pi:set-cache-warming',
    piDefaults: 'pi:defaults',
    piTrust: 'pi:trust',
    answerPiTrust: 'pi:answer-trust',
    projectTrust: 'pi:project-trust',
    setProjectTrust: 'pi:set-project-trust',
    claudeMcp: 'claude:mcp',
    claudeMemory: 'claude:memory',
    grokMcp: 'grok:mcp',
    addGrokMcp: 'grok:mcp-add',
    removeGrokMcp: 'grok:mcp-remove',
    setGrokMcp: 'grok:mcp-set',
    piMcp: 'pi:mcp',
    addPiMcp: 'pi:mcp-add',
    removePiMcp: 'pi:mcp-remove',
    setPiMcp: 'pi:mcp-set',
    codexMcp: 'codex:mcp',
    addCodexMcp: 'codex:mcp-add',
    removeCodexMcp: 'codex:mcp-remove',
    codexPlugins: 'codex:plugins',
    changeCodexPlugins: 'codex:plugins-change',
    codexFeatures: 'codex:features',
    setCodexFeature: 'codex:set-feature',
    codexApps: 'codex:apps',
    setCodexApp: 'codex:set-app',
    codexMemory: 'codex:memory',
    resetCodexMemory: 'codex:reset-memory',
    setClaudeAutoMemory: 'claude:set-auto-memory',
    addClaudeMcp: 'claude:mcp-add',
    removeClaudeMcp: 'claude:mcp-remove',
    scopedModels: 'pi:scoped-models',
    setScopedModels: 'pi:set-scoped-models',
    piChangelog: 'pi:changelog',
    setDefaultModel: 'pi:set-default-model',
    setDefaultThinkingLevel: 'pi:set-default-thinking-level',
    gitStatus: 'git:status',
    gitBranches: 'git:branches',
    gitFileDiff: 'git:file-diff',
    gitFileBytes: 'git:file-bytes',
    gitFileThumbs: 'git:file-thumbs',
    gitFileEntries: 'git:file-entries',
    repoEdits: 'git:repo-edits',
    gitDiscard: 'git:discard',
    gitCommit: 'git:commit',
    skills: 'skills:list',
    shareSkills: 'skills:share',
    worktreeParents: 'git:worktree-parents',
    createWorktree: 'git:create-worktree',
    applyWorktree: 'git:apply-worktree',
    removeWorktree: 'git:remove-worktree',
    threadTask: 'git:thread-task',
    openFolder: 'shell:open-folder',
    missingFolders: 'fs:missing-folders',
    revealPath: 'shell:reveal-path',
    listDir: 'fs:list-dir',
    readFile: 'fs:read-file',
    realPath: 'fs:real-path',
    projectSources: 'fs:project-sources',
    writeFile: 'fs:write-file',
    watchDirs: 'fs:watch-dirs',
    dirsChanged: 'fs:dirs-changed',
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
    revealSession: 'window:reveal-session',
    importSession: 'session:import',
    exportProjects: 'window:export-projects',
    moveTab: 'window:move-tab',
    exportThreads: 'window:export-threads',
    importThreads: 'window:import-threads',
    openTabs: 'window:open-tabs',
    importProjects: 'window:import-projects',
    providers: 'providers:list',
    providerLogin: 'providers:login',
    providerAnswer: 'providers:answer',
    providerCancel: 'providers:cancel',
    providerLogout: 'providers:logout',
    saveEndpoint: 'providers:save-endpoint',
    removeEndpoint: 'providers:remove-endpoint',
    endpointModels: 'providers:endpoint-models',
    addChannel: 'providers:add-channel',
    providerLoginUpdate: 'providers:login-update',
    providersChanged: 'providers:changed',
    channelModels: 'providers:channel-models',
    channelHealth: 'providers:channel-health',
    channelTest: 'providers:channel-test',
    channelCancel: 'providers:channel-cancel',
    channelTestUpdate: 'providers:channel-test-update',
    routes: 'routes:state',
    routesSave: 'routes:save',
    routeCatalog: 'routes:catalog',
    threadRoute: 'routes:thread',
    setThreadRoute: 'routes:set-thread',
    sessionRoute: 'routes:session',
    setSessionRoute: 'routes:set-session',
    agentChannel: 'routes:agent-channel',
    useChannel: 'routes:use-channel',
    routesChanged: 'routes:changed',
    terminals: 'terminal:list',
    terminalsChanged: 'terminal:changed',
    terminalCreate: 'terminal:create',
    terminalAttach: 'terminal:attach',
    terminalDetach: 'terminal:detach',
    terminalData: 'terminal:data',
    terminalWrite: 'terminal:write',
    terminalResize: 'terminal:resize',
    terminalClose: 'terminal:close',
    terminalRestart: 'terminal:restart',
    terminalText: 'terminal:text',
    /** Renderer → main answer to a main → renderer request (export/import). */
    reply: 'window:reply',
} as const
