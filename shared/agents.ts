// Which coding agent a thread runs. pi is the native backend (its RPC mode, capability extensions,
// session files). Other agents speak ACP (Agent Client Protocol, JSON-RPC over stdio); the main
// process translates them into pi's event and message shapes, so the transcript code is shared.

export type AgentKind = 'pi' | AcpAgentId

export type AcpAgentId = 'codex' | 'claude' | 'grok' | 'opencode' | 'gemini' | 'copilot' | 'cursor'

export interface AcpAgentSpec {
    id: AcpAgentId
    label: string
    /**
     * Protocol to use: 'acp' (default), 'codex-app-server', or 'claude-tui' (the CLI's own TUI, see
     * electron/native/claudeTui.ts). Native protocols bypass the ACP adapter.
     */
    protocol?: 'acp' | 'codex-app-server' | 'claude-tui'
    /** The ACP command on the login shell's PATH (or in `dirs`), with its arguments. */
    bin: string
    args?: string[]
    /** Install folders the login shell may not have on PATH (`~/` is the home folder). */
    dirs?: string[]
    /** What the app installs (into its own folder) when `bin` is not on PATH: a pinned npm package. */
    npm?: string
    /** Or a pinned archive per platform (`<os>-<arch>`, platform.target), with the command inside it. */
    archive?: Partial<Record<string, AgentArchive>>
    /**
     * The agent's own CLI, passed to the adapter so it uses the user's install and sign-in. Agents
     * like Codex and Claude Code need an ACP adapter on top of it; `dirs` are extra folders to look in.
     */
    cli?: { bin: string, env: string, dirs?: string[] }
    /** The variable the agent reads an API key from; set (by the user, or routing's gateway), a sign-in request picks the API-key method. */
    apiKeyEnv?: string
    /** What to do when the agent says it is not signed in. */
    signIn: { zh: string, en: string }
    /**
     * Whether ACP `inputTokens` already counts cache reads (OpenAI style) or not (Anthropic style).
     * Undefined: decide from totalTokens.
     */
    inputIncludesCache?: boolean
    /**
     * session/load answers before the history is all sent (Gemini CLI 0.63 does not await its
     * streamHistory): the load waits for the updates to go quiet before the session counts as open.
     */
    lateHistory?: boolean
}

export interface AgentArchive {
    url: string
    sha256: string
    /** The ACP command, relative to the unpacked archive. */
    cmd: string
}

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
    {
        id: 'codex',
        label: 'Codex',
        protocol: 'codex-app-server',
        bin: 'codex',
        args: ['app-server'],
        // Where Codex's own installer (chatgpt.com/codex/install.sh) puts it.
        dirs: ['~/.local/bin'],
        // The CLI itself speaks app-server; the version the adapter was checked against.
        npm: '@openai/codex@0.160.1',
        cli: { bin: 'codex', env: 'CODEX_PATH', dirs: ['~/.local/bin'] },
        inputIncludesCache: true,
        signIn: { zh: '在终端里运行 codex 完成登录', en: 'run codex in a terminal and sign in' },
    },
    {
        id: 'claude',
        label: 'Claude Code',
        // The user's own interactive `claude`, unmodified, in a terminal the thread holds
        // (electron/native/claudeTui.ts): it signs in and bills as it does in their terminal.
        protocol: 'claude-tui',
        bin: 'claude',
        // Where Claude Code's installer and its migrated local install put it.
        dirs: ['~/.local/bin', '~/.claude/local'],
        inputIncludesCache: false,
        signIn: {
            zh: '在这个对话的终端里运行 /login 登录',
            en: 'run /login in this thread\'s terminal',
        },
    },
    {
        id: 'grok',
        label: 'Grok Build',
        bin: 'grok',
        // The app pins its install, so the CLI must not update itself under it; --no-leader keeps the
        // session in this process rather than a shared ~/.grok/leader.sock one the user may enable.
        args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'],
        dirs: ['~/.grok/bin'],
        // npm's `latest`; newer versions are on the `alpha` tag.
        npm: '@xai-official/grok@1.0.46',
        inputIncludesCache: true,
        signIn: { zh: '在终端里运行 grok 完成登录', en: 'run grok in a terminal and sign in' },
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        bin: 'opencode',
        args: ['acp'],
        dirs: ['~/.opencode/bin', '~/.bun/bin'],
        npm: 'opencode-ai@1.18.35',
        signIn: { zh: '在终端里运行 opencode auth login', en: 'run opencode auth login in a terminal' },
    },
    {
        id: 'gemini',
        label: 'Gemini CLI',
        bin: 'gemini',
        args: ['--acp'],
        npm: '@google/gemini-cli@0.63.0',
        apiKeyEnv: 'GEMINI_API_KEY',
        inputIncludesCache: true,
        lateHistory: true,
        signIn: { zh: '在终端里运行 gemini 登录', en: 'run gemini in a terminal and sign in' },
    },
    {
        id: 'copilot',
        label: 'GitHub Copilot',
        bin: 'copilot',
        args: ['--acp'],
        npm: '@github/copilot@1.0.92',
        signIn: { zh: '在终端里运行 copilot 并用 /login 登录 GitHub', en: 'run copilot in a terminal and sign in with /login' },
    },
    {
        id: 'cursor',
        label: 'Cursor',
        bin: 'cursor-agent',
        args: ['acp'],
        dirs: ['~/.local/bin'],
        // From the ACP registry (cdn.agentclientprotocol.com/registry/v1/latest/registry.json); the
        // hashes are of the archives as downloaded (macOS 2026-10-07, Linux and Windows 2026-10-09;
        // the registry lists none for Cursor).
        archive: {
            'darwin-arm64': { url: 'https://downloads.cursor.com/lab/2026.10.01-14929f9/darwin/arm64/agent-cli-package.tar.gz', sha256: '778d04e542adc5c8b6760fda3ebe0757f903b1764f2792c232ef9a35e6e2151b', cmd: 'dist-package/cursor-agent' },
            'darwin-x64': { url: 'https://downloads.cursor.com/lab/2026.10.01-14929f9/darwin/x64/agent-cli-package.tar.gz', sha256: '8930008f9902a4d02d3185c0d34071e0536bac3426439b55bcfd48b78765a3dd', cmd: 'dist-package/cursor-agent' },
            'linux-arm64': { url: 'https://downloads.cursor.com/lab/2026.10.01-14929f9/linux/arm64/agent-cli-package.tar.gz', sha256: 'c31ef0ba6b827fdf8053919de57abae4a7bd71afefdf2cab061e276faac42b3a', cmd: 'dist-package/cursor-agent' },
            'linux-x64': { url: 'https://downloads.cursor.com/lab/2026.10.01-14929f9/linux/x64/agent-cli-package.tar.gz', sha256: 'ba9a855f8f813c91b9f2707127572d2dc9ae5a62818e1c36719625d0fb8bd452', cmd: 'dist-package/cursor-agent' },
            // A batch file that runs the PowerShell script next to it on the node.exe it ships.
            'win32-arm64': { url: 'https://downloads.cursor.com/lab/2026.10.01-14929f9/windows/arm64/agent-cli-package.zip', sha256: 'eda025bf9cc7632e48d290fa52468104916f0db261e2fa44306ad184cd1274c9', cmd: 'dist-package/cursor-agent.cmd' },
            'win32-x64': { url: 'https://downloads.cursor.com/lab/2026.10.01-14929f9/windows/x64/agent-cli-package.zip', sha256: '2558ae1ddc155f43791e8eed145afa0366c5ad6a266b0e40c0b5c9490a945a5f', cmd: 'dist-package/cursor-agent.cmd' },
        },
        signIn: { zh: '在终端里运行 cursor-agent login', en: 'run cursor-agent login in a terminal' },
    },
]

export const acpAgent = (id: string): AcpAgentSpec | undefined => ACP_AGENTS.find(a => a.id === id)

export function agentLabel(kind: AgentKind | undefined): string {
    return !kind || kind === 'pi' ? 'pi' : acpAgent(kind)?.label ?? kind
}

/** Whether an agent can be started here, and how; `error` says why not. */
export interface AgentAvailability {
    id: AgentKind
    label: string
    available: boolean
    /** The agent's own CLI, when found: with `available` false, only the ACP adapter is missing. */
    cli?: string
    /** The adapter command that will run, for the settings line. */
    command?: string
    /** Where the command comes from: the user's PATH, the app's own install, or a test override. */
    via?: 'path' | 'app' | 'override'
    error?: string
    /** Not installed (or the app's install is older than the pinned version), and the app can install it. */
    installable?: boolean
    /** The app's install is older than the version it would install now. */
    outdated?: boolean
    /** An install is running. */
    installing?: boolean
}

// ---------------------------------------------------------------- session keys

/**
 * ACP sessions have no file the app reads; their key is `acp:<agent>:<sessionId>`. It stands where a
 * pi session file path would (tab keys, SessionSummary.path), and never looks like an absolute path.
 */
const ACP_PREFIX = 'acp:'

export function acpSessionKey(agent: AcpAgentId, sessionId: string): string {
    return `${ACP_PREFIX}${agent}:${sessionId}`
}

export function parseAcpSessionKey(key: string | undefined): { agent: AcpAgentId, sessionId: string } | null {
    if (!key?.startsWith(ACP_PREFIX))
        return null
    const rest = key.slice(ACP_PREFIX.length)
    const colon = rest.indexOf(':')
    if (colon <= 0 || colon === rest.length - 1)
        return null
    const agent = rest.slice(0, colon)
    return acpAgent(agent) ? { agent: agent as AcpAgentId, sessionId: rest.slice(colon + 1) } : null
}

/** The agent behind a tab key or session path: pi unless it is an ACP session key. */
export function agentOfKey(key: string | undefined): AgentKind {
    return parseAcpSessionKey(key)?.agent ?? 'pi'
}

// ---------------------------------------------------------------- features

/** What the UI may offer for a thread; pi-only features stay hidden for other agents. */
export interface AgentFeatures {
    /** pi capability extensions (todo, ask, approval, plan, review, subagents). */
    capabilities: boolean
    /** Compact context on demand. */
    compaction: boolean
    /** Compaction takes a note on what to keep (pi's customInstructions, Claude Code's `/compact <note>`); Codex and Grok take none. */
    compactInstructions: boolean
    /** pi's own compaction point (settings, the status line's countdown). */
    autoCompaction: boolean
    /** Fork from any earlier prompt (pi). */
    fork: boolean
    /** Thinking level as pi's levels; ACP agents expose theirs as a config option instead. */
    piPickers: boolean
    /** Agent-defined select options (ACP session config: mode, model, effort, …). */
    configOptions: boolean
    /** Fork the whole session into a new thread (ACP session/fork). */
    forkSession: boolean
    /** Name the session, in the agent's own history. */
    rename: boolean
    images: boolean
}

export function agentFeatures(kind: AgentKind, caps?: AcpAgentCaps, commands: readonly { name: string }[] = []): AgentFeatures {
    const pi = kind === 'pi'
    return {
        capabilities: pi,
        // Claude Code and Codex compact through their own protocols; an ACP agent says so by listing /compact.
        compaction: pi || kind === 'claude' || kind === 'codex' || commands.some(c => c.name === 'compact'),
        compactInstructions: pi || kind === 'claude',
        autoCompaction: pi,
        fork: pi || !!caps?.forkAt,
        forkSession: !pi && !!caps?.fork,
        rename: pi || !!caps?.rename,
        images: pi || caps?.images !== false,
        piPickers: pi,
        configOptions: !pi,
    }
}

// ---------------------------------------------------------------- ACP agent capabilities

/** What an ACP agent said it can do (initialize), the parts the app acts on. */
export interface AcpAgentCaps {
    images: boolean
    /** `_session/steering`: a message typed mid-run joins the running turn. */
    steering: boolean
    /** session/fork (whole session). */
    fork: boolean
    /** session/delete: the agent's own history. */
    delete: boolean
    /** session/list. */
    list: boolean
    /** The agent keeps a name the user gives the session (Grok x.ai/session/rename, Codex thread/name/set, Claude /rename). */
    rename: boolean
    /**
     * Grok Build's `x.ai/…` extensions (initialize `_meta.grokShell`): steering is `x.ai/interject`,
     * fork / delete / rename are `x.ai/session/…`, and it asks the client questions and plan approvals.
     */
    xai: boolean
    /** Fork or resume at a specific message (Codex lastTurnId/beforeTurnId, Claude --resume-session-at). */
    forkAt?: boolean
    /** Rewind/truncate to a message (Codex thread/revert, Claude rewind_files). */
    rewind?: boolean
    /** Ask-user questions (Codex item/tool/requestUserInput, Claude AskUserQuestion). */
    ask?: boolean
    /** Plan mode + approval (Codex collaborationMode:'plan', Claude ExitPlanMode). */
    plan?: boolean
    /** Subagent tree (Codex collabAgentToolCall, Claude Task with parent_tool_use_id). */
    subagents?: boolean
}

export function acpCaps(init: any): AcpAgentCaps {
    const agent = init?.agentCapabilities ?? {}
    const session = agent.sessionCapabilities ?? {}
    const xai = init?._meta?.grokShell === true
    return {
        images: !!agent.promptCapabilities?.image,
        steering: xai || !!init?._meta?.steering?.supported,
        fork: xai || !!session.fork,
        delete: xai || !!session.delete,
        list: !!session.list,
        rename: xai,
        xai,
    }
}

// ---------------------------------------------------------------- ACP session config

/** ACP session config option (select type), as the agent declares it. */
export interface AcpConfigOption {
    id: string
    name: string
    description?: string
    /** model / thought_level / mode / …: lets the UI place well-known options. */
    category?: string
    currentValue: string
    options: { value: string, name: string, description?: string }[]
}
