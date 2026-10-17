// The commands the app's own controls call in its pi (extensions/builtins.ts): the real pi over RPC, a mock model.
import type { PiEnv } from '@shared/ipc'
import type { MockLlm, PiSession } from './harness'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPi, startMockLlm, startPi } from './harness'

let env: PiEnv | null = null
beforeAll(async () => {
    env = await findPi()
}, 30_000)

const open: { llm: MockLlm, pi: PiSession }[] = []
afterEach(async () => {
    for (const { llm, pi } of open.splice(0)) {
        await pi.stop()
        await llm.close()
    }
})

/** pi with two answered prompts, "first" and "second". */
async function twoTurns(settings?: Record<string, unknown>) {
    const llm = await startMockLlm(r => ({ text: `answer ${r.messages.length}` }))
    const pi = await startPi(env!, llm, [], { settings })
    open.push({ llm, pi })
    await pi.run('first')
    await pi.run('second')
    return { llm, pi }
}

/** Runs a command; `answers` pick an option of each select it asks, in order. Resolves with its response. */
async function command(pi: PiSession, message: string, answers: ((option: string) => boolean)[] = []) {
    const before = pi.events.length
    const response = pi.request<{ disposition: string }>({ type: 'prompt', message })
    for (const [i, choose] of answers.entries()) {
        const ask: any = await pi.waitFor(e => e.type === 'extension_ui_request' && e.method === 'select' && pi.events.indexOf(e) >= before
            && pi.events.filter(x => x.type === 'extension_ui_request' && x.method === 'select' && pi.events.indexOf(x) >= before).indexOf(e) === i)
        pi.send({ type: 'extension_ui_response', id: ask.id, value: ask.options.find(choose) })
    }
    const result = await response
    expect(result.data?.disposition).toBe('handled')
    return pi.events.slice(before)
}

const userTexts = async (pi: PiSession) => {
    const { data } = await pi.request<{ messages: any[] }>({ type: 'get_messages' })
    return data!.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.map((p: any) => p.text).join(''))
}
const stateOf = async (pi: PiSession) => (await pi.request<any>({ type: 'get_state' })).data

const entriesOf = async (pi: PiSession) => (await pi.request<{ entries: any[] }>({ type: 'get_entries' })).data!.entries
const idOf = (entries: any[], role: string, text: string) => entries.find(e => e.type === 'message' && e.message.role === role && JSON.stringify(e.message.content).includes(text)).id

describe.runIf(process.env.PI_GUI_SKIP_E2E !== '1')('the app\'s session commands (real pi, mock model)', () => {
    it('serves only the gui- commands: pi\'s editor commands have controls in the app and are not extension commands', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi, llm } = await twoTurns()
        const { data } = await pi.request<{ commands: { name: string, source: string }[] }>({ type: 'get_commands' })
        const names = data!.commands.filter(c => c.source === 'extension').map(c => c.name)
        expect(names).toEqual(expect.arrayContaining(['gui-rewind', 'gui-rewind-to', 'gui-clone', 'gui-reload']))
        for (const gone of ['compact', 'name', 'model', 'thinking', 'tree', 'fork', 'clone', 'reload'])
            expect(names).not.toContain(gone)
        // So what is typed is text for the model, as for any agent.
        const requests = llm.requests.length
        await pi.run('/tree')
        expect(llm.requests.length).toBe(requests + 1)
        expect(await userTexts(pi)).toContain('/tree')
    })

    it('/gui-rewind goes back before a prompt on the same file, and keeps the abandoned branch', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi } = await twoTurns()
        const file = (await stateOf(pi)).sessionFile
        await command(pi, `/gui-rewind ${idOf(await entriesOf(pi), 'user', 'second')}`)
        expect(await userTexts(pi)).toEqual(['first'])
        expect((await stateOf(pi)).sessionFile).toBe(file)
        await pi.run('other')
        expect(await userTexts(pi)).toEqual(['first', 'other'])
        expect(JSON.stringify(await entriesOf(pi))).toContain('second')
    })

    it('/gui-rewind-to stands on an answer; with summarize it writes a summary of the branch left', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi } = await twoTurns()
        const entries = await entriesOf(pi)
        const firstAnswer = entries.find(e => e.type === 'message' && e.message.role === 'assistant').id
        await command(pi, `/gui-rewind-to ${firstAnswer}`)
        expect(await userTexts(pi)).toEqual(['first'])
        expect(JSON.stringify(await entriesOf(pi))).not.toContain('branch_summary')
        // Back out to the end, then again with a summary.
        const { pi: other } = await twoTurns()
        const answer = (await entriesOf(other)).find(e => e.type === 'message' && e.message.role === 'assistant').id
        await command(other, `/gui-rewind-to ${answer} summarize`)
        expect((await entriesOf(other)).some(e => e.type === 'branch_summary')).toBe(true)
        // Not an answer: refused, nothing moves.
        const user = idOf(await entriesOf(other), 'user', 'first')
        const before = await userTexts(other)
        await command(other, `/gui-rewind-to ${user}`)
        expect(await userTexts(other)).toEqual(before)
    })

    it('/gui-clone moves to a new session file with the same branch', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi } = await twoTurns()
        const file = (await stateOf(pi)).sessionFile
        await command(pi, '/gui-clone')
        expect((await stateOf(pi)).sessionFile).not.toBe(file)
        expect(await userTexts(pi)).toEqual(['first', 'second'])
    })

    it('the compact request passes its instructions to the summary', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi, llm } = await twoTurns({ compaction: { keepRecentTokens: 1 } })
        const before = pi.events.length
        await pi.request({ type: 'compact', customInstructions: 'keep the colour' })
        expect(pi.events.slice(before).find(e => e.type === 'compaction_end')).toMatchObject({ aborted: false })
        expect(llm.requests.some(r => JSON.stringify(r.messages).includes('keep the colour'))).toBe(true)
        const { data } = await pi.request<{ messages: any[] }>({ type: 'get_messages' })
        expect(data!.messages.some(m => m.role === 'compactionSummary')).toBe(true)
    })
})
