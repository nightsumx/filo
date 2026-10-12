// Routing end to end with the real agent CLIs (each skipped when not installed): the agent is pointed
// at the gateway the way the app launches it, and the group's first provider is overloaded, so every
// answer the agent prints must have come from the second one. The providers are a local fake, and
// each agent gets a home of its own, so nothing reaches a real account or the user's config.
import type { AddressInfo } from 'node:net'
import type { RouteCatalog, RoutesConfig } from '@shared/routes'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { acpAgent } from '@shared/agents'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RoutesService } from './routes'

const which = (bin: string) => {
    try {
        return execFileSync('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim() || undefined
    }
    catch {
        return undefined
    }
}
const claude = which('claude')
const codex = which('codex')
const grok = which('grok')
const PI = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
const EXTENSION = path.resolve(__dirname, '../packages/capabilities/extensions/routes.ts')

/** Requests the fake providers got: provider, path, model, the key they were sent. */
const seen: { provider: string, path: string, model?: string, key?: string }[] = []

const sse = (res: http.ServerResponse, events: [string | undefined, unknown][]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [event, data] of events)
        res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    res.end()
}

function anthropic(res: http.ServerResponse, model: string, text: string) {
    const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }],
    ])
}

function responses(res: http.ServerResponse, model: string, text: string) {
    const item = { type: 'message', role: 'assistant', id: 'm1', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    sse(res, [
        ['response.created', { type: 'response.created', response: { id: 'r1', model, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'm1', delta: text }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response: { id: 'r1', model, status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } }],
    ])
}

function chat(res: http.ServerResponse, model: string, text: string) {
    const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })
    sse(res, [
        [undefined, chunk({ role: 'assistant', content: '' })],
        [undefined, chunk({ content: text })],
        [undefined, { ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }],
        [undefined, '[DONE]'],
    ])
}

let upstream: http.Server
let upstreamUrl = ''
let routes: RoutesService
let home: string
const ANSWER = 'routed-through-good'

const config: RoutesConfig = {
    groups: [
        { id: 'claudeg', name: 'Claude group', api: 'anthropic-messages', mode: 'order', members: [{ provider: 'bad', model: 'claude-x' }, { provider: 'good', model: 'claude-x' }] },
        { id: 'codexg', name: 'Codex group', api: 'openai-responses', mode: 'order', members: [{ provider: 'bad', model: 'gpt-x' }, { provider: 'good', model: 'gpt-x' }] },
        { id: 'chatg', name: 'Chat group', api: 'openai-completions', mode: 'order', members: [{ provider: 'bad', model: 'chat-x' }, { provider: 'good', model: 'chat-x' }] },
        // Members of their own: Grok's run leaves bad/chat-x resting.
        { id: 'pig', name: 'pi group', api: 'openai-completions', mode: 'order', members: [{ provider: 'bad', model: 'pi-x' }, { provider: 'good', model: 'pi-x' }] },
    ],
    syncTerminal: false,
    terminal: { claude: 'claudeg', codex: 'codexg' },
}

beforeAll(async () => {
    upstream = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => (body += c))
        req.on('end', () => {
            const [, provider, ...rest] = (req.url ?? '').split('/')
            const json = body ? JSON.parse(body) : {}
            const key = String(req.headers['x-api-key'] ?? req.headers.authorization ?? '')
            seen.push({ provider, path: `/${rest.join('/')}`, model: json.model, key })
            if (provider === 'bad') {
                res.writeHead(529, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
                return
            }
            const route = `/${rest.join('/')}`
            if (route.startsWith('/v1/messages/count_tokens'))
                return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
            if (route.startsWith('/v1/messages')) {
                if (!json.stream)
                    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
                return anthropic(res, json.model, ANSWER)
            }
            if (route.startsWith('/v1/responses'))
                return responses(res, json.model, ANSWER)
            if (route.startsWith('/v1/chat/completions'))
                return chat(res, json.model, ANSWER)
            res.writeHead(404).end()
        })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    home = await mkdtemp(path.join(os.tmpdir(), 'routes-e2e-'))
    const catalog: RouteCatalog = { models: [], skipped: [] }
    routes = new RoutesService({
        file: path.join(home, 'routes.json'),
        helper: {
            routeCatalog: async () => catalog,
            routeTarget: async (provider, model) => ({
                api: 'x',
                // Anthropic base URLs leave /v1 out, OpenAI ones name it: as pi has them.
                baseUrl: `${upstreamUrl}/${provider}${model.startsWith('claude') ? '' : '/v1'}`,
                apiKey: `real-key-${provider}`,
            }),
        },
        onChanged: () => {},
        piExtension: EXTENSION,
        home,
        // Terminal sync's files: folders of the test's own.
        env: { CLAUDE_CONFIG_DIR: path.join(home, 'term-claude'), CODEX_HOME: path.join(home, 'term-codex'), PI_CODING_AGENT_DIR: path.join(home, 'term-pi') },
    })
    await routes.save(config)
})

afterAll(async () => {
    await routes.shutdown()
    await new Promise<void>(r => upstream.close(() => r()))
    await rm(home, { recursive: true, force: true })
})

const run = (file: string, args: string[], env: Record<string, string>, cwd = home) => new Promise<{ stdout: string, stderr: string, code: number | null }>((resolve) => {
    const child = execFile(file, args, { env, cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? (error as any).code ?? 1 : 0 }))
    // CLIs in print mode read a piped stdin as more prompt.
    child.stdin?.end()
})

const baseEnv = () => {
    const env = { ...process.env as Record<string, string> }
    for (const name of Object.keys(env)) {
        if (/^(ANTHROPIC|OPENAI|CLAUDE|CODEX|GROK|XAI|GEMINI|GOOGLE)_/.test(name))
            delete env[name]
    }
    return env
}

/** The launch the app would start an agent with, for a thread on its group. */
const THREAD_GROUPS = { claude: 'claudeg', codex: 'codexg', grok: 'chatg' }
async function routedLaunch(agent: 'claude' | 'codex' | 'grok', args: string[], env: Record<string, string>) {
    const routed = await routes.routeAcp(acpAgent(agent)!, { file: 'x', args, env }, { group: THREAD_GROUPS[agent] })
    expect(routed).toBeDefined()
    routed!.started(`test-${agent}`)
    return routed!
}

const expectFailover = (provider: string, from: number) => {
    const mine = seen.slice(from)
    if (process.env.ROUTES_E2E_DEBUG)
        console.log(provider, JSON.stringify(mine, null, 1), JSON.stringify(routes.gateway.recent, null, 1))
    expect(mine.some(s => s.provider === 'bad'), JSON.stringify(mine)).toBe(true)
    expect(mine.some(s => s.provider === 'good')).toBe(true)
    // The real key went upstream, never the gateway's.
    expect(mine.every(s => s.key?.includes(`real-key-${s.provider}`)), JSON.stringify(mine)).toBe(true)
    void provider
}

describe('routing through the gateway with real agents', () => {
    it.skipIf(!claude)('Claude Code', async () => {
        const from = seen.length
        const env = baseEnv()
        env.CLAUDE_CONFIG_DIR = path.join(home, 'claude')
        const routed = await routedLaunch('claude', [], env)
        expect(routed.launch.env.ANTHROPIC_BASE_URL).toBe(routes.gateway.origin)
        const out = await run(claude!, ['-p', 'say hi', '--output-format', 'json', '--model', 'claude-sonnet-4-5'], routed.launch.env)
        expect(out.stdout, out.stderr).toContain(ANSWER)
        expectFailover('anthropic', from)
        expect(seen.slice(from).filter(s => s.provider === 'good').every(s => s.model === 'claude-x')).toBe(true)
        routed.exited()
    }, 150_000)

    it.skipIf(!codex)('Codex', async () => {
        const from = seen.length
        const env = baseEnv()
        env.CODEX_HOME = path.join(home, 'codex')
        await import('node:fs/promises').then(fs => fs.mkdir(env.CODEX_HOME, { recursive: true }))
        await writeFile(path.join(env.CODEX_HOME, 'config.toml'), 'model = "gpt-5.5"\n')
        const routed = await routedLaunch('codex', ['app-server'], env)
        const overrides = routed.launch.args.slice(1)
        const out = await run(codex!, ['exec', '--skip-git-repo-check', ...overrides, 'say hi'], routed.launch.env)
        if (process.env.ROUTES_E2E_DEBUG)
            console.log(out.stdout, out.stderr.slice(-3000), JSON.stringify(seen.slice(from)), JSON.stringify(routes.gateway.recent))
        expect(out.stdout + out.stderr).toContain(ANSWER)
        expectFailover('openai', from)
        routed.exited()
    }, 150_000)

    it.skipIf(!grok)('Grok Build', async () => {
        const from = seen.length
        const env = baseEnv()
        env.GROK_HOME = path.join(home, '.grok')
        const routed = await routedLaunch('grok', ['--no-auto-update', 'agent', '--no-leader', 'stdio'], env)
        expect(routed.launch.args).toEqual(['--no-auto-update', 'agent', '-m', 'filo-chatg', '--no-leader', 'stdio'])
        // The models of every group Grok can use (Chat here), the key from the environment.
        const toml = await readFile(path.join(home, '.grok', 'config.toml'), 'utf8')
        expect(toml).toContain('[model."filo-chatg"]')
        const out = await run(grok!, ['--no-auto-update', '-p', 'say hi', '-m', 'filo-chatg'], routed.launch.env)
        if (process.env.ROUTES_E2E_DEBUG)
            console.log(out.stdout, out.stderr.slice(-3000), JSON.stringify(seen.slice(from)), JSON.stringify(routes.gateway.recent))
        expect(out.stdout + out.stderr).toContain(ANSWER)
        expectFailover('xai', from)
        routed.exited()
    }, 150_000)

    it('pi', async () => {
        const from = seen.length
        const env = baseEnv()
        env.PI_CODING_AGENT_DIR = path.join(home, 'pi')
        const routed = await routes.routePi()
        expect(routed).toBeDefined()
        routed!.started('test-pi')
        // A thread picks the group as its model.
        const out = await run(process.execPath, [PI, ...routed!.args, '--model', 'filo/pig', '--no-session', '-p', 'say hi'], { ...env, ...routed!.env })
        if (process.env.ROUTES_E2E_DEBUG)
            console.log(out.stdout, out.stderr.slice(-3000), JSON.stringify(seen.slice(from)), JSON.stringify(routes.gateway.recent))
        expect(out.stdout, out.stderr).toContain(ANSWER)
        expectFailover('pi', from)
        routed!.exited()
    }, 150_000)
})

// The agents started as from a terminal: no launch of the app's, only their own config files, which
// terminal sync pointed at the gateway.
describe('terminal sync with real agents', () => {
    const CODEX_USER = 'model = "gpt-5.5"\n\n[model_providers.other]\nname = "Other"\nbase_url = "http://127.0.0.1:1/v1"\n'
    beforeAll(async () => {
        await import('node:fs/promises').then(fs => fs.mkdir(path.join(home, 'term-codex'), { recursive: true }))
        await writeFile(path.join(home, 'term-codex', 'config.toml'), CODEX_USER)
        await routes.save({ ...config, syncTerminal: true })
        expect(routes.state().status.syncErrors).toEqual({})
    })
    afterAll(async () => {
        await routes.save({ ...config, syncTerminal: false })
    })
    /** Served by the good provider through the gateway since `from`, with its real key. */
    const expectRouted = (from: number) => {
        const mine = seen.slice(from)
        expect(mine.some(s => s.provider === 'good'), JSON.stringify(mine)).toBe(true)
        expect(mine.every(s => s.key?.includes(`real-key-${s.provider}`)), JSON.stringify(mine)).toBe(true)
    }

    it.skipIf(!claude)('Claude Code', async () => {
        const from = seen.length
        const out = await run(claude!, ['-p', 'say hi', '--output-format', 'json', '--model', 'claude-sonnet-4-5'], { ...baseEnv(), CLAUDE_CONFIG_DIR: path.join(home, 'term-claude') })
        expect(out.stdout, out.stderr).toContain(ANSWER)
        expectRouted(from)
    }, 150_000)

    it.skipIf(!codex)('Codex', async () => {
        const from = seen.length
        const out = await run(codex!, ['exec', '--skip-git-repo-check', 'say hi'], { ...baseEnv(), CODEX_HOME: path.join(home, 'term-codex') })
        expect(out.stdout + out.stderr).toContain(ANSWER)
        expectRouted(from)
    }, 150_000)

    it('pi', async () => {
        const from = seen.length
        const out = await run(process.execPath, [PI, '--model', 'filo/pig', '--no-session', '-p', 'say hi'], { ...baseEnv(), PI_CODING_AGENT_DIR: path.join(home, 'term-pi') })
        expect(out.stdout, out.stderr).toContain(ANSWER)
        expectRouted(from)
    }, 150_000)

    it('puts the files back when turned off', async () => {
        await routes.save({ ...config, syncTerminal: false })
        expect(await readFile(path.join(home, 'term-codex', 'config.toml'), 'utf8')).toBe(CODEX_USER)
        await expect(readFile(path.join(home, 'term-claude', 'settings.json'), 'utf8')).rejects.toThrow()
        await expect(readFile(path.join(home, 'term-pi', 'models.json'), 'utf8')).rejects.toThrow()
    })
})
