// pi's editor commands in the app's pi (extensions/builtins.ts): the real pi over RPC, a mock model.
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

describe.runIf(process.env.PI_GUI_SKIP_E2E !== '1')('pi editor commands (real pi, mock model)', () => {
    it('are listed as commands, so the app never sends them to the model', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi, llm } = await twoTurns()
        const { data } = await pi.request<{ commands: { name: string, source: string }[] }>({ type: 'get_commands' })
        const names = data!.commands.filter(c => c.source === 'extension').map(c => c.name)
        expect(names).toEqual(expect.arrayContaining(['compact', 'name', 'model', 'thinking', 'tree', 'fork', 'clone', 'reload']))
        const requests = llm.requests.length
        await command(pi, '/name My thread')
        expect((await stateOf(pi)).sessionName).toBe('My thread')
        await command(pi, '/model mock/mock-1')
        await command(pi, '/thinking', [o => o === 'off'])
        expect(llm.requests.length).toBe(requests)
    })

    it('/tree goes back before a prompt on the same file, and the prompt comes back to the editor', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi } = await twoTurns()
        const file = (await stateOf(pi)).sessionFile
        const events = await command(pi, '/tree', [o => o.includes('提问：second'), o => o === '不总结'])
        expect(await userTexts(pi)).toEqual(['first'])
        expect(events.find(e => e.type === 'extension_ui_request' && e.method === 'set_editor_text')).toMatchObject({ text: 'second' })
        expect((await stateOf(pi)).sessionFile).toBe(file)
        await pi.run('other')
        expect(await userTexts(pi)).toEqual(['first', 'other'])
        // The abandoned branch is still in the tree, off the current one.
        await command(pi, '/tree', [o => o.includes('○ 提问：second'), o => o === '不总结'])
        expect(await userTexts(pi)).toEqual(['first'])
    })

    it('/fork and /clone move to a new session file', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi } = await twoTurns()
        const file = (await stateOf(pi)).sessionFile
        const events = await command(pi, '/fork', [o => o.endsWith('second')])
        const forked = (await stateOf(pi)).sessionFile
        expect(forked).not.toBe(file)
        expect(await userTexts(pi)).toEqual(['first'])
        expect(events.find(e => e.type === 'extension_ui_request' && e.method === 'set_editor_text')).toMatchObject({ text: 'second' })
        await command(pi, '/clone')
        expect((await stateOf(pi)).sessionFile).not.toBe(forked)
        expect(await userTexts(pi)).toEqual(['first'])
    })

    it('/compact passes its instructions to the summary', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi, llm } = await twoTurns({ compaction: { keepRecentTokens: 1 } })
        const events = await command(pi, '/compact keep the colour')
        expect(events.find(e => e.type === 'compaction_end')).toMatchObject({ aborted: false })
        expect(llm.requests.some(r => JSON.stringify(r.messages).includes('keep the colour'))).toBe(true)
        const { data } = await pi.request<{ messages: any[] }>({ type: 'get_messages' })
        expect(data!.messages.some(m => m.role === 'compactionSummary')).toBe(true)
    })

    it('/gui-rewind (the app\'s ask again) still goes back without asking', async ({ skip }) => {
        if (!env)
            return skip()
        const { pi } = await twoTurns()
        const { data: entries } = await pi.request<{ entries: any[] }>({ type: 'get_entries' })
        const second = entries!.entries.find(e => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message.content).includes('second'))
        await command(pi, `/gui-rewind ${second.id}`)
        expect(await userTexts(pi)).toEqual(['first'])
    })
})
