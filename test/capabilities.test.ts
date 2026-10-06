import type { ApprovalMode, ApprovalRequest, AskDetails, AskResponse, CapabilityId, PlanDetails, SubagentDetails, TodoDetails } from '@shared/capabilities'
import type { PiEnv } from '@shared/ipc'
import type { MockLlm, MockReply, MockRequest, PiSession } from './harness'
import { APPROVAL_TITLE_PREFIX, CAPABILITIES } from '@shared/capabilities'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPi, startMockLlm, startPi } from './harness'

let env: PiEnv | null = null
beforeAll(async () => {
    env = await findPi()
}, 30_000)

const open: { llm: MockLlm, pi?: PiSession }[] = []
afterEach(async () => {
    for (const { llm, pi } of open.splice(0)) {
        await pi?.stop()
        await llm.close()
    }
})

async function setup(capabilities: CapabilityId[], reply: (request: MockRequest, index: number) => MockReply, options: { approvalMode?: ApprovalMode } = {}) {
    const llm = await startMockLlm(reply)
    const slot: { llm: MockLlm, pi?: PiSession } = { llm }
    open.push(slot)
    slot.pi = await startPi(env!, llm, capabilities, options)
    return { llm, pi: slot.pi }
}

/** Replies with the scripted tool calls first, then plain text once every tool has a result. */
const script = (...steps: MockReply[]) => (_r: MockRequest, i: number): MockReply => steps[i] ?? { text: 'done' }

const toolEnd = (name: string) => (e: any) => e.type === 'tool_execution_end' && e.toolName === name

const approvalPrompt = (e: any) => e.type === 'extension_ui_request' && e.method === 'select' && String(e.title).startsWith(APPROVAL_TITLE_PREFIX)
const approvalOf = (e: any): ApprovalRequest => JSON.parse(e.title.slice(APPROVAL_TITLE_PREFIX.length))
const statusOf = (pi: PiSession, key: string) => pi.events.filter(e => e.type === 'extension_ui_request' && e.method === 'setStatus' && e.statusKey === key).at(-1)?.statusText
const toolNames = (r: MockRequest) => r.tools.map((t: any) => t.function?.name ?? t.name)

describe.runIf(process.env.PI_GUI_SKIP_E2E !== '1')('capability extensions (real pi, mock model)', () => {
    it('todo: details carry the full list and the model gets a summary', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const items = [
            { text: 'Read the code', status: 'done' },
            { text: 'Write the fix', status: 'in_progress' },
            { text: 'Run tests', status: 'pending' },
        ]
        const { llm, pi } = await setup(['todo'], script({ toolCalls: [{ name: 'todo', arguments: { items } }] }))
        await pi.run('fix it')

        const end: any = await pi.waitFor(toolEnd('todo'))
        expect(end.isError).toBe(false)
        expect(end.result.details as TodoDetails).toEqual({ kind: 'todo', items })
        expect(llm.requests[1].toolResults[0]).toBe('Todo list updated: 1/3 done. In progress: Write the fix')
    }, 30_000)

    it('ask: waits for /gui-ask-answer and returns the answers to the model', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['ask'], script({
            toolCalls: [{ name: 'ask', arguments: { questions: [
                { question: 'Which database?', options: ['Postgres', 'SQLite'] },
                { question: 'Extras?', options: ['Auth', 'Billing'], multiple: true },
            ] } }],
        }))
        const prompt = await pi.request({ type: 'prompt', message: 'build it' })
        expect(prompt.success).toBe(true)

        const update: any = await pi.waitFor(e => e.type === 'tool_execution_update' && e.toolName === 'ask')
        const pending = update.partialResult.details as AskDetails
        expect(pending.status).toBe('pending')
        expect(pending.questions.map(q => q.id)).toEqual(['q1', 'q2'])

        // Hidden command while the parent is mid-tool: handled immediately, not queued.
        const response: AskResponse = { answers: { q1: { selected: ['SQLite'] }, q2: { selected: ['Auth'], text: 'and audit logs' } } }
        const answer = await pi.request({ type: 'prompt', message: `/gui-ask-answer ${update.toolCallId} ${JSON.stringify(response)}` })
        expect(answer.data).toEqual({ disposition: 'handled' })

        const end: any = await pi.waitFor(toolEnd('ask'))
        expect((end.result.details as AskDetails).status).toBe('answered')
        await pi.waitFor(e => e.type === 'agent_settled')
        expect(llm.requests[1].toolResults[0]).toBe('Q: Which database?\nA: SQLite\n\nQ: Extras?\nA: Auth; and audit logs')
        // The internal command never reaches the model.
        expect(JSON.stringify(llm.requests[1].messages)).not.toContain('gui-ask-answer')
    }, 30_000)

    it('ask: aborting the run resolves the pending question as cancelled', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['ask'], script({ toolCalls: [{ name: 'ask', arguments: { questions: [{ question: 'A or B?', options: ['A', 'B'] }] } }] }))
        await pi.request({ type: 'prompt', message: 'go' })
        await pi.waitFor(e => e.type === 'tool_execution_update' && e.toolName === 'ask')
        await pi.request({ type: 'abort' })
        const end: any = await pi.waitFor(toolEnd('ask'))
        expect((end.result.details as AskDetails).status).toBe('cancelled')
        await pi.waitFor(e => e.type === 'agent_settled')
    }, 30_000)

    it('approval: asks before bash, and a denial reaches the model', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['approval'], script({ toolCalls: [{ name: 'bash', arguments: { command: 'git push origin main' } }] }), { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'ship it' })
        const prompt: any = await pi.waitFor(approvalPrompt)
        const request = approvalOf(prompt)
        expect(request).toMatchObject({ tool: 'bash', summary: 'git push origin main', scope: 'git' })
        expect(prompt.options).toEqual(['allow', 'always', 'deny'])
        expect(statusOf(pi, 'gui-approval')).toBe('ask')

        pi.send({ type: 'extension_ui_response', id: prompt.id, value: 'deny' })
        const end: any = await pi.waitFor(toolEnd('bash'))
        expect(end.isError).toBe(true)
        expect(end.toolCallId).toBe(request.toolCallId)
        await pi.waitFor(e => e.type === 'agent_settled')
        expect(llm.requests[1].toolResults[0]).toContain('The user declined this bash call')
    }, 30_000)

    it('approval: "always" covers later calls of the same program in the session', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['approval'], script(
            { toolCalls: [{ name: 'bash', arguments: { command: 'echo one' } }] },
            { toolCalls: [{ name: 'bash', arguments: { command: 'echo two' } }] },
        ), { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'go' })
        const prompt: any = await pi.waitFor(approvalPrompt)
        pi.send({ type: 'extension_ui_response', id: prompt.id, value: 'always' })
        await pi.waitFor(e => e.type === 'agent_settled')
        const ends = pi.events.filter(toolEnd('bash'))
        expect(ends.map((e: any) => e.isError)).toEqual([false, false])
        expect(pi.events.filter(approvalPrompt)).toHaveLength(1)
    }, 30_000)

    it('approval: edits mode lets project file edits through and still asks for bash', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['approval'], script(
            { toolCalls: [{ name: 'write', arguments: { path: 'notes.txt', content: 'hi' } }] },
            { toolCalls: [{ name: 'write', arguments: { path: '../outside.txt', content: 'hi' } }] },
        ), { approvalMode: 'edits' })
        await pi.request({ type: 'prompt', message: 'write' })
        const prompt: any = await pi.waitFor(approvalPrompt)
        // Only the write outside the project asked.
        expect(approvalOf(prompt).summary).toBe('../outside.txt')
        expect(pi.events.filter(toolEnd('write'))).toHaveLength(1)
        expect(statusOf(pi, 'gui-approval')).toBe('edits')
        pi.send({ type: 'extension_ui_response', id: prompt.id, value: 'deny' })
        await pi.waitFor(e => e.type === 'agent_settled')
    }, 30_000)

    it('approval: /gui-approval auto stops asking; aborting dismisses a pending prompt', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        // A bash call for every new user message, then plain text.
        const { pi } = await setup(['approval'], r => r.messages.at(-1)?.role === 'user' ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { text: 'done' }, { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'one' })
        await pi.waitFor(approvalPrompt)
        await pi.request({ type: 'abort' })
        const end: any = await pi.waitFor(toolEnd('bash'))
        expect(end.isError).toBe(true)
        await pi.waitFor(e => e.type === 'agent_settled')

        const handled = await pi.request({ type: 'prompt', message: '/gui-approval auto' })
        expect(handled.data).toEqual({ disposition: 'handled' })
        expect(statusOf(pi, 'gui-approval')).toBe('auto')
        const before = pi.events.length
        await pi.run('two')
        const later = pi.events.slice(before)
        expect(later.filter(approvalPrompt)).toHaveLength(0)
        expect(later.filter(toolEnd('bash')).map((e: any) => e.isError)).toEqual([false])
    }, 30_000)

    it('plan: read-only tools and instructions while on; approval restores tools mid-run', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['plan'], script(
            { toolCalls: [{ name: 'bash', arguments: { command: 'git status && ls' } }, { name: 'bash', arguments: { command: 'rm -rf src' } }] },
            { toolCalls: [{ name: 'propose_plan', arguments: { plan: '1. Edit a.ts\n2. Test' } }] },
            { toolCalls: [{ name: 'write', arguments: { path: 'a.ts', content: 'x' } }] },
        ))
        expect((await pi.request({ type: 'prompt', message: '/gui-plan on' })).data).toEqual({ disposition: 'handled' })
        expect(statusOf(pi, 'gui-plan')).toBe('on')
        await pi.request({ type: 'prompt', message: 'plan the change' })

        const update: any = await pi.waitFor(e => e.type === 'tool_execution_update' && e.toolName === 'propose_plan')
        expect(update.partialResult.details as PlanDetails).toEqual({ kind: 'plan', status: 'pending', plan: '1. Edit a.ts\n2. Test' })
        const first = llm.requests[0]
        expect(toolNames(first)).toEqual(expect.arrayContaining(['read', 'bash', 'propose_plan']))
        expect(toolNames(first)).not.toContain('write')
        expect(toolNames(first)).not.toContain('edit')
        expect(first.system).toContain('Plan mode is on')
        // The read-only command ran; the destructive one was blocked.
        expect(llm.requests[1].toolResults[0]).not.toContain('Plan mode allows only')
        expect(llm.requests[1].toolResults[1]).toContain('Plan mode allows only read-only commands')

        await pi.request({ type: 'prompt', message: `/gui-plan-decide ${update.toolCallId} ${JSON.stringify({ approve: true })}` })
        const end: any = await pi.waitFor(toolEnd('propose_plan'))
        expect((end.result.details as PlanDetails).status).toBe('approved')
        await pi.waitFor(e => e.type === 'agent_settled')
        // Same run: the next request has the write tools back and no propose_plan.
        expect(toolNames(llm.requests[2])).toContain('write')
        expect(toolNames(llm.requests[2])).not.toContain('propose_plan')
        expect(pi.events.filter(toolEnd('write')).map((e: any) => e.isError)).toEqual([false])
        expect(statusOf(pi, 'gui-plan')).toBeUndefined()
    }, 30_000)

    it('plan: feedback keeps plan mode on and goes back to the model', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['plan'], script({ toolCalls: [{ name: 'propose_plan', arguments: { plan: 'Rewrite everything' } }] }))
        await pi.request({ type: 'prompt', message: '/gui-plan on' })
        await pi.request({ type: 'prompt', message: 'plan' })
        const update: any = await pi.waitFor(e => e.type === 'tool_execution_update' && e.toolName === 'propose_plan')
        await pi.request({ type: 'prompt', message: `/gui-plan-decide ${update.toolCallId} ${JSON.stringify({ feedback: 'smaller steps' })}` })
        const end: any = await pi.waitFor(toolEnd('propose_plan'))
        expect(end.result.details).toEqual({ kind: 'plan', status: 'revised', plan: 'Rewrite everything', feedback: 'smaller steps' })
        await pi.waitFor(e => e.type === 'agent_settled')
        expect(llm.requests[1].toolResults[0]).toContain('smaller steps')
        expect(toolNames(llm.requests[1])).toContain('propose_plan')
        expect(statusOf(pi, 'gui-plan')).toBe('on')
    }, 30_000)

    it('plan: off by default, and propose_plan is not offered', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['plan'], script())
        await pi.run('hi')
        expect(toolNames(llm.requests[0])).not.toContain('propose_plan')
        expect(toolNames(llm.requests[0])).toContain('write')
        expect(llm.requests[0].system).not.toContain('Plan mode is on')
    }, 30_000)

    /**
     * Parent and child share the mock: requests offering the subagent tool are the parent's. The
     * parent delegates once, then answers; the child follows `child` by its own request count.
     */
    const delegate = (child: MockReply[]) => {
        let childRequests = 0
        return (r: MockRequest): MockReply => {
            if (toolNames(r).includes('subagent'))
                return r.toolResults.length ? { text: 'parent done' } : { toolCalls: [{ name: 'subagent', arguments: { title: 'Look around', task: 'CHILD TASK: list files' } }] }
            return child[childRequests++] ?? { text: 'child result' }
        }
    }
    const subagentUpdate = (match: (d: SubagentDetails) => boolean) => (e: any) =>
        e.type === 'tool_execution_update' && e.toolName === 'subagent' && match(e.partialResult.details)

    it('subagent: runs a child pi, streams its transcript, returns its reply and usage', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        // The command outlasts one update interval, so a live update with the child's messages is certain.
        const { llm, pi } = await setup(['todo', 'subagent'], delegate([{ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 0.4; echo from-child' } }] }]))
        await pi.run('investigate')

        const end: any = await pi.waitFor(toolEnd('subagent'))
        const details = end.result.details as SubagentDetails
        expect(end.isError).toBe(false)
        expect(details).toMatchObject({ kind: 'subagent', status: 'done', title: 'Look around', task: 'CHILD TASK: list files', model: 'mock/mock-1' })
        expect(details.messages.map(m => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
        expect(JSON.stringify(details)).not.toContain('Plan mode')
        expect(JSON.stringify(details.messages[2])).toContain('from-child')
        expect(details.usage.input).toBeGreaterThan(0)
        expect(end.result.usage.totalTokens).toBeGreaterThan(0)
        // Live updates came before the end.
        expect(pi.events.some(subagentUpdate(d => d.messages.length > 0))).toBe(true)

        const parentAfter = llm.requests.filter(r => toolNames(r).includes('subagent')).at(-1)!
        expect(parentAfter.toolResults[0]).toBe('child result')
        // The child got the task, not this conversation, and no subagent tool of its own.
        const childFirst = llm.requests.find(r => !toolNames(r).includes('subagent'))!
        expect(JSON.stringify(childFirst.messages)).toContain('CHILD TASK')
        expect(JSON.stringify(childFirst.messages)).not.toContain('investigate')
        expect(toolNames(childFirst)).toContain('todo')
    }, 40_000)

    it('subagent: a steer reaches the child mid-run', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['subagent'], delegate([{ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 1.5' } }] }]))
        await pi.request({ type: 'prompt', message: 'go' })
        const running: any = await pi.waitFor(subagentUpdate(d => Object.keys(d.tools).length > 0))
        const handled = await pi.request({ type: 'prompt', message: `/gui-subagent-steer ${running.toolCallId} only look at README.md` })
        expect(handled.data).toEqual({ disposition: 'handled' })
        await pi.waitFor(subagentUpdate(d => d.steering.includes('only look at README.md')))
        await pi.waitFor(e => e.type === 'agent_settled', 20_000)

        const childSecond = llm.requests.filter(r => !toolNames(r).includes('subagent'))[1]
        expect(JSON.stringify(childSecond.messages)).toContain('only look at README.md')
        const details = (pi.events.find(toolEnd('subagent')) as any).result.details as SubagentDetails
        expect(details.status).toBe('done')
        // The parent's own transcript never saw the steer.
        expect(JSON.stringify(llm.requests.filter(r => toolNames(r).includes('subagent')).map(r => r.messages))).not.toContain('only look at README.md')
    }, 40_000)

    it('subagent: cancel stops only the child; the parent carries on', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['subagent'], delegate([{ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 10' } }] }]))
        await pi.request({ type: 'prompt', message: 'go' })
        const running: any = await pi.waitFor(subagentUpdate(d => Object.keys(d.tools).length > 0))
        const started = Date.now()
        await pi.request({ type: 'prompt', message: `/gui-subagent-cancel ${running.toolCallId}` })
        const end: any = await pi.waitFor(toolEnd('subagent'))
        expect(Date.now() - started).toBeLessThan(3000)
        expect((end.result.details as SubagentDetails).status).toBe('cancelled')
        await pi.waitFor(e => e.type === 'agent_settled')
        const parentAfter = llm.requests.filter(r => toolNames(r).includes('subagent')).at(-1)!
        expect(parentAfter.toolResults[0]).toContain('The user cancelled this subagent')
    }, 40_000)

    it('subagent: aborting the parent run stops the child', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['subagent'], delegate([{ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 10' } }] }]))
        await pi.request({ type: 'prompt', message: 'go' })
        await pi.waitFor(subagentUpdate(d => Object.keys(d.tools).length > 0))
        await pi.request({ type: 'abort' })
        const end: any = await pi.waitFor(toolEnd('subagent'), 5000)
        expect((end.result.details as SubagentDetails).status).toBe('cancelled')
        await pi.waitFor(e => e.type === 'agent_settled')
    }, 40_000)

    it('subagent: the child\'s approvals are forwarded with its title', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['approval', 'subagent'], delegate([{ toolCalls: [{ name: 'bash', arguments: { command: 'echo approved' } }] }]), { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'go' })
        // Launching the subagent itself needs no approval; the child's bash does.
        const prompt: any = await pi.waitFor(approvalPrompt, 20_000)
        expect(approvalOf(prompt)).toMatchObject({ tool: 'bash', summary: 'echo approved', agent: 'Look around' })
        pi.send({ type: 'extension_ui_response', id: prompt.id, value: 'allow' })
        const end: any = await pi.waitFor(toolEnd('subagent'), 20_000)
        const details = end.result.details as SubagentDetails
        expect(details.status).toBe('done')
        expect(JSON.stringify(details.messages)).toContain('approved')
        expect(pi.events.filter(approvalPrompt)).toHaveLength(1)
    }, 40_000)

    it('gui- commands are registered as extension commands', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['ask'], script())
        const { data } = await pi.request<{ commands: { name: string }[] }>({ type: 'get_commands' })
        expect(data!.commands.map(c => c.name)).toContain('gui-ask-answer')
    }, 30_000)

    it('declared context cost matches what each capability adds to a request', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        // Tool schemas plus system prompt, in rough tokens (4 chars each).
        const size = (r: MockRequest) => (JSON.stringify(r.tools).length + r.system.length) / 4
        const measure = async (capabilities: CapabilityId[]) => {
            const { llm, pi } = await setup(capabilities, script())
            await pi.run('hi')
            return size(llm.requests[0])
        }
        const base = await measure([])
        // Within 25% (or 30 tokens for capabilities that add nothing), so settings stay honest.
        const close = (measured: number, declared: number, label: string) =>
            expect(Math.abs(measured - declared), `${label}: measured ${Math.round(measured)} tokens`).toBeLessThan(Math.max(30, declared * 0.25))
        for (const c of CAPABILITIES)
            close((await measure([c.id])) - base, c.contextTokens, c.id)

    }, 90_000)
})
