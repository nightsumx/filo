// AcpAgent against a stand-in for `gemini --acp` that loads a session as Gemini CLI 0.63.0 does:
// its own `<session_context>` preamble first, and the response to session/load before the history
// (loadSession does not await streamHistory).
import type { PiEvent } from '@shared/pi'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acpAgent } from '@shared/agents'
import { AcpAgent } from './agent'

const FAKE = `
let buffer = ''
const write = m => process.stdout.write(JSON.stringify(m) + '\\n')
const update = (sessionId, u) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const text = t => ({ type: 'text', text: t })
async function handle(m) {
    const p = m.params ?? {}
    if (m.method === 'initialize')
        return write({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    if (m.method === 'session/load') {
        write({ jsonrpc: '2.0', id: m.id, result: { modes: { availableModes: [], currentModeId: 'default' } } })
        await sleep(30)
        update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: text('<session_context>\\nThis is the Gemini CLI.\\n</session_context>') })
        update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: text('terminal question') })
        await sleep(30)
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('terminal answer') })
        return
    }
    if (m.method === 'session/prompt') {
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('new answer') })
        return write({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
    }
    if (m.id !== undefined)
        write({ jsonrpc: '2.0', id: m.id, result: {} })
}
process.stdin.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (line.trim())
            void handle(JSON.parse(line))
    }
})
`

let dir: string
let agent: AcpAgent | undefined
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pi-fake-gemini-'))
    await writeFile(path.join(dir, 'gemini.cjs'), FAKE)
})
afterEach(async () => {
    await agent?.stop()
    await rm(dir, { recursive: true, force: true })
})

it('takes Gemini\'s history as history when it streams in after session/load returns', async () => {
    const events: PiEvent[] = []
    agent = new AcpAgent(acpAgent('gemini')!, { file: process.execPath, args: [path.join(dir, 'gemini.cjs')], env: { ...process.env } as Record<string, string> }, { cwd: dir, sessionId: 's1', replayTime: 1000 }, {
        onEvent: (_, event) => events.push(event),
        onExit: () => {},
    })
    await agent.ready
    await new Promise(r => setTimeout(r, 200))
    // Nothing of the old turn reaches the thread as live messages; the thread has it from the replay.
    expect(events.filter(e => e.type === 'message_end')).toEqual([])

    const settled = new Promise<void>(resolve => events.push = function (this: PiEvent[], ...e: PiEvent[]) {
        if (e.some(x => x.type === 'agent_settled' as any))
            resolve()
        return Array.prototype.push.apply(this, e)
    })
    const response = await agent.request({ type: 'prompt', message: 'follow-up' } as any)
    expect(response.success).toBe(true)
    await settled
    const ended = events.filter(e => e.type === 'message_end').map((e: any) => [e.message.role, e.message.content[0]?.text])
    expect(ended).toEqual([['user', 'follow-up'], ['assistant', 'new answer']])
    const items = agent.snapshot().map(i => [i.message.role, (i.message as any).content[0]?.text])
    expect(items).toEqual([['user', 'terminal question'], ['assistant', 'terminal answer'], ['user', 'follow-up'], ['assistant', 'new answer']])
    // The old turn keeps the session's time, not the time it happened to arrive.
    expect(agent.snapshot()[0].message.timestamp).toBe(1000)
})
