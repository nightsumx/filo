// AcpAgent against test/fakeGrok.mjs, a stand-in for `grok agent stdio` whose messages are shaped
// like Grok Build 1.0.46's (recorded, or read from its source). Each case checks the live thread and
// that reopening the session (session/load replay) gives the same messages.
import type { PiEvent } from '@shared/pi'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acpAgent } from '@shared/agents'
import { AcpAgent } from './agent'
import { deleteAgentSession } from './list'

const FAKE = path.join(__dirname, '../../test/fakeGrok.mjs')
const spec = acpAgent('grok')!

let dir: string
let agents: AcpAgent[] = []
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pi-fake-grok-'))
})
afterEach(async () => {
    await Promise.all(agents.map(a => a.stop()))
    agents = []
    await rm(dir, { recursive: true, force: true })
})

const launch = (env: Record<string, string> = {}) => ({ file: process.execPath, args: [FAKE], env: { ...process.env, FAKE_GROK_DIR: dir, ...env } as Record<string, string> })

function start(sessionId?: string, env?: Record<string, string>) {
    const events: PiEvent[] = []
    const waiters: { test: (e: PiEvent) => boolean, resolve: (e: PiEvent) => void }[] = []
    const agent = new AcpAgent(spec, launch(env), { cwd: dir, sessionId }, {
        onEvent: (_, event) => {
            events.push(event)
            for (const w of [...waiters]) {
                if (w.test(event)) {
                    waiters.splice(waiters.indexOf(w), 1)
                    w.resolve(event)
                }
            }
        },
        onExit: () => {},
    })
    agents.push(agent)
    /** The next event (from now) that passes `test`. */
    const next = (test: (e: any) => boolean) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for an event')), 5000)
        waiters.push({ test, resolve: (e) => {
            clearTimeout(timer)
            resolve(e)
        } })
    })
    const send = async (command: Record<string, unknown>) => {
        const response = await agent.request(command)
        if (!response.success)
            throw new Error(String((response as any).error))
        return (response as any).data
    }
    return { agent, events, next, send, settled: () => next(e => e.type === 'agent_settled') }
}

/** Messages as the thread shows them (no ids or times). */
const shape = (agent: AcpAgent) => agent.snapshot().map(({ message: m }: any) => ({
    role: m.role,
    ...(m.role === 'toolResult' ? { tool: m.toolName, isError: m.isError, details: m.details } : {}),
    content: typeof m.content === 'string' ? m.content : m.content?.map((c: any) => c.type === 'text' ? c.text : c.type === 'toolCall' ? { call: c.name, args: c.arguments } : c.type === 'thinking' ? { thinking: c.thinking } : c.type),
}))

async function reopened(sessionId: string) {
    const again = start(sessionId)
    await again.agent.ready
    return shape(again.agent)
}

describe('Grok Build', () => {
    it('opens with its caps, a mode switch and the model\'s context window', async () => {
        const { agent, send } = start()
        await agent.ready
        const state = await send({ type: 'get_state' })
        expect(state.agentCaps).toMatchObject({ xai: true, steering: true, fork: true, delete: true, images: false })
        expect(state.configOptions.map((o: any) => o.id)).toEqual(['model', 'reasoning_effort', 'mode'])
        await send({ type: 'set_config_option', configId: 'mode', value: 'plan' })
        expect((await send({ type: 'get_state' })).configOptions.find((o: any) => o.id === 'mode').currentValue).toBe('plan')
    })

    it('streams Bash output, fails on its exit code, and reports usage, cost and context', async () => {
        const { agent, events, send, settled } = start()
        await agent.ready
        const done = settled()
        await send({ type: 'prompt', message: 'bash' })
        await done
        const partials = events.filter((e: any) => e.type === 'tool_execution_update' && e.toolName === 'bash').map((e: any) => e.partialResult.content[0].text)
        expect(partials).toContain('one\n')
        expect(partials.at(-1)).toBe('one\ntwo\n')
        const end: any = events.find(e => e.type === 'tool_execution_end')
        expect(end).toMatchObject({ toolName: 'bash', isError: true })
        const live = shape(agent)
        expect(live).toEqual([
            { role: 'user', content: ['bash'] },
            { role: 'assistant', content: ['I\'ll run that command now.', { call: 'bash', args: { command: 'echo one; sleep 4; echo two; exit 3', description: 'Run specified echo/sleep command' } }] },
            { role: 'toolResult', tool: 'bash', isError: true, details: undefined, content: ['one\ntwo\n'] },
            { role: 'assistant', content: ['done'] },
        ])
        const stats = await send({ type: 'get_session_stats' })
        expect(stats.cost).toBeCloseTo(2 * 79407000 / 1e10)
        expect(stats.contextUsage).toMatchObject({ tokens: 18200, contextWindow: 256000 })
        // The turn's usage comes once (turn_completed), not again from the prompt result.
        const usage = agent.snapshot().map(i => (i.message as any).usage).filter(Boolean)
        expect(usage.reduce((n, u) => n + u.output, 0)).toBe(30)
        expect(await reopened(agent.sessionId)).toEqual(live)
    })

    it('asks through the ask form and answers Grok by question text', async () => {
        const { agent, send, next, settled } = start()
        await agent.ready
        const pending = next(e => e.type === 'tool_execution_update' && e.partialResult?.details?.status === 'pending')
        await send({ type: 'prompt', message: 'ask' })
        const asked = await pending
        expect(asked.toolName).toBe('ask')
        expect(asked.partialResult.details.questions).toEqual([
            { id: 'Which branch?', question: 'Which branch?', options: ['main (Recommended)', 'poi'] },
            { id: 'Which checks, of a, b and c?', question: 'Which checks, of a, b and c?', options: ['lint', 'tests'], multiple: true },
        ])
        const done = settled()
        const answers = { 'Which branch?': { selected: [], text: 'dev, please' }, 'Which checks, of a, b and c?': { selected: ['lint', 'tests'] } }
        expect(await send({ type: 'prompt', message: `/gui-ask-answer ${asked.toolCallId} ${JSON.stringify({ answers })}` })).toEqual({ disposition: 'handled' })
        await done
        const live = shape(agent)
        expect(live.at(-1)).toEqual({ role: 'assistant', content: ['heard {"Which branch?":["Other"],"Which checks, of a, b and c?":["lint","tests"]}'] })
        const result: any = live.find(m => m.role === 'toolResult')
        expect(result.details).toEqual({ kind: 'ask', status: 'answered', questions: asked.partialResult.details.questions, answers })
        expect(await reopened(agent.sessionId)).toEqual(live)
    })

    it('a stopped question tells Grok it was declined', async () => {
        const { agent, send, next, settled } = start()
        await agent.ready
        const pending = next(e => e.partialResult?.details?.status === 'pending')
        await send({ type: 'prompt', message: 'ask' })
        await pending
        const done = settled()
        await send({ type: 'abort' })
        await done
        expect(shape(agent).find(m => m.role === 'toolResult')?.details).toMatchObject({ status: 'cancelled' })
        expect((agent.snapshot().at(-1)!.message as any).stopReason).toBe('aborted')
        expect((await send({ type: 'get_state' })).isStreaming).toBe(false)
    })

    it.each([
        [{ approve: true }, 'approved', { status: 'approved', plan: '# Plan\n\n1. Do A\n2. Do B\n' }],
        [{ feedback: 'Do C first' }, 'cancelled', { status: 'revised', feedback: 'Do C first' }],
        [{ cancelled: true }, 'abandoned', { status: 'cancelled' }],
    ])('takes the plan decision %j to exit_plan_mode', async (decision, outcome, details) => {
        const { agent, send, next, settled } = start()
        await agent.ready
        const pending = next(e => e.partialResult?.details?.status === 'pending')
        await send({ type: 'prompt', message: 'plan' })
        const asked = await pending
        expect(asked).toMatchObject({ toolName: 'propose_plan', partialResult: { details: { kind: 'plan', plan: '# Plan\n\n1. Do A\n2. Do B\n' } } })
        const done = settled()
        await send({ type: 'prompt', message: `/gui-plan-decide ${asked.toolCallId} ${JSON.stringify(decision)}` })
        await done
        const live = shape(agent)
        expect(live.at(-1)).toEqual({ role: 'assistant', content: [`plan ${outcome}`] })
        expect(live.find(m => m.role === 'toolResult')?.details).toMatchObject({ kind: 'plan', ...details })
        const replay = await reopened(agent.sessionId)
        expect(replay.find(m => m.role === 'toolResult')?.details).toMatchObject({ kind: 'plan', ...details })
    })

    it('steers mid-turn: the interjection shows queued, then where Grok took it in', async () => {
        const { agent, events, send, next, settled } = start()
        await agent.ready
        const working = next(e => e.type === 'message_update')
        await send({ type: 'prompt', message: 'slow' })
        await working
        const done = settled()
        expect(await send({ type: 'prompt', message: 'also this', streamingBehavior: 'steer' })).toEqual({})
        await done
        expect(events.filter(e => e.type === 'queue_update').map((e: any) => e.steering)).toEqual([['also this'], []])
        const live = shape(agent)
        expect(live).toEqual([
            { role: 'user', content: ['slow'] },
            { role: 'assistant', content: ['working'] },
            { role: 'user', content: ['also this'] },
            { role: 'assistant', content: ['heard: also this'] },
        ])
        expect(events.filter(e => e.type === 'agent_end')).toHaveLength(1)
        expect(await reopened(agent.sessionId)).toEqual(live)
    })

    it('steers while a command runs: the interjection lands after its result, before the next model call', async () => {
        const { agent, send, next, settled } = start(undefined, { FAKE_GROK_BASH_MS: '300' })
        await agent.ready
        const running = next(e => e.type === 'tool_execution_update' && e.toolName === 'bash' && e.partialResult.content[0]?.text === 'one\n')
        await send({ type: 'prompt', message: 'bash' })
        await running
        const done = settled()
        await send({ type: 'prompt', message: 'say pear', streamingBehavior: 'steer' })
        await done
        const live = shape(agent)
        expect(live.map(m => m.role === 'toolResult' ? 'result' : `${m.role}: ${typeof m.content[0] === 'string' ? m.content[0] : ''}`)).toEqual([
            'user: bash',
            'assistant: I\'ll run that command now.',
            'result',
            'user: say pear',
            'assistant: done, heard: say pear',
        ])
        expect(await reopened(agent.sessionId)).toEqual(live)
    })

    it('an interjection that misses the turn runs as Grok\'s own turn, in the same run', async () => {
        const { agent, events, send, next, settled } = start()
        await agent.ready
        const quick = next(e => e.type === 'message_update')
        await send({ type: 'prompt', message: 'late' })
        await quick
        const done = settled()
        await send({ type: 'prompt', message: 'one more', streamingBehavior: 'steer' })
        await done
        const live = shape(agent)
        expect(live).toEqual([
            { role: 'user', content: ['late'] },
            { role: 'assistant', content: ['quick'] },
            { role: 'user', content: ['one more'] },
            { role: 'assistant', content: ['heard: one more'] },
        ])
        expect(events.filter(e => e.type === 'agent_start')).toHaveLength(1)
        expect(events.filter(e => e.type === 'agent_end')).toHaveLength(1)
        expect((await send({ type: 'get_state' })).isStreaming).toBe(false)
        expect(await reopened(agent.sessionId)).toEqual(live)
    })

    it('a prompt typed during Grok\'s own turn waits for it', async () => {
        const { agent, send, next, settled } = start()
        await agent.ready
        const quick = next(e => e.type === 'message_update')
        await send({ type: 'prompt', message: 'late' })
        await quick
        await send({ type: 'prompt', message: 'one more', streamingBehavior: 'steer' })
        await next(e => e.type === 'message_update' && JSON.stringify(e).includes('heard'))
        const done = settled()
        await send({ type: 'prompt', message: 'next', streamingBehavior: 'followUp' })
        await done
        expect(shape(agent).map(m => m.content[0])).toEqual(['late', 'quick', 'one more', 'heard: one more', 'next', 'echo: next'])
    })

    it('compacts, renames, forks and deletes through the x.ai methods', async () => {
        const { agent, events, send, settled } = start()
        await agent.ready
        const done = settled()
        await send({ type: 'prompt', message: 'hello' })
        await done
        await send({ type: 'compact' })
        expect(events.filter(e => e.type.startsWith('compaction_')).map((e: any) => [e.type, e.reason])).toEqual([['compaction_start', 'manual'], ['compaction_end', 'manual']])
        const note: any = agent.snapshot().at(-1)!.message
        expect(note).toMatchObject({ role: 'compactionSummary', tokensBefore: 18100 })
        expect(note.summary).toContain('18,100')
        expect((await send({ type: 'get_session_stats' })).contextUsage.tokens).toBe(2000)

        await send({ type: 'set_session_name', name: 'Named' })
        expect(JSON.parse(await readFile(path.join(dir, `${agent.sessionId}.meta.json`), 'utf8')).title).toBe('Named')

        const { sessionFile } = await send({ type: 'acp_fork' })
        const forked = String(sessionFile).split(':').at(-1)!
        expect(forked).not.toBe(agent.sessionId)
        expect((await reopened(forked)).map(m => m.role)).toEqual(['user', 'assistant', 'compactionSummary'])

        await deleteAgentSession(spec, launch(), forked)
        const gone = start(forked)
        await expect(gone.agent.ready).rejects.toThrow(/not found/i)
    })

    it('a failed prompt ends the run with its error', async () => {
        const { agent, send, settled } = start()
        await agent.ready
        const done = settled()
        await send({ type: 'prompt', message: 'fail' })
        await done
        expect((agent.snapshot().at(-1)!.message as any)).toMatchObject({ role: 'assistant', stopReason: 'error', errorMessage: 'Internal error' })
    })
})
