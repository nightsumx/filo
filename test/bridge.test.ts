// pi-cc-tui's bridge against a real terminal pi: pi runs in its TUI inside tmux (with the mock model),
// and the app's BridgeAgent joins it over the socket the way it would from the desktop app.
import type { PiEvent } from '@shared/pi'
import type { MockLlm } from './harness'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeAgent } from '../electron/bridge'
import { readPresence } from '../electron/presence'
import { startMockLlm } from './harness'
import { hasTmux, startTerminalPi } from './terminal'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until<T>(get: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
    const end = Date.now() + timeoutMs
    for (;;) {
        const value = await get()
        if (value)
            return value as NonNullable<T>
        if (Date.now() > end)
            throw new Error(`timed out: ${what}`)
        await sleep(100)
    }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse())
        await fn().catch(() => {})
})

/** A terminal pi with the bridge, in a throwaway agent dir whose only model is the mock. */
async function startTerminal(llm: MockLlm, env: Record<string, string> = {}, args: (root: string) => Promise<string[]> = async () => []) {
    // Short: the socket path must fit in 104 bytes.
    const root = await mkdtemp(path.join('/tmp', 'pib-'))
    const agentDir = path.join(root, 'agent')
    const cwd = path.join(root, 'project')
    await mkdir(agentDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off', compaction: { keepRecentTokens: 1 } }))
    const terminal = await startTerminalPi({ agentDir, cwd, env, extensions: ['cc-presence.ts', 'cc-bridge.ts', 'capabilities/approval.ts', 'capabilities/ask.ts'], args: await args(root) })
    cleanup.push(async () => {
        await terminal.kill()
        await rm(root, { recursive: true, force: true })
    })
    return { ...terminal, presenceDir: path.join(agentDir, 'pi-kit-presence') }
}

/** A joined client and the events it got. */
async function join(socket: string, pid: number) {
    const events: PiEvent[] = []
    let detached = false
    const agent = await BridgeAgent.connect(socket, pid, {
        onEvent: (_id, event) => events.push(event),
        onExit: (_id, info) => {
            detached = !!info.detached
        },
    })
    cleanup.push(() => agent.stop())
    return { agent, events, detached: () => detached }
}

describe.runIf(hasTmux && process.env.PI_GUI_SKIP_E2E !== '1')('terminal pi bridge', () => {
    it('streams the terminal run, takes prompts, catches up a late client and detaches on quit', async () => {
        const llm = await startMockLlm((_r, i) => i === 0
            ? { text: 'first reply' }
            : { thinking: 'pondering the question', text: 'second reply', delayMs: 2500 })
        cleanup.push(llm.close)
        const terminal = await startTerminal(llm)

        const presence = await until(async () => (await readPresence(terminal.presenceDir)).find(p => p.bridge && p.session), 'presence with a bridge')
        const a = await join(presence.bridge!, presence.pid)

        const state = await a.agent.request({ type: 'get_state' })
        expect(state.data).toMatchObject({ sessionFile: presence.session, terminalPid: presence.pid, isStreaming: false })
        expect(a.events.find(e => e.type === 'extension_ui_request' && e.statusKey === 'gui-approval')).toBeTruthy()

        // From the app: runs in the terminal, streams to the app.
        expect((await a.agent.request({ type: 'prompt', message: 'hello from the app' })).data).toEqual({ disposition: 'started' })
        await until(() => a.events.some(e => e.type === 'agent_settled'), 'first run settles')
        const deltas = a.events.filter(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta').map(e => e.assistantMessageEvent.delta).join('')
        expect(deltas).toBe('first reply')
        expect(a.events.some(e => e.type === 'message_update' && 'partial' in e.assistantMessageEvent)).toBe(false)
        await until(async () => (await terminal.pane()).includes('first reply'), 'reply in the terminal')
        expect(await terminal.pane()).toContain('hello from the app')

        // From the terminal: the app sees it live, and a client joining mid-run catches up.
        await terminal.type('hello from the terminal')
        await until(() => a.events.some(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'thinking_delta'), 'thinking streams')
        const b = await join(presence.bridge!, presence.pid)
        expect((await b.agent.request({ type: 'get_state' })).data.isStreaming).toBe(true)
        await until(() => b.events.some(e => e.type === 'message_start'), 'catch-up')
        const types = b.events.map(e => e.type)
        expect(types.indexOf('agent_start')).toBeGreaterThanOrEqual(0)
        expect(types.indexOf('agent_start')).toBeLessThan(types.indexOf('message_start'))
        const caughtUp = b.events.find(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'thinking_delta')
        expect(caughtUp?.assistantMessageEvent.delta).toBe('pondering the question')
        await until(() => b.events.some(e => e.type === 'agent_settled'), 'second run settles for the late client')
        expect(b.events.filter(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta').map(e => e.assistantMessageEvent.delta).join('')).toBe('second reply')
        expect(a.events.filter(e => e.type === 'message_end' && e.message.role === 'user').map(e => e.message.content)).toHaveLength(2)

        // Not here: the app keeps it for its own pi.
        expect((await a.agent.request({ type: 'fork', entryId: 'x' })).success).toBe(false)

        // Quitting the terminal pi detaches both clients and removes its socket.
        await terminal.keys('C-c')
        await sleep(200)
        await terminal.keys('C-c')
        await until(() => a.detached() && b.detached(), 'detach on quit')
        await until(() => !existsSync(presence.bridge!), 'socket removed')
        const transcript = await readFile(presence.session!, 'utf8')
        expect(transcript).toContain('second reply')
    }, 60_000)

    it('puts what the app sends in as if typed in the terminal', async () => {
        const llm = await startMockLlm((request) => {
            const last = JSON.stringify(request.messages.at(-1))
            if (last.includes('<conversation>'))
                return { text: '## Goal\nsummary', delayMs: 2000 }
            return last.includes('slow') ? { text: 'slow done', delayMs: 2500 } : { text: 'ok' }
        })
        cleanup.push(llm.close)
        const terminal = await startTerminal(llm)
        const presence = await until(async () => (await readPresence(terminal.presenceDir)).find(p => p.bridge && p.session), 'presence with a bridge')
        const a = await join(presence.bridge!, presence.pid)
        const users = async () => (await readFile(presence.session!, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
            .filter(e => e.message?.role === 'user').map(e => e.message.content.map((p: any) => p.text).join(''))
        const settled = async () => {
            await until(async () => (await a.agent.request({ type: 'get_state' })).data.isStreaming === false, 'idle')
            await sleep(300)
        }

        // What the user is typing in the terminal stays there; the app's text goes in whole, tabs and all.
        await terminal.keys('-l', 'my draft')
        await until(async () => (await terminal.pane()).includes('my draft'), 'draft typed')
        await a.agent.request({ type: 'prompt', message: 'from\tthe app' })
        await until(async () => (await users()).includes('from\tthe app'), 'app prompt sent')
        await settled()
        expect(await terminal.pane()).toContain('my draft')
        await terminal.keys('C-c')

        // `!cmd` runs as the terminal's own, and the app sees its result.
        expect((await a.agent.request({ type: 'prompt', message: '!echo bridged-bash' })).data).toEqual({ disposition: 'handled' })
        const bash = await until(() => a.events.find(e => e.type === 'message_end' && e.message.role === 'bashExecution'), 'bash result')
        expect(bash.message).toMatchObject({ command: 'echo bridged-bash', output: 'bridged-bash\n', exitCode: 0 })
        expect((await a.agent.request({ type: 'bash', command: 'echo kept-out', excludeFromContext: true })).success).toBe(true)
        const kept = await until(() => a.events.find(e => e.type === 'message_end' && e.message.command === 'echo kept-out'), 'bash over rpc')
        expect(kept.message).toMatchObject({ output: 'kept-out\n', excludeFromContext: true })

        // During a run: Enter steers, Alt+Enter follows up, Alt+Up takes the queue back.
        await a.agent.request({ type: 'prompt', message: 'slow one' })
        await until(() => a.events.some(e => e.type === 'agent_start'), 'slow run')
        await a.agent.request({ type: 'prompt', message: 'taken back', streamingBehavior: 'followUp' })
        expect((await a.agent.request({ type: 'clear_queue' })).data).toEqual({ steering: ['taken back'], followUp: [] })
        await a.agent.request({ type: 'prompt', message: 'follow-1', streamingBehavior: 'followUp' })
        await a.agent.request({ type: 'prompt', message: 'steer-1', streamingBehavior: 'steer' })
        // pi's queue reaches the app as its queue_update, and empties as it delivers.
        await until(() => a.events.some(e => e.type === 'queue_update' && e.steering.includes('steer-1') && e.followUp.includes('follow-1')), 'queue shown')
        expect((await a.agent.request({ type: 'get_state' })).data.pendingMessageCount).toBe(2)
        await until(async () => (await users()).includes('follow-1'), 'queue delivered', 30_000)
        await settled()
        expect((await users()).slice(-3)).toEqual(['slow one', 'steer-1', 'follow-1'])
        expect(a.events.findLast(e => e.type === 'queue_update')).toMatchObject({ steering: [], followUp: [] })
        expect((await a.agent.request({ type: 'get_state' })).data.pendingMessageCount).toBe(0)

        // A `!cmd` streams to the app while it runs, and Esc cancels it as in the terminal.
        await a.agent.request({ type: 'bash', command: 'echo started; sleep 30' })
        const start = await until(() => a.events.find(e => e.type === 'bash_execution_start' && e.command === 'echo started; sleep 30'), 'bash starts')
        await until(() => a.events.some(e => e.type === 'bash_execution_update' && e.id === start.id && e.delta.includes('started')), 'bash output streams')
        await a.agent.request({ type: 'abort_bash' })
        expect((await until(() => a.events.find(e => e.type === 'bash_execution_end' && e.id === start.id), 'bash ends')).cancelled).toBe(true)
        const cancelled = await until(() => a.events.find(e => e.type === 'message_end' && e.bashId === start.id), 'cancelled bash recorded')
        expect(cancelled.message).toMatchObject({ command: 'echo started; sleep 30', output: 'started\n', cancelled: true })

        // A compaction shows in the state, and a prompt sent during it waits for it, as in the terminal.
        const compaction = a.agent.request({ type: 'compact' })
        await until(() => a.events.some(e => e.type === 'compaction_start'), 'compaction starts')
        expect((await a.agent.request({ type: 'get_state' })).data.isCompacting).toBe(true)
        await a.agent.request({ type: 'prompt', message: 'after compaction' })
        await until(async () => (await terminal.pane()).includes('Queued message for after compaction'), 'held by the terminal')
        expect((await compaction).success).toBe(true)
        expect((await a.agent.request({ type: 'get_state' })).data.isCompacting).toBe(false)
        await until(async () => (await users()).includes('after compaction'), 'held prompt sent')
        await settled()

        // An image goes in as a pasted one: a pi-clipboard file whose path is in the text.
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        await a.agent.request({ type: 'prompt', message: 'look', images: [{ type: 'image', data: png, mimeType: 'image/png' }] })
        await until(async () => (await users()).some(u => u.startsWith('look ')), 'image prompt sent')
        const file = (await users()).find(u => u.startsWith('look '))!.slice('look '.length)
        expect(path.basename(file)).toBe(`pi-clipboard-${path.basename(file).slice('pi-clipboard-'.length, -'.png'.length)}.png`)
        expect(path.dirname(file)).toBe(os.tmpdir())
        expect((await readFile(file)).toString('base64')).toBe(png)
    }, 90_000)

    it('offers terminal approval prompts to the app and closes the terminal dialog on its answer', async () => {
        let calls = 0
        const llm = await startMockLlm(() => ++calls === 1
            ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo bridged-ok > out.txt && cat out.txt' } }] }
            : { text: 'done' })
        cleanup.push(llm.close)
        const terminal = await startTerminal(llm, { PI_KIT_APPROVAL_MODE: 'ask' })
        const presence = await until(async () => (await readPresence(terminal.presenceDir)).find(p => p.bridge && p.session), 'presence with a bridge')
        const a = await join(presence.bridge!, presence.pid)

        await a.agent.request({ type: 'prompt', message: 'run it' })
        const ask = await until(() => a.events.find(e => e.type === 'extension_ui_request' && e.method === 'select' && e.title?.startsWith('gui-approval ')), 'approval request')
        expect(JSON.parse(ask.title.slice('gui-approval '.length))).toMatchObject({ tool: 'bash', summary: expect.stringContaining('bridged-ok') })
        await until(async () => (await terminal.pane()).includes('Do you want to proceed?'), 'terminal dialog')

        // A client joining now gets the open prompt too.
        const b = await join(presence.bridge!, presence.pid)
        expect(b.events).toEqual([])
        await b.agent.request({ type: 'get_state' })
        await until(() => b.events.some(e => e.type === 'extension_ui_request' && e.id === ask.id), 'open prompt for a late client')

        a.agent.write({ type: 'extension_ui_response', id: ask.id, value: 'allow' })
        await until(() => b.events.some(e => e.type === 'extension_ui_cancel' && e.id === ask.id), 'prompt closed for the other client')
        await until(() => a.events.some(e => e.type === 'agent_settled'), 'run settles')
        const result = a.events.find(e => e.type === 'tool_execution_end')
        expect(result?.isError).toBe(false)
        expect(JSON.stringify(result?.result)).toContain('bridged-ok')
        await until(async () => (await terminal.pane()).includes('done'), 'terminal carries on')
        expect(await terminal.pane()).not.toContain('Do you want to proceed?')
    }, 60_000)

    it('shows what other extensions show, and either side answers their dialogs', async () => {
        const llm = await startMockLlm(() => ({ text: 'ok' }))
        cleanup.push(llm.close)
        // An extension of the user's: it knows nothing of the app.
        const terminal = await startTerminal(llm, {}, async (root) => {
            const file = path.join(root, 'asks.ts')
            await writeFile(file, `export default function (pi) {
                pi.registerCommand('asks', { handler: async (_args, ctx) => {
                    ctx.ui.setStatus('mine', 'my status')
                    ctx.ui.setWidget('lines', ['one', 'two'])
                    ctx.ui.notify('hello there', 'warning')
                    const colour = await ctx.ui.select('Colour?', ['red', 'blue'])
                    const sure = await ctx.ui.confirm('Sure?', 'Really')
                    const name = await ctx.ui.input('Name?', 'type it')
                    const notes = await ctx.ui.editor('Notes?', 'prefilled')
                    ctx.ui.setStatus('answers', JSON.stringify({ colour, sure, name, notes }))
                } })
            }`)
            return ['-e', file]
        })
        const presence = await until(async () => (await readPresence(terminal.presenceDir)).find(p => p.bridge && p.session), 'presence with a bridge')
        const a = await join(presence.bridge!, presence.pid)
        const request = (method: string) => until(() => a.events.findLast(e => e.type === 'extension_ui_request' && e.method === method && !a.events.some(c => c.type === 'extension_ui_cancel' && c.id === e.id)), method)
        const closed = (id: string) => until(() => a.events.some(e => e.type === 'extension_ui_cancel' && e.id === id), 'closed')

        expect((await a.agent.request({ type: 'prompt', message: '/asks' })).data).toEqual({ disposition: 'handled' })
        expect(await request('setStatus')).toMatchObject({ statusKey: 'mine', statusText: 'my status' })
        expect(await request('setWidget')).toMatchObject({ widgetKey: 'lines', widgetLines: ['one', 'two'] })
        expect(await request('notify')).toMatchObject({ message: 'hello there', notifyType: 'warning' })

        // Answered in the app: the terminal's closes.
        const select = await request('select')
        expect(select).toMatchObject({ title: 'Colour?', options: ['red', 'blue'] })
        await until(async () => (await terminal.pane()).includes('Colour?'), 'terminal select')
        // A client joining now gets the open dialog, the status and the widget.
        const b = await join(presence.bridge!, presence.pid)
        await b.agent.request({ type: 'get_state' })
        await until(() => b.events.some(e => e.id === select.id) && b.events.some(e => e.statusKey === 'mine') && b.events.some(e => e.widgetKey === 'lines'), 'late client catches up')
        a.agent.write({ type: 'extension_ui_response', id: select.id, value: 'blue' })
        await closed(select.id)

        // Answered in the terminal: the app's closes.
        const confirm = await request('confirm')
        expect(confirm).toMatchObject({ title: 'Sure?', message: 'Really' })
        await until(async () => (await terminal.pane()).includes('Really'), 'terminal confirm')
        await terminal.keys('Enter')
        await closed(confirm.id)

        const input = await request('input')
        expect(input).toMatchObject({ title: 'Name?', placeholder: 'type it' })
        a.agent.write({ type: 'extension_ui_response', id: input.id, value: 'Ada' })
        await closed(input.id)

        // pi's editor dialog only the terminal shows; the app hears it is open.
        const editor = await request('terminal')
        expect(editor.title).toBe('Notes?')
        await until(async () => (await terminal.pane()).includes('prefilled'), 'terminal editor')
        await terminal.keys('Enter')
        await closed(editor.id)

        const answers = await until(() => a.events.find(e => e.statusKey === 'answers'), 'answers')
        expect(JSON.parse(answers.statusText)).toEqual({ colour: 'blue', sure: true, name: 'Ada', notes: 'prefilled' })
        expect(await terminal.pane()).not.toContain('Colour?')
    }, 60_000)

    it('takes the app\'s answer to a question the terminal shows, mid-run', async () => {
        let calls = 0
        const llm = await startMockLlm(() => ++calls === 1
            ? { toolCalls: [{ name: 'ask', arguments: { questions: [{ question: 'Which colour?', options: ['red', 'blue'] }] } }] }
            : { text: 'noted' })
        cleanup.push(llm.close)
        const terminal = await startTerminal(llm)
        const presence = await until(async () => (await readPresence(terminal.presenceDir)).find(p => p.bridge && p.session), 'presence with a bridge')
        const a = await join(presence.bridge!, presence.pid)

        await a.agent.request({ type: 'prompt', message: 'ask me' })
        const call = await until(() => a.events.find(e => e.type === 'tool_execution_start' && e.toolName === 'ask'), 'ask call')
        await until(async () => (await terminal.pane()).includes('Which colour?'), 'terminal form')
        // As Thread.answerAsk sends it.
        const answer = { answers: { q1: { selected: ['blue'] } } }
        const response = await a.agent.request({ type: 'prompt', message: `/gui-ask-answer ${call.toolCallId} ${JSON.stringify(answer)}` })
        expect(response.data).toEqual({ disposition: 'handled' })
        await until(() => a.events.some(e => e.type === 'agent_settled'), 'run settles')
        expect(JSON.stringify(a.events.find(e => e.type === 'tool_execution_end')?.result)).toContain('blue')
        expect(JSON.stringify(llm.requests[1].messages)).not.toContain('gui-ask-answer')
        await until(async () => (await terminal.pane()).includes('noted'), 'terminal carries on')
    }, 60_000)
})
