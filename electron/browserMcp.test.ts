// The MCP server for the other agents (packages/capabilities/mcp/browser.mjs), run as a real process
// against the app's real tool socket with a stand-in for the browser behind it.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserRequest, BrowserResponse } from '@shared/capabilities'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { BROWSER_TOOLS } from 'pi-capabilities/lib/browserSpec.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserMcpServers } from './browserMcp'
import { ToolSocket } from './toolSocket'

const script = path.join(import.meta.dirname, '../packages/capabilities/mcp/browser.mjs')

let dir: string
let socket: ToolSocket<BrowserRequest, BrowserResponse>
let seen: BrowserRequest[]
let child: ChildProcessWithoutNullStreams | undefined
let answers: (request: BrowserRequest) => Promise<BrowserResponse> | BrowserResponse

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'filo-mcp-'))
    seen = []
    answers = () => ({ ok: true, text: 'fine' })
    socket = new ToolSocket(path.join(dir, 'b.sock'), async (request) => {
        seen.push(request)
        return answers(request)
    }, { socket: 'PI_KIT_BROWSER', token: 'PI_KIT_BROWSER_TOKEN' })
    await socket.start()
})

afterEach(async () => {
    child?.kill()
    child = undefined
    socket.stop()
    await rm(dir, { recursive: true, force: true })
})

/** Starts the server; returns a way to call it. */
function client(env: Record<string, string> = {}) {
    child = spawn(process.execPath, [script], { env: { ...process.env, ...socket.env(), PI_KIT_BROWSER_CWD: '/work/app', PI_KIT_BROWSER_SESSION: 's-1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const waiting = new Map<number, (message: any) => void>()
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line)
        waiting.get(message.id)?.(message)
    })
    let next = 0
    return {
        request(method: string, params?: unknown): Promise<any> {
            const id = ++next
            return new Promise((resolve) => {
                waiting.set(id, resolve)
                child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
            })
        },
        notify(method: string, params?: unknown) {
            child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
        },
    }
}

describe('browser MCP server', () => {
    it('lists the same tools pi has, taken from the app', async () => {
        answers = request => request.method === 'tools'
            ? { ok: true, instructions: 'Use refs.', tools: BROWSER_TOOLS.map(t => ({ name: t.name, title: t.label, description: t.description, inputSchema: t.parameters, readOnly: t.readOnly === true })) }
            : { ok: true }
        const c = client()
        const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
        expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'filo-browser' }, instructions: 'Use refs.' })
        const list = await c.request('tools/list')
        expect(list.result.tools.map((t: any) => t.name)).toEqual(BROWSER_TOOLS.map(t => t.name))
        const click = list.result.tools.find((t: any) => t.name === 'browser_click')
        expect(click.inputSchema).toMatchObject({ type: 'object', properties: { ref: { type: 'string' } } })
        expect(list.result.tools.find((t: any) => t.name === 'browser_snapshot').annotations.readOnlyHint).toBe(true)
        expect(click.annotations.readOnlyHint).toBe(false)
    })

    it('sends a call with the thread\'s folder and its own session, and returns text and images', async () => {
        answers = () => ({ ok: true, text: 'Page: Hi', image: { data: 'AAAA', mimeType: 'image/png' } })
        const c = client()
        const result = await c.request('tools/call', { name: 'browser_screenshot', arguments: { full_page: true } })
        expect(result.result).toEqual({ content: [{ type: 'text', text: 'Page: Hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] })
        expect(seen.at(-1)).toMatchObject({ method: 'tool', name: 'browser_screenshot', args: { full_page: true }, cwd: '/work/app', session: 's-1', token: socket.token })
    })

    it('reports the app\'s refusals and an unreachable app as tool errors, not crashes', async () => {
        answers = () => ({ ok: false, error: 'no such ref e9' })
        const c = client()
        const refused = await c.request('tools/call', { name: 'browser_click', arguments: { ref: 'e9' } })
        expect(refused.result).toEqual({ content: [{ type: 'text', text: 'no such ref e9' }], isError: true })
        socket.stop()
        const gone = await c.request('tools/call', { name: 'browser_click', arguments: {} })
        expect(gone.result.isError).toBe(true)
        expect(gone.result.content[0].text).toMatch(/not reachable/)
        expect((await c.request('ping')).result).toEqual({})
    })

    it('drops a call the client cancels, and answers unknown methods with an error', async () => {
        let started!: () => void
        const gotIt = new Promise<void>(r => (started = r))
        answers = () => {
            started()
            return new Promise(() => {})
        }
        const c = client()
        const pending = c.request('tools/call', { name: 'browser_wait', arguments: { seconds: 30 } })
        await gotIt
        c.notify('notifications/cancelled', { requestId: 1 })
        const unknown = await c.request('resources/list')
        expect(unknown.error.code).toBe(-32601)
        // The cancelled call is never answered.
        expect(await Promise.race([pending.then(() => 'answered'), new Promise(r => setTimeout(() => r('silent'), 300))])).toBe('silent')
    })

    it('says so when the app\'s socket is not set', async () => {
        const c = client({ PI_KIT_BROWSER: '' })
        const result = await c.request('tools/call', { name: 'browser_snapshot', arguments: {} })
        expect(result.result.isError).toBe(true)
        expect(result.result.content[0].text).toMatch(/not available/)
    })
})

describe('browserMcpServers', () => {
    const options = { script: '/res/mcp/browser.mjs', env: () => ({ PI_KIT_BROWSER: '/tmp/b.sock', PI_KIT_BROWSER_TOKEN: 't' }) }

    it('gives a thread the server only when the browser capability is on and the app listens', () => {
        expect(browserMcpServers(options, ['todo'], '/work', 'codex')).toEqual([])
        expect(browserMcpServers({ ...options, env: () => ({}) }, ['browser'], '/work', 'codex')).toEqual([])
        const [server] = browserMcpServers(options, ['todo', 'browser'], '/work', 'codex')
        expect(server).toMatchObject({ name: 'filo-browser', args: ['/res/mcp/browser.mjs'], env: { PI_KIT_BROWSER: '/tmp/b.sock', PI_KIT_BROWSER_TOKEN: 't', PI_KIT_BROWSER_CWD: '/work', ELECTRON_RUN_AS_NODE: '1' } })
        expect(server.env.PI_KIT_BROWSER_SESSION).toMatch(/^codex-/)
    })

    it('makes every thread its own caller, so each gets a tab of its own', () => {
        const a = browserMcpServers(options, ['browser'], '/work', 'codex')[0].env.PI_KIT_BROWSER_SESSION
        const b = browserMcpServers(options, ['browser'], '/work', 'codex')[0].env.PI_KIT_BROWSER_SESSION
        expect(a).not.toBe(b)
    })
})
