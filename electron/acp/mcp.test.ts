// The app's MCP servers reach an ACP agent in session/new and session/load, in ACP's shape (the
// environment as a list of name and value), and none are sent when the thread has none.
import type { McpServerConfig } from './adapter'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { acpAgent } from '@shared/agents'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpAgent } from './agent'

const FAKE = path.join(import.meta.dirname, '../../test/fakeAcp.mjs')
const spec = acpAgent('grok')!

let dir: string
let agents: AcpAgent[] = []
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pi-acp-mcp-'))
})
afterEach(async () => {
    await Promise.all(agents.map(a => a.stop()))
    agents = []
    await rm(dir, { recursive: true, force: true })
})

async function params(options: { sessionId?: string, mcpServers?: McpServerConfig[] }) {
    const log = path.join(dir, 'params.jsonl')
    const agent = new AcpAgent(spec, { file: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ACP_DIR: dir, FAKE_ACP_PARAMS: log } as Record<string, string> }, { cwd: dir, ...options }, { onEvent: () => {}, onExit: () => {} })
    agents.push(agent)
    await agent.ready
    return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

const server: McpServerConfig = { name: 'filo-browser', command: '/usr/bin/node', args: ['/res/mcp/browser.mjs'], env: { PI_KIT_BROWSER: '/tmp/b.sock', PI_KIT_BROWSER_SESSION: 'grok-1' } }

describe('MCP servers for ACP agents', () => {
    it('go to a new session with the environment as name/value pairs', async () => {
        const [request] = await params({ mcpServers: [server] })
        expect(request.method).toBe('session/new')
        expect(request.params.mcpServers).toEqual([{ name: 'filo-browser', command: '/usr/bin/node', args: ['/res/mcp/browser.mjs'], env: [{ name: 'PI_KIT_BROWSER', value: '/tmp/b.sock' }, { name: 'PI_KIT_BROWSER_SESSION', value: 'grok-1' }] }])
    })

    it('send an empty list when the thread has none', async () => {
        const [request] = await params({})
        expect(request.params.mcpServers).toEqual([])
    })
})
