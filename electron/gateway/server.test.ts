import type { AddressInfo } from 'node:net'
import type { RouteEvent, RouteGroup, RoutesConfig } from '@shared/routes'
import type { MemberTarget } from './server'
import type { WarmEntry } from './warm'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { groupsFor } from '@shared/routes'
import { Gateway, UnreachableMember } from './server'

// A fake provider host: each provider id is a path prefix, answering as the test tells it.
type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void
const handlers = new Map<string, Handler>()
const seen: { provider: string, path: string, body: any, headers: IncomingMessage['headers'] }[] = []
let upstream: Server
let upstreamUrl = ''

beforeAll(async () => {
    upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c)
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
        const [, provider, ...rest] = (req.url ?? '').split('/')
        seen.push({ provider, path: `/${rest.join('/')}`, body, headers: req.headers })
        const handler = handlers.get(provider)
        if (!handler) {
            res.writeHead(404).end()
            return
        }
        handler(req, body, res)
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(r => upstream.close(() => r())))

const sse = (res: ServerResponse, events: unknown[], { delayMs = 0, status = 200 } = {}) => {
    res.writeHead(status, { 'content-type': 'text/event-stream' })
    let i = 0
    const next = () => {
        if (i >= events.length) {
            res.end()
            return
        }
        const e: any = events[i++]
        res.write(typeof e === 'string' ? e : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        setTimeout(next, delayMs)
    }
    next()
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}
const okMessage = (text: string) => [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_stop' },
]

let config: RoutesConfig
let gateway: Gateway
let events: RouteEvent[]
let keys: Record<string, string | undefined>
/** Header names of each upstream request as the gateway hands it to fetch. */
let sentHeaders: string[][]
let warms: WarmEntry[]
const group = (members: string[], extra: Partial<RouteGroup> = {}): RouteGroup => ({
    id: 'main',
    name: 'Main',
    api: 'anthropic-messages',
    mode: 'order',
    members: members.map((k) => {
        const [provider, model] = k.split('/')
        return { provider, model }
    }),
    ...extra,
})

beforeEach(async () => {
    handlers.clear()
    seen.length = 0
    events = []
    keys = { a: 'key-a', b: 'key-b', c: 'key-c' }
    sentHeaders = []
    warms = []
    config = { groups: [group(['a/m1', 'b/m2', 'c/m3'])], syncTerminal: false, terminal: {} }
    gateway = new Gateway({
        groups: agent => groupsFor(config, agent),
        resolve: async (m): Promise<MemberTarget> => {
            if (!(m.provider in keys))
                throw new UnreachableMember('auth', `no key for ${m.provider}`)
            return { api: 'anthropic-messages', baseUrl: `${upstreamUrl}/${m.provider}`, apiKey: keys[m.provider] }
        },
        onEvent: e => events.push(e),
        fetch: (input, init) => {
            sentHeaders.push(Object.keys(init?.headers ?? {}).map(h => h.toLowerCase()))
            return fetch(input, init)
        },
        keepAliveMs: 50,
        firstOutputMs: 300,
        // Eleven seconds: the first warm a second after the request.
        warming: { mode: () => 'streaming', model: () => ({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 11 } }), warmed: (_s, e) => warms.push(e) },
    })
    await gateway.listen()
})
afterEach(() => gateway.close())

/** A Claude Code process started on the main group. */
const open = () => gateway.open('claude', { startGroup: 'main' })
const call = (token: string, body: unknown, path = '/v1/messages', headers: Record<string, string> = {}) =>
    fetch(`${gateway.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) })

describe('gateway', () => {
    it('passes a channel session\'s requests on as they came, with pi\'s key, and keeps their cache warm while the thread runs', async () => {
        handlers.set('a', (_req, body, res) => body.stream
            ? sse(res, [{ type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 100_000 } } }, ...okMessage('hi').slice(1)])
            : json(res, 200, { model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 100_000, output_tokens: 1 } }))
        const session = gateway.open('claude', { channel: { provider: 'a', model: 'm1' } })
        gateway.warmer.running(session.warm, true)
        const res = await call(session.token, { model: 'claude-x', stream: true, max_tokens: 32000, messages: [{ role: 'user', content: 'hi' }] }, '/v1/messages?beta=true')
        expect(await res.text()).toContain('hi')
        expect(seen[0]).toMatchObject({ provider: 'a', path: '/v1/messages?beta=true', body: { model: 'claude-x', stream: true } })
        expect(seen[0].headers['x-api-key']).toBe('key-a')
        await new Promise(r => setTimeout(r, 1300))
        expect(seen[1]).toMatchObject({ provider: 'a', path: '/v1/messages?beta=true', body: { model: 'claude-x', stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } })
        expect(seen[1].headers['x-api-key']).toBe('key-a')
        expect(warms).toMatchObject([{ type: 'usage', kind: 'cache_warm', provider: 'a', model: 'claude-x', usage: { cacheRead: 100_000, output: 1 } }])
        gateway.drop(session.token)
        expect(session.warm.runs.size).toBe(0)
    })

    it('refuses unknown tokens and non-local Host headers', async () => {
        expect((await call('filo-nope', {})).status).toBe(401)
        const session = open()
        const { request } = await import('node:http')
        const status = await new Promise<number>((resolve) => {
            const req = request({ host: '127.0.0.1', port: gateway.port!, path: '/v1/messages', method: 'POST', headers: { 'host': 'evil.example', 'x-api-key': session.token } }, res => resolve(res.statusCode!))
            req.end('{}')
        })
        expect(status).toBe(403)
    })

    it('sends to the first member with its own key and model, and keeps the agent headers', async () => {
        handlers.set('a', (_req, _body, res) => sse(res, okMessage('hi from a')))
        const session = open()
        const res = await call(session.token, { model: 'claude-sonnet-4-5', stream: true, messages: [] }, '/v1/messages?beta=true', { 'anthropic-beta': 'x' })
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('hi from a')
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ provider: 'a', path: '/v1/messages?beta=true', body: { model: 'm1' } })
        expect(seen[0].headers['x-api-key']).toBe('key-a')
        expect(seen[0].headers['anthropic-beta']).toBe('x')
        expect(seen[0].headers['anthropic-version']).toBe('2023-06-01')
        expect(events).toEqual([])
    })

    it('leaves out the headers a browser-like fetch sets itself (Electron\'s net.fetch refuses them)', async () => {
        handlers.set('a', (_req, _body, res) => sse(res, okMessage('hi from a')))
        const session = open()
        // Node's fetch, as in the agents' SDKs, sends sec-fetch-mode on every request.
        const res = await call(session.token, { model: 'claude-sonnet-4-5', stream: true, messages: [] }, '/v1/messages', { 'sec-fetch-mode': 'cors', 'sec-ch-ua': 'x', 'user-agent': 'claude-cli/2' })
        expect(await res.text()).toContain('hi from a')
        expect(sentHeaders[0]).toContain('user-agent')
        expect(sentHeaders[0].filter(h => h.startsWith('sec-'))).toEqual([])
    })

    it('fails over on 401, 429, 5xx and network errors, then stays on the member that answered', async () => {
        keys.a = 'wrong'
        handlers.set('a', (_req, _body, res) => json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        handlers.set('b', (_req, _body, res) => json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, { 'retry-after': '30' }))
        handlers.set('c', (_req, _body, res) => sse(res, okMessage('hi from c')))
        const session = open()
        const res = await call(session.token, { stream: true, messages: [] })
        expect(await res.text()).toContain('hi from c')
        expect(seen.map(s => s.provider)).toEqual(['a', 'b', 'c'])
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ agent: 'claude', group: 'main', served: 'c/m3', failed: [{ member: 'a/m1', kind: 'auth', status: 401 }, { member: 'b/m2', kind: 'rate', status: 429 }] })
        const health = gateway.health.snapshot()
        expect(health.providers.a.reason).toBe('auth')
        expect(health.members['b/m2'].restUntil! - Date.now()).toBeGreaterThan(25_000)
        expect(health.members['c/m3'].served).toBe(1)

        // The next request goes straight to c: a and b are resting and c is sticky.
        seen.length = 0
        await (await call(session.token, { stream: true, messages: [] })).text()
        expect(seen.map(s => s.provider)).toEqual(['c'])
    })

    it('treats a member that cannot be resolved or reached as failed', async () => {
        delete keys.a
        keys.b = 'key-b'
        handlers.set('c', (_req, _body, res) => json(res, 200, { type: 'message', content: [{ type: 'text', text: 'plain' }] }))
        // b: nothing listening at its base URL.
        const resolve = gateway['hooks'].resolve
        gateway['hooks'].resolve = async m => (m.provider === 'b' ? { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1' } : resolve(m))
        const res = await call(open().token, { messages: [] })
        expect(await res.json()).toMatchObject({ content: [{ text: 'plain' }] })
        expect(events[0].failed.map(f => [f.member, f.kind])).toEqual([['a/m1', 'auth'], ['b/m2', 'network']])
    })

    it('fails over when a stream reports an error before its first output', async () => {
        handlers.set('a', (_req, _body, res) => sse(res, [{ type: 'message_start', message: {} }, { type: 'ping' }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]))
        handlers.set('b', (_req, _body, res) => sse(res, okMessage('hi from b')))
        const text = await (await call(open().token, { stream: true, messages: [] })).text()
        expect(text).toContain('hi from b')
        // Nothing of a's stream reached the agent.
        expect(text.match(/event: message_start/g)).toHaveLength(1)
        expect(text).not.toContain('Overloaded')
        expect(events[0].failed[0]).toMatchObject({ member: 'a/m1', kind: 'server', status: 529 })
    })

    it('sends keep-alives while a slow member holds back its first output', async () => {
        handlers.set('a', (_req, _body, res) => sse(res, okMessage('slow'), { delayMs: 120 }))
        config.groups[0].members = [{ provider: 'a', model: 'm1' }]
        const text = await (await call(open().token, { stream: true, messages: [] })).text()
        expect(text.startsWith(': filo keep-alive')).toBe(true)
        expect(text).toContain('slow')
    })

    it('gives up on a member with no output in time while another is left', async () => {
        handlers.set('a', (_req, _body, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(`event: message_start\ndata: {"type":"message_start"}\n\n`)
        })
        handlers.set('b', (_req, _body, res) => sse(res, okMessage('hi from b')))
        const text = await (await call(open().token, { stream: true, messages: [] })).text()
        expect(text).toContain('hi from b')
        expect(events[0].failed[0]).toMatchObject({ member: 'a/m1', status: 504 })
    })

    it('does not switch once output reached the agent', async () => {
        handlers.set('a', (_req, _body, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            for (const e of okMessage('partial').slice(0, 3))
                res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
            setTimeout(() => res.destroy(), 20)
        })
        handlers.set('b', (_req, _body, res) => sse(res, okMessage('hi from b')))
        const text = await (await call(open().token, { stream: true, messages: [] })).text().catch(() => 'aborted')
        expect(text).not.toContain('hi from b')
        expect(seen.map(s => s.provider)).toEqual(['a'])
        expect(gateway.health.snapshot().members['a/m1'].failed).toBe(1)
    })

    it('gives bad requests back to the agent without trying others', async () => {
        handlers.set('a', (_req, _body, res) => json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }))
        const res = await call(open().token, { stream: true })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ error: { message: 'messages: field required' } })
        expect(seen.map(s => s.provider)).toEqual(['a'])
        expect(gateway.health.snapshot().members['a/m1'].restUntil).toBeUndefined()
    })

    it('retries once without thinking blocks another provider signed', async () => {
        handlers.set('a', (_req, body, res) => {
            const signed = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'thinking'))
            if (signed)
                json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } })
            else
                sse(res, okMessage('fresh'))
        })
        const body = { stream: true, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'other' }, { type: 'text', text: 'y' }] }, { role: 'user', content: 'b' }] }
        const text = await (await call(open().token, body)).text()
        expect(text).toContain('fresh')
        expect(seen.map(s => s.provider)).toEqual(['a', 'a'])
        expect(seen[1].body.messages[1].content).toEqual([{ type: 'text', text: 'y' }])
    })

    it('answers with every failure when no member is left', async () => {
        handlers.set('a', (_req, _body, res) => json(res, 503, { error: { message: 'down a' } }))
        handlers.set('b', (_req, _body, res) => json(res, 503, { error: { message: 'down b' } }))
        handlers.set('c', (_req, _body, res) => json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'down c' } }))
        const res = await call(open().token, { messages: [] })
        expect(res.status).toBe(529)
        expect(await res.json()).toMatchObject({ error: { message: 'down c' } })
        expect(events[0].served).toBeUndefined()
        expect(events[0].failed).toHaveLength(3)
    })

    it('follows manual picks and thread pins', async () => {
        for (const p of ['a', 'b', 'c'])
            handlers.set(p, (_req, _body, res) => sse(res, okMessage(`hi from ${p}`)))
        config.groups.push(group(['c/m3'], { id: 'other', name: 'Other' }))
        config.groups[0] = { ...config.groups[0], mode: 'manual', pick: 'b/m2' }
        const session = open()
        expect(await (await call(session.token, { stream: true, messages: [] })).text()).toContain('hi from b')
        session.override = { pin: 'a/m1' }
        expect(await (await call(session.token, { stream: true, messages: [] })).text()).toContain('hi from a')
        // A pin that is not in the group (another group's member, a removed one) does nothing.
        session.override = { pin: 'x/m9' }
        expect(await (await call(session.token, { stream: true, messages: [] })).text()).toContain('hi from b')
    })

    it('sends every request of a process to its group, and a model naming a group to that group', async () => {
        for (const p of ['a', 'b', 'c'])
            handlers.set(p, (_req, _body, res) => sse(res, okMessage(`hi from ${p}`)))
        config.groups.push(group(['c/m3'], { id: 'other', name: 'Other' }))
        const session = open()
        // Claude Code's Haiku side requests too.
        expect(await (await call(session.token, { model: 'claude-haiku-4-5', stream: true, messages: [] })).text()).toContain('hi from a')
        // pi and Grok pick a group as their model; switching models is switching groups.
        const pi = gateway.open('pi')
        expect(await (await call(pi.token, { model: 'other', stream: true, messages: [] })).text()).toContain('hi from c')
        expect(await (await call(pi.token, { model: 'main', stream: true, messages: [] })).text()).toContain('hi from a')
    })

    it('says so when the agent has no group of its API', async () => {
        const codex = gateway.open('codex')
        const res2 = await fetch(`${gateway.origin}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${codex.token}` }, body: '{}' })
        expect(res2.status).toBe(400)
        expect(await res2.text()).toContain('routing group')
    })
})
