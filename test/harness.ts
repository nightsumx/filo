// End-to-end harness for capability extensions: a scripted OpenAI-compatible model plus a real
// `pi --mode rpc` started through the app's AgentManager. No real provider, no tokens spent.
import type { ApprovalMode, CapabilityId } from '@shared/capabilities'
import type { PiEnv } from '@shared/ipc'
import type { PiEvent, RpcResponse } from '@shared/pi'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../electron/agents'
import { resolvePiEnv, setBundledPi } from '../electron/pi-env'

export const EXTENSIONS_DIR = path.resolve(__dirname, '../packages/capabilities/extensions')

/** What one model request looked like, decoded from the chat-completions body. */
export interface MockRequest {
    system: string
    messages: any[]
    tools: any[]
    /** Text of every tool result message, in order. */
    toolResults: string[]
}

/**
 * thinking streams as reasoning_content before the reply, like llama.cpp / DeepSeek endpoints.
 * `delayMs` holds the rest of the reply back (after thinking, if any), and `usage` sets the token
 * counts; both only matter where timings and stats are shown (site screenshots).
 */
export type MockReply = { delayMs?: number, usage?: { input: number, output: number } } & (
    | { text: string, thinking?: string }
    | { toolCalls: { name: string, arguments: Record<string, unknown> }[], thinking?: string, text?: string }
)

export interface MockLlm {
    baseUrl: string
    requests: MockRequest[]
    close: () => Promise<void>
}

const text = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : ''

export async function startMockLlm(reply: (request: MockRequest, index: number) => MockReply): Promise<MockLlm> {
    const requests: MockRequest[] = []
    let callId = 0
    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
            body += chunk
        })
        req.on('end', () => {
            // The model list an endpoint form fetches (OpenAI's GET /models).
            if (req.method === 'GET' && req.url === '/v1/models') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
                return
            }
            const parsed = JSON.parse(body || '{}')
            const messages: any[] = parsed.messages ?? []
            const request: MockRequest = {
                system: messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => text(m.content)).join('\n'),
                messages,
                tools: parsed.tools ?? [],
                toolResults: messages.filter(m => m.role === 'tool').map(m => text(m.content)),
            }
            requests.push(request)
            const answer = reply(request, requests.length - 1)
            const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
                id: 'mock',
                object: 'chat.completion.chunk',
                created: 0,
                model: parsed.model,
                choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`)
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            if (answer.thinking)
                chunk({ role: 'assistant', reasoning_content: answer.thinking })
            const finish = () => {
                if ('toolCalls' in answer) {
                    if (answer.text)
                        chunk({ role: 'assistant', content: answer.text })
                    chunk({
                        role: 'assistant',
                        tool_calls: answer.toolCalls.map((c, index) => ({
                            index,
                            id: `call_${++callId}`,
                            type: 'function',
                            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                        })),
                    })
                    chunk({}, 'tool_calls')
                }
                else {
                    chunk({ role: 'assistant', content: answer.text })
                    chunk({}, 'stop')
                }
                const { input, output } = answer.usage ?? { input: 1, output: 1 }
                res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } })}\n\n`)
                res.end('data: [DONE]\n\n')
            }
            if (answer.delayMs)
                setTimeout(finish, answer.delayMs)
            else
                finish()
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise(resolve => server.close(() => resolve())),
    }
}

/**
 * The installed pi, or null when it cannot be found (tests then skip). PI_GUI_PI=bundled runs the
 * pi devDependency on the electron package's binary as node, the way the app runs its shipped pi.
 */
export async function findPi(): Promise<PiEnv | null> {
    const root = path.join(import.meta.dirname, '..')
    setBundledPi({
        cli: path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
        launcher: path.join(root, 'electron/piLauncher.mjs'),
        runtime: createRequire(import.meta.url)('electron') as unknown as string,
    })
    const result = await resolvePiEnv()
    return result.ok ? result.env : null
}

export interface PiSession {
    /** Throwaway agent dir (sessions are written under it) and project dir; removed by stop(). */
    agentDir: string
    cwd: string
    events: PiEvent[]
    request: <T = any>(command: Record<string, unknown>) => Promise<RpcResponse<T>>
    /** Writes a record without waiting for a response (extension_ui_response). */
    send: (record: Record<string, unknown>) => void
    /** Resolves with the first event (already seen or future) matching the predicate. */
    waitFor: (match: (event: PiEvent) => boolean, timeoutMs?: number) => Promise<PiEvent>
    /** Sends a prompt and waits for agent_settled. */
    run: (message: string) => Promise<void>
    stop: () => Promise<void>
}

/**
 * Starts pi in a throwaway agent dir whose only model is the mock, so user settings, extensions
 * and credentials are never read.
 */
export async function startPi(env: PiEnv, llm: MockLlm, capabilities: CapabilityId[], options: { approvalMode?: ApprovalMode, settings?: Record<string, unknown>, hostEnv?: Record<string, string> } = {}): Promise<PiSession> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-test-'))
    const agentDir = path.join(root, 'agent')
    const cwd = path.join(root, 'project')
    await mkdir(agentDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off', ...options.settings }))

    const events: PiEvent[] = []
    const waiters: { match: (e: PiEvent) => boolean, resolve: (e: PiEvent) => void }[] = []
    let exited = false
    const manager = new AgentManager({
        onEvent: (_id, event) => {
            events.push(event)
            for (const w of [...waiters]) {
                if (w.match(event)) {
                    waiters.splice(waiters.indexOf(w), 1)
                    w.resolve(event)
                }
            }
        },
        onExit: () => {
            exited = true
        },
    }, EXTENSIONS_DIR, () => options.hostEnv ?? {})

    // piSpawnEnv copies process.env at spawn time.
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    const id = manager.start(env, { cwd, capabilities, approvalMode: options.approvalMode })
    if (previous === undefined)
        delete process.env.PI_CODING_AGENT_DIR
    else
        process.env.PI_CODING_AGENT_DIR = previous

    const waitFor = (match: (event: PiEvent) => boolean, timeoutMs = 15_000) => {
        const seen = events.find(match)
        if (seen)
            return Promise.resolve(seen)
        return new Promise<PiEvent>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for event${exited ? ' (pi exited)' : ''}`)), timeoutMs)
            waiters.push({ match, resolve: (e) => {
                clearTimeout(timer)
                resolve(e)
            } })
        })
    }

    return {
        agentDir,
        cwd,
        events,
        request: command => manager.request(id, command),
        send: record => manager.send(id, record),
        waitFor,
        async run(message) {
            const before = events.length
            const response = await manager.request(id, { type: 'prompt', message })
            if (!response.success)
                throw new Error(response.error)
            await waitFor(e => e.type === 'agent_settled' && events.indexOf(e) >= before)
        },
        async stop() {
            await manager.stopAll()
            // Windows keeps a folder busy until the processes in it have exited.
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
        },
    }
}
