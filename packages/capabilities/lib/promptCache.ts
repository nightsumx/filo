// Prompt-cache hit rate and misses over a session's model requests, read from each reply's usage.
// pi-cc-tui's status line, turn footer and /cache, and Filo's status line, its cache panel and turn
// cards all count with this, so the two show the same figures.
//
// A miss is counted the way pi's own core/cache-stats.ts counts one (its /session "cache waste" and
// `showCacheMissNotices`): a request re-bills more than 1024 tokens of the previous request's prompt
// instead of reading them from the cache; compaction and branch summaries start over. pi's cache-warming
// requests (`usage` entries outside the message list) keep the cache alive without being requests of
// their own, so the cache's age counts from the latest one.

/** What this reads of a session message; pi's AgentMessage fits. */
export interface CacheMessage {
    role: string
    /** CACHE_WARM for pi's cache-warming requests (a `usage` entry, as a custom message). */
    customType?: string
    provider?: string
    model?: string
    thinkingLevel?: string
    stopReason?: string
    timestamp: number
    usage?: {
        input: number
        cacheRead: number
        cacheWrite: number
        cost?: { input: number, cacheRead: number, cacheWrite: number, total?: number }
    }
    /** A cache-warming request's `usage` entry. */
    details?: any
}

/** A provider keeps a prompt prefix about 5 minutes after its last use (Anthropic's default, OpenAI's least). */
export const CACHE_TTL_MS = 5 * 60_000

/**
 * How long the model's prompt cache lives: the short tier of pi's `promptCache`, the one pi warms on
 * unless PI_CACHE_RETENTION asks for long; CACHE_TTL_MS when the model has none.
 */
export const cacheTtlMs = (model: { promptCache?: { short?: number } } | undefined) => (model?.promptCache?.short ?? CACHE_TTL_MS / 1000) * 1000

/** The `kind` of pi's usage entry for a cache-warming request. */
export const CACHE_WARM = 'cache_warm'

const isWarm = (m: CacheMessage) => m.role === 'custom' && m.customType === CACHE_WARM

/** pi's noise floor: misses up to this are cache breakpoint granularity. */
const NOISE_TOKENS = 1024

/**
 * Why a request missed, from what is visible between it and the previous one, first match wins:
 * - model / thinking: the model or thinking level changed; each has its own cache
 * - idle: longer than the cache lives
 * - partial: most of the prefix was read, but its end was billed again
 * - prompt: a new prompt started and the whole prefix was lost: the system prompt or tools changed
 *   at the start of the run (plan or autopilot toggled, skills or AGENTS.md reloaded), or the provider dropped it
 * - provider: mid-run, with only tool results in between: nothing changed locally
 */
export type MissReason = 'model' | 'thinking' | 'idle' | 'partial' | 'prompt' | 'provider'

/** Reasons that follow from what the user did; the rest point at the provider or the prompt. */
export const EXPECTED_MISSES: ReadonlySet<MissReason> = new Set(['model', 'thinking', 'idle'])

/**
 * Worth flagging on its turn: a significant miss that lost the cache. Re-billed tails are summed in
 * the details instead, since a provider that does it does it on every request.
 */
export const isNotable = (miss: CacheMiss) => miss.significant && miss.reason !== 'partial'

export interface CacheMiss {
    /** Tokens of the previous prompt billed again instead of read. */
    missed: number
    reason: MissReason
    /** Since the previous request, the time the cache had to outlive. */
    idleMs: number
    /** What reading `missed` again cost over a cache hit; null when the prices are unknown. */
    extraCost: number | null
    /** The previous request's prompt, which this one was expected to read. */
    expected: number
    prompt: number
    read: number
    /** Worth a notice: pi's own threshold for its transcript notices (20k tokens or $0.10). */
    significant: boolean
}

export interface CacheStats {
    /** Requests with a prompt. */
    requests: number
    /** Prompt tokens over them (fresh input + cache read + cache write). */
    prompt: number
    read: number
    /** read / prompt, 0..1; null when no request reports any caching (the provider has none or hides it). */
    rate: number | null
    lastMiss: CacheMiss | null
    misses: number
    missedTokens: number
    /** Sum of the known extraCost. */
    extraCost: number
    /** What the replies and cache warming cost; less extraCost and warming, what it would with every request reading the cache. */
    cost: number
    warming: number
    /** When the cache was last used, by a request or pi warming it; 0 before any request. */
    usedAt: number
}

/** A branch's session entries as the messages this reads, the way Filo's transcript lists them (electron/sessions.ts). */
export function entryMessages(entries: readonly { type: string, timestamp?: string, message?: any, kind?: string, usage?: any }[]): CacheMessage[] {
    return entries.flatMap((e): CacheMessage[] => {
        if (e.type === 'message' && e.message)
            return [e.message]
        if (e.type === 'usage' && e.kind === CACHE_WARM)
            return [{ role: 'custom', customType: CACHE_WARM, details: e, timestamp: Date.parse(e.timestamp ?? '') || 0 }]
        if (e.type === 'compaction' || e.type === 'branch_summary')
            return [{ role: e.type === 'compaction' ? 'compactionSummary' : 'branchSummary', timestamp: Date.parse(e.timestamp ?? '') || 0 }]
        return []
    })
}

const promptOf = (u: NonNullable<CacheMessage['usage']>) => (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
const modelOf = (m: CacheMessage) => `${m.provider ?? ''}/${m.model ?? ''}`
const isRequest = (m: CacheMessage) => m.role === 'assistant' && m.stopReason !== 'pending' && !!m.usage && promptOf(m.usage) > 0

/**
 * The miss of each message, aligned with `messages`: null for hits, the first request after a start
 * or a compaction, other roles, and requests without a prompt (failed before the provider answered,
 * which do not count as the previous request either).
 */
export function cacheMisses(messages: readonly CacheMessage[], ttlMs = CACHE_TTL_MS): (CacheMiss | null)[] {
    // Per model, what a cached token costs: a miss's own reply has no read price when it read nothing.
    const readPrice = new Map<string, number>()
    for (const m of messages) {
        const u = m.usage
        if (m.role === 'assistant' && u && u.cacheRead > 0 && u.cost?.cacheRead && !readPrice.has(modelOf(m)))
            readPrice.set(modelOf(m), u.cost.cacheRead / u.cacheRead)
    }

    let prev: { prompt: number, model: string, thinking?: string, at: number } | undefined
    // A provider that never reported caching reads nothing on every request: that is not a miss.
    let reported = false
    let newPrompt = false
    return messages.map((m) => {
        if (m.role === 'compactionSummary' || m.role === 'branchSummary') {
            prev = undefined
            reported = false
            return null
        }
        if (m.role === 'user')
            newPrompt = true
        if (isWarm(m) && prev)
            prev.at = m.timestamp
        if (!isRequest(m))
            return null
        const u = m.usage!
        const prompt = promptOf(u)
        const before = prev
        const fresh = newPrompt
        prev = { prompt, model: modelOf(m), thinking: m.thinkingLevel, at: m.timestamp }
        newPrompt = false
        const cached = reported || u.cacheRead + u.cacheWrite > 0
        reported = cached
        if (!before || !cached)
            return null
        const expected = Math.min(before.prompt, prompt)
        const missed = expected - u.cacheRead
        if (missed <= NOISE_TOKENS)
            return null
        const idleMs = Math.max(0, m.timestamp - before.at)
        const reason: MissReason = before.model !== modelOf(m)
            ? 'model'
            : before.thinking !== m.thinkingLevel
                ? 'thinking'
                : idleMs > ttlMs
                    ? 'idle'
                    : u.cacheRead * 2 >= expected ? 'partial' : fresh ? 'prompt' : 'provider'
        // The missed tokens are billed as input or cache write, at this reply's own rate.
        const paidTokens = (u.input || 0) + (u.cacheWrite || 0)
        const paid = paidTokens > 0 && u.cost ? ((u.cost.input || 0) + (u.cost.cacheWrite || 0)) / paidTokens : 0
        const read = readPrice.get(modelOf(m))
        const extraCost = paid > 0 && read !== undefined ? missed * Math.max(0, paid - read) : null
        return { missed, reason, idleMs, extraCost, expected, prompt, read: u.cacheRead, significant: missed >= 20_000 || (extraCost ?? 0) >= 0.1 }
    })
}

/** Session figures for a status line, from the messages on the current branch in order. */
export function cacheStats(messages: readonly CacheMessage[], ttlMs = CACHE_TTL_MS): CacheStats {
    const misses = cacheMisses(messages, ttlMs)
    const stats: CacheStats = { requests: 0, prompt: 0, read: 0, rate: null, lastMiss: null, misses: 0, missedTokens: 0, extraCost: 0, cost: 0, warming: 0, usedAt: 0 }
    let reported = false
    messages.forEach((m, i) => {
        if (isWarm(m)) {
            stats.warming += m.details?.usage?.cost?.total || 0
            stats.usedAt = stats.requests ? m.timestamp : stats.usedAt
        }
        if (m.role === 'assistant')
            stats.cost += m.usage?.cost?.total || 0
        if (!isRequest(m))
            return
        stats.usedAt = m.timestamp
        const u = m.usage!
        const prompt = promptOf(u)
        reported ||= u.cacheRead > 0 || u.cacheWrite > 0
        stats.requests++
        stats.prompt += prompt
        stats.read += u.cacheRead || 0
        const miss = misses[i] ?? null
        stats.lastMiss = miss
        if (miss) {
            stats.misses++
            stats.missedTokens += miss.missed
            stats.extraCost += miss.extraCost ?? 0
        }
    })
    stats.cost += stats.warming
    stats.rate = reported && stats.prompt ? stats.read / stats.prompt : null
    return stats
}

/**
 * The channel, not the conversation, loses the cache: over at least five requests, half or more
 * re-billed the prefix's tail or dropped it with nothing changed locally. Common on relays that bill
 * caching their own way; pi's cache warming saves nothing there either.
 */
export function channelFault(misses: readonly (CacheMiss | null)[], requests: number): { count: number, extraCost: number } | null {
    const own = misses.filter((m): m is CacheMiss => m?.reason === 'partial' || m?.reason === 'provider')
    if (requests < 5 || own.length * 2 < requests)
        return null
    return { count: own.length, extraCost: own.reduce((sum, m) => sum + (m.extraCost ?? 0), 0) }
}

/** Misses grouped by reason, costliest first. */
export function missesByReason(misses: readonly (CacheMiss | null)[]): { reason: MissReason, count: number, missed: number, extraCost: number }[] {
    const by = new Map<MissReason, { reason: MissReason, count: number, missed: number, extraCost: number }>()
    for (const m of misses) {
        if (!m)
            continue
        const g = by.get(m.reason) ?? { reason: m.reason, count: 0, missed: 0, extraCost: 0 }
        g.count++
        g.missed += m.missed
        g.extraCost += m.extraCost ?? 0
        by.set(m.reason, g)
    }
    return [...by.values()].sort((a, b) => b.extraCost - a.extraCost || b.missed - a.missed)
}

/** Short English labels, for the terminal (Filo translates the reasons itself). */
export const MISS_LABELS: Record<MissReason, string> = {
    model: 'model changed',
    thinking: 'thinking level changed',
    idle: 'idle',
    partial: 'tail re-billed',
    prompt: 'lost at a new prompt',
    provider: 'dropped mid-run',
}

/** A miss's label, with how long it idled. */
export const missLabel = (miss: CacheMiss) => (miss.reason === 'idle' ? `idle ${Math.round(miss.idleMs / 60_000)}m` : MISS_LABELS[miss.reason])

/** One line on what a reason means, for the terminal's /cache. */
export const MISS_HINTS: Record<MissReason, string> = {
    model: 'each model has its own cache',
    thinking: 'each thinking level has its own cache',
    idle: 'the cache had expired',
    partial: 'the prefix was read, but its end was billed again; normally only the new part is written',
    prompt: 'the system prompt or tools changed when the run started (plan or autopilot toggled, skills reloaded), or the provider dropped the cache',
    provider: 'only tool results came in between, so nothing changed locally; the provider did not read the cache',
}
