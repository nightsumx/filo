import { describe, expect, it } from 'vitest'
import { sortProviders } from './providers'

describe('provider order', () => {
    it('puts the common subscriptions first and keeps pi\'s order for the rest', () => {
        const ids = ['amazon-bedrock', 'anthropic', 'deepseek', 'github-copilot', 'groq', 'openai', 'zai']
        expect(sortProviders(ids.map(id => ({ id }))).map(p => p.id))
            .toEqual(['openai', 'anthropic', 'github-copilot', 'deepseek', 'amazon-bedrock', 'groq', 'zai'])
    })
})
