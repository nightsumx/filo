// The local gateway: an HTTP server on 127.0.0.1 that agents use as their model endpoint. Each agent
// process gets its own token (a session), so a thread's choices in the composer apply to its own
// requests and the gateway knows which group a request is for. A request goes to the members of
// that group in plan order (policy.ts); a member that fails before the agent saw any output is
// rested and the next one tried, so the agent never sees the failure.
//
// Streams are held back until their first real output (wire.ts judgeEvent): a provider that accepts
// the request and then reports an overload or quota error in the stream still counts as failed.
// While held for long, the agent gets SSE comments so its idle timeout does not fire.
//
// A session on a channel (Claude Code, Codex on one of pi's providers) has no group: its requests go
// to that provider as they came, with pi's key, so the gateway can keep their cache warm (warm.ts).

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { CacheWarming } from '@shared/ipc'
import type { PricedModel } from 'pi-capabilities/lib/prices.ts'
import type { FailureKind, RouteApi, RouteEvent, RouteGroup, RouteMember, RoutedAgent, ThreadRoute } from '@shared/routes'
import type { Failure, Verdict } from './policy'
import type { Incoming } from './wire'
import type { WarmEntry, WarmState } from './warm'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { memberKey } from '@shared/routes'
import { classify, Health, plan, retryAfterMs } from './policy'
import { AnswerTap, Warmer } from './warm'
import { authHeaders, bodyError, errorBody, errorEvent, errorMessage, incoming, judgeEvent, refusesForeignReasoning, SseSplitter, upstreamUrl, wantsStream, withModel, withoutReasoning } from './wire'

/** Where and how to reach one member: pi's endpoint and key for that provider and model. */
export interface MemberTarget {
    api: string
    baseUrl: string
    apiKey?: string
    headers?: Record<string, string>
}

/** Thrown by `resolve` when a member cannot be reached at all (no key, model gone). */
export class UnreachableMember extends Error {
    constructor(readonly kind: FailureKind, message: string) {
        super(message)
    }
}

export interface GatewaySession {
    token: string
    agent: RoutedAgent
    /** The app's agent id, once the process runs; undefined for terminal sessions. */
    agentId?: string
    /** Group the process started on, used when the agent's group is later cleared. */
    startGroup?: string
    override: ThreadRoute
    /** Group of the last request. */
    lastGroup?: string
    /** Per group, the member that answered last and when, to keep the session on it while its cache is warm. */
    sticky: Record<string, { member: string, at: number }>
    /** The channel's provider and the model pi resolves its endpoint by; the agent names its own models. */
    channel?: RouteMember
    warm: WarmState
}

export interface GatewayHooks {
    /** The groups an agent can use (groupsFor). */
    groups: (agent: RoutedAgent) => RouteGroup[]
    resolve: (member: RouteMember) => Promise<MemberTarget>
    /** A provider rejected its key: drop what resolve cached for it. */
    invalidate?: (provider: string) => void
    fetch?: typeof fetch
    /** A session's request was answered by `member`. */
    onServed?: (session: GatewaySession, member: string) => void
    /** A request was rerouted or failed everywhere. */
    onEvent?: (event: RouteEvent) => void
    /** Rests or counts changed. */
    onHealth?: () => void
    now?: () => number
    /** Held streams get their first keep-alive after this long. */
    keepAliveMs?: number
    /** A member with no output after this long is given up on when another member is left. */
    firstOutputMs?: number
    /** Cache warming of channel sessions: pi's setting, pi's model of an id the agent asked for, each warm done. */
    warming?: {
        mode: () => CacheWarming
        model: (session: GatewaySession, id: string) => PricedModel | undefined
        warmed: (session: GatewaySession, entry: WarmEntry) => void
    }
}

const MAX_BODY = 256 * 1024 * 1024
const ERROR_TEXT_LIMIT = 64 * 1024
const HOLD_LIMIT = 1024 * 1024
const HEADERS_TIMEOUT_MS = 10 * 60_000
const KEEP_ALIVE_EVERY_MS = 15_000
const RECENT_EVENTS = 50

/** Request headers the gateway sets itself or that must not reach a provider. */
const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'authorization', 'x-api-key', 'x-goog-api-key', 'accept-encoding', 'cookie', 'origin', 'referer', 'x-filo-session'])
/** Response headers that describe the upstream body as sent, which fetch already decoded. */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'])

const isLocalHost = (host: string | undefined) => {
    if (!host)
        return false
    const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
    return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** The gateway token a request carries, wherever its client puts keys. */
function tokensOf(req: IncomingMessage, url: URL): string[] {
    const out: string[] = []
    const add = (v: unknown) => typeof v === 'string' && v && out.push(v.trim())
    add(req.headers['x-filo-session'])
    add(req.headers['x-api-key'])
    const auth = req.headers.authorization
    if (typeof auth === 'string' && /^bearer\s+/i.test(auth))
        add(auth.replace(/^bearer\s+/i, ''))
    add(req.headers['x-goog-api-key'])
    add(url.searchParams.get('key'))
    return out
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY)
            throw Object.assign(new Error('request too large'), { status: 413 })
        chunks.push(chunk)
    }
    return Buffer.concat(chunks)
}

/** Reads at most `limit` characters of a body, then stops reading. */
async function readText(response: Response, limit: number): Promise<string> {
    if (!response.body)
        return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
        for (; ;) {
            const { done, value } = await reader.read()
            if (done)
                break
            text += decoder.decode(value, { stream: true })
            if (text.length >= limit) {
                void reader.cancel().catch(() => {})
                break
            }
        }
    }
    catch {}
    return text.slice(0, limit)
}

/** The response to the agent: holds its headers back until a member commits, with keep-alives meanwhile. */
class ClientOut {
    private timer: ReturnType<typeof setTimeout> | undefined
    committed = false

    /** `tap` sees the answer as it passes. */
    constructor(private res: ServerResponse, private api: RouteApi, stream: boolean, keepAliveMs: number, private tap?: (text: string) => void) {
        // Gemini's SDK reads `data:` lines from the start of its buffer and stalls on comments.
        if (stream && api !== 'google-generative-ai')
            this.timer = setTimeout(() => this.keepAlive(), keepAliveMs)
    }

    private keepAlive() {
        if (this.committed || this.res.writableEnded)
            return
        if (!this.res.headersSent)
            this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        this.res.write(': filo keep-alive\n\n')
        this.timer = setTimeout(() => this.keepAlive(), KEEP_ALIVE_EVERY_MS)
    }

    private stop() {
        clearTimeout(this.timer)
        this.timer = undefined
    }

    get closed() {
        return this.res.writableEnded || this.res.destroyed
    }

    commit(status: number, headers: Headers) {
        this.stop()
        this.committed = true
        if (this.res.headersSent)
            return
        const out: Record<string, string> = {}
        headers.forEach((value, name) => {
            if (!DROP_RESPONSE.has(name))
                out[name] = value
        })
        this.res.writeHead(status, out)
    }

    write(text: string) {
        this.tap?.(text)
        if (!this.closed)
            this.res.write(text)
    }

    end(text?: string) {
        this.stop()
        if (text)
            this.tap?.(text)
        if (!this.closed)
            this.res.end(text)
    }

    /** An error to the agent: the provider's own answer when there is one, else the gateway's. */
    fail(status: number, text: string, headers?: Headers) {
        this.stop()
        if (this.closed)
            return
        if (this.res.headersSent) {
            this.res.end(errorEvent(this.api, status, errorMessage(text) || text))
            return
        }
        const out: Record<string, string> = { 'content-type': headers?.get('content-type') ?? 'application/json' }
        const retry = headers?.get('retry-after')
        if (retry)
            out['retry-after'] = retry
        this.res.writeHead(status, out)
        this.res.end(text)
    }
}

type Attempt =
    | { type: 'served' }
    | { type: 'failed', failure: Failure, verdict: Verdict, raw?: { status: number, headers: Headers, text: string }, committed: boolean }

export class Gateway {
    readonly health: Health
    private sessions = new Map<string, GatewaySession>()
    private server: Server | null = null
    private recentEvents: RouteEvent[] = []
    private fetcher: typeof fetch
    private now: () => number
    readonly warmer: Warmer
    port: number | null = null

    constructor(private hooks: GatewayHooks) {
        this.now = hooks.now ?? Date.now
        this.health = new Health(this.now)
        this.fetcher = hooks.fetch ?? fetch
        this.warmer = new Warmer({
            fetch: this.fetcher,
            now: this.now,
            mode: () => hooks.warming?.mode() ?? 'off',
            warmed: (state, entry) => {
                const session = [...this.sessions.values()].find(s => s.warm === state)
                if (session)
                    hooks.warming?.warmed(session, entry)
            },
        })
    }

    /** Listens on 127.0.0.1, on `preferred` when it is free (terminal configs name the port), else any. */
    async listen(preferred?: number): Promise<number> {
        if (this.server && this.port)
            return this.port
        const server = createServer((req, res) => void this.handle(req, res).catch((error) => {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' })
            if (!res.writableEnded)
                res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
        }))
        // Streams can run for long; the agent's own timeouts apply.
        server.requestTimeout = 0
        server.headersTimeout = 60_000
        const tryPort = (port: number) => new Promise<number>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off('listening', onListening)
                reject(error)
            }
            const onListening = () => {
                server.off('error', onError)
                const address = server.address()
                resolve(typeof address === 'object' && address ? address.port : port)
            }
            server.once('error', onError)
            server.once('listening', onListening)
            server.listen(port, '127.0.0.1')
        })
        let port: number
        try {
            port = await tryPort(preferred ?? 0)
        }
        catch (error) {
            if (!preferred)
                throw error
            port = await tryPort(0)
        }
        this.server = server
        this.port = port
        return port
    }

    close(): Promise<void> {
        const server = this.server
        this.server = null
        this.port = null
        return new Promise(resolve => (server ? server.close(() => resolve()) : resolve()))
    }

    get origin(): string {
        return `http://127.0.0.1:${this.port}`
    }

    /** A session for an agent process (or a terminal agent): its token goes into the agent's env. */
    open(agent: RoutedAgent, options: { startGroup?: string, override?: ThreadRoute, token?: string, channel?: RouteMember } = {}): GatewaySession {
        const session: GatewaySession = {
            token: options.token ?? `filo-${randomBytes(24).toString('hex')}`,
            agent,
            startGroup: options.startGroup,
            override: options.override ?? {},
            sticky: {},
            channel: options.channel,
            warm: { running: false, runs: new Map() },
        }
        this.sessions.set(session.token, session)
        return session
    }

    session(token: string): GatewaySession | undefined {
        return this.sessions.get(token)
    }

    sessionOf(agentId: string): GatewaySession | undefined {
        for (const session of this.sessions.values()) {
            if (session.agentId === agentId)
                return session
        }
        return undefined
    }

    drop(token: string) {
        const session = this.sessions.get(token)
        if (session)
            this.warmer.stop(session.warm)
        this.sessions.delete(token)
    }

    get recent(): RouteEvent[] {
        return [...this.recentEvents]
    }

    /** The group a session's request goes to; see the order in the comment of `handle`. */
    groupFor(session: GatewaySession, api: RouteApi, model: string | undefined): RouteGroup | undefined {
        const groups = this.hooks.groups(session.agent)
        const usable = (id: string | undefined) => (id ? groups.find(g => g.id === id && g.api === api) : undefined)
        return usable(model) ?? usable(session.startGroup)
    }

    /**
     * One agent request. Its group is the model the agent asked for when that names a group (pi and
     * Grok pick groups as models), else the group its process started on (Claude Code, Codex, Gemini:
     * every request of the process, Haiku side requests included).
     */
    private async handle(req: IncomingMessage, res: ServerResponse) {
        // Browsers cannot read the token, but a page could still try: only local names are served.
        if (!isLocalHost(req.headers.host)) {
            res.writeHead(403).end()
            return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const session = tokensOf(req, url).map(t => this.sessions.get(t)).find(Boolean)
        if (!session) {
            res.writeHead(401, { 'content-type': 'application/json' }).end(errorBody('openai-completions', 401, 'Unknown Filo gateway token'))
            return
        }
        if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
            const groups = this.hooks.groups(session.agent)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ object: 'list', data: groups.map(g => ({ id: g.id, object: 'model', type: 'model', display_name: g.name, owned_by: 'filo' })), has_more: false }))
            return
        }
        const target = incoming(url.pathname)
        if (req.method !== 'POST' || !target) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(errorBody('openai-completions', 404, `Not served by the Filo gateway: ${req.method} ${url.pathname}`))
            return
        }
        let raw: Buffer
        try {
            raw = await readBody(req)
        }
        catch (error: any) {
            res.writeHead(error?.status ?? 400, { 'content-type': 'application/json' }).end(errorBody(target.api, error?.status ?? 400, String(error?.message ?? error)))
            return
        }
        let body: any
        try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
        }
        catch {
            res.writeHead(400, { 'content-type': 'application/json' }).end(errorBody(target.api, 400, 'Request body is not JSON'))
            return
        }
        const asked = target.model ?? (typeof body?.model === 'string' ? body.model : undefined)
        const group = this.groupFor(session, target.api, asked)
        const channel = group ? undefined : session.channel
        const stream = wantsStream(target, body)
        const answer = channel ? new AnswerTap(target.api, stream) : undefined
        const out = new ClientOut(res, target.api, stream, this.hooks.keepAliveMs ?? 15_000, answer && (text => answer.push(text)))
        const abort = new AbortController()
        res.on('close', () => {
            if (!res.writableFinished)
                abort.abort()
        })
        const forward: Record<string, string> = {}
        for (const [name, value] of Object.entries(req.headers)) {
            // sec-*: set by fetch itself (Node's adds sec-fetch-mode), and Electron's net.fetch refuses them.
            if (!DROP_REQUEST.has(name) && !name.startsWith('sec-') && typeof value === 'string')
                forward[name] = value
        }
        url.searchParams.delete('key')
        const search = url.searchParams.size ? `?${url.searchParams}` : ''

        if (channel) {
            let endpoint: MemberTarget
            try {
                endpoint = await this.hooks.resolve(channel)
            }
            catch (error) {
                out.fail(502, errorBody(target.api, 502, `Filo: ${String((error as Error)?.message ?? error)}`))
                return
            }
            const attempt = await this.attempt(target, endpoint, channel.model, body, forward, search, out, abort.signal, true)
            if (attempt.type === 'served') {
                if (target.op === '/messages' || target.op === '/responses') {
                    const request = { api: target.api, url: upstreamUrl(target, endpoint.baseUrl, channel.model, search), headers: { ...forward, ...endpoint.headers, ...authHeaders(target.api, endpoint.apiKey), 'content-type': 'application/json' }, body }
                    this.warmer.served(session.warm, request, channel.provider, this.hooks.warming?.model(session, String(body?.model ?? '')), answer?.tokens())
                }
            }
            else if (attempt.committed) {
                out.end()
            }
            else {
                if (attempt.failure.kind === 'auth')
                    this.hooks.invalidate?.(channel.provider)
                out.fail(attempt.raw?.status ?? 502, attempt.raw?.text ?? errorBody(target.api, 502, attempt.failure.message), attempt.raw?.headers)
            }
            return
        }
        if (!group) {
            const message = `Filo: no ${target.api} routing group for ${session.agent}. It may have been deleted or changed to another API; pick one in Settings → Routing.`
            out.fail(400, errorBody(target.api, 400, message))
            return
        }
        session.lastGroup = group.id
        const candidates = plan(group, { pin: session.override.pin, sticky: session.sticky[group.id], health: this.health, now: this.now() })
        if (!candidates.length) {
            out.fail(503, errorBody(target.api, 503, `Filo: routing group "${group.name}" has no member turned on`))
            return
        }

        const failed: RouteEvent['failed'] = []
        let last: Attempt | undefined
        for (let i = 0; i < candidates.length && !abort.signal.aborted; i++) {
            const member = candidates[i]
            const key = memberKey(member)
            const isLast = i === candidates.length - 1
            let attempt: Attempt
            try {
                const endpoint = await this.hooks.resolve(member)
                let send = withModel(target, body, member.model)
                attempt = await this.attempt(target, endpoint, member.model, send, forward, search, out, abort.signal, isLast)
                // Reasoning signed by another provider: once more without it, on the same member.
                if (attempt.type === 'failed' && !attempt.committed && refusesForeignReasoning(attempt.failure.status, attempt.failure.message)) {
                    const stripped = withoutReasoning(target.api, send)
                    if (stripped) {
                        send = stripped
                        attempt = await this.attempt(target, endpoint, member.model, send, forward, search, out, abort.signal, isLast)
                    }
                }
            }
            catch (error) {
                const kind = error instanceof UnreachableMember ? error.kind : 'network'
                const failure: Failure = { kind, status: 0, message: String((error as Error)?.message ?? error) }
                attempt = { type: 'failed', failure, verdict: { kind, next: true, rest: kind === 'auth' ? 'provider' : 'member' }, committed: false }
            }
            last = attempt
            if (attempt.type === 'served') {
                this.health.ok(member)
                session.sticky[group.id] = { member: key, at: this.now() }
                this.hooks.onServed?.(session, key)
                if (failed.length)
                    this.record({ at: this.now(), agent: session.agent, group: group.id, failed, served: key })
                this.hooks.onHealth?.()
                return
            }
            if (abort.signal.aborted)
                return
            this.health.fail(member, attempt.failure, attempt.verdict)
            if (attempt.failure.kind === 'auth')
                this.hooks.invalidate?.(member.provider)
            failed.push({ member: key, kind: attempt.failure.kind, status: attempt.failure.status, message: attempt.failure.message.slice(0, 300) })
            if (session.sticky[group.id]?.member === key)
                delete session.sticky[group.id]
            this.hooks.onHealth?.()
            // Past the first output nothing can move; a refusal of the request is the agent's to see.
            if (attempt.committed || !attempt.verdict.next)
                break
        }
        if (failed.length)
            this.record({ at: this.now(), agent: session.agent, group: group.id, failed })
        if (last?.type === 'failed' && last.committed) {
            out.end()
            return
        }
        if (last?.type === 'failed' && last.raw) {
            out.fail(last.raw.status, last.raw.text, last.raw.headers)
            return
        }
        const message = failed.length
            ? `Filo: every member of "${group.name}" failed. ${failed.map(f => `${f.member}: ${f.message || f.kind}`).join('; ')}`
            : 'Filo: request cancelled'
        out.fail(502, errorBody(target.api, 502, message))
    }

    private record(event: RouteEvent) {
        this.recentEvents.unshift(event)
        this.recentEvents.length = Math.min(this.recentEvents.length, RECENT_EVENTS)
        this.hooks.onEvent?.(event)
    }

    /** Sends the request to one member and, when it answers, passes the answer on to the agent. */
    private async attempt(target: Incoming, endpoint: MemberTarget, model: string, body: any, forward: Record<string, string>, search: string, out: ClientOut, signal: AbortSignal, isLast: boolean): Promise<Attempt> {
        const failure = (status: number, message: string, raw?: { status: number, headers: Headers, text: string }, retryAfter?: number): Attempt => {
            const verdict = classify(status, message)
            return { type: 'failed', failure: { kind: verdict.kind, status, message, retryAfter }, verdict, raw, committed: false }
        }
        const upstream = new AbortController()
        const onAbort = () => upstream.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        const headersTimer = setTimeout(() => upstream.abort(new Error('no answer in 10 minutes')), HEADERS_TIMEOUT_MS)
        let response: Response
        try {
            response = await this.fetcher(upstreamUrl(target, endpoint.baseUrl, model, search), {
                method: 'POST',
                headers: { ...forward, ...endpoint.headers, ...authHeaders(target.api, endpoint.apiKey), 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: upstream.signal,
            })
        }
        catch (error: any) {
            clearTimeout(headersTimer)
            signal.removeEventListener('abort', onAbort)
            return failure(0, String(error?.cause?.message ?? error?.message ?? error))
        }
        clearTimeout(headersTimer)
        try {
            const type = response.headers.get('content-type') ?? ''
            if (!response.ok) {
                const text = await readText(response, ERROR_TEXT_LIMIT)
                return failure(response.status, errorMessage(text) || `HTTP ${response.status}`, { status: response.status, headers: response.headers, text }, retryAfterMs(response.headers.get('retry-after'), this.now()))
            }
            if (type.includes('text/html')) {
                await response.body?.cancel().catch(() => {})
                return { ...failure(502, 'HTML page instead of an API reply'), failure: { kind: 'empty', status: 502, message: 'HTML page instead of an API reply' }, verdict: { kind: 'empty', next: true, rest: 'member' } } as Attempt
            }
            if (!type.includes('text/event-stream')) {
                const text = await response.text()
                const hidden = bodyError(target.api, text)
                if (hidden)
                    return failure(hidden.status, hidden.message, { status: hidden.status, headers: response.headers, text })
                out.commit(response.status, response.headers)
                out.end(text)
                return { type: 'served' }
            }
            return await this.relayStream(target.api, response, out, isLast)
        }
        catch (error: any) {
            return failure(0, String(error?.cause?.message ?? error?.message ?? error))
        }
        finally {
            signal.removeEventListener('abort', onAbort)
        }
    }

    /** Holds a stream until its first output, then passes it through. */
    private async relayStream(api: RouteApi, response: Response, out: ClientOut, isLast: boolean): Promise<Attempt> {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        const splitter = new SseSplitter()
        let held = ''
        let events = 0
        let midStreamError: { status: number, message: string } | undefined
        const firstOutputMs = this.hooks.firstOutputMs ?? 120_000
        let giveUp: ReturnType<typeof setTimeout> | undefined
        let gaveUp = false
        // With another member left, a member that never starts its answer is given up on.
        if (!isLast) {
            giveUp = setTimeout(() => {
                gaveUp = true
                void reader.cancel().catch(() => {})
            }, firstOutputMs)
        }
        const commit = () => {
            clearTimeout(giveUp)
            out.commit(response.status, response.headers)
            out.write(held)
            held = ''
        }
        const failed = (status: number, message: string, committed: boolean): Attempt => {
            const verdict = classify(status, message)
            return { type: 'failed', failure: { kind: verdict.kind, status, message }, verdict, committed }
        }
        try {
            for (; ;) {
                let chunk: ReadableStreamReadResult<Uint8Array>
                try {
                    chunk = await reader.read()
                }
                catch (error: any) {
                    if (gaveUp)
                        return failed(504, `no output in ${Math.round(firstOutputMs / 1000)}s`, false)
                    return failed(0, String(error?.cause?.message ?? error?.message ?? error), out.committed)
                }
                if (chunk.done)
                    break
                const text = decoder.decode(chunk.value, { stream: true })
                for (const event of splitter.push(text)) {
                    events++
                    const verdict = judgeEvent(api, event)
                    if (out.committed) {
                        if (verdict.type === 'error')
                            midStreamError ??= verdict
                        out.write(event)
                        continue
                    }
                    if (verdict.type === 'error') {
                        void reader.cancel().catch(() => {})
                        clearTimeout(giveUp)
                        return { ...failed(verdict.status, verdict.message, false), raw: { status: verdict.status, headers: new Headers({ 'content-type': 'application/json' }), text: errorBody(api, verdict.status, verdict.message) } } as Attempt
                    }
                    held += event
                    if (verdict.type === 'output' || held.length > HOLD_LIMIT)
                        commit()
                }
                if (gaveUp && !out.committed)
                    return failed(504, `no output in ${Math.round(firstOutputMs / 1000)}s`, false)
            }
            const rest = splitter.rest() + decoder.decode()
            if (!out.committed) {
                clearTimeout(giveUp)
                if (gaveUp)
                    return failed(504, `no output in ${Math.round(firstOutputMs / 1000)}s`, false)
                if (!events && !rest.trim())
                    return { type: 'failed', failure: { kind: 'empty', status: 502, message: 'empty stream' }, verdict: { kind: 'empty', next: true, rest: 'member' }, committed: false }
                commit()
            }
            out.end(rest)
            if (midStreamError)
                return failed(midStreamError.status, midStreamError.message, true)
            return { type: 'served' }
        }
        finally {
            clearTimeout(giveUp)
        }
    }
}
