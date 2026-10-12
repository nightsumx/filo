// Channel test: does a provider (often a relay in front of one) really cache prompts? A short scripted
// conversation is sent to the model and each reply's usage is checked against what a working cache
// must read. Filo's Settings → 供应商 and pi-cc-tui's /channel-test both run it; each host sends
// the requests through its own pi (`ProbeSend`), so the request is the one pi would send in a thread.
//
// The run, after a random nonce at the very start of the system prompt (no earlier run can have it):
//   first   a long system prompt and a short question. Nothing to read; a provider that writes says so
//   repeat  the same request again: everything should be read
//   append  ×5, the conversation grows by the reply and a new question with a block of text: the
//           previous request's whole prompt should be read, and no more than that
//   idle    optional: wait a while (under the 5-minute TTL), then send the last request again
//
// What the figures can show:
//   - a fresh prompt that "reads" from the cache, or a read beyond what was sent before, is made up:
//     relays that bill by a fixed hit ratio report reads like that
//   - reads that stay short of the previous prompt: the cache is lost or partly re-billed
//   - writes and no reads: the cache is written and never used
//   - no cache figures at all: the provider has no cache or does not report it
import { CACHE_TTL_MS } from './promptCache'

/** Per million tokens, as in pi's model list. */
export interface ProbeCost {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
}

export interface ProbeModel {
    provider: string
    id: string
    name?: string
    cost?: ProbeCost
}

/** The assistant turn is the message the host got back, passed through unchanged (thinking signatures and all). */
export type ProbeTurn = { role: 'user', text: string } | { role: 'assistant', message: unknown }

export interface ProbeRequest {
    system: string
    turns: ProbeTurn[]
    maxTokens: number
    /** The same for every request of a run: providers that route or cache by session use it. */
    sessionId: string
}

export interface ProbeUsage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** Dollars, as pi priced the reply; 0 when the model has no prices. */
    cost?: number
}

export interface ProbeReply {
    /** pi's AssistantMessage, to send back in the next request. */
    message: unknown
    usage: ProbeUsage
    /** From sending to the first text; null when no text came. */
    ttftMs: number | null
    durationMs: number
    /** The provider's error; the run stops at it. */
    error?: string
}

export type ProbeSend = (request: ProbeRequest, signal?: AbortSignal) => Promise<ProbeReply>

export type StepKind = 'first' | 'repeat' | 'append' | 'idle'

/** hit: the expected prefix was read; partial: some of it; miss: none; fresh: the first request, nothing to read. */
export type StepStatus = 'fresh' | 'hit' | 'partial' | 'miss' | 'excess'

export interface StepResult {
    kind: StepKind
    /** Fresh input + cache read + cache write. */
    prompt: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** Tokens a working cache reads here: the previous request's prompt (0 for the first). */
    expected: number
    /** expected − read, never below 0. */
    unread: number
    status: StepStatus
    ttftMs: number | null
    durationMs: number
    /** Dollars spent on this request; null without prices. */
    cost: number | null
    /** Dollars the unread tokens cost over reading them; null without prices. */
    extraCost: number | null
}

/**
 * healthy: every request read what it should
 * partial: some requests read less (cache lost, tail re-billed, or it expired while idle)
 * none: the provider reports writes but never reads
 * unreported: no cache figures at all: no cache, or the provider does not report it
 * fabricated: reads that cannot be real (a never-sent prompt, or more than was sent before)
 * failed: a request failed; the steps before it are kept
 */
export type Verdict = 'healthy' | 'partial' | 'none' | 'unreported' | 'fabricated' | 'failed'

export interface ChannelResult {
    version: 1
    provider: string
    model: string
    /** Finished, ms since the epoch. */
    at: number
    verdict: Verdict
    steps: StepResult[]
    /** The idle step's wait, when it ran. */
    idleMs?: number
    error?: string
    /** Read over prompt, all requests; null when nothing was reported. */
    hitRate: number | null
    /** Sum over the requests; null without prices. */
    cost: number | null
    extraCost: number | null
    /** Median time to first text. */
    ttftMs: number | null
    /** Output tokens per second after the first text. */
    outputTps: number | null
}

export interface ProbeProgress {
    /** 0-based index of the request under way. */
    index: number
    total: number
    kind: StepKind
    /** While the idle step waits: when it sends. */
    waitUntil?: number
    done: StepResult[]
}

// ---------------------------------------------------------------- the script

/** Words of the system prompt and of each appended block. About 1.2 tokens a word with the usual tokenizers. */
export const SYSTEM_WORDS = 9000
export const APPEND_WORDS = 1500
export const APPENDS = 5
/** Lines the model copies back per turn: enough output to time, little to pay. */
const COPY_LINES = 12
export const MAX_TOKENS = 1024
/** Under the 5-minute TTL providers keep a prefix at least, so a working cache still has it. */
export const IDLE_MS = 4 * 60_000
const TOKENS_PER_WORD = 1.25
const REPLY_TOKENS = 130

const WORDS = ('time year people way day man thing woman life child world school state family student group country problem hand part place case week company system program question work government number night point home water room mother area money story fact month lot right study book eye job word business issue side kind head house service friend father power hour game line end member law car city community name president team minute idea kid body information back parent face others level office door health person art war history party result change morning reason research girl guy moment air teacher force education river stone garden window bridge market letter forest island signal engine valley harbor lantern meadow orbit pepper quartz ribbon saddle timber velvet walnut yellow zephyr anchor beacon candle dragon ember falcon glacier hollow ivory jasmine kettle ledger marble nectar oyster prism quiver raven silver thistle umber vessel willow amber copper delta echo fable granite hazel indigo juniper kernel lumen mosaic nimbus onyx pillar quarry relic summit tundra ultra vertex wander')
    .split(' ')

/** mulberry32 over a string seed: the same nonce gives the same text, so a run is reproducible. */
function rng(seed: string) {
    let h = 1779033703 ^ seed.length
    for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
        h = (h << 13) | (h >>> 19)
    }
    let a = h >>> 0
    return () => {
        a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function prose(seed: string, words: number) {
    const next = rng(seed)
    const out: string[] = []
    let sentence: string[] = []
    let paragraph = 0
    for (let i = 0; i < words; i++) {
        const w = WORDS[Math.floor(next() * WORDS.length)]
        sentence.push(sentence.length ? w : w[0].toUpperCase() + w.slice(1))
        if (sentence.length >= 8 + Math.floor(next() * 9)) {
            out.push(`${sentence.join(' ')}.`)
            sentence = []
            if (++paragraph % 6 === 0)
                out.push('\n\n')
        }
    }
    if (sentence.length)
        out.push(`${sentence.join(' ')}.`)
    return out.join(' ').replace(/ \n\n /g, '\n\n')
}

function copyLines(seed: string, turn: number) {
    const next = rng(`${seed}:lines:${turn}`)
    const pick = () => WORDS[Math.floor(next() * WORDS.length)]
    return Array.from({ length: COPY_LINES }, (_, i) => `${turn}.${i + 1} ${pick()} ${pick()} ${1000 + Math.floor(next() * 9000)} ${pick()}`).join('\n')
}

function question(seed: string, turn: number, block: boolean) {
    const text = block ? `Reference notes, part ${turn}:\n\n${prose(`${seed}:block:${turn}`, APPEND_WORDS)}\n\n` : ''
    return `${text}Copy these lines exactly, one per line, and write nothing else:\n${copyLines(seed, turn)}`
}

function system(nonce: string) {
    return `Channel test ${nonce}. You are checking a connection. Each user turn asks you to copy some lines; copy them exactly and add nothing.\n\nBackground text (do not summarise it):\n\n${prose(nonce, SYSTEM_WORDS)}`
}

export interface ProbeOptions {
    /** Wait this long before the last request again; omit to skip the idle step. */
    idleMs?: number
}

export const stepKinds = (options: ProbeOptions = {}): StepKind[] =>
    ['first', 'repeat', ...Array.from({ length: APPENDS }, () => 'append' as const), ...(options.idleMs ? ['idle' as const] : [])]

// ---------------------------------------------------------------- cost

export interface CostEstimate {
    requests: number
    /** Prompt tokens over all requests, roughly. */
    promptTokens: number
    outputTokens: number
    /** Dollars when the cache works / when every token is billed as fresh input; null without prices. */
    healthy: number | null
    worst: number | null
}

const hasPrices = (cost?: ProbeCost): cost is ProbeCost => !!cost && cost.input + cost.output > 0

export function estimateCost(model: ProbeModel, options: ProbeOptions = {}): CostEstimate {
    const kinds = stepKinds(options)
    const first = Math.round((SYSTEM_WORDS + 60) * TOKENS_PER_WORD)
    const growth = Math.round(APPEND_WORDS * TOKENS_PER_WORD) + 2 * REPLY_TOKENS
    let prompt = 0
    let promptTokens = 0
    let fresh = 0
    let read = 0
    for (const kind of kinds) {
        const before = prompt
        if (kind === 'first')
            prompt = first
        else if (kind === 'append')
            prompt += growth
        promptTokens += prompt
        const reads = kind === 'first' ? 0 : before
        read += reads
        fresh += prompt - reads
    }
    const outputTokens = kinds.length * REPLY_TOKENS
    const cost = model.cost
    if (!hasPrices(cost))
        return { requests: kinds.length, promptTokens, outputTokens, healthy: null, worst: null }
    const write = cost.cacheWrite || cost.input
    const healthy = (fresh * write + read * (cost.cacheRead || cost.input) + outputTokens * cost.output) / 1e6
    // Worst case: nothing read and every reply runs to the cap.
    const worst = (promptTokens * Math.max(cost.input, write) + kinds.length * MAX_TOKENS * cost.output) / 1e6
    return { requests: kinds.length, promptTokens, outputTokens, healthy, worst }
}

// ---------------------------------------------------------------- judging

/** Short of the expected read by no more than this counts as read: OpenAI caches in 128-token steps. */
const slack = (expected: number) => Math.max(256, Math.round(expected * 0.02))
/** A fresh prompt may read a provider's own preamble, never a real part of ours. */
const freshLimit = (prompt: number) => Math.max(2048, Math.round(prompt * 0.1))
const NOISE = 1024

const promptOf = (u: ProbeUsage) => (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)

function stepOf(kind: StepKind, reply: ProbeReply, previousPrompt: number, cost?: ProbeCost): StepResult {
    const u = reply.usage
    const prompt = promptOf(u)
    const expected = kind === 'first' ? 0 : Math.min(previousPrompt, prompt)
    const read = u.cacheRead || 0
    const unread = Math.max(0, expected - read)
    const status: StepStatus = kind === 'first'
        ? read > freshLimit(prompt) ? 'excess' : 'fresh'
        : read > expected + slack(expected) ? 'excess' : unread <= slack(expected) ? 'hit' : read <= NOISE ? 'miss' : 'partial'
    let spent: number | null = null
    let extraCost: number | null = null
    if (hasPrices(cost)) {
        spent = u.cost || (u.input * cost.input + read * cost.cacheRead + u.cacheWrite * cost.cacheWrite + u.output * cost.output) / 1e6
        // What the unread part was billed at: a write when this reply wrote, else fresh input.
        const paid = u.cacheWrite > 0 && cost.cacheWrite ? cost.cacheWrite : cost.input
        extraCost = status === 'excess' ? 0 : unread * Math.max(0, paid - cost.cacheRead) / 1e6
    }
    return { kind, prompt, input: u.input || 0, output: u.output || 0, cacheRead: read, cacheWrite: u.cacheWrite || 0, expected, unread, status, ttftMs: reply.ttftMs, durationMs: reply.durationMs, cost: spent, extraCost }
}

export function verdictOf(steps: readonly StepResult[], failed: boolean): Verdict {
    if (failed)
        return 'failed'
    if (steps.every(s => s.cacheRead + s.cacheWrite === 0))
        return 'unreported'
    if (steps.some(s => s.status === 'excess'))
        return 'fabricated'
    const checked = steps.filter(s => s.kind !== 'first')
    if (checked.every(s => s.cacheRead <= NOISE))
        return 'none'
    return checked.every(s => s.status === 'hit') ? 'healthy' : 'partial'
}

function median(values: number[]) {
    if (!values.length)
        return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function summarize(model: ProbeModel, steps: StepResult[], options: { error?: string, idleMs?: number, at?: number } = {}): ChannelResult {
    const prompt = steps.reduce((n, s) => n + s.prompt, 0)
    const read = steps.reduce((n, s) => n + s.cacheRead, 0)
    const reported = steps.some(s => s.cacheRead + s.cacheWrite > 0)
    const priced = steps.length > 0 && steps.every(s => s.cost !== null)
    const timed = steps.filter(s => s.ttftMs !== null && s.durationMs > s.ttftMs)
    const streamMs = timed.reduce((n, s) => n + s.durationMs - s.ttftMs!, 0)
    const streamed = timed.reduce((n, s) => n + s.output, 0)
    return {
        version: 1,
        provider: model.provider,
        model: model.id,
        at: options.at ?? Date.now(),
        verdict: verdictOf(steps, !!options.error),
        steps,
        idleMs: steps.some(s => s.kind === 'idle') ? options.idleMs : undefined,
        error: options.error,
        hitRate: reported && prompt ? read / prompt : null,
        cost: priced ? steps.reduce((n, s) => n + s.cost!, 0) : null,
        extraCost: priced ? steps.reduce((n, s) => n + (s.extraCost ?? 0), 0) : null,
        ttftMs: median(steps.flatMap(s => (s.ttftMs === null ? [] : [s.ttftMs]))),
        outputTps: streamMs > 0 ? streamed / (streamMs / 1000) : null,
    }
}

// ---------------------------------------------------------------- sending through pi

/** What this needs of pi-ai's AssistantMessageEventStream. */
export interface ProbeStream extends AsyncIterable<{ type: string }> {
    result: () => Promise<any>
}

export type ProbeStreamFn = (
    context: { systemPrompt: string, messages: unknown[] },
    options: { maxTokens: number, sessionId: string, signal?: AbortSignal },
) => ProbeStream

/**
 * One request through pi's streamSimple (a ModelRegistry's or ModelRuntime's, bound to the model).
 * Filo's provider helper does the same in its own process (electron/providerHelper.mts).
 */
export async function sendThroughPi(stream: ProbeStreamFn, request: ProbeRequest, signal?: AbortSignal): Promise<ProbeReply> {
    const now = Date.now()
    const messages = request.turns.map(t => (t.role === 'user' ? { role: 'user', content: t.text, timestamp: now } : t.message))
    const started = performance.now()
    let ttftMs: number | null = null
    const events = stream({ systemPrompt: request.system, messages }, { maxTokens: request.maxTokens, sessionId: request.sessionId, signal })
    for await (const event of events) {
        if (ttftMs === null && (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta'))
            ttftMs = performance.now() - started
    }
    const message = await events.result()
    if (message.stopReason === 'aborted' || signal?.aborted)
        throw abortError()
    const u = message.usage ?? {}
    return {
        message,
        usage: { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, cost: u.cost?.total },
        ttftMs,
        durationMs: performance.now() - started,
        error: message.stopReason === 'error' ? message.errorMessage || 'request failed' : undefined,
    }
}

// ---------------------------------------------------------------- the run

export interface RunOptions extends ProbeOptions {
    model: ProbeModel
    send: ProbeSend
    signal?: AbortSignal
    onProgress?: (progress: ProbeProgress) => void
    /** Tests fix these. */
    nonce?: string
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function abortError() {
    const error = new Error('Channel test cancelled')
    error.name = 'AbortError'
    return error
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted)
        return reject(abortError())
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
    }, ms)
    const onAbort = () => {
        clearTimeout(timer)
        reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
})

const randomNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')

/** Runs the script; throws an AbortError when cancelled, otherwise always returns a result (failed included). */
export async function runChannelTest(options: RunOptions): Promise<ChannelResult> {
    const { model, send, signal, onProgress } = options
    const sleep = options.sleep ?? defaultSleep
    const nonce = options.nonce ?? randomNonce()
    const idleMs = options.idleMs ? Math.min(options.idleMs, CACHE_TTL_MS - 30_000) : undefined
    const kinds = stepKinds({ idleMs })
    const steps: StepResult[] = []
    const base: ProbeRequest = { system: system(nonce), turns: [], maxTokens: MAX_TOKENS, sessionId: `channel-test-${nonce}` }
    let request: ProbeRequest = { ...base, turns: [{ role: 'user', text: question(nonce, 1, false) }] }
    let previousPrompt = 0
    let turn = 1
    for (const [index, kind] of kinds.entries()) {
        if (signal?.aborted)
            throw abortError()
        if (kind === 'idle' && idleMs) {
            onProgress?.({ index, total: kinds.length, kind, waitUntil: Date.now() + idleMs, done: [...steps] })
            await sleep(idleMs, signal)
        }
        onProgress?.({ index, total: kinds.length, kind, done: [...steps] })
        const reply = await send(request, signal)
        if (signal?.aborted)
            throw abortError()
        if (reply.error)
            return summarize(model, steps, { error: reply.error, idleMs })
        const step = stepOf(kind, reply, previousPrompt, model.cost)
        steps.push(step)
        previousPrompt = step.prompt
        const next = kinds[index + 1]
        if (next === 'append') {
            turn++
            request = { ...request, turns: [...request.turns, { role: 'assistant', message: reply.message }, { role: 'user', text: question(nonce, turn, true) }] }
        }
        // repeat and idle send the same request again.
    }
    return summarize(model, steps, { idleMs })
}
