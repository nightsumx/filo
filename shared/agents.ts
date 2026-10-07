// Which coding agent a thread runs. pi is the native backend (its RPC mode, capability extensions,
// session files). Other agents speak ACP (Agent Client Protocol, JSON-RPC over stdio); the main
// process translates them into pi's event and message shapes, so the transcript code is shared.

export type AgentKind = 'pi' | AcpAgentId

export type AcpAgentId = 'codex' | 'claude' | 'grok' | 'opencode' | 'gemini' | 'copilot' | 'cursor'

export interface AcpAgentSpec {
    id: AcpAgentId
    label: string
    /** The ACP command on the login shell's PATH (or in `dirs`), with its arguments. */
    bin: string
    args?: string[]
    /** Install folders the login shell may not have on PATH (`~/` is the home folder). */
    dirs?: string[]
    /** Fallback when `bin` is missing: an npm package run with npx, pinned. None: install it yourself. */
    npm?: string
    npmArgs?: string[]
    /** The agent's own CLI, passed to the adapter so it uses the user's install and sign-in. */
    cli?: { bin: string, env: string }
    /** An API key the agent takes from pi's auth.json (Model providers) when the environment has none. */
    apiKey?: { provider: string, env: string }
    /** What to do when the agent says it is not signed in. */
    signIn: { zh: string, en: string }
    /** Where to get it when it is neither installed nor on npm. */
    install?: string
    /**
     * Whether ACP `inputTokens` already counts cache reads (OpenAI style) or not (Anthropic style).
     * Undefined: decide from totalTokens.
     */
    inputIncludesCache?: boolean
}

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
    {
        id: 'codex',
        label: 'Codex',
        bin: 'codex-acp',
        npm: '@agentclientprotocol/codex-acp@2.1.1',
        cli: { bin: 'codex', env: 'CODEX_PATH' },
        inputIncludesCache: true,
        signIn: { zh: '在终端里运行 codex 完成登录', en: 'run codex in a terminal and sign in' },
    },
    {
        id: 'claude',
        label: 'Claude Code',
        // Anthropic does not allow claude.ai sign-in in third-party apps: the adapter's
        // --hide-claude-auth refuses turns a subscription would pay for, so an API key is needed.
        bin: 'claude-agent-acp',
        args: ['--hide-claude-auth'],
        npm: '@agentclientprotocol/claude-agent-acp@0.86.0',
        apiKey: { provider: 'anthropic', env: 'ANTHROPIC_API_KEY' },
        inputIncludesCache: false,
        signIn: {
            zh: '在 设置 → 模型供应商 里填 Anthropic 的 API key（Anthropic 不允许第三方应用使用 Claude 订阅）',
            en: 'enter an Anthropic API key in Settings → Model providers (Anthropic does not allow Claude subscriptions in third-party apps)',
        },
    },
    {
        id: 'grok',
        label: 'Grok Build',
        bin: 'grok',
        args: ['agent', 'stdio'],
        dirs: ['~/.grok/bin'],
        npm: '@xai-official/grok@1.0.50',
        npmArgs: ['agent', 'stdio'],
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
        npmArgs: ['acp'],
        signIn: { zh: '在终端里运行 opencode auth login', en: 'run opencode auth login in a terminal' },
    },
    {
        id: 'gemini',
        label: 'Gemini CLI',
        bin: 'gemini',
        args: ['--acp'],
        npm: '@google/gemini-cli@0.63.0',
        npmArgs: ['--acp'],
        apiKey: { provider: 'google', env: 'GEMINI_API_KEY' },
        inputIncludesCache: true,
        signIn: { zh: '在终端里运行 gemini 登录，或在 设置 → 模型供应商 里填 Google 的 API key', en: 'run gemini in a terminal and sign in, or enter a Google API key in Settings → Model providers' },
    },
    {
        id: 'copilot',
        label: 'GitHub Copilot',
        bin: 'copilot',
        args: ['--acp'],
        npm: '@github/copilot@1.0.92',
        npmArgs: ['--acp'],
        signIn: { zh: '在终端里运行 copilot 并用 /login 登录 GitHub', en: 'run copilot in a terminal and sign in with /login' },
    },
    {
        id: 'cursor',
        label: 'Cursor',
        bin: 'cursor-agent',
        args: ['acp'],
        dirs: ['~/.local/bin'],
        install: 'curl https://cursor.com/install -fsS | bash',
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
    /** The adapter command that will run, for the settings line. */
    command?: string
    /** Where the command comes from: installed, run through npx (downloaded on first use), or a test override. */
    via?: 'path' | 'npx' | 'override'
    error?: string
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
    images: boolean
}

export function agentFeatures(kind: AgentKind, caps?: AcpAgentCaps, commands: readonly { name: string }[] = []): AgentFeatures {
    const pi = kind === 'pi'
    return {
        capabilities: pi,
        // ACP agents compact with their own /compact command, when they have one.
        compaction: pi || commands.some(c => c.name === 'compact'),
        autoCompaction: pi,
        fork: pi,
        forkSession: !pi && !!caps?.fork,
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
}

export function acpCaps(init: any): AcpAgentCaps {
    const agent = init?.agentCapabilities ?? {}
    const session = agent.sessionCapabilities ?? {}
    return {
        images: !!agent.promptCapabilities?.image,
        steering: !!init?._meta?.steering?.supported,
        fork: !!session.fork,
        delete: !!session.delete,
        list: !!session.list,
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
