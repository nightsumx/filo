// Prompt-cache warming for Claude Code and Codex threads on a channel, which reach it through the
// gateway (routes.ts routeAcp): pi's own warmer (core/cache-warmer.js) on the wire. Before the cache
// a request wrote expires, the same request goes again with a one-token answer, while that is
// expected to save money: pi's timing, limits and economics, under pi's `cacheWarming` setting. A
// run is a prefix (model and system prompt: the thread, each subagent, side requests apart); the
// thread's run state comes from the app (agent_start … agent_end). Only keys pi holds, never a
// subscription: the gateway has no other.
import type { CacheWarming } from '@shared/ipc'
import type { RouteApi } from '@shared/routes'
import type { PricedModel, Tokens } from 'pi-capabilities/lib/prices.ts'
import { createHash } from 'node:crypto'
import { CACHE_WARM } from 'pi-capabilities/lib/promptCache.ts'
import { claudeTokens, costOf } from 'pi-capabilities/lib/prices.ts'
import { eventData, SseSplitter } from './wire'

const MAX_STREAMING_MS = 60 * 60_000
const MAX_IDLE_MS = 30 * 60_000
const MIN_SAVINGS = 0.05
const IDLE_CONTINUATION = 0.15
/** Prefixes kept warm per thread at most; the oldest goes. */
const MAX_RUNS = 4

/** A request as sent upstream: replayed as it was, but for the answer's length. */
export interface WarmRequest {
    api: RouteApi
    url: string
    headers: Record<string, string>
    body: any
}

/** pi's `usage` entry of a warming request, as pi appends it to its session. */
export interface WarmEntry {
    type: 'usage'
    kind: typeof CACHE_WARM
    provider: string
    model: string
    usage: Tokens & { totalTokens: number, cost: ReturnType<typeof costOf> }
    timestamp: string
}

interface Run {
    request: WarmRequest
    model: PricedModel
    provider: string
    ttlMs: number
    delayMs: number
    /** The prompt of the last real request. */
    prompt: number
    phase: 'streaming' | 'idle'
    startedAt: number
    timer?: ReturnType<typeof setTimeout>
    controller: AbortController
}

/** What warming keeps per gateway session. */
export interface WarmState {
    running: boolean
    runs: Map<string, Run>
}

const json = (text: string): any => {
    try {
        return JSON.parse(text)
    }
    catch {
        return undefined
    }
}

/** pi's getCacheWarmingDelayMs: at 90% of the lifetime, ten seconds before it at least. */
export const warmDelayMs = (ttlMs: number) => (ttlMs <= 10_000 ? undefined : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000))))

/** An answer's usage as pi counts tokens: input without the cache. */
export function usageTokens(api: RouteApi, usage: any): Tokens | undefined {
    if (api === 'anthropic-messages')
        return claudeTokens(usage)
    if (typeof usage?.input_tokens !== 'number')
        return undefined
    const cacheRead = Number(usage.input_tokens_details?.cached_tokens) || 0
    return { input: Math.max(0, usage.input_tokens - cacheRead), output: Number(usage.output_tokens) || 0, cacheRead, cacheWrite: 0 }
}

/** The usage of an answer passing to the agent, streamed or not. */
export class AnswerTap {
    private splitter = new SseSplitter()
    private text = ''
    private usage: any

    constructor(private api: RouteApi, private stream: boolean) {}

    push(text: string) {
        if (!this.stream) {
            this.text += text
            return
        }
        for (const event of this.splitter.push(text)) {
            const data = json(eventData(event))
            if (data?.type === 'message_start')
                this.usage = { ...data.message?.usage }
            else if (data?.type === 'message_delta')
                this.usage = { ...this.usage, ...data.usage }
            else if (data?.type === 'response.completed')
                this.usage = data.response?.usage
        }
    }

    tokens(): Tokens | undefined {
        return usageTokens(this.api, this.stream ? this.usage : json(this.text)?.usage)
    }
}

/** pi's isReplayable: Anthropic's budget thinking derives its budget from max_tokens, which the replay changes. */
const replayable = (r: WarmRequest) => r.api !== 'anthropic-messages' || r.body?.thinking?.type !== 'enabled'

/** pi's retention tier the request asked for: Anthropic's one-hour breakpoints, OpenAI's 24h. */
function retention(r: WarmRequest): 'short' | 'long' {
    if (r.api === 'openai-responses')
        return r.body?.prompt_cache_retention === '24h' ? 'long' : 'short'
    const long = (v: any): boolean => Array.isArray(v) ? v.some(long) : !!v && typeof v === 'object' && (v.cache_control?.ttl === '1h' || Object.values(v).some(long))
    return long([r.body?.system, r.body?.tools, r.body?.messages]) ? 'long' : 'short'
}

/** The request again with a one-token answer (Responses wants 16 at least), not streamed. */
export function replayBody(r: WarmRequest): any {
    return r.api === 'anthropic-messages'
        ? { ...r.body, max_tokens: 1, stream: false }
        : { ...r.body, max_output_tokens: 16, stream: false }
}

/** pi's CacheWarmer.evaluate: warm when the miss it avoids, times the chance of a next request, beats the warm by 5¢. */
export function shouldWarm(model: PricedModel, prompt: number, phase: Run['phase']): boolean {
    const price = (t: Partial<Tokens>) => costOf(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...t }).total
    const hit = price({ cacheRead: prompt })
    const miss = price(model.cost?.cacheWrite ? { cacheWrite: prompt } : { input: prompt })
    const warm = price({ cacheRead: prompt, output: 1 })
    const chance = phase === 'idle' ? IDLE_CONTINUATION : 1
    return prompt > 0 && chance * Math.max(0, miss - hit) - warm >= MIN_SAVINGS
}

export interface WarmerDeps {
    fetch: typeof fetch
    mode: () => CacheWarming
    now: () => number
    warmed: (state: WarmState, entry: WarmEntry) => void
}

export class Warmer {
    constructor(private deps: WarmerDeps) {}

    /** A real request was answered: (re)start the run of its prefix. */
    served(state: WarmState, request: WarmRequest, provider: string, model: PricedModel | undefined, tokens: Tokens | undefined) {
        const key = createHash('sha256').update(JSON.stringify([request.body?.model, request.body?.system ?? request.body?.instructions])).digest('hex')
        this.clear(state, key)
        const seconds = model?.promptCache?.[retention(request)]
        const ttlMs = seconds === undefined ? undefined : seconds * 1000
        const delayMs = ttlMs && warmDelayMs(ttlMs)
        const phase = state.running ? 'streaming' : 'idle'
        const mode = this.deps.mode()
        if (!model || !ttlMs || !delayMs || !tokens || mode === 'off' || (mode === 'streaming' && phase === 'idle') || !replayable(request))
            return
        const run: Run = { request, model, provider, ttlMs, delayMs, prompt: tokens.input + tokens.cacheRead + tokens.cacheWrite, phase, startedAt: this.deps.now(), controller: new AbortController() }
        state.runs.set(key, run)
        if (state.runs.size > MAX_RUNS)
            this.clear(state, state.runs.keys().next().value!)
        this.schedule(state, key, run)
    }

    /** The thread's run started or settled (pi's onAgentSettled; the idle limit applies at the next warm). */
    running(state: WarmState, running: boolean) {
        state.running = running
        if (running)
            return
        for (const [key, run] of state.runs) {
            run.phase = 'idle'
            if (this.deps.mode() !== 'idle')
                this.clear(state, key)
        }
    }

    stop(state: WarmState) {
        for (const key of [...state.runs.keys()])
            this.clear(state, key)
    }

    private clear(state: WarmState, key: string) {
        const run = state.runs.get(key)
        state.runs.delete(key)
        clearTimeout(run?.timer)
        run?.controller.abort()
    }

    /** The one-hour limit from the real request, 30 minutes once the thread is idle. */
    private limit = (run: Run) => run.startedAt + (run.phase === 'idle' ? MAX_IDLE_MS : MAX_STREAMING_MS)

    private schedule(state: WarmState, key: string, run: Run) {
        const at = this.deps.now() + run.delayMs
        if (at > this.limit(run)) {
            this.clear(state, key)
            return
        }
        // A late timer (sleep) keeps half the margin; later than that the cache is likely gone.
        const deadline = at + Math.floor((run.ttlMs - run.delayMs) / 2)
        run.timer = setTimeout(() => void this.refresh(state, key, run, deadline), run.delayMs)
        run.timer.unref?.()
    }

    private async refresh(state: WarmState, key: string, run: Run, deadline: number) {
        const mode = this.deps.mode()
        const current = () => state.runs.get(key) === run
        if (!current())
            return
        if (mode === 'off' || (mode === 'streaming' && run.phase === 'idle') || this.deps.now() > Math.min(deadline, this.limit(run)) || !shouldWarm(run.model, run.prompt, run.phase)) {
            this.clear(state, key)
            return
        }
        try {
            const response = await this.deps.fetch(run.request.url, { method: 'POST', headers: run.request.headers, body: JSON.stringify(replayBody(run.request)), signal: run.controller.signal })
            const answer = json(await response.text())
            const tokens = response.ok ? usageTokens(run.request.api, answer?.usage) : undefined
            if (tokens && current()) {
                const cost = costOf(run.model.cost, tokens)
                const model = typeof answer?.model === 'string' ? answer.model : String(run.request.body?.model ?? '')
                this.deps.warmed(state, { type: 'usage', kind: CACHE_WARM, provider: run.provider, model, usage: { ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite, cost }, timestamp: new Date(this.deps.now()).toISOString() })
            }
        }
        catch {}
        if (current())
            this.schedule(state, key, run)
    }
}
