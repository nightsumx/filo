import { describe, expect, it } from 'vitest'
import { CACHE_WARM, cacheMisses, cacheStats, cacheTtlMs, channelFault, missesByReason, type CacheMessage } from 'pi-capabilities/lib/promptCache.ts'

const MIN = 60_000
// Anthropic-style prices per token: input 3e-6, write 3.75e-6, read 0.3e-6.
const req = (at: number, input: number, cacheRead: number, cacheWrite = 0, more: Partial<CacheMessage> = {}): CacheMessage => ({
    role: 'assistant',
    provider: 'anthropic',
    model: 'claude',
    thinkingLevel: 'high',
    timestamp: at,
    usage: { input, cacheRead, cacheWrite, cost: { input: input * 3e-6, cacheRead: cacheRead * 0.3e-6, cacheWrite: cacheWrite * 3.75e-6 } },
    ...more,
})
const user = (at: number): CacheMessage => ({ role: 'user', timestamp: at })
const tool = (at: number): CacheMessage => ({ role: 'toolResult', timestamp: at })
const reasons = (messages: CacheMessage[]) => cacheMisses(messages).map(m => m?.reason ?? null)

describe('cacheMisses', () => {
    it('a request that reads the previous prompt back is a hit, up to pi\'s 1024-token noise floor', () => {
        expect(reasons([req(0, 10, 0, 20_000), tool(1), req(MIN, 10, 20_000, 500)])).toEqual([null, null, null])
        expect(reasons([req(0, 10, 0, 20_000), tool(1), req(MIN, 10, 19_000, 1500)])).toEqual([null, null, null])
    })

    it('names why the prefix was not read, from what came in between', () => {
        expect(reasons([
            req(0, 10, 0, 20_000),
            tool(1),
            req(1 * MIN, 10, 0, 21_000), // only a tool result in between: the provider
            user(2 * MIN),
            req(2 * MIN, 10, 0, 22_000), // a new prompt
            req(10 * MIN, 10, 0, 23_000), // idle past the TTL
            req(11 * MIN, 10, 15_000, 9_000), // most of it read: the tail was billed again
            req(12 * MIN, 10, 0, 25_000, { thinkingLevel: 'low' }),
            req(13 * MIN, 10, 0, 26_000, { model: 'other', thinkingLevel: 'low' }),
        ])).toEqual([null, null, 'provider', null, 'prompt', 'idle', 'partial', 'thinking', 'model'])
    })

    it('prices the re-billed tokens against the cache-read rate', () => {
        const [, miss] = cacheMisses([req(0, 10, 0, 20_000), req(MIN, 10, 0, 21_000), req(2 * MIN, 10, 21_000)])
        expect(miss).toMatchObject({ missed: 20_010, expected: 20_010, prompt: 21_010, read: 0, significant: true })
        // Paid (10 input + 21000 write) at their blended rate, less what a read would have cost.
        const paid = (10 * 3e-6 + 21_000 * 3.75e-6) / 21_010
        expect(miss?.extraCost).toBeCloseTo(20_010 * (paid - 0.3e-6))
    })

    it('starts over after compaction, and ignores providers that never report caching', () => {
        expect(reasons([req(0, 10, 0, 20_000), { role: 'compactionSummary', timestamp: 1 }, req(MIN, 10, 0, 5_000)])).toEqual([null, null, null])
        const plain = (at: number, input: number): CacheMessage => ({ role: 'assistant', timestamp: at, usage: { input, cacheRead: 0, cacheWrite: 0 } })
        expect(reasons([plain(0, 5000), plain(MIN, 6000)])).toEqual([null, null])
    })

    it('skips failed and streaming requests', () => {
        const failed: CacheMessage = { role: 'assistant', timestamp: MIN, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }
        const pending = req(2 * MIN, 10, 0, 30_000, { stopReason: 'pending' })
        expect(reasons([req(0, 10, 0, 20_000), failed, pending, req(3 * MIN, 10, 20_000)])).toEqual([null, null, null, null])
    })
})

describe('cacheStats', () => {
    it('weights the session rate by prompt size', () => {
        const messages = [req(0, 0, 0, 10_000), req(MIN, 0, 10_000, 10_000), req(2 * MIN, 0, 0, 20_000)]
        const s = cacheStats(messages)
        expect(s.rate).toBeCloseTo(10_000 / 50_000)
        expect(s).toMatchObject({ misses: 1, missedTokens: 20_000 })
        expect(s.lastMiss?.reason).toBe('provider')
        expect(missesByReason(cacheMisses(messages))).toEqual([{ reason: 'provider', count: 1, missed: 20_000, extraCost: expect.any(Number) }])
    })

    it('spent less what misses re-billed and warming cost is the run with every request reading the cache', () => {
        const priced = (m: CacheMessage): CacheMessage => ({ ...m, usage: { ...m.usage!, cost: { ...m.usage!.cost!, total: m.usage!.cost!.cacheRead + m.usage!.cost!.cacheWrite } } })
        const warm: CacheMessage = { role: 'custom', customType: CACHE_WARM, timestamp: MIN, details: { usage: { cost: { total: 0.01 } } } }
        const s = cacheStats([priced(req(0, 0, 0, 10_000)), warm, priced(req(2 * MIN, 0, 0, 10_000)), priced(req(3 * MIN, 0, 10_000))])
        expect(s.warming).toBe(0.01)
        expect(s.cost - s.extraCost - s.warming).toBeCloseTo(10_000 * 3.75e-6 + 2 * 10_000 * 0.3e-6)
    })

    it('has no rate when nothing reports caching', () => {
        expect(cacheStats([{ role: 'assistant', timestamp: 0, usage: { input: 5000, cacheRead: 0, cacheWrite: 0 } }])).toMatchObject({ rate: null, requests: 1 })
    })
})

describe('cache warming', () => {
    const warm = (at: number): CacheMessage => ({ role: 'custom', customType: CACHE_WARM, timestamp: at })

    it('pi\'s refreshes keep the cache alive: the age counts from the latest one, and a later miss is not idle', () => {
        const messages = [req(0, 10, 0, 20_000), warm(4.5 * MIN), warm(9 * MIN), req(12 * MIN, 10, 0, 21_000)]
        expect(reasons(messages)).toEqual([null, null, null, 'provider'])
        expect(cacheStats(messages.slice(0, 3)).usedAt).toBe(9 * MIN)
    })

    it('idles against the model\'s own lifetime', () => {
        const messages = [req(0, 10, 0, 20_000), req(10 * MIN, 10, 0, 21_000)]
        expect(cacheMisses(messages, cacheTtlMs({ promptCache: { short: 3600 } }))[1]?.reason).toBe('provider')
        expect(cacheMisses(messages, cacheTtlMs(undefined))[1]?.reason).toBe('idle')
    })
})

describe('channelFault', () => {
    it('blames the channel once half the requests lose the cache with nothing changed, not before five', () => {
        const tails = [req(0, 10, 0, 20_000), ...[1, 2, 3, 4].map(i => req(i * MIN, 10, 15_000, 5_000 + i * 1000))]
        expect(channelFault(cacheMisses(tails), 5)).toMatchObject({ count: 4 })
        expect(channelFault(cacheMisses(tails.slice(0, 4)), 4)).toBeNull()
        const healthy = [0, 1, 2, 3, 4, 5].map(i => req(i * MIN, 10, i ? 20_000 + (i - 1) * 100 : 0, i ? 100 : 20_000))
        expect(channelFault(cacheMisses(healthy), 6)).toBeNull()
    })
})
