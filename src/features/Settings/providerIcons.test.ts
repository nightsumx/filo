import { describe, expect, it } from 'vitest'
import { providerIcon } from './providerIcons'

describe('providerIcon', () => {
    it('finds regional and plan variants by their leading id segments', () => {
        expect(providerIcon('minimax-cn')).toBe(providerIcon('minimax'))
        expect(providerIcon('xiaomi-token-plan-sgp')).toBe(providerIcon('xiaomi'))
        expect(providerIcon('cloudflare-workers-ai')).toBe(providerIcon('cloudflare-ai-gateway'))
        expect(providerIcon('openai-codex')).toBe(providerIcon('openai'))
        expect(providerIcon('openai')).toContain('<svg')
    })

    it('keeps distinct icons where the first segment would be wrong', () => {
        expect(providerIcon('google-vertex')).not.toBe(providerIcon('google'))
    })

    it('falls back to the name for custom entries, and to nothing', () => {
        expect(providerIcon('my-local', 'Ollama')).toBe(providerIcon('ollama'))
        expect(providerIcon('company-gateway', '公司网关')).toBeUndefined()
        expect(providerIcon('radius', 'Radius')).toBeUndefined()
    })
})
