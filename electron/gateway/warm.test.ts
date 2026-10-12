import type { WarmState } from './warm'
import { describe, expect, it } from 'vitest'
import { AnswerTap, replayBody, shouldWarm, Warmer } from './warm'

const sonnet = { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300, long: 3600 } }
const event = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`

describe('cache warming on the wire', () => {
    it('reads the prompt of an answer, streamed or not', () => {
        const claude = new AnswerTap('anthropic-messages', true)
        claude.push(event({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } } }).slice(0, 20))
        claude.push(event({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } } }).slice(20))
        claude.push(event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }))
        expect(claude.tokens()).toMatchObject({ input: 5, output: 7, cacheRead: 900, cacheWrite: 100 })

        const codex = new AnswerTap('openai-responses', true)
        codex.push(event({ type: 'response.completed', response: { usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 3 } } }))
        expect(codex.tokens()).toEqual({ input: 200, output: 3, cacheRead: 800, cacheWrite: 0 })

        const plain = new AnswerTap('openai-responses', false)
        plain.push(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 1 } }))
        expect(plain.tokens()).toEqual({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0 })
    })

    it('warms as pi does: when the miss it saves, by the chance of a next request, beats the warm by 5¢', () => {
        expect(shouldWarm(sonnet, 100_000, 'streaming')).toBe(true)
        expect(shouldWarm(sonnet, 10_000, 'streaming')).toBe(false)
        expect(shouldWarm(sonnet, 300_000, 'idle')).toBe(true)
        expect(shouldWarm(sonnet, 200_000, 'idle')).toBe(false)
        expect(shouldWarm({}, 100_000, 'streaming')).toBe(false)
    })

    it('replays the request with a one-token answer, not streamed', () => {
        const body = { model: 'm', stream: true, max_tokens: 32000, messages: [{ role: 'user', content: 'hi' }] }
        expect(replayBody({ api: 'anthropic-messages', url: '', headers: {}, body })).toEqual({ ...body, max_tokens: 1, stream: false })
        expect(replayBody({ api: 'openai-responses', url: '', headers: {}, body: { model: 'm', input: [] } })).toEqual({ model: 'm', input: [], max_output_tokens: 16, stream: false })
    })

    it('keeps a run per prefix, not for budget thinking or a model without a lifetime, and stops when the thread settles', () => {
        let mode: 'streaming' | 'idle' = 'streaming'
        const warmer = new Warmer({ fetch, mode: () => mode, now: Date.now, warmed: () => {} })
        const state: WarmState = { running: true, runs: new Map() }
        const tokens = { input: 0, output: 1, cacheRead: 100_000, cacheWrite: 0 }
        const request = (body: object) => ({ api: 'anthropic-messages' as const, url: 'http://127.0.0.1:9/v1/messages', headers: {}, body: { model: 'm', system: 'main', ...body } })
        warmer.served(state, request({}), 'p', sonnet, tokens)
        warmer.served(state, request({ messages: ['later'] }), 'p', sonnet, tokens)
        warmer.served(state, request({ system: 'subagent' }), 'p', sonnet, tokens)
        expect(state.runs.size).toBe(2)
        warmer.served(state, request({ system: 'x', thinking: { type: 'enabled', budget_tokens: 1024 } }), 'p', sonnet, tokens)
        warmer.served(state, request({ system: 'y' }), 'p', {}, tokens)
        expect(state.runs.size).toBe(2)
        mode = 'idle'
        warmer.running(state, false)
        expect(state.runs.size).toBe(2)
        mode = 'streaming'
        warmer.running(state, false)
        expect(state.runs.size).toBe(0)
        warmer.served(state, request({}), 'p', sonnet, tokens)
        expect(state.runs.size).toBe(0)
    })
})
