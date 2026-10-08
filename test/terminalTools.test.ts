// The terminal capability end to end: a real pi with the extension, a scripted model, the app's
// socket server and real PTYs. The model starts a server in an app terminal, waits for it to be
// ready, lists terminals (the user's shell included), reads one and stops what it started.
import type { TerminalDetails } from '@shared/capabilities'
import type { PiEnv } from '@shared/ipc'
import type { MockLlm, MockReply, MockRequest, PiSession } from './harness'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TerminalTools } from '../electron/terminalTools'
import { Terminals } from '../electron/terminals'
import { findPi, startMockLlm, startPi } from './harness'

let env: PiEnv | null = null
beforeAll(async () => {
    env = await findPi()
}, 30_000)

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
    for (const f of cleanup.splice(0).reverse())
        await f()
})

const toolEnd = (name: string) => (e: any) => e.type === 'tool_execution_end' && e.toolName === name
const toolNames = (r: MockRequest) => r.tools.map((t: any) => t.function?.name ?? t.name)

/** The project folder as a window has it (unresolved, /var/…), while pi reports /private/var/…. */
async function setup(reply: (request: MockRequest, index: number) => MockReply) {
    let project = ''
    const terminals = new Terminals({ ptyDir: path.resolve('node_modules/node-pty'), onChange: () => {} })
    const dir = mkdtempSync(path.join(os.tmpdir(), 'filo-tt-'))
    const tools = new TerminalTools(terminals, path.join(dir, 't.sock'), () => [project])
    await tools.start()
    const llm: MockLlm = await startMockLlm(reply)
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => llm.close(), () => tools.stop(), () => terminals.closeAll())
    const pi: PiSession = await startPi(env!, llm, ['terminal'], { hostEnv: tools.env() })
    project = pi.cwd
    cleanup.push(() => pi.stop())
    return { terminals, tools, llm, pi }
}

describe.runIf(process.env.PI_GUI_SKIP_E2E !== '1')('terminal capability (real pi, mock model, real PTYs)', () => {
    it('runs a server in an app terminal, waits for it, lists, reads and stops it', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const idOf = (text: string) => /terminal ([0-9a-f-]{36})/.exec(text)?.[1] ?? ''
        const { terminals, llm, pi } = await setup((r, i) => {
            if (i === 0)
                return { toolCalls: [{ name: 'terminal_run', arguments: { command: 'echo booting; sleep 1; echo "ready on 4100"; sleep 600', label: 'dev', wait_for: 'ready on', timeout: 20 } }] }
            const id = idOf(r.toolResults[0] ?? '')
            if (i === 1)
                return { toolCalls: [{ name: 'terminal_read', arguments: {} }] }
            if (i === 2)
                return { toolCalls: [{ name: 'terminal_read', arguments: { id, lines: 5 } }] }
            if (i === 3)
                return { toolCalls: [{ name: 'terminal_stop', arguments: { id } }] }
            return { text: 'done' }
        })
        // The user's own shell in the same project, as if opened from the Terminal panel.
        const mine = terminals.create({ cwd: pi.cwd })
        await pi.run('start the dev server')

        expect(toolNames(llm.requests[0])).toEqual(expect.arrayContaining(['terminal_run', 'terminal_read', 'terminal_stop']))
        const run: any = await pi.waitFor(toolEnd('terminal_run'))
        expect(run.isError).toBe(false)
        const started = (run.result.details as TerminalDetails).terminal!
        expect(started).toMatchObject({ by: 'agent', status: 'running', command: expect.stringContaining('ready on 4100') })
        expect(llm.requests[1].toolResults[0]).toContain('"ready on" appeared')
        expect(llm.requests[1].toolResults[0]).toContain('booting')

        const list = llm.requests[2].toolResults[1]
        expect(list).toContain(started.id)
        expect(list).toContain(`${mine.id}  `)
        expect(list).toContain('opened by the user')
        expect(llm.requests[3].toolResults[2]).toContain('ready on 4100')

        const stop: any = await pi.waitFor(toolEnd('terminal_stop'))
        expect(stop.isError).toBe(false)
        // Stopped but still there with its output, for the user to read.
        expect(terminals.get(started.id)?.exit).toBeDefined()
        expect(await terminals.text(started.id)).toContain('booting')
    }, 60_000)

    it('the same command again restarts its terminal; the user\'s shells cannot be stopped', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        let mine = ''
        const { terminals, llm, pi } = await setup((_r, i) => {
            if (i === 0 || i === 1)
                return { toolCalls: [{ name: 'terminal_run', arguments: { command: 'echo tick; sleep 600', wait_for: 'tick' } }] }
            if (i === 2)
                return { toolCalls: [{ name: 'terminal_stop', arguments: { id: mine } }] }
            return { text: 'done' }
        })
        mine = terminals.create({ cwd: pi.cwd }).id
        await pi.run('go')
        expect(llm.requests[2].toolResults[1]).toMatch(/^Restarted in terminal/)
        expect(terminals.list().filter(t => t.by === 'agent')).toHaveLength(1)
        const stop: any = await pi.waitFor(toolEnd('terminal_stop'))
        expect(stop.isError).toBe(true)
        expect(llm.requests[3].toolResults[2]).toContain('belongs to the user')
        expect(terminals.get(mine)?.exit).toBeUndefined()
    }, 60_000)

    // macOS: /tmp is a link to /private/tmp, which pi reports.
    it.runIf(realpathSync('/tmp') !== '/tmp')('a request from pi\'s resolved cwd lands in the project as the window knows it', async () => {
        const terminals = new Terminals({ ptyDir: path.resolve('node_modules/node-pty'), onChange: () => {} })
        const tools = new TerminalTools(terminals, '/dev/null', () => ['/tmp'])
        cleanup.push(() => terminals.closeAll())
        const response = await tools.handle({ method: 'run', cwd: '/private/tmp', command: 'echo hi', waitFor: 'hi', timeoutMs: 5000 })
        expect(response.ok).toBe(true)
        expect(terminals.list()[0].cwd).toBe('/tmp')
    })

    it('rejects requests without the token', async () => {
        const terminals = new Terminals({ ptyDir: path.resolve('node_modules/node-pty'), onChange: () => {} })
        const dir = mkdtempSync(path.join(os.tmpdir(), 'filo-tt-'))
        const tools = new TerminalTools(terminals, path.join(dir, 't.sock'))
        await tools.start()
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => tools.stop())
        const net = await import('node:net')
        const answer = await new Promise<string>((resolve) => {
            const socket = net.createConnection(path.join(dir, 't.sock'), () => socket.write(`${JSON.stringify({ token: 'nope', method: 'read', cwd: dir })}\n`))
            let out = ''
            socket.on('data', (d) => {
                out += d
            })
            socket.on('end', () => resolve(out))
        })
        expect(JSON.parse(answer)).toEqual({ ok: false, error: 'not authorized' })
        expect(terminals.list()).toEqual([])
    })
})
