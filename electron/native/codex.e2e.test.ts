// The native Codex adapter against the real `codex app-server` (skipped when codex is not on PATH),
// with a scripted Responses API standing in for the model and a CODEX_HOME of its own, so nothing
// touches the user's Codex history or account.
import type { AddressInfo } from 'node:net'
import type { PiEvent } from '@shared/pi'
import type { AgentAdapterCallbacks } from '../acp/adapter'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { acpAgent } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CodexAgent, deleteCodexThread, displayCommand, listCodexThreads } from './codex'

function findCodex(): string | undefined {
    if (process.env.CODEX_BIN)
        return process.env.CODEX_BIN
    try {
        return execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim() || undefined
    }
    catch {
        return undefined
    }
}
const codex = findCodex()

/** What the fake model answers one request with: text, or one function call. */
type Step = ({ text: string } | { call: { name: string, namespace?: string, args: Record<string, unknown> } }) & { when?: string }

let script: Step[] = []
let requests: any[] = []
let server: http.Server
let home: string
let work: string

function respond(res: http.ServerResponse, step: Step | undefined, n: number, input: unknown) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('response.created', { response: { id: `r${n}` } })
    if (step && 'call' in step) {
        // `$AGENT`: the id spawn_agent returned, as the model would pass it on.
        const agentId = /\\"agent_id\\":\\"([^\\"]+)/.exec(JSON.stringify(input))?.[1] ?? ''
        const args = JSON.stringify(step.call.args).replaceAll('$AGENT', agentId)
        const item = { type: 'function_call', id: `fc${n}`, call_id: `call_${n}`, name: step.call.name, ...(step.call.namespace ? { namespace: step.call.namespace } : {}), arguments: args }
        ev('response.output_item.added', { output_index: 0, item })
        ev('response.output_item.done', { output_index: 0, item })
    }
    else {
        const text = step?.text ?? 'out of script'
        const item = { type: 'message', role: 'assistant', id: `m${n}`, content: [{ type: 'output_text', text }] }
        ev('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
        // Two deltas: the text streams in.
        const half = Math.ceil(text.length / 2)
        for (const delta of [text.slice(0, half), text.slice(half)].filter(Boolean))
            ev('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta })
        ev('response.output_item.done', { output_index: 0, item })
    }
    ev('response.completed', { response: { id: `r${n}`, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 107 } } })
    res.end()
}

const spec = acpAgent('codex')!
const launch = () => ({ file: codex!, args: ['app-server'], env: { ...process.env as Record<string, string>, CODEX_HOME: home, RUST_LOG: 'error' } })

interface Started {
    agent: CodexAgent
    events: PiEvent[]
    /** Resolves with the first event from `from` on that matches. */
    next: (match: (e: any) => boolean, from?: number) => Promise<any>
    settled: (from?: number) => Promise<any>
}

const agents: CodexAgent[] = []

async function start(sessionId?: string, readOnly = false): Promise<Started> {
    const events: PiEvent[] = []
    const waiters: { match: (e: any) => boolean, from: number, resolve: (e: any) => void }[] = []
    const callbacks: AgentAdapterCallbacks = {
        onEvent: (_id, event) => {
            events.push(event)
            for (const w of [...waiters]) {
                if (events.length - 1 >= w.from && w.match(event)) {
                    waiters.splice(waiters.indexOf(w), 1)
                    w.resolve(event)
                }
            }
        },
        onExit: () => {},
        onFork: (_a, id) => `acp:codex:${id}`,
    }
    const agent = new CodexAgent(spec, launch(), { cwd: work, sessionId, readOnly }, callbacks)
    agents.push(agent)
    await agent.ready
    const next = (match: (e: any) => boolean, from = 0) => {
        const found = events.slice(from).find(match)
        if (found)
            return Promise.resolve(found)
        return new Promise<any>(resolve => waiters.push({ match, from, resolve }))
    }
    return { agent, events, next, settled: (from = 0) => next(e => e.type === 'agent_settled', from) }
}

const ok = async (agent: CodexAgent, command: Record<string, unknown>) => {
    const response = await agent.request(command)
    expect(response.success, response.error).toBe(true)
    return response.data as any
}

/** The transcript as role: text / tool names, for comparing live with replayed. */
const outline = (agent: CodexAgent) => agent.snapshot().map(({ message: m }) => {
    if (m.role === 'user')
        return `user: ${(m.content as any[]).map(c => c.text ?? `[${c.type}]`).join('')}`
    if (m.role === 'assistant')
        return `assistant: ${m.content.map(c => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `<${c.name}>` : '')).join('')}`
    if (m.role === 'toolResult')
        return `result ${m.toolName}${m.isError ? ' (error)' : ''}`
    return m.role
})

const exec = (cmd: string, extra: Record<string, unknown> = {}): Step => ({ call: { name: 'exec_command', args: { cmd, ...extra } } })
const patch = (body: string): Step => exec(`apply_patch <<'EOF'\n*** Begin Patch\n${body}\n*** End Patch\nEOF\n`)
/** Each model request's `originator` header (Codex sends the client's name). */
const originators: string[] = []
const lastInput = (n: number) => JSON.stringify(requests[n]?.input?.slice(-1) ?? [])
const latestInput = () => JSON.stringify(requests.at(-1)?.input?.slice(-1) ?? [])

describe.skipIf(!codex)('Codex native adapter against codex app-server', () => {
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = ''
            req.on('data', (c) => {
                body += c
            })
            req.on('end', () => {
                const n = requests.length
                requests.push(JSON.parse(body || '{}'))
                originators.push(String(req.headers.originator ?? ''))
                // A step with `when` answers only a request whose input has that text (a subagent's).
                const input = JSON.stringify((requests[n].input ?? []).filter((i: any) => i.role === 'user'))
                let at = script.findIndex(st => st.when && input.includes(st.when))
                if (at === -1)
                    at = script.findIndex(st => !st.when)
                respond(res, at === -1 ? undefined : script.splice(at, 1)[0], n, requests[n].input)
            })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as AddressInfo).port
        home = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'))
        await writeFile(path.join(home, 'config.toml'), [
            'model = "mock-model"',
            'model_provider = "mock"',
            '[model_providers.mock]',
            'name = "mock"',
            `base_url = "http://127.0.0.1:${port}/v1"`,
            'wire_api = "responses"',
            // An MCP server whose tool Codex asks about before calling (mcpServer/elicitation/request).
            '[features]',
            'request_permissions_tool = true',
            '[mcp_servers.demo]',
            'command = "node"',
            `args = [${JSON.stringify(path.resolve('test/fakeMcp.mjs'))}]`,
            '',
        ].join('\n'))
    })

    afterAll(async () => {
        await Promise.all(agents.map(a => a.stop()))
        server?.close()
        await rm(home, { recursive: true, force: true })
    })

    beforeEach(async () => {
        script = []
        requests = []
        work = await mkdtemp(path.join(os.tmpdir(), 'codex-work-'))
    })

    it('runs a prompt: streams the answer, settles, and reports the session and its usage', async () => {
        const { agent, events, settled } = await start()
        script = [{ text: 'hello there' }]
        await ok(agent, { type: 'prompt', message: 'hi' })
        await settled()
        const types = events.map(e => e.type)
        expect(types.indexOf('agent_start')).toBeLessThan(types.indexOf('agent_end'))
        expect(events.some(e => e.type === 'message_update' && (e as any).assistantMessageEvent.type === 'text_delta')).toBe(true)
        expect(outline(agent)).toEqual(['user: hi', 'assistant: hello there'])
        const state = await ok(agent, { type: 'get_state' })
        expect(state.sessionFile).toBe(`acp:codex:${agent.sessionId}`)
        expect(state.isStreaming).toBe(false)
        // Codex's own default for a folder it does not trust yet.
        expect(state.configOptions.find((o: any) => o.id === 'mode').currentValue).toBe('read-only')
        const stats = await ok(agent, { type: 'get_session_stats' })
        // pi's input excludes cache reads: 100 in, 40 of them cached.
        expect(stats.tokens).toMatchObject({ input: 60, cacheRead: 40, output: 7 })
        expect(requests).toHaveLength(1)
    }, 30_000)

    it('asks before an escalated command: allow runs it, deny declines it', async () => {
        const { agent, events, next, settled } = await start()
        script = [exec('touch allowed.txt', { sandbox_permissions: 'require_escalated', justification: 'make the marker' }), { text: 'done' }]
        await ok(agent, { type: 'prompt', message: 'make it' })
        const ask = await next(e => e.type === 'extension_ui_request')
        expect(ask.title.startsWith(APPROVAL_TITLE_PREFIX)).toBe(true)
        const approval = JSON.parse(ask.title.slice(APPROVAL_TITLE_PREFIX.length))
        expect(approval).toMatchObject({ tool: 'bash' })
        expect(approval.summary).toContain('touch allowed.txt')
        expect(approval.summary).toContain('make the marker')
        expect(ask.options).toEqual(['allow', 'always', 'deny'])
        agent.write({ type: 'extension_ui_response', id: ask.id, value: 'allow' })
        await settled()
        expect(existsSync(path.join(work, 'allowed.txt'))).toBe(true)
        expect(outline(agent)).toEqual(['user: make it', 'assistant: <bash>', 'result bash', 'assistant: done'])

        const mark = events.length
        script = [exec('touch denied.txt', { sandbox_permissions: 'require_escalated' }), { text: 'ok, not doing it' }]
        await ok(agent, { type: 'prompt', message: 'again' })
        const second = await next(e => e.type === 'extension_ui_request' && e.id !== ask.id)
        agent.write({ type: 'extension_ui_response', id: second.id, value: 'deny' })
        await settled(mark)
        expect(existsSync(path.join(work, 'denied.txt'))).toBe(false)
        expect(outline(agent).slice(4)).toEqual(['user: again', 'assistant: <bash>', 'result bash (error)', 'assistant: ok, not doing it'])
        // Declined: the model was told so and carried on.
        expect(lastInput(3)).toContain('rejected by user')
    }, 30_000)

    it('shows file changes as write / edit with the patch, asking first in read-only mode', async () => {
        const { agent, events, next, settled } = await start()
        await ok(agent, { type: 'set_config_option', configId: 'mode', value: 'read-only' })
        script = [patch('*** Add File: notes.txt\n+one\n+two'), { text: 'added' }]
        await ok(agent, { type: 'prompt', message: 'add notes' })
        const ask = await next(e => e.type === 'extension_ui_request')
        const approval = JSON.parse(ask.title.slice(APPROVAL_TITLE_PREFIX.length))
        expect(approval.tool).toBe('write')
        expect(approval.summary).toContain('notes.txt')
        agent.write({ type: 'extension_ui_response', id: ask.id, value: 'allow' })
        await settled()
        expect(await readFile(path.join(work, 'notes.txt'), 'utf8')).toBe('one\ntwo\n')
        const write = agent.snapshot().flatMap(i => (i.message.role === 'assistant' ? i.message.content : [])).find(c => c.type === 'toolCall')
        expect(write).toMatchObject({ name: 'write', arguments: { path: path.join(work, 'notes.txt'), content: 'one\ntwo\n' } })

        const from = events.length
        await ok(agent, { type: 'set_config_option', configId: 'mode', value: 'auto' })
        script = [patch('*** Update File: notes.txt\n@@\n one\n-two\n+TWO'), { text: 'edited' }]
        await ok(agent, { type: 'prompt', message: 'shout two' })
        await settled(from)
        expect(await readFile(path.join(work, 'notes.txt'), 'utf8')).toBe('one\nTWO\n')
        const end = events.slice(from).find((e: any) => e.type === 'tool_execution_end' && e.toolName === 'edit') as any
        expect(end.result.details.patch).toContain('-two\n+TWO')
        expect(events.slice(from).some(e => e.type === 'extension_ui_request')).toBe(false)
    }, 30_000)

    it('reopens a thread with the same transcript, and lists and deletes it', async () => {
        const { agent, settled, events } = await start()
        script = [exec('echo hi'), { text: 'printed' }]
        await ok(agent, { type: 'prompt', message: 'print' })
        await settled()
        const from = events.length
        script = [{ text: 'second answer' }]
        await ok(agent, { type: 'prompt', message: 'more' })
        await settled(from)
        const live = outline(agent)
        expect(live).toEqual(['user: print', 'assistant: <bash>', 'result bash', 'assistant: printed', 'user: more', 'assistant: second answer'])

        const reopened = await start(agent.sessionId, true)
        expect(outline(reopened.agent)).toEqual(live)
        const bash = reopened.agent.snapshot().find(i => i.message.role === 'toolResult')!.message as any
        expect(bash.content[0].text).toContain('hi')

        const listed = await listCodexThreads(launch())
        expect(listed.sessions.map(s => s.sessionId)).toContain(agent.sessionId)
        expect(listed.sessions.find(s => s.sessionId === agent.sessionId)?.cwd).toBe(work)
        await agent.stop()
        await reopened.agent.stop()
        await deleteCodexThread(launch(), agent.sessionId)
        expect((await listCodexThreads(launch())).sessions.map(s => s.sessionId)).not.toContain(agent.sessionId)
    }, 40_000)

    it('asks again from a prompt (thread/revert) and forks at one (thread/fork)', async () => {
        const { agent, events, settled } = await start()
        for (const [message, answer] of [['one', 'first'], ['two', 'second']]) {
            const from = events.length
            script = [{ text: answer }]
            await ok(agent, { type: 'prompt', message })
            await settled(from)
        }
        expect(outline(agent)).toEqual(['user: one', 'assistant: first', 'user: two', 'assistant: second'])
        expect((await ok(agent, { type: 'prompt', message: '/gui-rewind 2' })).disposition).toBe('handled')
        expect(outline(agent)).toEqual(['user: one', 'assistant: first'])
        expect(outline((await start(agent.sessionId, true)).agent)).toEqual(['user: one', 'assistant: first'])

        let from = events.length
        script = [{ text: 'third' }]
        await ok(agent, { type: 'prompt', message: 'three' })
        await settled(from)
        // What the model saw: the reverted turn is gone.
        expect(JSON.stringify(requests.at(-1).input)).not.toContain('second')

        const source = agent.sessionId
        const fork = await ok(agent, { type: 'fork', entryId: '2' })
        expect(fork.text).toBe('three')
        expect(agent.sessionId).not.toBe(source)
        expect(outline(agent)).toEqual(['user: one', 'assistant: first'])
        from = events.length
        script = [{ text: 'branch' }]
        await ok(agent, { type: 'prompt', message: 'other way' })
        await settled(from)
        expect(outline((await start(agent.sessionId, true)).agent)).toEqual(['user: one', 'assistant: first', 'user: other way', 'assistant: branch'])
        expect(outline((await start(source, true)).agent)).toEqual(['user: one', 'assistant: first', 'user: three', 'assistant: third'])
    }, 60_000)

    it('a second tab forks a thread another has open (the GUI\'s Fork from here), and writes once it is free', async () => {
        const { agent, settled, events } = await start()
        for (const [message, answer] of [['one', 'first'], ['two', 'second']]) {
            const from = events.length
            script = [{ text: answer }]
            await ok(agent, { type: 'prompt', message })
            await settled(from)
        }
        // Codex lets one process write a thread: the second opens it without taking it over.
        const other = await start(agent.sessionId)
        expect(outline(other.agent)).toEqual(outline(agent))
        expect((await ok(other.agent, { type: 'get_state' })).model.id).toBe('mock-model')
        const fork = await ok(other.agent, { type: 'fork', entryId: '2' })
        expect(fork.text).toBe('two')
        expect(other.agent.sessionId).not.toBe(agent.sessionId)
        script = [{ text: 'branch' }]
        await ok(other.agent, { type: 'prompt', message: 'other way' })
        await other.settled()
        expect(outline(other.agent)).toEqual(['user: one', 'assistant: first', 'user: other way', 'assistant: branch'])

        // A prompt while the first still holds it says so; once it is closed, the prompt goes.
        const third = await start(agent.sessionId)
        const held = await third.agent.request({ type: 'prompt', message: 'too' })
        expect(held.success).toBe(false)
        expect(held.error).toMatch(/open elsewhere|别处打开/)
        await agent.stop()
        script = [{ text: 'took over' }]
        await ok(third.agent, { type: 'prompt', message: 'now' })
        await third.settled()
        expect(outline(third.agent).slice(-2)).toEqual(['user: now', 'assistant: took over'])
    }, 40_000)

    it('plan mode: answers Codex\'s question, then the approved plan leaves plan mode and starts on it', async () => {
        const { agent, next, settled } = await start()
        await ok(agent, { type: 'set_config_option', configId: 'mode', value: 'auto' })
        await ok(agent, { type: 'set_config_option', configId: 'mode', value: 'plan' })
        script = [
            { call: { name: 'request_user_input', args: { questions: [{ id: 'db', header: 'Database', question: 'Which database?', options: [{ label: 'SQLite', description: 'a file' }, { label: 'Postgres', description: 'a server' }] }] } } },
            { text: 'Here it is.\n<proposed_plan>\n# Plan\n1. Add Postgres\n</proposed_plan>' },
            { text: 'implemented' },
        ]
        await ok(agent, { type: 'prompt', message: 'plan a db' })
        const ask = await next(e => e.type === 'tool_execution_update' && e.partialResult?.details?.kind === 'ask')
        expect(ask.partialResult.details.questions).toEqual([{ id: 'db', question: 'Which database?', options: ['SQLite', 'Postgres'] }])
        await ok(agent, { type: 'prompt', message: `/gui-ask-answer ${ask.toolCallId} ${JSON.stringify({ answers: { db: { selected: ['Postgres'] } } })}` })
        const plan = await next(e => e.type === 'tool_execution_update' && e.partialResult?.details?.kind === 'plan')
        expect(plan.partialResult.details).toMatchObject({ status: 'pending' })
        expect(plan.partialResult.details.plan).toContain('1. Add Postgres')
        expect(lastInput(1)).toContain('Postgres')
        // The run stays open while the plan waits.
        expect((await ok(agent, { type: 'get_state' })).isStreaming).toBe(true)
        await ok(agent, { type: 'prompt', message: `/gui-plan-decide ${plan.toolCallId} ${JSON.stringify({ approve: true })}` })
        await settled()
        expect(lastInput(2)).toContain('Implement the plan.')
        const state = await ok(agent, { type: 'get_state' })
        expect(state.configOptions.find((o: any) => o.id === 'mode').currentValue).toBe('auto')
        expect(outline(agent).at(-1)).toBe('assistant: implemented')
        const replayed = await start(agent.sessionId, true)
        const planResult = replayed.agent.snapshot().find(i => i.message.role === 'toolResult' && i.message.toolName === 'propose_plan')!.message as any
        expect(planResult.details).toMatchObject({ kind: 'plan', status: 'approved' })
    }, 40_000)

    it('stop interrupts a running command; a steer joins the running turn', async () => {
        const { agent, events, next, settled } = await start()
        await ok(agent, { type: 'set_config_option', configId: 'mode', value: 'full-access' })
        script = [exec('sleep 30')]
        await ok(agent, { type: 'prompt', message: 'wait' })
        await next(e => e.type === 'tool_execution_start')
        const t0 = Date.now()
        await ok(agent, { type: 'abort' })
        await settled()
        expect(Date.now() - t0).toBeLessThan(5000)
        const last = agent.snapshot().at(-1)!.message as any
        expect(last.role === 'assistant' ? last.stopReason : last.role).toBe('aborted')

        const from = events.length
        script = [exec('sleep 1'), { text: 'took it in' }]
        await ok(agent, { type: 'prompt', message: 'slow' })
        await next(e => e.type === 'tool_execution_start', from)
        await ok(agent, { type: 'prompt', message: 'also this', streamingBehavior: 'steer' })
        await settled(from)
        expect(JSON.stringify(requests.at(-1).input)).toContain('also this')
        expect(outline(agent).slice(-5)).toEqual(['user: slow', 'assistant: <bash>', 'user: also this', 'result bash', 'assistant: took it in'])
    }, 40_000)

    it('compacts as a turn of its own and leaves a note', async () => {
        const { agent, events, settled } = await start()
        script = [{ text: 'answer' }]
        await ok(agent, { type: 'prompt', message: 'hi' })
        await settled()
        const from = events.length
        script = [{ text: 'Summary: the user said hi.' }]
        await ok(agent, { type: 'compact' })
        await settled(from)
        expect(outline(agent)).toEqual(['user: hi', 'assistant: answer', 'compactionSummary'])
        expect(outline((await start(agent.sessionId, true)).agent)).toEqual(['user: hi', 'assistant: answer', 'compactionSummary'])
    }, 30_000)

    it('a subagent (spawn_agent) shows as a subagent call: the child\'s transcript live and replayed, its approvals asked', async () => {
        const { agent, events, next, settled } = await start()
        script = [
            { call: { name: 'spawn_agent', namespace: 'multi_agent_v1', args: { message: 'CHILD TASK: count files' } } },
            { when: 'CHILD TASK', ...exec('touch child.txt && ls', { sandbox_permissions: 'require_escalated', justification: 'child writes' }) },
            { when: 'CHILD TASK', text: 'child says 3 files' },
            { call: { name: 'wait_agent', namespace: 'multi_agent_v1', args: { targets: ['$AGENT'], timeout_ms: 30000 } } },
            { text: 'parent done' },
        ]
        await ok(agent, { type: 'prompt', message: 'delegate' })
        const started = await next(e => e.type === 'tool_execution_start' && e.toolName === 'subagent')
        // The child's command asks first: the prompt names the child's call.
        const asked = await next(e => e.type === 'extension_ui_request')
        const approval = JSON.parse(asked.title.slice(APPROVAL_TITLE_PREFIX.length))
        expect(approval.summary).toContain('touch child.txt')
        const waiting = events.filter((e: any) => e.type === 'tool_execution_update' && e.toolCallId === started.toolCallId).at(-1) as any
        const live = waiting.partialResult.details
        expect(live).toMatchObject({ kind: 'subagent', status: 'running', task: 'CHILD TASK: count files' })
        expect(live.title).not.toBe('')
        // The subagent view finds the waiting call among the child's (subagentWaiting).
        expect(JSON.stringify([live.messages, live.streaming])).toContain(approval.toolCallId)
        agent.write({ type: 'extension_ui_response', id: asked.id, value: 'allow' })
        await settled()
        expect(existsSync(path.join(work, 'child.txt'))).toBe(true)

        const end = events.find((e: any) => e.type === 'tool_execution_end' && e.toolCallId === started.toolCallId) as any
        expect(end.isError).toBe(false)
        const done = end.result.details
        expect(done).toMatchObject({ kind: 'subagent', status: 'done', task: 'CHILD TASK: count files' })
        // Codex's nickname for it.
        expect(done.title).not.toMatch(/^(Subagent|子 Agent)$/)
        const childOutline = (details: any) => details.messages.map((m: any) => m.role === 'assistant' ? m.content.map((c: any) => c.type === 'text' ? c.text : `<${c.name}>`).join('') : m.role)
        expect(childOutline(done)).toEqual(['user', '<bash>', 'toolResult', 'child says 3 files'])
        expect(done.usage.output).toBeGreaterThan(0)
        expect(outline(agent).at(-1)).toBe('assistant: parent done')
        const wait = agent.snapshot().flatMap(i => (i.message.role === 'assistant' ? i.message.content : [])).find((c: any) => c.type === 'toolCall' && c.name === 'agent') as any
        expect(wait.arguments.description).toMatch(new RegExp(`^(Wait for|等待) ${done.title}$`))

        // Replayed: the call reads the child's thread back.
        const replayed = (await start(agent.sessionId, true)).agent.snapshot()
        const result = replayed.find(i => i.message.role === 'toolResult' && i.message.toolName === 'subagent')!.message as any
        expect(result.details).toMatchObject({ kind: 'subagent', status: 'done', title: done.title })
        expect(childOutline(result.details)).toEqual(['user', '<bash>', 'toolResult', 'child says 3 files'])
    }, 40_000)

    it('asks before an MCP tool runs: allow calls it, allow for the session stops asking, deny rejects it', async () => {
        const { agent, events, next, settled } = await start()
        script = [{ call: { name: 'echo', namespace: 'mcp__demo', args: { text: 'hello' } } }, { text: 'echoed' }]
        await ok(agent, { type: 'prompt', message: 'echo it' })
        const ask = await next(e => e.type === 'extension_ui_request')
        const approval = JSON.parse(ask.title.slice(APPROVAL_TITLE_PREFIX.length))
        expect(approval).toMatchObject({ tool: 'demo.echo', summary: 'demo.echo\ntext: hello' })
        expect(ask.options).toEqual(['allow', 'always', 'deny'])
        // On the call shown for it.
        const running = events.find((e: any) => e.type === 'tool_execution_start' && e.toolName === 'demo.echo') as any
        expect(approval.toolCallId).toBe(running.toolCallId)
        agent.write({ type: 'extension_ui_response', id: ask.id, value: 'always' })
        await settled()
        expect(latestInput()).toContain('echo: hello')

        let from = events.length
        script = [{ call: { name: 'echo', namespace: 'mcp__demo', args: { text: 'again' } } }, { text: 'echoed again' }]
        await ok(agent, { type: 'prompt', message: 'once more' })
        await settled(from)
        expect(events.slice(from).some(e => e.type === 'extension_ui_request')).toBe(false)
        expect(latestInput()).toContain('echo: again')

        from = events.length
        script = [{ call: { name: 'pick_color', namespace: 'mcp__demo', args: {} } }, { text: 'not run' }]
        await ok(agent, { type: 'prompt', message: 'pick' })
        const second = await next(e => e.type === 'extension_ui_request' && e.id !== ask.id)
        agent.write({ type: 'extension_ui_response', id: second.id, value: 'deny' })
        await settled(from)
        expect(latestInput()).toContain('rejected')
        expect(outline(agent).slice(-3)).toEqual(['assistant: <demo.pick_color>', 'result demo.pick_color (error)', 'assistant: not run'])
    }, 30_000)

    it('an MCP server\'s form (elicitation) is the ask form, its answers typed as the schema says', async () => {
        const { agent, events, next, settled } = await start()
        script = [{ call: { name: 'pick_color', namespace: 'mcp__demo', args: {} } }, { text: 'picked' }]
        await ok(agent, { type: 'prompt', message: 'pick a color' })
        const approve = await next(e => e.type === 'extension_ui_request')
        agent.write({ type: 'extension_ui_response', id: approve.id, value: 'allow' })
        const ask = await next(e => e.type === 'tool_execution_update' && e.partialResult?.details?.kind === 'ask')
        expect(ask.partialResult.details.questions).toEqual([
            // Required first, with the server's message.
            { id: 'color', question: 'Pick a color for the theme · Color', options: ['red', 'green', 'blue'] },
            { id: 'bright', question: expect.stringMatching(/^Bright/), options: [expect.any(String), expect.any(String)] },
            { id: 'count', question: expect.stringMatching(/^How many/), options: [] },
            { id: 'shade', question: expect.stringMatching(/^Shade \(Any word\)/), options: [] },
        ])
        const [yes] = ask.partialResult.details.questions[1].options
        // Not a number: said so, the form keeps waiting.
        const bad = await agent.request({ type: 'prompt', message: `/gui-ask-answer ${ask.toolCallId} ${JSON.stringify({ answers: { color: { selected: ['blue'] }, count: { selected: [], text: 'lots' } } })}` })
        expect(bad.success).toBe(false)
        await ok(agent, { type: 'prompt', message: `/gui-ask-answer ${ask.toolCallId} ${JSON.stringify({ answers: { color: { selected: ['blue'] }, shade: { selected: [], text: 'navy' }, bright: { selected: [yes] }, count: { selected: [], text: '3' } } })}` })
        await settled()
        // What the server got back, as its tool's output.
        const output = JSON.parse(requests.at(-1).input.at(-1).output.at(-1).text.replace(/^answer: /, ''))
        expect(output).toEqual({ action: 'accept', content: { color: 'blue', shade: 'navy', bright: true, count: 3 } })
        const done = events.filter((e: any) => e.type === 'tool_execution_end' && e.toolName === 'ask').at(-1) as any
        expect(done.result.details).toMatchObject({ status: 'answered', answers: { color: { selected: ['blue'] } } })
    }, 30_000)

    it('request_permissions asks for the access: allow grants it for the turn, deny grants none', async () => {
        const { agent, next, settled, events } = await start()
        const permissions = { network: { enabled: true }, file_system: { write: ['/tmp/pi-gui-perm'] } }
        script = [{ call: { name: 'request_permissions', args: { permissions, reason: 'to fetch the schema' } } }, { text: 'granted' }]
        await ok(agent, { type: 'prompt', message: 'need access' })
        const ask = await next(e => e.type === 'extension_ui_request')
        const approval = JSON.parse(ask.title.slice(APPROVAL_TITLE_PREFIX.length))
        expect(approval.summary.split('\n')).toEqual([expect.stringMatching(/Network access|联网/), expect.stringMatching(/(Write|写) \/tmp\/pi-gui-perm/), 'to fetch the schema'])
        agent.write({ type: 'extension_ui_response', id: ask.id, value: 'allow' })
        await settled()
        const granted = JSON.parse(requests.at(-1).input.find((i: any) => i.type === 'function_call_output').output)
        expect(granted).toMatchObject({ scope: 'turn', permissions: { network: { enabled: true }, file_system: { write: ['/tmp/pi-gui-perm'] } } })

        const from = events.length
        script = [{ call: { name: 'request_permissions', args: { permissions } } }, { text: 'none' }]
        await ok(agent, { type: 'prompt', message: 'again' })
        const second = await next(e => e.type === 'extension_ui_request' && e.id !== ask.id)
        agent.write({ type: 'extension_ui_response', id: second.id, value: 'deny' })
        await settled(from)
        const denied = JSON.parse(requests.at(-1).input.filter((i: any) => i.type === 'function_call_output').at(-1).output)
        expect(denied.permissions).toEqual({ network: null, file_system: null })
    }, 30_000)

    it('names itself as a Codex client (originator codex_…): relays turn other names away', async () => {
        const { agent, settled } = await start()
        script = [{ text: 'hi' }]
        await ok(agent, { type: 'prompt', message: 'hello' })
        await settled()
        expect(originators.at(-1)).toMatch(/^codex_/)
    }, 30_000)

    it('offers /compact as a command', async () => {
        const { agent, events, settled } = await start()
        expect((await ok(agent, { type: 'get_commands' })).commands.map((c: any) => c.name)).toContain('compact')
        script = [{ text: 'answer' }]
        await ok(agent, { type: 'prompt', message: 'hi' })
        await settled()
        const from = events.length
        script = [{ text: 'Summary.' }]
        expect((await ok(agent, { type: 'prompt', message: '/compact' })).disposition).not.toBe('handled')
        await settled(from)
        expect(outline(agent)).toEqual(['user: hi', 'assistant: answer', 'compactionSummary'])
    }, 30_000)

    it('sends images as data URLs', async () => {
        const { agent, settled } = await start()
        script = [{ text: 'a red dot' }]
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
        await ok(agent, { type: 'prompt', message: 'what is it', images: [{ type: 'image', data: png, mimeType: 'image/png' }] })
        await settled()
        expect(JSON.stringify(requests[0].input)).toContain(`data:image/png;base64,${png}`)
    }, 30_000)

    it('unwraps the shell Codex runs commands in', () => {
        expect(displayCommand(`/bin/zsh -lc 'touch a && echo '\\''hi'\\'''`)).toBe(`touch a && echo 'hi'`)
        expect(displayCommand('ls -la')).toBe('ls -la')
    })
})
