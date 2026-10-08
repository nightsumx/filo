// Opening an old session that is not running replays it read-only with the agent's own protocol:
// Codex speaks app-server (native/codex.ts), not ACP, so asking it for ACP's loadSession failed
// with "Codex cannot reopen sessions".
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../pi-env', () => ({ loginShellPath: async () => '/usr/bin:/bin' }))

const { AcpService } = await import('./service')
const { acpSessionKey } = await import('@shared/agents')

// A minimal `codex app-server`: the handshake, thread/read and two pages of history.
const FAKE_APP_SERVER = `
const TURN1 = { id: 't1', status: 'completed', items: [
    { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'list the files' }] },
    { type: 'reasoning', id: 'r1', summary: ['Look first.'], content: [] },
    { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/x', status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts\\nb.ts' },
    { type: 'agentMessage', id: 'a1', text: 'Two files.' },
] }
const TURN2 = { id: 't2', status: 'completed', items: [
    { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'and now?' }] },
    // Far over one pipe read (64KB), multi-byte: the reply only parses when lines are framed.
    { type: 'agentMessage', id: 'big', text: '长'.repeat(100000) },
    { type: 'agentMessage', id: 'a2', text: 'Answer from history' },
] }
const rl = require('node:readline').createInterface({ input: process.stdin })
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
rl.on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.id === undefined) return
    if (msg.method === 'initialize') return reply(msg.id, { userAgent: 'fake' })
    // Reading only: thread/read, which (unlike thread/resume) does not take the thread over.
    if (msg.method === 'thread/read') return reply(msg.id, { thread: { id: msg.params.threadId, name: 'Old one' } })
    if (msg.method === 'thread/turns/list') {
        // codex 0.160's schema: asc/desc, pages under data with nextCursor.
        const p = msg.params
        if (p.sortDirection !== 'asc' || p.itemsView !== 'full')
            return process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'bad params ' + JSON.stringify(p) } }) + '\\n')
        if (!p.cursor)
            return reply(msg.id, { data: [TURN1], nextCursor: 'page2' })
        return reply(msg.id, { data: [TURN2], nextCursor: null })
    }
    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'unknown ' + msg.method } }) + '\\n')
})
`

describe('reading an old session that is not running', () => {
    let dir: string
    const previous = process.env.PI_GUI_ACP_CODEX
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-replay-'))
        await writeFile(path.join(dir, 'app-server.cjs'), FAKE_APP_SERVER)
        process.env.PI_GUI_ACP_CODEX = JSON.stringify([process.execPath, path.join(dir, 'app-server.cjs')])
    })
    afterEach(async () => {
        if (previous === undefined)
            delete process.env.PI_GUI_ACP_CODEX
        else
            process.env.PI_GUI_ACP_CODEX = previous
        // Windows keeps a folder busy until the app-server in it has exited.
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    })

    it('replays a Codex session over app-server, not ACP', async () => {
        const key = acpSessionKey('codex', 'thread-1')
        await writeFile(path.join(dir, 'acp.json'), JSON.stringify({
            sessions: [{ key, agent: 'codex', sessionId: 'thread-1', cwd: dir, title: 'Old one', createdAt: 1, updatedAt: 2, imported: true }],
        }))
        const service = new AcpService(() => path.join(dir, 'acp.json'))
        const snapshot = await service.readSession(key)
        const messages = snapshot.items.map((i: any) => i.message)
        const texts = (role: string) => messages.filter(m => m.role === role).map(m => m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''))
        // Both pages, in order, with the user's prompts.
        expect(texts('user')).toEqual(['list the files', 'and now?'])
        expect(texts('assistant').filter(Boolean)).toEqual(['Two files.', `${'长'.repeat(100000)}Answer from history`])
        const thinking = messages.flatMap(m => m.role === 'assistant' ? m.content.filter((c: any) => c.type === 'thinking') : [])
        expect(thinking.map((c: any) => c.thinking)).toEqual(['Look first.'])
        const call = messages.flatMap(m => m.role === 'assistant' ? m.content.filter((c: any) => c.type === 'toolCall') : [])[0]
        expect(call).toMatchObject({ name: 'bash', arguments: { command: 'ls' } })
        const result = messages.find(m => m.role === 'toolResult')
        expect(result).toMatchObject({ toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'a.ts\nb.ts' }] })
    }, 15_000)
})
