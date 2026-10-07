import type { ApprovalMode, ApprovalRequest, AskDetails, AskResponse, CapabilityId, PlanDetails, ReviewDetails, ReviewProgress, SubagentDetails, TodoDetails } from '@shared/capabilities'
import type { PiEnv } from '@shared/ipc'
import type { MockLlm, MockReply, MockRequest, PiSession } from './harness'
import { APPROVAL_TITLE_PREFIX, CAPABILITIES } from '@shared/capabilities'
import { execFileSync } from 'node:child_process'
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

async function setup(capabilities: CapabilityId[], reply: (request: MockRequest, index: number) => MockReply, options: { approvalMode?: ApprovalMode, settings?: Record<string, unknown> } = {}) {
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

    // A list left with open steps (finished work never ticked off, or work dropped) would otherwise
    // keep showing under every later prompt; the model is shown it again so it updates or clears it.
    it('todo: open steps left from earlier are shown to the model at the next prompt', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const open = [{ text: 'Write the fix', status: 'done' }, { text: 'Run tests', status: 'in_progress' }]
        const { llm, pi } = await setup(['todo'], script({ toolCalls: [{ name: 'todo', arguments: { items: open } }] }))
        await pi.run('fix it')
        const before = llm.requests.length
        await pi.run('commit it')
        const next = JSON.stringify(llm.requests[before].messages)
        expect(next).toContain('still has open steps')
        expect(next).toContain('Run tests')
        // Once, as the last message before the new prompt's reply.
        expect(next.split('still has open steps').length - 1).toBe(1)
    }, 30_000)

    it('todo: a finished or empty list adds nothing to the next prompt', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['todo'], script({ toolCalls: [{ name: 'todo', arguments: { items: [{ text: 'Write the fix', status: 'done' }] } }] }))
        await pi.run('fix it')
        await pi.run('thanks')
        expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toContain('still has open steps')
    }, 30_000)

    // Compaction replaces the todo call with a summary, which is when the list stops being updated.
    it('todo: after a compaction mid-run, the open list is repeated to the model', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const open = [{ text: 'Step one', status: 'in_progress' }, { text: 'Step two', status: 'pending' }]
        const { llm, pi } = await setup(['todo'], (r, i) => {
            // The summary request is the only one without tools.
            if (!r.tools.length)
                return { text: '## Goal\nsummary' }
            if (i === 0)
                return { toolCalls: [{ name: 'todo', arguments: { items: open } }] }
            // Reports a context near the window (with enough output to cut), so pi compacts before the next request.
            if (i === 1)
                return { toolCalls: [{ name: 'bash', arguments: { command: 'seq 1 3000' } }], usage: { input: 95_000, output: 10 } }
            return { text: 'done' }
        }, { settings: { compaction: { keepRecentTokens: 100 } } })
        await pi.run('do it')
        const compacted = pi.events.some(e => e.type === 'compaction_end' && (e as any).reason === 'threshold')
        const after = llm.requests.filter(r => r.tools.length).at(-1)!
        expect(compacted).toBe(true)
        expect(JSON.stringify(after.messages)).toContain('still has open steps')
        // Hidden: not listed as a queued steering message either.
        expect(JSON.stringify(pi.events.filter(e => e.type === 'queue_update'))).not.toContain('open steps')
    }, 60_000)

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

    it('approval: asks before bash; a denial ends the turn and reaches the model with the next message', async ({ skip }) => {
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
        // No follow-up request: the turn stops so the user can say what to do instead.
        expect(llm.requests).toHaveLength(1)
        await pi.run('do it differently')
        expect(llm.requests[1].toolResults[0]).toContain('The user declined this bash call')
    }, 30_000)

    it('approval: a denial declines the rest of the batch without asking', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        // Two bash calls for every new user message.
        const batch = { toolCalls: [
            { name: 'bash', arguments: { command: 'touch one' } },
            { name: 'bash', arguments: { command: 'touch two' } },
        ] }
        const { llm, pi } = await setup(['approval'], r => r.messages.at(-1)?.role === 'user' ? batch : { text: 'done' }, { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'go' })
        const prompt: any = await pi.waitFor(approvalPrompt)
        pi.send({ type: 'extension_ui_response', id: prompt.id, value: 'deny' })
        await pi.waitFor(e => e.type === 'agent_settled')
        expect(pi.events.filter(approvalPrompt)).toHaveLength(1)
        const ends = pi.events.filter(toolEnd('bash'))
        expect(ends.map((e: any) => e.isError)).toEqual([true, true])
        expect(ends[1].result.content[0].text).toContain('declined an earlier call')
        expect(llm.requests).toHaveLength(1)

        // The next message's calls are asked about again.
        await pi.request({ type: 'prompt', message: 'again' })
        const second: any = await pi.waitFor(e => approvalPrompt(e) && e.id !== prompt.id)
        pi.send({ type: 'extension_ui_response', id: second.id, value: 'allow' })
        const third: any = await pi.waitFor(e => approvalPrompt(e) && e.id !== prompt.id && e.id !== second.id)
        pi.send({ type: 'extension_ui_response', id: third.id, value: 'allow' })
        await pi.waitFor(e => e.type === 'agent_settled' && pi.events.filter(toolEnd('bash')).length === 4)
        expect(pi.events.filter(toolEnd('bash')).slice(2).map((e: any) => e.isError)).toEqual([false, false])
    }, 30_000)

    it('approval: "always" on a project file edit switches to the edits mode', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['approval'], script(
            { toolCalls: [{ name: 'write', arguments: { path: 'a.txt', content: 'a' } }] },
            { toolCalls: [{ name: 'write', arguments: { path: 'b.txt', content: 'b' } }] },
            { toolCalls: [{ name: 'write', arguments: { path: '../outside.txt', content: 'c' } }] },
        ), { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'write' })
        const first: any = await pi.waitFor(approvalPrompt)
        expect(approvalOf(first)).toMatchObject({ tool: 'write', scope: 'edits' })
        expect(first.options).toEqual(['allow', 'always', 'deny'])
        pi.send({ type: 'extension_ui_response', id: first.id, value: 'always' })
        // b.txt goes through; the file outside the project asks, with no "always".
        const outside: any = await pi.waitFor(e => approvalPrompt(e) && approvalOf(e).summary === '../outside.txt')
        expect(statusOf(pi, 'gui-approval')).toBe('edits')
        expect(outside.options).toEqual(['allow', 'deny'])
        expect(pi.events.filter(toolEnd('write')).map((e: any) => e.isError)).toEqual([false, false])
        pi.send({ type: 'extension_ui_response', id: outside.id, value: 'allow' })
        await pi.waitFor(e => e.type === 'agent_settled')
    }, 30_000)

    it('approval: "always" covers later calls of the same program in the session', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['approval'], script(
            { toolCalls: [{ name: 'bash', arguments: { command: 'touch one' } }] },
            { toolCalls: [{ name: 'bash', arguments: { command: 'touch two' } }] },
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
        const { pi } = await setup(['approval'], r => r.messages.at(-1)?.role === 'user' ? { toolCalls: [{ name: 'bash', arguments: { command: 'touch hi' } }] } : { text: 'done' }, { approvalMode: 'ask' })
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
        const { pi } = await setup(['approval', 'subagent'], delegate([{ toolCalls: [{ name: 'bash', arguments: { command: 'touch approved' } }] }]), { approvalMode: 'ask' })
        await pi.request({ type: 'prompt', message: 'go' })
        // Launching the subagent itself needs no approval; the child's bash does.
        const prompt: any = await pi.waitFor(approvalPrompt, 20_000)
        expect(approvalOf(prompt)).toMatchObject({ tool: 'bash', summary: 'touch approved', agent: 'Look around' })
        pi.send({ type: 'extension_ui_response', id: prompt.id, value: 'allow' })
        const end: any = await pi.waitFor(toolEnd('subagent'), 20_000)
        const details = end.result.details as SubagentDetails
        expect(details.status).toBe('done')
        expect(JSON.stringify(details.messages)).toContain('approved')
        expect(pi.events.filter(approvalPrompt)).toHaveLength(1)
    }, 40_000)

    /**
     * Parent and reviewer share the mock: requests offering submit_review are the reviewer's. The
     * parent writes a file once, then answers; the reviewer follows `reviewer` by its own request count.
     */
    const reviewed = (reviewer: MockReply[]) => {
        let reviewerRequests = 0
        let parentRequests = 0
        return (r: MockRequest): MockReply => {
            if (toolNames(r).includes('submit_review'))
                return reviewer[reviewerRequests++] ?? { text: 'reviewer idle' }
            if (parentRequests++ === 0)
                return { toolCalls: [{ name: 'write', arguments: { path: 'greet.txt', content: 'hello\n' } }] }
            return { text: `Parent reply ${parentRequests}: wrote greet.txt and verified it.` }
        }
    }
    const isReviewer = (r: MockRequest) => toolNames(r).includes('submit_review')
    const reportAppended = (pi: PiSession, after = 0) => pi.waitFor(e => e.type === 'entry_appended' && e.entry?.customType === 'pi-kit-review' && pi.events.indexOf(e) >= after, 30_000)
    const gitProject = (cwd: string) => {
        const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
        git('init', '-q')
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    }

    it('review: a read-only child reviews the thread\'s diff; runtime evidence confirms issues; picked items go back', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const submit = {
            verdict: 'needs_work',
            summary: 'Checked greet.txt.',
            issues: [
                { title: 'Exit status is wrong', severity: 'high', file: 'greet.txt', line: 1, detail: 'The check fails.', fix: 'Fix it.', repro: 'cat greet.txt;  exit 3' },
                { title: 'Might break later', severity: 'low', detail: 'A guess.', repro: 'never ran this' },
            ],
            suggestions: [{ title: 'Add a test', detail: 'Cover greet.txt.' }],
        }
        const { llm, pi } = await setup(['review'], reviewed([
            // Outlasts one progress interval, so a progress update names it.
            { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 0.8; cat greet.txt; exit 3' } }] },
            { toolCalls: [{ name: 'submit_review', arguments: submit }] },
            // Second round: rechecks R1.
            { toolCalls: [{ name: 'submit_review', arguments: { verdict: 'pass', summary: 'Fixed.', rechecks: [{ id: 'R1', outcome: 'fixed', note: 'Exit is 0 now.' }, { id: 'R9', outcome: 'fixed', note: 'unknown' }] } }] },
        ]))
        gitProject(pi.cwd)
        await pi.run('create greet.txt')

        const started = pi.events.length
        const handled = await pi.request({ type: 'prompt', message: '/gui-review look at exit codes' })
        expect(handled.success).toBe(true)
        const appended: any = await reportAppended(pi)
        const report = appended.entry.data as ReviewDetails
        expect(report).toMatchObject({ kind: 'review', status: 'done', round: 1, verdict: 'needs_work', scope: 'thread', files: ['greet.txt'] })
        expect(report.issues.map(i => [i.id, i.status])).toEqual([['R1', 'confirmed'], ['R2', 'suspected']])
        expect(report.issues[0].evidence).toMatchObject({ command: 'sleep 0.8; cat greet.txt; exit 3', exitCode: 3 })
        expect(report.issues[0].evidence!.output).toContain('hello')
        expect(report.suggestions).toEqual([{ id: 'S1', title: 'Add a test', detail: 'Cover greet.txt.' }])
        expect(report.commands).toHaveLength(1)
        expect(report.run.messages.length).toBeGreaterThan(0)

        // The reviewer was told the facts and nothing else, and could not edit.
        const first = llm.requests.find(isReviewer)!
        const told = JSON.stringify(first.messages)
        expect(told).toContain('create greet.txt')
        expect(told).toContain('wrote greet.txt and verified it')
        expect(told).toContain('+hello')
        expect(told).toContain('look at exit codes')
        expect(toolNames(first)).toEqual(expect.arrayContaining(['read', 'bash', 'submit_review']))
        expect(toolNames(first)).not.toContain('write')
        expect(toolNames(first)).not.toContain('edit')
        // The parent's context never saw the review.
        const parentRequests = () => llm.requests.filter(r => !isReviewer(r))
        expect(parentRequests()).toHaveLength(2)

        // Progress went out as status JSON while it ran, and was cleared after the report.
        await pi.waitFor(e => e.type === 'extension_ui_request' && e.statusKey === 'gui-review' && e.statusText === undefined && pi.events.indexOf(e) > started)
        const progress = pi.events.filter(e => e.type === 'extension_ui_request' && e.method === 'setStatus' && e.statusKey === 'gui-review' && pi.events.indexOf(e) >= started)
        expect(JSON.parse(progress[0].statusText) as ReviewProgress).toMatchObject({ id: report.id, tools: 0 })
        expect(progress.some(e => e.statusText && JSON.parse(e.statusText).last === 'bash sleep 0.8; cat greet.txt; exit 3')).toBe(true)
        expect(progress.at(-1)!.statusText).toBeUndefined()
        expect(pi.events.indexOf(progress.at(-1)!)).toBeGreaterThan(pi.events.indexOf(appended))

        // Apply R1 with a note: the parent gets it as a new turn.
        const before = pi.events.length
        await pi.request({ type: 'prompt', message: `/gui-review-apply ${report.id} ${JSON.stringify({ items: ['R1', 'bogus'], note: 'keep it small' })}` })
        await pi.waitFor(e => e.type === 'agent_settled' && pi.events.indexOf(e) >= before, 20_000)
        const fed = JSON.stringify(parentRequests().at(-1)!.messages)
        expect(fed).toContain('R1 [confirmed, high] Exit status is wrong')
        expect(fed).toContain('exited with 3')
        expect(fed).toContain('keep it small')
        expect(fed).not.toContain('Might break later')
        const sent: any = pi.events.find(e => e.type === 'message_end' && e.message?.customType === 'pi-kit-review-feedback')
        expect(sent.message.details).toEqual({ reviewId: report.id, items: ['R1'], note: 'keep it small' })

        // Round two hears what was sent back and how the agent answered.
        const second = pi.events.length
        await pi.request({ type: 'prompt', message: '/gui-review' })
        const next = (await reportAppended(pi, second) as any).entry.data as ReviewDetails
        expect(next).toMatchObject({ status: 'done', round: 2, verdict: 'pass', rechecks: [{ id: 'R1', title: 'Exit status is wrong', outcome: 'fixed', note: 'Exit is 0 now.' }] })
        const recheckTask = JSON.stringify(llm.requests.filter(isReviewer).at(-1)!.messages)
        expect(recheckTask).toContain('R1: Exit status is wrong')
        expect(recheckTask).toContain('Parent reply 3')
    }, 60_000)

    it('review: falls back to uncommitted changes, nudges once, then reports the failure', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup(['review'], (r) => isReviewer(r) ? { text: 'looks fine' } : { text: 'nothing to do' })
        gitProject(pi.cwd)
        execFileSync('sh', ['-c', 'printf "draft\n" > notes.md'], { cwd: pi.cwd })
        await pi.run('hi')
        await pi.request({ type: 'prompt', message: '/gui-review' })
        const report = (await reportAppended(pi) as any).entry.data as ReviewDetails
        expect(report).toMatchObject({ status: 'failed', scope: 'uncommitted', files: ['notes.md'] })
        expect(report.error).toContain('without submitting')
        const reviewerRequests = llm.requests.filter(isReviewer)
        expect(reviewerRequests).toHaveLength(2)
        expect(JSON.stringify(reviewerRequests[0].messages)).toContain('+draft')
        expect(JSON.stringify(reviewerRequests[1].messages)).toContain('Call submit_review now')
    }, 60_000)

    it('review: cancel stops the reviewer without a report; one review at a time', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { pi } = await setup(['review'], reviewed([{ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 10' } }] }]))
        await pi.run('create greet.txt')
        const started = pi.events.length
        await pi.request({ type: 'prompt', message: '/gui-review' })
        await pi.waitFor(e => e.type === 'extension_ui_request' && e.statusKey === 'gui-review' && e.statusText && JSON.parse(e.statusText).tools === 1, 20_000)
        await pi.request({ type: 'prompt', message: '/gui-review' })
        await pi.waitFor(e => e.type === 'extension_ui_request' && e.method === 'notify' && String(e.message).includes('已经在进行中'))
        const cancelledAt = Date.now()
        await pi.request({ type: 'prompt', message: '/gui-review-cancel' })
        await pi.waitFor(e => e.type === 'extension_ui_request' && e.statusKey === 'gui-review' && e.statusText === undefined && pi.events.indexOf(e) > started)
        expect(Date.now() - cancelledAt).toBeLessThan(5000)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(pi.events.some(e => e.type === 'entry_appended' && e.entry?.customType === 'pi-kit-review')).toBe(false)
    }, 60_000)

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
