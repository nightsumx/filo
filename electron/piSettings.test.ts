import { describe, expect, it } from 'vitest'
import { resolveCompaction } from './piSettings'

describe('resolveCompaction', () => {
    it('prefers the model override, then the ordinary setting, then the default', () => {
        const settings = { compaction: { reserveTokens: 20000, modelOverrides: { 'anthropic/opus': { reserveTokens: 750000 } } } }
        expect(resolveCompaction(settings, 'anthropic/opus')).toEqual({ enabled: true, reserveTokens: 750000 })
        expect(resolveCompaction(settings, 'anthropic/haiku')).toEqual({ enabled: true, reserveTokens: 20000 })
        expect(resolveCompaction({}, 'x/y')).toEqual({ enabled: true, reserveTokens: 16384 })
    })

    it('reports disabled compaction and ignores invalid numbers', () => {
        expect(resolveCompaction({ compaction: { enabled: false, reserveTokens: -1 } })).toEqual({ enabled: false, reserveTokens: 16384 })
    })
})
