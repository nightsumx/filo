// What the gateway needs to know of each wire API: where a request goes upstream, how the key is
// sent, which stream events are real output (before them the gateway can still switch members), how
// an error looks to the agent, and what to drop from a request a member refused for another
// provider's thinking signatures.

import type { RouteApi } from '@shared/routes'
import { anthropicErrorStatus } from './policy'

// ---------------------------------------------------------------- incoming requests

export interface Incoming {
    api: RouteApi
    /** Path after the API version (`/messages`, `/responses`, `/chat/completions`), or the Gemini method. */
    op: string
    /** Gemini: the model named in the path. */
    model?: string
}

/** The API and operation a request path is for; undefined for paths the gateway does not serve. */
export function incoming(pathname: string): Incoming | undefined {
    // Clients that add /v1 to a base URL that already has it.
    pathname = pathname.replace(/^\/v1\/v1\//, '/v1/')
    // Gemini: /v1beta/models/<model>:<method>, or without the version (pi sets it in its base URL).
    const gemini = /^(?:\/v1beta|\/v1)?\/models\/([^/:]+):(\w+)$/.exec(pathname)
    if (gemini)
        return { api: 'google-generative-ai', op: gemini[2], model: decodeURIComponent(gemini[1]) }
    if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/'))
        return { api: 'anthropic-messages', op: pathname.slice(3) }
    if (pathname === '/v1/responses' || pathname.startsWith('/v1/responses/'))
        return { api: 'openai-responses', op: pathname.slice(3) }
    if (pathname === '/v1/chat/completions')
        return { api: 'openai-completions', op: '/chat/completions' }
    return undefined
}

/** The request asks for a stream. */
export function wantsStream(req: Incoming, body: any): boolean {
    if (req.api === 'google-generative-ai')
        return req.op === 'streamGenerateContent'
    return body?.stream === true
}

/** The upstream URL for a member reached at `baseUrl` (pi's, with or without the version). */
export function upstreamUrl(req: Incoming, baseUrl: string, model: string, search: string): string {
    const base = baseUrl.replace(/\/+$/, '')
    if (req.api === 'google-generative-ai')
        return `${base}/models/${encodeURIComponent(model)}:${req.op}${search}`
    if (req.api === 'anthropic-messages')
        // pi's Anthropic base URLs leave out /v1 (its SDK adds it); some name it anyway.
        return `${base.endsWith('/v1') ? base : `${base}/v1`}${req.op}${search}`
    return `${base}${req.op}${search}`
}

/** The request body for a member: its own model id. Gemini names the model in the path instead. */
export function withModel(req: Incoming, body: any, model: string): any {
    if (req.api === 'google-generative-ai' || !body || typeof body !== 'object')
        return body
    return { ...body, model }
}

/** Auth headers for a member's key, as pi sends them for that API. */
export function authHeaders(api: RouteApi, key: string | undefined): Record<string, string> {
    if (!key)
        return {}
    if (api === 'anthropic-messages')
        return { 'x-api-key': key }
    if (api === 'google-generative-ai')
        return { 'x-goog-api-key': key }
    return { authorization: `Bearer ${key}` }
}

// ---------------------------------------------------------------- streams

/** Splits a text/event-stream into whole events (each with its blank-line terminator). */
export class SseSplitter {
    private buffer = ''

    push(chunk: string): string[] {
        this.buffer += chunk
        const events: string[] = []
        for (; ;) {
            const lf = this.buffer.indexOf('\n\n')
            const crlf = this.buffer.indexOf('\r\n\r\n')
            if (lf < 0 && crlf < 0)
                break
            const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf + 2
            events.push(this.buffer.slice(0, end))
            this.buffer = this.buffer.slice(end)
        }
        return events
    }

    /** What is left after the stream ended (an event without its blank line). */
    rest(): string {
        const rest = this.buffer
        this.buffer = ''
        return rest
    }
}

/** The `data:` payload of one event (lines joined), '' for comments and keep-alives. */
export function eventData(event: string): string {
    const lines: string[] = []
    for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:'))
            lines.push(line.slice(line[5] === ' ' ? 6 : 5))
    }
    return lines.join('\n')
}

export type StreamVerdict =
    | { type: 'hold' }
    | { type: 'output' }
    | { type: 'error', status: number, message: string }

const parse = (data: string): any => {
    try {
        return JSON.parse(data)
    }
    catch {
        return undefined
    }
}

const errorText = (error: any): string =>
    typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : JSON.stringify(error ?? '').slice(0, 500)

/**
 * Whether a stream event is output the agent acts on (text, thinking, a tool call), something that
 * can wait (metadata, pings), or an error. Until the first output the gateway holds the stream back,
 * so an error there still moves the request to the next member.
 */
export function judgeEvent(api: RouteApi, event: string): StreamVerdict {
    const data = eventData(event)
    if (!data)
        return { type: 'hold' }
    if (data === '[DONE]')
        return { type: 'output' }
    const json = parse(data)
    if (json === undefined)
        return { type: 'output' }
    if (api === 'anthropic-messages') {
        if (json.type === 'error')
            return { type: 'error', status: anthropicErrorStatus(String(json.error?.type ?? '')), message: errorText(json.error) }
        return json.type === 'message_start' || json.type === 'ping' ? { type: 'hold' } : { type: 'output' }
    }
    if (api === 'openai-responses') {
        if (json.type === 'error')
            return { type: 'error', status: Number(json.status) || statusOfCode(json.code), message: errorText(json.message ?? json.error ?? json) }
        if (json.type === 'response.failed') {
            const error = json.response?.error
            return { type: 'error', status: statusOfCode(error?.code), message: errorText(error ?? 'response.failed') }
        }
        return json.type === 'response.created' || json.type === 'response.in_progress' || json.type === 'response.queued' ? { type: 'hold' } : { type: 'output' }
    }
    if (api === 'openai-completions') {
        if (json.error)
            return { type: 'error', status: Number(json.error.code) || Number(json.error.status) || statusOfCode(json.error.type ?? json.error.code), message: errorText(json.error) }
        const choice = Array.isArray(json.choices) ? json.choices[0] : undefined
        const delta = choice?.delta ?? {}
        const said = (v: unknown) => (typeof v === 'string' ? v.length > 0 : v != null)
        return said(delta.content) || said(delta.reasoning_content) || said(delta.reasoning) || said(delta.tool_calls) || said(delta.function_call) || said(choice?.finish_reason)
            ? { type: 'output' }
            : { type: 'hold' }
    }
    // Gemini
    if (json.error)
        return { type: 'error', status: Number(json.error.code) || 500, message: errorText(json.error) }
    return Array.isArray(json.candidates) && json.candidates.length ? { type: 'output' } : { type: 'hold' }
}

/** OpenAI error codes some providers send in place of a status. */
function statusOfCode(code: unknown): number {
    const c = String(code ?? '')
    if (/rate_limit/.test(c))
        return 429
    if (/insufficient_quota|quota/.test(c))
        return 429
    if (/invalid_api_key|authentication/.test(c))
        return 401
    if (/context_length|too_long/.test(c))
        return 400
    if (/model_not_found/.test(c))
        return 404
    if (/invalid_request|invalid_prompt|bad_request/.test(c))
        return 400
    return 500
}

/** A non-stream 2xx body that is an error in disguise (some relays answer quota errors with 200). */
export function bodyError(api: RouteApi, text: string): { status: number, message: string } | undefined {
    const json = parse(text)
    if (!json || typeof json !== 'object' || !json.error)
        return undefined
    // A real reply never carries both; an error object with the reply's fields is the reply's.
    if (json.content || json.choices || json.output || json.candidates)
        return undefined
    const error = json.error
    const status = api === 'anthropic-messages' ? anthropicErrorStatus(String(error?.type ?? '')) : Number(error?.code) || statusOfCode(error?.type ?? error?.code)
    return { status, message: errorText(error) }
}

/** The message an upstream error body carries, for the status list; falls back to the text. */
export function errorMessage(text: string): string {
    const json = parse(text)
    const message = json ? errorText(json.error ?? json.message ?? json) : text
    return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** An error the gateway itself answers with, shaped like the API's own. */
export function errorBody(api: RouteApi, status: number, message: string): string {
    if (api === 'anthropic-messages')
        return JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 529 ? 'overloaded_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message } })
    if (api === 'google-generative-ai')
        return JSON.stringify({ error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : status >= 500 ? 'UNAVAILABLE' : 'INVALID_ARGUMENT' } })
    return JSON.stringify({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code: status } })
}

/** The same error as a stream event, for a stream whose headers already went out (keep-alives). */
export function errorEvent(api: RouteApi, status: number, message: string): string {
    if (api === 'anthropic-messages')
        return `event: error\ndata: ${errorBody(api, status, message)}\n\n`
    if (api === 'openai-responses')
        return `event: error\ndata: ${JSON.stringify({ type: 'error', code: String(status), message })}\n\n`
    return `data: ${errorBody(api, status, message)}\n\n`
}

// ---------------------------------------------------------------- foreign reasoning

const SIGNATURE_WORDS = /signature|thinking|redacted|encrypted_content|encrypted content|reasoning item|could not be verified|decrypt/i

/** A 400 that is about reasoning another provider (or account) produced. */
export const refusesForeignReasoning = (status: number, message: string) => status === 400 && SIGNATURE_WORDS.test(message)

/**
 * The request without the reasoning earlier answers carried (Anthropic thinking blocks, Responses
 * reasoning items), which another provider signed or encrypted; undefined when it has none. Anthropic
 * requires a tool-use continuation to start with thinking while thinking is on, so a request in the
 * middle of a tool loop also turns thinking off.
 */
export function withoutReasoning(api: RouteApi, body: any): any | undefined {
    if (!body || typeof body !== 'object')
        return undefined
    if (api === 'anthropic-messages' && Array.isArray(body.messages)) {
        let dropped = false
        const messages = body.messages.map((message: any) => {
            if (message?.role !== 'assistant' || !Array.isArray(message.content))
                return message
            const content = message.content.filter((block: any) => block?.type !== 'thinking' && block?.type !== 'redacted_thinking')
            if (content.length === message.content.length)
                return message
            dropped = true
            return { ...message, content: content.length ? content : [{ type: 'text', text: '' }] }
        })
        if (!dropped)
            return undefined
        const next: any = { ...body, messages }
        const last = messages[messages.length - 1]
        const inToolLoop = last?.role === 'user' && Array.isArray(last.content) && last.content.some((b: any) => b?.type === 'tool_result')
        if (inToolLoop && next.thinking)
            delete next.thinking
        return next
    }
    if (api === 'openai-responses' && Array.isArray(body.input)) {
        const input = body.input.filter((item: any) => item?.type !== 'reasoning')
        if (input.length === body.input.length)
            return undefined
        return { ...body, input }
    }
    return undefined
}
