// Autopilot in a real pi with a scripted model: the supervisor child decides after each run, its
// message reaches the agent, cards wait for the user, the hard rules hold calls, and what the user
// types while it is on is recorded. Supervisor requests are the ones offering submit_decision.
import type { AutopilotCard, AutopilotDecision, AutopilotStatus } from '@shared/capabilities'
import type { PiEnv } from '@shared/ipc'
import type { MockLlm, MockReply, MockRequest, PiSession } from './harness'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
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

const toolNames = (r: MockRequest) => r.tools.map((t: any) => t.function?.name ?? t.name)
const isSupervisor = (r: MockRequest) => toolNames(r).includes('submit_decision')
const told = (r: MockRequest) => JSON.stringify(r.messages)

/** Agent and supervisor share the mock; each follows its own script by its own request count. */
function scripted(agent: MockReply[], supervisor: MockReply[]) {
    let a = 0
    let s = 0
    return (r: MockRequest): MockReply => isSupervisor(r) ? supervisor[s++] ?? { toolCalls: [{ name: 'submit_decision', arguments: { next: 'done', reason: 'nothing more' } }] } : agent[a++] ?? { text: 'idle' }
}

async function setup(agent: MockReply[], supervisor: MockReply[]) {
    const llm = await startMockLlm(scripted(agent, supervisor))
    const slot: { llm: MockLlm, pi?: PiSession } = { llm }
    open.push(slot)
    slot.pi = await startPi(env!, llm, ['ask', 'autopilot'])
    const git = (...args: string[]) => execFileSync('git', args, { cwd: slot.pi!.cwd, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    return { llm, pi: slot.pi }
}

const appended = (pi: PiSession, type: string, after = 0) => pi.waitFor(e => e.type === 'entry_appended' && e.entry?.customType === type && pi.events.indexOf(e) >= after, 30_000)
const statuses = (pi: PiSession) => pi.events.filter(e => e.type === 'extension_ui_request' && e.method === 'setStatus' && e.statusKey === 'gui-autopilot' && e.statusText).map(e => JSON.parse(e.statusText) as AutopilotStatus)
const decide = (args: Record<string, unknown>): MockReply => ({ toolCalls: [{ name: 'submit_decision', arguments: args }] })

describe.runIf(process.env.PI_GUI_SKIP_E2E !== '1')('autopilot (real pi, mock model)', () => {
    it('judges each settled run, answers for the user, and leaves the user\'s decisions on cards', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup([
            { toolCalls: [{ name: 'write', arguments: { path: 'greet.txt', content: 'hello\n' } }] },
            { text: '写好了 greet.txt。要我提交吗？' },
            { text: '已提交。' },
        ], [
            { toolCalls: [{ name: 'bash', arguments: { command: 'cat greet.txt' } }] },
            decide({ next: 'continue', message: '提交吧，只提交你自己的文件。', reason: '内容核对过了，还没提交。', rules: ['R02', 'R18'], topic: '问候文件', cards: [{ category: 'taste', title: '问候语', question: 'hello 还是 你好？', options: [{ label: 'hello' }, { label: '你好' }], recommended: 'A', fallback: '保持 hello' }] }),
            decide({ next: 'done', reason: '提交了，目标完成。' }),
        ])
        await pi.request({ type: 'prompt', message: '/gui-autopilot on' })
        expect(statuses(pi).at(-1)!.phase).toBe('idle')

        await pi.run('写一个 greet.txt')
        const first = await appended(pi, 'pi-kit-autopilot')
        const decision = first.entry.data as AutopilotDecision
        expect(decision).toMatchObject({ status: 'done', next: 'continue', message: '提交吧，只提交你自己的文件。', rules: ['R02', 'R18'], topic: '问候文件', workTools: 1 })
        expect(decision.commands).toEqual([expect.objectContaining({ command: 'cat greet.txt', exitCode: 0 })])

        // The card waits; the message went to the agent as the user's.
        const card = (await appended(pi, 'pi-kit-autopilot-card')).entry.data as AutopilotCard
        expect(card).toMatchObject({ category: 'taste', title: '问候语', recommended: 'A', options: [{ id: 'A', label: 'hello' }, { id: 'B', label: '你好' }] })
        const done = await appended(pi, 'pi-kit-autopilot', pi.events.indexOf(first) + 1)
        expect((done.entry.data as AutopilotDecision).next).toBe('done')
        const agentRequests = llm.requests.filter(r => !isSupervisor(r))
        expect(told(agentRequests.at(-1)!)).toContain('提交吧，只提交你自己的文件。')

        // The supervisor was told the conversation, the reply and the diff, and could not edit.
        const sup = llm.requests.find(isSupervisor)!
        expect(told(sup)).toContain('写一个 greet.txt')
        expect(told(sup)).toContain('要我提交吗')
        expect(told(sup)).toContain('+hello')
        expect(toolNames(sup)).not.toContain('write')
        expect(toolNames(sup)).not.toContain('edit')
        // The agent worked unattended: instructions on, ask off.
        expect(agentRequests[0].system).toContain('Autopilot is on')
        expect(toolNames(agentRequests[0])).not.toContain('ask')

        // Answering the card tells the agent; the status counts what waits.
        await pi.waitFor(e => e.type === 'extension_ui_request' && e.statusKey === 'gui-autopilot' && pi.events.indexOf(e) > pi.events.indexOf(done) && JSON.parse(e.statusText).phase === 'waiting')
        expect(statuses(pi).at(-1)!.pending).toBe(1)
        const before = pi.events.length
        await pi.request({ type: 'prompt', message: `/gui-autopilot-answer ${card.id} ${JSON.stringify({ choice: 'B', text: '加个感叹号' })}` })
        await pi.waitFor(e => e.type === 'agent_settled' && pi.events.indexOf(e) >= before)
        expect(told(llm.requests.filter(r => !isSupervisor(r)).at(-1)!)).toContain('用户对「问候语」的决定：你好。加个感叹号')
        expect(statuses(pi).at(-1)!.pending).toBe(0)
    }, 90_000)

    it('holds a push for the user; allowing it lets the same kind through', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup([
            { toolCalls: [{ name: 'bash', arguments: { command: 'git push origin main' } }] },
            { text: '推送被拦下了，我先做别的。' },
            { toolCalls: [{ name: 'bash', arguments: { command: 'git push origin main' } }] },
            { text: '推了。' },
        ], [
            decide({ next: 'wait', reason: '等用户批准推送。' }),
            decide({ next: 'done', reason: '推过了。' }),
        ])
        await pi.request({ type: 'prompt', message: '/gui-autopilot on' })
        await pi.run('推上去')
        const card = (await appended(pi, 'pi-kit-autopilot-card')).entry.data as AutopilotCard
        expect(card).toMatchObject({ category: 'gate', gate: { key: 'git push', summary: 'git push origin main' } })
        const blocked = pi.events.find(e => e.type === 'tool_execution_end' && e.toolName === 'bash')
        expect(JSON.stringify(blocked)).toContain('Held for the user')
        const waiting = await appended(pi, 'pi-kit-autopilot')
        expect((waiting.entry.data as AutopilotDecision).next).toBe('wait')
        await pi.waitFor(() => statuses(pi).at(-1)?.phase === 'waiting')

        const before = pi.events.length
        await pi.request({ type: 'prompt', message: `/gui-autopilot-answer ${card.id} ${JSON.stringify({ choice: 'allow' })}` })
        await appended(pi, 'pi-kit-autopilot', before)
        expect(told(llm.requests.filter(r => !isSupervisor(r))[2])).toContain('用户批准了：git push origin main')
        const second = pi.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'bash').at(-1)
        expect(JSON.stringify(second)).not.toContain('Held for the user')
    }, 90_000)

    it('the user stepping in after a decision is a miss; off means nobody supervises', async ({ skip }) => {
        if (!env)
            return skip('pi not installed')
        const { llm, pi } = await setup([{ text: '好了' }, { text: '改了' }, { text: '嗯' }], [decide({ next: 'done', reason: 'ok' }), decide({ next: 'done', reason: 'ok' })])
        await pi.request({ type: 'prompt', message: '/gui-autopilot on' })
        await pi.run('做个东西')
        await appended(pi, 'pi-kit-autopilot')
        await pi.run('你的测试是纸糊的？')
        const file = path.join(pi.agentDir, 'autopilot', 'misses.jsonl')
        expect(existsSync(file)).toBe(true)
        const misses = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
        // Setting the goal was not a miss; stepping in after a decision is.
        expect(misses).toHaveLength(1)
        expect(misses[0]).toMatchObject({ text: '你的测试是纸糊的？', angry: true, reply: '好了', decision: { next: 'done' } })

        await pi.request({ type: 'prompt', message: '/gui-autopilot off' })
        const supervised = llm.requests.filter(isSupervisor).length
        await pi.run('再来')
        await new Promise(r => setTimeout(r, 500))
        expect(llm.requests.filter(isSupervisor).length).toBe(supervised)
        expect(statuses(pi).at(-1)!.phase).toBe('off')
    }, 90_000)
})
