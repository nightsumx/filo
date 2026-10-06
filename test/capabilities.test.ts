import type { AskDetails, AskResponse, CapabilityId, TodoDetails } from '@shared/capabilities'
import type { PiEnv } from '@shared/ipc'
import type { MockLlm, MockReply, MockRequest, PiSession } from './harness'
import { CAPABILITIES } from '@shared/capabilities'
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

async function setup(capabilities: CapabilityId[], reply: (request: MockRequest, index: number) => MockReply) {
    const llm = await startMockLlm(reply)
    const slot: { llm: MockLlm, pi?: PiSession } = { llm }
    open.push(slot)
    slot.pi = await startPi(env!, llm, capabilities)
    return { llm, pi: slot.pi }
}

/** Replies with the scripted tool calls first, then plain text once every tool has a result. */
const script = (...steps: MockReply[]) => (_r: MockRequest, i: number): MockReply => steps[i] ?? { text: 'done' }

const toolEnd = (name: string) => (e: any) => e.type === 'tool_execution_end' && e.toolName === name

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
        for (const c of CAPABILITIES) {
            const added = (await measure([c.id])) - base
            // Within 25%, so the number shown in settings stays honest when prompts change.
            expect(Math.abs(added - c.contextTokens) / c.contextTokens, `${c.id}: measured ${Math.round(added)} tokens`).toBeLessThan(0.25)
        }
    }, 60_000)
})
