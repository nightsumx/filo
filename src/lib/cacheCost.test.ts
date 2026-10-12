import type { AssistantMessage, PiModel, Usage } from '@shared/pi'
import { describe, expect, it } from 'vitest'
import { contextTokens, uncachedCost } from './cacheCost'

const model = (cost: PiModel['cost']): PiModel => ({ id: 'm', name: 'm', provider: 'p', cost })
const reply = (u: Partial<Usage>): AssistantMessage => ({
    role: 'assistant',
    content: [],
    timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...u },
})

describe('uncachedCost', () => {
    it('prices the context at the cache-write rate when the model bills one', () => {
        expect(uncachedCost(100_000, model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), undefined)).toBeCloseTo(0.375)
    })

    it('falls back to the input rate for models without cache-write pricing', () => {
        expect(uncachedCost(100_000, model({ input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }), undefined)).toBeCloseTo(0.2)
    })

    it('derives the rate from the last reply when the model has no price list', () => {
        const r = reply({ cacheWrite: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.00375, total: 0.00375 } })
        expect(uncachedCost(100_000, undefined, r)).toBeCloseTo(0.375)
    })

    it('is null for free or unknown models', () => {
        expect(uncachedCost(100_000, model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined)).toBeNull()
        expect(uncachedCost(100_000, undefined, undefined)).toBeNull()
    })
})

describe('contextTokens', () => {
    it("prefers pi's estimate, else sums the last reply's usage", () => {
        const r = reply({ input: 10, cacheRead: 900, cacheWrite: 50, output: 40 })
        expect(contextTokens(5000, r)).toBe(5000)
        expect(contextTokens(null, r)).toBe(1000)
        expect(contextTokens(undefined, undefined)).toBeNull()
    })
})
