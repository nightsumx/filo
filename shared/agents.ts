// Which coding agent a thread runs. pi is the native backend (its RPC mode, capability extensions,
// session files). Other agents speak ACP (Agent Client Protocol, JSON-RPC over stdio); the main
// process translates them into pi's event and message shapes, so the transcript code is shared.

export type AgentKind = 'pi' | AcpAgentId

export type AcpAgentId = 'codex'

export interface AcpAgentSpec {
    id: AcpAgentId
    label: string
    /** Adapter commands tried in order: a binary on the login shell's PATH, then an npm package run with npx. */
    bin: string
    npm: string
    /** The agent's own CLI, passed to the adapter so it uses the user's install and sign-in. */
    cli?: { bin: string, env: string }
}

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
    {
        id: 'codex',
        label: 'Codex',
        bin: 'codex-acp',
        npm: '@agentclientprotocol/codex-acp@2.1.1',
        cli: { bin: 'codex', env: 'CODEX_PATH' },
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
    compaction: boolean
    fork: boolean
    /** Thinking level as pi's levels; ACP agents expose theirs as a config option instead. */
    piPickers: boolean
    /** Agent-defined select options (ACP session config: mode, model, effort, …). */
    configOptions: boolean
    /** Edits attributed per session (pi's session files). */
    editLog: boolean
}

export function agentFeatures(kind: AgentKind): AgentFeatures {
    const pi = kind === 'pi'
    return { capabilities: pi, compaction: pi, fork: pi, piPickers: pi, configOptions: !pi, editLog: pi }
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
