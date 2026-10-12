// Routing groups: ordered lists of provider/model pairs that agents reach through the app's local
// gateway (electron/gateway). An agent points at the gateway instead of a vendor; the gateway sends
// each request to the first member that is not resting, and moves on to the next one when a member
// fails before the agent saw any output. Providers and keys are pi's (Settings → 供应商), so a
// group only names them.
//
// The gateway does not translate between wire protocols: a group speaks one API, and an agent can
// use the groups whose API it speaks.

import type { Localized } from './i18n'

export const ROUTE_APIS = ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'] as const
export type RouteApi = typeof ROUTE_APIS[number]

export const ROUTE_API_LABELS: Record<RouteApi, string> = {
    'anthropic-messages': 'Anthropic Messages',
    'openai-responses': 'OpenAI Responses',
    'openai-completions': 'OpenAI Chat',
    'google-generative-ai': 'Gemini',
}

export const isRouteApi = (v: unknown): v is RouteApi => (ROUTE_APIS as readonly unknown[]).includes(v)

/** Agents the app can point at the gateway. */
export const ROUTED_AGENTS = ['claude', 'codex', 'gemini', 'grok', 'pi'] as const
export type RoutedAgent = typeof ROUTED_AGENTS[number]

export const isRoutedAgent = (v: unknown): v is RoutedAgent => (ROUTED_AGENTS as readonly unknown[]).includes(v)

/** The wire APIs each agent speaks to its model; the first is what a new group for it uses. */
export const AGENT_APIS: Record<RoutedAgent, readonly RouteApi[]> = {
    claude: ['anthropic-messages'],
    codex: ['openai-responses'],
    gemini: ['google-generative-ai'],
    // Grok Build's custom models take api_backend chat_completions, responses or messages.
    grok: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    // pi speaks every API itself.
    pi: ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'],
}

export const ROUTED_AGENT_LABELS: Record<RoutedAgent, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini CLI',
    grok: 'Grok Build',
    pi: 'pi',
}

export interface RouteMember {
    provider: string
    model: string
    /** Paused: kept in its place, never sent to. */
    off?: boolean
}

export const memberKey = (m: { provider: string, model: string }) => `${m.provider}/${m.model}`

/** order: the first member that is ready, the next on failure. manual: only the picked member. */
export type RouteMode = 'order' | 'manual'

export interface RouteGroup {
    id: string
    name: string
    api: RouteApi
    mode: RouteMode
    members: RouteMember[]
    /** manual: the member in use (memberKey); the first one when unset or gone. */
    pick?: string
}

/** Agents whose terminal config the app can point at one group (pi lists every group as a model). */
export const TERMINAL_AGENTS = ['claude', 'codex'] as const
export type TerminalAgent = typeof TERMINAL_AGENTS[number]

/**
 * Groups are models: each shows up in the model picker of every agent that speaks its API, and a
 * thread picks one the way it picks any model. Nothing here says which agent uses which group.
 */
export interface RoutesConfig {
    groups: RouteGroup[]
    /**
     * Also point the agents' own config files at the gateway while the app runs, so they route in a
     * terminal too. Put back on quit.
     */
    syncTerminal: boolean
    /** The group terminal Claude Code / Codex use (their config names one endpoint for everything). */
    terminal: Partial<Record<TerminalAgent, string>>
}

export const EMPTY_ROUTES: RoutesConfig = { groups: [], syncTerminal: false, terminal: {} }

/** Groups an agent can use: the ones of its API. */
export const groupsFor = (config: RoutesConfig, agent: RoutedAgent): RouteGroup[] => config.groups.filter(g => AGENT_APIS[agent].includes(g.api))

/** Groups an agent can pick as a model: the ones it can use, with members. */
export const pickableGroups = (config: RoutesConfig, agent: RoutedAgent) => groupsFor(config, agent).filter(g => g.members.length > 0)

/**
 * What a terminal agent's own config points at, read from the file (electron/gateway/channel.ts).
 * Picking a provider model for Claude Code or Codex writes it there, as cc-switch does.
 */
export interface AgentChannel {
    /** The provider model the app put there, while the file still says so. */
    current?: { provider: string, model: string }
    /** Otherwise, an endpoint of the user's own (its host), or the group terminal sync points it at. */
    other?: string
    /** After a channel was picked: what going back gives, '' for the agent's own sign-in. */
    restore?: string
}

/** A model a group can name: one of pi's, from a provider signed in with a key. */
export interface RouteModel {
    provider: string
    providerName: string
    id: string
    name: string
    api: RouteApi
    contextWindow?: number
    maxTokens?: number
    reasoning?: boolean
    images?: boolean
    /** pi's own fields for the model, given to a pi thread that uses the group. */
    thinkingLevelMap?: Record<string, unknown>
    compat?: Record<string, unknown>
}

export interface RouteCatalog {
    models: RouteModel[]
    /** Configured providers the gateway cannot use, and why (subscription sign-in, other API). */
    skipped: { provider: string, name: string, reason: 'subscription' | 'api' }[]
    error?: string
}

// ---------------------------------------------------------------- live state

/** Why a member failed; each kind rests the member (or its whole provider) its own way. */
export type FailureKind =
    | 'network' // no answer: connection refused, reset, DNS, TLS
    | 'auth' // 401/403: the key is wrong or lacks access (whole provider)
    | 'credit' // 402 / balance: out of money (whole provider)
    | 'quota' // usage limit reached (whole provider)
    | 'rate' // 429 rate limit
    | 'server' // 5xx, 408, overloaded
    | 'model' // the provider does not serve this model
    | 'context' // the request does not fit this model: next member, no rest
    | 'empty' // 2xx with no API reply (HTML page, empty stream)
    | 'request' // the request itself is wrong: passed to the agent, no switch

export const FAILURE_LABELS: Record<FailureKind, Localized> = {
    network: { zh: '连不上', en: 'Unreachable' },
    auth: { zh: 'key 无效或无权限', en: 'Key rejected' },
    credit: { zh: '余额不足', en: 'Out of credit' },
    quota: { zh: '额度用完', en: 'Quota reached' },
    rate: { zh: '限流', en: 'Rate limited' },
    server: { zh: '服务出错', en: 'Server error' },
    model: { zh: '不提供这个模型', en: 'Model not served' },
    context: { zh: '上下文太长', en: 'Context too long' },
    empty: { zh: '没有返回内容', en: 'Empty reply' },
    request: { zh: '请求被拒', en: 'Request rejected' },
}

export interface MemberHealth {
    key: string
    /** Resting until (ms): tried last meanwhile. */
    restUntil?: number
    reason?: FailureKind
    lastError?: { kind: FailureKind, status: number, message: string, at: number }
    lastOk?: number
    served: number
    failed: number
}

/** One request that did not go to the first member it was planned for, or failed everywhere. */
export interface RouteEvent {
    at: number
    agent: RoutedAgent
    group: string
    /** Members that failed, in order, with why. */
    failed: { member: string, kind: FailureKind, status: number, message: string }[]
    /** The member that answered; none when every member failed. */
    served?: string
}

export interface RouteStatus {
    /** Gateway port; null while it is not listening. */
    port: number | null
    members: Record<string, MemberHealth>
    /** Rests that cover a whole provider (auth, credit, quota). */
    providers: Record<string, { restUntil: number, reason: FailureKind }>
    recent: RouteEvent[]
    /** Terminal sync problems, per agent file. */
    syncErrors: Partial<Record<RoutedAgent, string>>
}

/** What Settings → 路由 and the composer read. */
export interface RoutesState {
    config: RoutesConfig
    /** The catalog's models (the channels Claude Code and Codex can pick); null until it was first read. */
    models: RouteModel[] | null
    status: RouteStatus
    /**
     * Per agent, what its processes were started with: when it changes, idle threads of the agent
     * restart so they pick it up (pi's and Grok's model lists name the groups at startup).
     */
    launchKeys: Partial<Record<RoutedAgent, string>>
}

/** A thread's routing, chosen in its model picker. */
export interface ThreadRoute {
    /**
     * The group the thread's process is started on (Claude Code, Codex, Gemini, Grok: picking a
     * group restarts the agent onto it, resuming the session). pi switches by model instead.
     */
    group?: string
    /** Only this member (memberKey), as if the group were manual. */
    pin?: string
}

/** A thread's process as the gateway sees it. */
export interface ThreadRouteInfo {
    agent: RoutedAgent
    /** The group its last request went to (or would go to); undefined before one, or when deleted. */
    group?: RouteGroup
    override: ThreadRoute
    /** Member that answered the thread's last request. */
    served?: string
}

// ---------------------------------------------------------------- validation

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const GROUP_ID = /^[\w-]{1,64}$/

/** The provider groups go by as models (pi: filo/<group id>, Grok: filo-<group id>); never a member. */
export const ROUTES_PROVIDER = 'filo'

/** A RoutesConfig from disk or IPC with only known fields; bad entries are dropped. */
export function routesOf(value: unknown): RoutesConfig {
    const raw = isObject(value) ? value : {}
    const groups: RouteGroup[] = []
    for (const g of Array.isArray(raw.groups) ? raw.groups.slice(0, 200) : []) {
        if (!isObject(g) || !GROUP_ID.test(String(g.id)) || !isRouteApi(g.api) || groups.some(x => x.id === g.id))
            continue
        const members: RouteMember[] = []
        for (const m of Array.isArray(g.members) ? g.members.slice(0, 100) : []) {
            const provider = text(m?.provider, 200)
            const model = text(m?.model, 300)
            if (!provider || !model || provider === ROUTES_PROVIDER || members.some(x => x.provider === provider && x.model === model))
                continue
            members.push(m.off === true ? { provider, model, off: true } : { provider, model })
        }
        groups.push({
            id: g.id,
            name: text(g.name, 100) || g.id,
            api: g.api,
            mode: g.mode === 'manual' ? 'manual' : 'order',
            members,
            ...(typeof g.pick === 'string' && g.pick ? { pick: g.pick.slice(0, 600) } : {}),
        })
    }
    const terminal: RoutesConfig['terminal'] = {}
    const usable = (agent: TerminalAgent, id: unknown) => typeof id === 'string' && groups.some(g => g.id === id && AGENT_APIS[agent].includes(g.api))
    for (const agent of TERMINAL_AGENTS) {
        const id = isObject(raw.terminal) ? raw.terminal[agent] : undefined
        if (usable(agent, id))
            terminal[agent] = id
    }
    return { groups, syncTerminal: raw.syncTerminal === true, terminal }
}

/** The member a manual group (or a pin) sends to: the picked one if it is still listed and on, else the first on. */
export function pickedMember(group: RouteGroup, pin?: string): RouteMember | undefined {
    const on = group.members.filter(m => !m.off)
    return on.find(m => memberKey(m) === (pin ?? group.pick)) ?? on[0]
}
