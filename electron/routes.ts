// Routing (Settings → 路由): the groups, the local gateway they run through, and what each agent
// the app starts needs to use it. Agents talk to the gateway with a key of their own process (a
// gateway session); the providers' real keys stay in this process, resolved through pi's helper.

import type { AcpAgentSpec } from '@shared/agents'
import type { AgentChannel, RouteCatalog, RouteGroup, RouteMember, RouteModel, RoutesConfig, RoutesState, RouteStatus, RoutedAgent, TerminalAgent, ThreadRoute, ThreadRouteInfo } from '@shared/routes'
import type { ChannelTarget, CodexLines } from './gateway/channel'
import type { AcpLaunch } from './acp/agent'
import type { CacheWarming } from '@shared/ipc'
import type { PriceList } from 'pi-capabilities/lib/prices.ts'
import type { GatewaySession, MemberTarget } from './gateway/server'
import type { WarmEntry } from './gateway/warm'
import type { JsonStashEntry } from './gateway/terminalSync'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pricedModel } from 'pi-capabilities/lib/prices.ts'
import { AGENT_APIS, EMPTY_ROUTES, groupsFor, isRoutedAgent, memberKey, pickableGroups, ROUTED_AGENT_LABELS, routesOf } from '@shared/routes'
import { grokBlock, grokModelId, withBlock } from './gateway/agentConfig'
import { claudeChannelEdits, codexChannelLines, codexChannelToml, codexLines, codexProviderId, codexTables, lineValue } from './gateway/channel'
import { Gateway, UnreachableMember } from './gateway/server'
import { applyJson, claudeEdits, codexToml, piEdits, restoreJson } from './gateway/terminalSync'

/** What the routing needs of pi's provider helper. */
export interface RouteHelper {
    routeCatalog: () => Promise<RouteCatalog>
    routeTarget: (provider: string, model: string) => Promise<MemberTarget>
}

export interface RoutesDeps {
    /** routes.json in the app's data folder. */
    file: string
    helper: RouteHelper
    /** Electron's fetch (system proxy). */
    fetch?: typeof fetch
    /** Settings or live status changed. */
    onChanged: (state: RoutesState) => void
    /** The routing pi extension (packages/capabilities/extensions/routes.ts). */
    piExtension: string
    /** Home folder for agent config files (tests point it elsewhere). */
    home?: string
    /** Where CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME and PI_CODING_AGENT_DIR come from (process.env). */
    env?: Record<string, string | undefined>
    /** Cache warming of threads on a channel: pi's setting and model list, and each warm, for the thread to show. */
    warming?: {
        mode: () => CacheWarming
        prices: () => PriceList
        warmed: (agentId: string, entry: WarmEntry) => void
    }
}

/** Agents a terminal can start routed (Settings → 路由 → terminal sync). */
const SYNCED_AGENTS = ['claude', 'codex', 'pi'] as const
type SyncedAgent = typeof SYNCED_AGENTS[number]

/** What terminal sync wrote, kept so it can be undone after a crash too. */
interface TerminalSaved {
    /** Each agent's terminal key for the gateway, while synced. */
    tokens?: Partial<Record<SyncedAgent, string>>
    /** Per file: the JSON keys set (Claude Code, pi), and whether the app created the file. */
    files?: Partial<Record<SyncedAgent, { entries?: JsonStashEntry[], created?: boolean }>>
}

/** The channel picked for a terminal agent, and what its config held before the first one. */
interface ChannelSaved {
    provider: string
    model: string
    /** Claude Code: the keys set, with what they held before. */
    entries?: JsonStashEntry[]
    /** Codex: its own top-level lines before. */
    lines?: CodexLines
}

interface Saved {
    config?: unknown
    /** The gateway port last used, tried first so config files written for it stay right. */
    port?: number
    terminal?: TerminalSaved
    /** The group each Claude Code / Codex / Gemini / Grok session was last on (session key → group). */
    sessions?: Record<string, string>
    channels?: Partial<Record<TerminalAgent, ChannelSaved>>
}

/** Sessions remembered; the oldest go first. */
const MAX_SESSIONS = 2000

const TARGET_TTL_MS = 10 * 60_000
const CATALOG_TTL_MS = 60_000
const STATUS_THROTTLE_MS = 400

/** The extra launch an agent process gets for routing, and the hooks for its lifetime. */
export interface RoutedLaunch {
    launch: AcpLaunch
    started: (agentId: string) => void
    exited: () => void
}

export interface RoutedPi {
    env: Record<string, string>
    args: string[]
    started: (agentId: string) => void
    exited: () => void
}

export class RoutesService {
    config: RoutesConfig = EMPTY_ROUTES
    readonly gateway: Gateway
    private port: number | undefined
    private targets = new Map<string, { at: number, target: Promise<MemberTarget> }>()
    private catalogCache: { at: number, catalog: Promise<RouteCatalog> } | undefined
    /** The models of the last catalog read without an error; null before one. */
    private models: RouteModel[] | null = null
    private syncErrors: RouteStatus['syncErrors'] = {}
    private statusTimer: ReturnType<typeof setTimeout> | undefined
    private saving: Promise<void> = Promise.resolve()
    private grokWritten = false
    private terminal: TerminalSaved = {}
    private sessions: Record<string, string> = {}
    private channels: Saved['channels'] = {}

    constructor(private deps: RoutesDeps) {
        try {
            const saved: Saved = JSON.parse(readFileSync(deps.file, 'utf8'))
            this.config = routesOf(saved.config)
            this.port = typeof saved.port === 'number' && saved.port > 1024 && saved.port < 65536 ? saved.port : undefined
            if (saved.terminal && typeof saved.terminal === 'object')
                this.terminal = saved.terminal
            if (saved.sessions && typeof saved.sessions === 'object')
                this.sessions = Object.fromEntries(Object.entries(saved.sessions).filter(([, g]) => typeof g === 'string'))
            if (saved.channels && typeof saved.channels === 'object')
                this.channels = saved.channels
        }
        catch {}
        this.gateway = new Gateway({
            groups: agent => groupsFor(this.config, agent),
            resolve: member => this.resolve(member),
            invalidate: provider => this.forget(provider),
            fetch: deps.fetch,
            onHealth: () => this.statusSoon(),
            onEvent: () => this.statusSoon(),
            warming: deps.warming && {
                mode: deps.warming.mode,
                // The channel's own entry when it knows the cache, else the maker's (side requests name other models).
                model: (session, id) => {
                    const list = deps.warming!.prices()
                    const own = list[`${session.channel?.provider}/${id}`]
                    return own?.promptCache ? own : pricedModel(list, session.agent === 'claude' ? 'claude' : 'codex', id) ?? own
                },
                warmed: (session, entry) => session.agentId && deps.warming!.warmed(session.agentId, entry),
            },
        })
    }

    private get home() {
        return this.deps.home ?? os.homedir()
    }

    // ---------------------------------------------------------------- state

    state(): RoutesState {
        return { config: this.config, models: this.models, status: this.status(), launchKeys: this.launchKeys() }
    }

    status(): RouteStatus {
        return { port: this.gateway.port, ...this.gateway.health.snapshot(), recent: this.gateway.recent, syncErrors: this.syncErrors }
    }

    private statusSoon() {
        if (this.statusTimer)
            return
        this.statusTimer = setTimeout(() => {
            this.statusTimer = undefined
            this.deps.onChanged(this.state())
        }, STATUS_THROTTLE_MS)
    }

    /** The groups pi and Grok list as models when they start (the others start on one group, per thread). */
    launchKeys(): RoutesState['launchKeys'] {
        const keys: RoutesState['launchKeys'] = {}
        for (const agent of ['grok', 'pi'] as const) {
            const groups = pickableGroups(this.config, agent)
            if (groups.length)
                keys[agent] = JSON.stringify(groups.map(g => [g.id, g.name, g.api]))
        }
        return keys
    }

    // ---------------------------------------------------------------- sessions

    /** The group a session was last on, for a thread that resumes it. */
    sessionGroup(key: string): string | undefined {
        const id = this.sessions[key]
        return id && this.config.groups.some(g => g.id === id) ? id : undefined
    }

    /** Remembers (or with no group, forgets) the group a session is on. */
    async setSessionGroup(key: string, group: string | undefined) {
        if (typeof key !== 'string' || !key || key.length > 4096 || this.sessions[key] === group)
            return
        delete this.sessions[key]
        if (group) {
            this.sessions[key] = group
            const keys = Object.keys(this.sessions)
            for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS)))
                delete this.sessions[old]
        }
        await this.persist()
    }

    async save(value: unknown) {
        const config = routesOf(value)
        this.config = config
        await this.persist()
        await this.applyFiles()
        this.deps.onChanged(this.state())
    }

    private persist(): Promise<void> {
        const data: Saved = { config: this.config, port: this.gateway.port ?? this.port, terminal: this.terminal, sessions: this.sessions, channels: this.channels }
        this.saving = this.saving.then(async () => {
            await mkdir(path.dirname(this.deps.file), { recursive: true })
            const tmp = `${this.deps.file}.tmp`
            await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
            await rename(tmp, this.deps.file)
        }).catch(() => {})
        return this.saving
    }

    // ---------------------------------------------------------------- providers

    /** Models groups can name; cached a minute (the helper runs pi). Windows hear when the models change. */
    catalog(force = false): Promise<RouteCatalog> {
        if (force || !this.catalogCache || Date.now() - this.catalogCache.at > CATALOG_TTL_MS) {
            const catalog = this.deps.helper.routeCatalog().then((catalog) => {
                if (!catalog.error && JSON.stringify(catalog.models) !== JSON.stringify(this.models)) {
                    this.models = catalog.models
                    this.deps.onChanged(this.state())
                }
                return catalog
            }, (error: Error): RouteCatalog => ({ models: [], skipped: [], error: error.message }))
            this.catalogCache = { at: Date.now(), catalog }
        }
        return this.catalogCache.catalog
    }

    /** pi's endpoint and key for a member, cached for a while; a rejected key drops it (forget). */
    private resolve(member: RouteMember): Promise<MemberTarget> {
        const key = memberKey(member)
        const cached = this.targets.get(key)
        if (cached && Date.now() - cached.at < TARGET_TTL_MS)
            return cached.target
        const target = this.deps.helper.routeTarget(member.provider, member.model).catch((error: Error) => {
            this.targets.delete(key)
            throw new UnreachableMember(error.message.startsWith('model-gone') ? 'model' : 'auth', helperMessage(error.message))
        })
        this.targets.set(key, { at: Date.now(), target })
        return target
    }

    private forget(provider: string) {
        for (const key of this.targets.keys()) {
            if (key.startsWith(`${provider}/`))
                this.targets.delete(key)
        }
    }

    /**
     * Keys or models changed in Settings → 供应商: look them up again, and give providers a fresh
     * chance. A channel's config holds a copy of its key, so it is written again.
     */
    async providersChanged() {
        this.targets.clear()
        this.catalogCache = undefined
        for (const provider of Object.keys(this.gateway.health.snapshot().providers))
            this.gateway.health.forgetProvider(provider)
        this.statusSoon()
        await this.catalog()
        const saved = this.channels?.claude
        if (saved && (await this.channel('claude')).current)
            await this.useChannel('claude', saved).catch(() => {})
        await this.refreshCodexTables().catch(() => {})
    }

    /** Codex's tables of pi providers, with the endpoint and key pi has for them now. */
    private async refreshCodexTables() {
        const file = this.terminalFile('codex')
        const text = await readText(file)
        const models = (await this.catalog()).models
        const tables: ChannelTarget[] = []
        for (const provider of codexTables(text)) {
            const model = models.find(m => m.provider === provider && AGENT_APIS.codex.includes(m.api))
            const target = model && await this.deps.helper.routeTarget(provider, model.id).catch(() => undefined)
            if (model && target)
                tables.push({ provider, model: model.id, providerName: model.providerName, target })
        }
        const next = codexChannelToml(text, codexLines(text), tables)
        if (next !== text)
            await writeFile(file, next)
    }

    // ---------------------------------------------------------------- gateway

    private async ensureGateway(): Promise<string> {
        if (!this.gateway.port) {
            await this.gateway.listen(this.port)
            if (this.gateway.port !== this.port) {
                this.port = this.gateway.port!
                await this.persist()
            }
        }
        return this.gateway.origin
    }

    /**
     * Starts the gateway when something needs it now (Grok's config names its port), and takes out
     * a block a crashed run left behind for a routing that is off now.
     */
    async init() {
        void this.catalog()
        await this.applyFiles(true).catch(() => {})
    }

    /** Agent config files the routing writes: Grok's models, and with terminal sync the others'. */
    private async applyFiles(check = false) {
        await this.applyGrok(check)
        for (const agent of SYNCED_AGENTS)
            await this.applyTerminal(agent)
    }

    /** Grok's models. `check` looks even when nothing was written. */
    private async applyGrok(check: boolean) {
        const grokGroups = pickableGroups(this.config, 'grok')
        if (!grokGroups.length && !this.grokWritten && !check)
            return
        const origin = grokGroups.length ? await this.ensureGateway() : ''
        const catalog = grokGroups.length ? await this.catalog() : undefined
        const block = grokGroups.length ? grokBlock(grokGroups, origin, { contextWindow: g => groupMeta(g, catalog!).contextWindow }) : undefined
        const file = this.grokConfig()
        try {
            const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT')
                    return ''
                throw error
            })
            const next = withBlock(text, block)
            if (next !== text) {
                await mkdir(path.dirname(file), { recursive: true })
                await writeFile(file, next)
            }
            this.grokWritten = !!block
            delete this.syncErrors.grok
        }
        catch (error: any) {
            this.syncErrors.grok = `${file}: ${error?.message ?? error}`
        }
    }

    /** Grok's config.toml (GROK_HOME, as Grok reads it). */
    private grokConfig(): string {
        return path.join((this.deps.env ?? process.env).GROK_HOME || path.join(this.home, '.grok'), 'config.toml')
    }

    /** The agent's config file a terminal-started process reads. */
    private terminalFile(agent: SyncedAgent): string {
        const env = this.deps.env ?? process.env
        if (agent === 'claude')
            return path.join(env.CLAUDE_CONFIG_DIR || path.join(this.home, '.claude'), 'settings.json')
        if (agent === 'codex')
            return path.join(env.CODEX_HOME || path.join(this.home, '.codex'), 'config.toml')
        return path.join(env.PI_CODING_AGENT_DIR || path.join(this.home, '.pi', 'agent'), 'models.json')
    }

    /** The terminal's gateway key for an agent, its session opened. */
    private terminalToken(agent: SyncedAgent): string {
        const tokens = this.terminal.tokens ??= {}
        const token = tokens[agent] ??= `filo-${randomBytes(24).toString('hex')}`
        const session = this.gateway.session(token) ?? this.gateway.open(agent, { token })
        // Claude Code and Codex in a terminal name no group: they use the one picked for them.
        session.startGroup = agent === 'pi' ? undefined : this.config.terminal[agent]
        return token
    }

    /**
     * Points the agent's own config at the gateway while terminal sync is on and the agent has a
     * group, and puts it back otherwise. The undo record is saved before the file is written.
     */
    private async applyTerminal(agent: SyncedAgent, off = false) {
        const groups = agent === 'pi' ? pickableGroups(this.config, 'pi') : []
        const want = !off && this.config.syncTerminal && (agent === 'pi' ? groups.length > 0 : !!this.usable(agent, this.config.terminal[agent]))
        const saved = this.terminal.files?.[agent]
        if (!want && !saved) {
            delete this.syncErrors[agent]
            return
        }
        const file = this.terminalFile(agent)
        try {
            let text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT')
                    return undefined
                throw error
            })
            const created = saved ? !!saved.created : text === undefined
            text ??= ''
            let next: string
            let entries: JsonStashEntry[] | undefined
            if (want) {
                const origin = await this.ensureGateway()
                const token = this.terminalToken(agent)
                if (agent === 'codex') {
                    next = codexToml(text, origin, token)
                }
                else {
                    const catalog = agent === 'pi' ? await this.catalog() : undefined
                    const edits = agent === 'claude'
                        ? claudeEdits(origin, token)
                        : piEdits(origin, token, groups.map(group => ({ group, ...groupMeta(group, catalog!) })))
                    ;({ text: next, stash: entries } = applyJson(text, edits, saved?.entries))
                }
            }
            else {
                next = agent === 'codex' ? codexToml(text) : restoreJson(text, saved?.entries ?? [])
            }
            const files = this.terminal.files ??= {}
            if (want) {
                files[agent] = { entries, created: created || undefined }
                await this.persist()
            }
            // A file the app created goes again once nothing but its own edits was in it.
            const empty = agent === 'codex' ? !next.trim() : /^\{\s*\}\s*$/.test(next)
            if (!want && created && empty)
                await unlink(file).catch(() => {})
            else if (next !== text) {
                await mkdir(path.dirname(file), { recursive: true })
                await writeFile(file, next)
            }
            if (!want) {
                delete files[agent]
                const token = this.terminal.tokens?.[agent]
                if (token) {
                    this.gateway.drop(token)
                    delete this.terminal.tokens![agent]
                }
                await this.persist()
            }
            delete this.syncErrors[agent]
        }
        catch (error: any) {
            this.syncErrors[agent] = `${file}: ${error?.message ?? error}`
        }
    }

    // ---------------------------------------------------------------- channels

    /** What the agent's own config points at now (the file is the truth: a terminal may have changed it). */
    async channel(agent: TerminalAgent): Promise<AgentChannel> {
        const text = await readText(this.terminalFile(agent))
        const saved = this.channels?.[agent]
        const result: AgentChannel = {}
        if (agent === 'claude') {
            let json: Record<string, any> = {}
            try {
                json = JSON.parse(text || '{}')
            }
            catch {}
            const url = json?.env?.ANTHROPIC_BASE_URL
            const ours = saved?.entries?.find(e => e.path.join('.') === 'env.ANTHROPIC_BASE_URL')
            if (saved && ours && url === ours.after)
                result.current = { provider: saved.provider, model: typeof json.model === 'string' ? json.model : saved.model }
            else if (typeof url === 'string' && url)
                result.other = hostOf(url)
            if (saved)
                result.restore = typeof ours?.before === 'string' && ours.before ? hostOf(ours.before) : ''
        }
        else {
            const lines = codexLines(text)
            const provider = lineValue(lines.model_provider)
            if (saved && provider === codexProviderId(saved.provider))
                result.current = { provider: saved.provider, model: lineValue(lines.model) ?? saved.model }
            else if (provider && provider !== 'openai')
                result.other = provider
            if (saved) {
                const before = lineValue(saved.lines?.model_provider ?? null)
                result.restore = before && before !== 'openai' ? before : ''
            }
        }
        if (this.terminal.files?.[agent])
            result.other = this.usable(agent, this.config.terminal[agent])?.name ?? result.other
        return result
    }

    /**
     * Points the agent's own config at a provider model (cc-switch's channel), or with none, puts back
     * what it held before the first one. The undo record is saved before the file is written.
     */
    async useChannel(agent: TerminalAgent, pick: { provider: string, model: string } | null): Promise<AgentChannel> {
        const saved = this.channels?.[agent]
        let channel: ChannelTarget | undefined
        if (pick) {
            const model = (await this.catalog()).models.find(m => m.provider === pick.provider && m.id === pick.model)
            if (!model || !AGENT_APIS[agent].includes(model.api))
                throw new Error(`${pick.provider}/${pick.model}: not a model ${ROUTED_AGENT_LABELS[agent]} can use`)
            const target = await this.deps.helper.routeTarget(pick.provider, pick.model).catch((error: Error) => {
                throw new Error(helperMessage(error.message))
            })
            channel = { ...pick, providerName: model.providerName, target }
        }
        else if (!saved) {
            return this.channel(agent)
        }
        // The file names one endpoint: a channel takes the place of terminal sync's group.
        if (this.config.terminal[agent]) {
            const terminal = { ...this.config.terminal }
            delete terminal[agent]
            this.config = { ...this.config, terminal }
            await this.applyTerminal(agent)
        }
        const file = this.terminalFile(agent)
        const text = await readText(file)
        const channels = this.channels ??= {}
        let next: string
        if (agent === 'claude') {
            if (channel) {
                const applied = applyJson(text, claudeChannelEdits(channel), saved?.entries)
                next = applied.text
                channels.claude = { provider: channel.provider, model: channel.model, entries: applied.stash }
            }
            else {
                next = restoreJson(text, saved!.entries ?? [])
                delete channels.claude
            }
        }
        else {
            const now = codexLines(text)
            const ours = saved && lineValue(now.model_provider) === codexProviderId(saved.provider)
            const before = ours && saved.lines ? saved.lines : now
            if (channel) {
                next = codexChannelToml(text, codexChannelLines(channel), [channel])
                channels.codex = { provider: channel.provider, model: channel.model, lines: before }
            }
            else {
                next = codexChannelToml(text, ours ? before : now)
                delete channels.codex
            }
        }
        await this.persist()
        if (next !== text) {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(file, next)
        }
        this.deps.onChanged(this.state())
        return this.channel(agent)
    }

    /** The group `id` names when the agent can use it. */
    private usable(agent: RoutedAgent, id: string | undefined): RouteGroup | undefined {
        return id ? pickableGroups(this.config, agent).find(g => g.id === id) : undefined
    }

    /**
     * Points an ACP agent's process at the gateway when its thread is on a group (Grok: whenever it
     * has groups to list), or Claude Code's and Codex's on the channel the app set, to keep its cache
     * warm; undefined leaves the launch as it was (the agent talks to its own vendor).
     */
    async routeAcp(spec: AcpAgentSpec, launch: AcpLaunch, route?: ThreadRoute): Promise<RoutedLaunch | undefined> {
        const agent = spec.id
        if (!isRoutedAgent(agent))
            return undefined
        const group = this.usable(agent, route?.group)
        const onChannel = !group && (agent === 'claude' || agent === 'codex') && this.deps.warming ? agent : undefined
        const saved = onChannel && this.channels?.[onChannel]
        // Codex's -c splits keys at dots.
        const channel = onChannel && saved && !saved.provider.includes('.') && (await this.channel(onChannel)).current ? { provider: saved.provider, model: saved.model } : undefined
        if (!group && !channel && (agent !== 'grok' || !pickableGroups(this.config, 'grok').length))
            return undefined
        const origin = await this.ensureGateway()
        const session = this.gateway.open(agent, { startGroup: group?.id, override: route?.pin ? { pin: route.pin } : {}, channel })
        const env = { ...launch.env }
        let args = [...launch.args]
        if (agent === 'claude') {
            env.ANTHROPIC_BASE_URL = origin
            env.ANTHROPIC_API_KEY = session.token
            for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])
                delete env[name]
        }
        else if (agent === 'codex') {
            env.FILO_GATEWAY_KEY = session.token
            // On a channel, its own table: the session stays on that provider for `codex resume` in a terminal.
            args.push(...(channel ? codexChannelArgs(origin, channel.provider) : codexArgs(origin)))
        }
        else if (agent === 'gemini') {
            env.GOOGLE_GEMINI_BASE_URL = origin
            env.GEMINI_API_KEY = session.token
            for (const name of ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'])
                delete env[name]
        }
        else {
            // Grok lists every group as a model (config.toml); the key comes from its environment.
            await this.applyFiles()
            env.FILO_GATEWAY_KEY = session.token
            if (group)
                args = withGrokModel(args, grokModelId(group.id))
        }
        return { launch: { ...launch, env, args }, ...this.lifetime(session) }
    }

    /** pi with the groups as `filo` models (packages/capabilities/extensions/routes.ts), when there are any. */
    async routePi(route?: ThreadRoute): Promise<RoutedPi | undefined> {
        const groups = pickableGroups(this.config, 'pi')
        if (!groups.length)
            return undefined
        const origin = await this.ensureGateway()
        const catalog = await this.catalog()
        const session = this.gateway.open('pi', { override: route?.pin ? { pin: route.pin } : {} })
        const models = groups.map(g => ({ id: g.id, name: `Filo · ${g.name}`, api: g.api, ...groupMeta(g, catalog) }))
        return {
            env: {
                FILO_GATEWAY_URL: origin,
                FILO_GATEWAY_KEY: session.token,
                FILO_ROUTE_MODELS: JSON.stringify(models),
            },
            args: ['-e', this.deps.piExtension],
            ...this.lifetime(session),
        }
    }

    /** A thread's run started or settled: warming goes on past it only when pi's setting says idle. */
    running(agentId: string, running: boolean) {
        const session = this.gateway.sessionOf(agentId)
        if (session)
            this.gateway.warmer.running(session.warm, running)
    }

    private lifetime(session: GatewaySession) {
        return {
            started: (agentId: string) => {
                session.agentId = agentId
            },
            exited: () => this.gateway.drop(session.token),
        }
    }

    // ---------------------------------------------------------------- threads

    threadInfo(agentId: string): ThreadRouteInfo | undefined {
        const session = this.gateway.sessionOf(agentId)
        if (!session)
            return undefined
        const groups = groupsFor(this.config, session.agent)
        const usable = (id: string | undefined) => (id ? groups.find(g => g.id === id) : undefined)
        const group = usable(session.lastGroup) ?? usable(session.startGroup)
        const sticky = group ? session.sticky[group.id] : undefined
        return { agent: session.agent, group, override: session.override, served: sticky?.member }
    }

    setThread(agentId: string, override: unknown): ThreadRouteInfo | undefined {
        const session = this.gateway.sessionOf(agentId)
        if (!session)
            return undefined
        const raw = override && typeof override === 'object' ? override as Record<string, unknown> : {}
        // The group is the process's (or for pi and Grok, the model's); only the pin changes in place.
        const next: ThreadRoute = {}
        if (typeof raw.pin === 'string' && raw.pin)
            next.pin = raw.pin.slice(0, 600)
        session.override = next
        return this.threadInfo(agentId)
    }

    /** Takes the app's lines back out of agent config files. */
    async shutdown() {
        clearTimeout(this.statusTimer)
        if (this.grokWritten) {
            const file = this.grokConfig()
            const text = await readFile(file, 'utf8').catch(() => undefined)
            if (text !== undefined) {
                const next = withBlock(text, undefined)
                if (next !== text)
                    await writeFile(file, next).catch(() => {})
            }
            this.grokWritten = false
        }
        // Terminals go back to their own settings while the app is not there to answer.
        for (const agent of SYNCED_AGENTS)
            await this.applyTerminal(agent, true)
        await this.gateway.close()
    }
}

const readText = (file: string) => readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
        return ''
    throw error
})

/** routeTarget's error without its kind. */
const helperMessage = (message: string) => {
    for (const kind of ['no-key: ', 'model-gone: ']) {
        if (message.startsWith(kind))
            return message.slice(kind.length)
    }
    return message
}

const hostOf = (url: string) => {
    try {
        return new URL(url).host
    }
    catch {
        return url
    }
}

/** What pi needs to know of a group as a model: the most any member allows, conservatively. */
export function groupMeta(group: RouteGroup, catalog: RouteCatalog): { contextWindow: number, maxTokens: number, reasoning: boolean, images: boolean, thinkingLevelMap?: Record<string, unknown>, compat?: Record<string, unknown> } {
    const models = group.members.filter(m => !m.off).map(m => catalog.models.find(c => c.provider === m.provider && c.id === m.model)).filter((m): m is RouteModel => !!m)
    if (!models.length)
        return { contextWindow: 128_000, maxTokens: 16_384, reasoning: false, images: false }
    const first = models[0]
    return {
        contextWindow: Math.min(...models.map(m => m.contextWindow || 128_000)),
        maxTokens: Math.min(...models.map(m => m.maxTokens || 16_384)),
        reasoning: models.every(m => m.reasoning),
        images: models.every(m => m.images),
        ...(first.thinkingLevelMap ? { thinkingLevelMap: first.thinkingLevelMap } : {}),
        ...(first.compat ? { compat: first.compat } : {}),
    }
}

/** `codex app-server` config overrides pointing it at the gateway's Responses API. */
export function codexArgs(origin: string): string[] {
    const set = (key: string, value: string) => ['-c', `${key}=${JSON.stringify(value)}`]
    return [
        ...set('model_provider', 'filo'),
        ...set('model_providers.filo.name', 'Filo'),
        ...set('model_providers.filo.base_url', `${origin}/v1`),
        ...set('model_providers.filo.env_key', 'FILO_GATEWAY_KEY'),
        ...set('model_providers.filo.wire_api', 'responses'),
    ]
}

/** `codex app-server` overrides pointing the channel's table at the gateway, with the session's key. */
export function codexChannelArgs(origin: string, provider: string): string[] {
    const table = `model_providers.${codexProviderId(provider)}`
    return [
        '-c', `${table}.base_url=${JSON.stringify(`${origin}/v1`)}`,
        '-c', `${table}.env_key="FILO_GATEWAY_KEY"`,
    ]
}

/** Grok's arguments with `-m <model>` for its agent subcommand. */
export function withGrokModel(args: string[], model: string): string[] {
    const at = args.indexOf('agent')
    if (at < 0)
        return [...args, '-m', model]
    return [...args.slice(0, at + 1), '-m', model, ...args.slice(at + 1)]
}
