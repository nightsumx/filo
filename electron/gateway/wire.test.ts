import { describe, expect, it } from 'vitest'
import { bodyError, eventData, incoming, judgeEvent, SseSplitter, upstreamUrl, withoutReasoning } from './wire'

describe('incoming', () => {
    it('maps request paths to APIs', () => {
        expect(incoming('/v1/messages')).toEqual({ api: 'anthropic-messages', op: '/messages' })
        expect(incoming('/v1/messages/count_tokens')).toEqual({ api: 'anthropic-messages', op: '/messages/count_tokens' })
        expect(incoming('/v1/responses')).toEqual({ api: 'openai-responses', op: '/responses' })
        expect(incoming('/v1/chat/completions')).toEqual({ api: 'openai-completions', op: '/chat/completions' })
        expect(incoming('/v1beta/models/gemini-2.5-pro:streamGenerateContent')).toEqual({ api: 'google-generative-ai', op: 'streamGenerateContent', model: 'gemini-2.5-pro' })
        expect(incoming('/models/g1:generateContent')).toMatchObject({ model: 'g1', op: 'generateContent' })
        expect(incoming('/v1/files')).toBeUndefined()
    })

    it('builds upstream URLs from pi base URLs with or without the version', () => {
        const msg = incoming('/v1/messages')!
        expect(upstreamUrl(msg, 'https://api.anthropic.com', 'm', '')).toBe('https://api.anthropic.com/v1/messages')
        expect(upstreamUrl(msg, 'https://relay.example/api/', 'm', '?beta=true')).toBe('https://relay.example/api/v1/messages?beta=true')
        expect(upstreamUrl(msg, 'https://relay.example/v1', 'm', '')).toBe('https://relay.example/v1/messages')
        expect(upstreamUrl(incoming('/v1/responses')!, 'https://api.openai.com/v1', 'm', '')).toBe('https://api.openai.com/v1/responses')
        expect(upstreamUrl(incoming('/v1beta/models/x:streamGenerateContent')!, 'https://g.example/v1beta', 'gemini 2', '?alt=sse')).toBe('https://g.example/v1beta/models/gemini%202:streamGenerateContent?alt=sse')
    })
})

describe('streams', () => {
    it('splits events across chunks and line endings', () => {
        const s = new SseSplitter()
        expect(s.push('event: a\ndata: 1')).toEqual([])
        expect(s.push('\n\nevent: b\r\ndata: 2\r\n\r\ndata: 3')).toEqual(['event: a\ndata: 1\n\n', 'event: b\r\ndata: 2\r\n\r\n'])
        expect(s.rest()).toBe('data: 3')
        expect(eventData('event: x\ndata: {"a":\ndata: 1}\n\n')).toBe('{"a":\n1}')
        expect(eventData(': keep-alive\n\n')).toBe('')
    })

    it('holds Anthropic metadata and errors out on in-stream errors', () => {
        expect(judgeEvent('anthropic-messages', 'event: message_start\ndata: {"type":"message_start"}\n\n')).toEqual({ type: 'hold' })
        expect(judgeEvent('anthropic-messages', 'event: ping\ndata: {"type":"ping"}\n\n')).toEqual({ type: 'hold' })
        expect(judgeEvent('anthropic-messages', 'data: {"type":"content_block_start","content_block":{"type":"thinking"}}\n\n')).toEqual({ type: 'output' })
        expect(judgeEvent('anthropic-messages', 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')).toEqual({ type: 'error', status: 529, message: 'Overloaded' })
    })

    it('judges Responses, Chat and Gemini events', () => {
        expect(judgeEvent('openai-responses', 'data: {"type":"response.created"}\n\n')).toEqual({ type: 'hold' })
        expect(judgeEvent('openai-responses', 'data: {"type":"response.output_item.added"}\n\n')).toEqual({ type: 'output' })
        expect(judgeEvent('openai-responses', 'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}\n\n')).toEqual({ type: 'error', status: 429, message: 'slow down' })
        expect(judgeEvent('openai-completions', 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')).toEqual({ type: 'hold' })
        expect(judgeEvent('openai-completions', 'data: {"choices":[{"delta":{"content":""}}]}\n\n')).toEqual({ type: 'hold' })
        expect(judgeEvent('openai-completions', 'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\n')).toEqual({ type: 'output' })
        expect(judgeEvent('openai-completions', 'data: {"error":{"message":"busy","code":503}}\n\n')).toEqual({ type: 'error', status: 503, message: 'busy' })
        expect(judgeEvent('openai-completions', 'data: [DONE]\n\n')).toEqual({ type: 'output' })
        expect(judgeEvent('google-generative-ai', 'data: {"candidates":[{"content":{}}]}\n\n')).toEqual({ type: 'output' })
    })

    it('finds errors relays send with status 200', () => {
        expect(bodyError('openai-completions', '{"error":{"message":"insufficient quota","code":429}}')).toEqual({ status: 429, message: 'insufficient quota' })
        expect(bodyError('anthropic-messages', '{"type":"error","error":{"type":"rate_limit_error","message":"x"}}')).toEqual({ status: 429, message: 'x' })
        expect(bodyError('openai-completions', '{"choices":[],"error":null}')).toBeUndefined()
        expect(bodyError('openai-completions', 'not json')).toBeUndefined()
    })
})

describe('withoutReasoning', () => {
    it('drops thinking blocks and turns thinking off inside a tool loop', () => {
        const body = {
            model: 'm',
            thinking: { type: 'enabled', budget_tokens: 1000 },
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'tool_use', id: 't', name: 'n', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
            ],
        }
        const out = withoutReasoning('anthropic-messages', body)
        expect(out.messages[1].content).toEqual([{ type: 'tool_use', id: 't', name: 'n', input: {} }])
        expect(out.thinking).toBeUndefined()
        expect(body.messages[1].content).toHaveLength(2)
    })

    it('keeps thinking on outside a tool loop and does nothing without reasoning', () => {
        const body = {
            thinking: { type: 'enabled' },
            messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }, { role: 'user', content: 'next' }],
        }
        const out = withoutReasoning('anthropic-messages', body)
        expect(out.thinking).toEqual({ type: 'enabled' })
        expect(out.messages[0].content).toEqual([{ type: 'text', text: '' }])
        expect(withoutReasoning('anthropic-messages', { messages: [{ role: 'user', content: 'x' }] })).toBeUndefined()
    })

    it('drops Responses reasoning items', () => {
        expect(withoutReasoning('openai-responses', { input: [{ type: 'reasoning', encrypted_content: 'x' }, { type: 'message' }] })).toEqual({ input: [{ type: 'message' }] })
        expect(withoutReasoning('openai-responses', { input: [{ type: 'message' }] })).toBeUndefined()
    })
})
