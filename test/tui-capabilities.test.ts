// pi-cc-tui follows the capability choice in pi's settings.json, the one the desktop app writes:
// a real terminal pi in tmux (with the mock model) loads only what is on, /capabilities changes it
// and reloads, and a mode chosen in the terminal is saved for the next session.
import type { MockLlm } from './harness'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCapabilities } from '../packages/capabilities/lib/catalog'
import { capabilityMenu } from '../packages/pi-cc-tui/extensions/cc-capabilities'
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

const EXTENSIONS = ['cc-capabilities.ts', 'capabilities/todo.ts', 'capabilities/ask.ts', 'capabilities/approval.ts', 'capabilities/plan.ts']

async function startTerminal(llm: MockLlm, choice?: object) {
    const root = await mkdtemp(path.join('/tmp', 'pic-'))
    const agentDir = path.join(root, 'agent')
    const cwd = path.join(root, 'project')
    await mkdir(agentDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    const settings = path.join(agentDir, 'settings.json')
    await writeFile(settings, JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off', ...choice && { 'pi-capabilities': choice } }))
    const terminal = await startTerminalPi({ agentDir, cwd, extensions: EXTENSIONS })
    cleanup.push(async () => {
        await terminal.kill()
        await rm(root, { recursive: true, force: true })
    })
    const saved = async () => JSON.parse(await readFile(settings, 'utf8'))
    return { ...terminal, saved }
}

const toolNames = (llm: MockLlm, index: number) => llm.requests[index].tools.map((t: any) => t.function?.name ?? t.name)

/** Sends a prompt and waits for the model to have been asked `count` times. */
async function prompt(terminal: { type: (text: string) => Promise<void> }, llm: MockLlm, count: number) {
    await terminal.type('hi')
    await until(() => llm.requests.length >= count, `request ${count}`)
}

describe.runIf(hasTmux)('pi-cc-tui capabilities (real terminal pi, mock model)', () => {
    it('loads only what settings.json has on; /capabilities saves a preset and reloads', async () => {
        const llm = await startMockLlm(() => ({ text: 'ok' }))
        cleanup.push(() => llm.close())
        const terminal = await startTerminal(llm, { enabled: ['todo'] })
        await until(async () => (await terminal.pane()).includes('mock-1'), 'pi started')
        await prompt(terminal, llm, 1)
        expect(toolNames(llm, 0)).toContain('todo')
        expect(toolNames(llm, 0)).not.toContain('ask')

        await terminal.type('/capabilities')
        const menu = await until(async () => {
            const pane = await terminal.pane()
            return pane.includes('shared with Filo') && pane
        }, 'menu')
        expect(menu).toContain('[x] Todo list')
        expect(menu).toContain('[ ] Ask you')
        expect(menu).not.toContain('Terminals')
        // The third row is Full; the menu reopens at the top, and Save is its last row (after Full's spending limit).
        await terminal.keys('Down', 'Down', 'Enter')
        await until(async () => (await terminal.pane()).includes('Full  ✔'), 'full picked')
        await terminal.keys(...Array.from({ length: capabilityMenu(resolveCapabilities('full').ids, 5).length - 1 }, () => 'Down'), 'Enter')
        await until(async () => (await terminal.saved())['pi-capabilities']?.enabled === 'full', 'saved')
        expect((await terminal.saved()).defaultModel).toBe('mock-1')

        // Reloaded: the next request has the full set.
        await sleep(1000)
        await prompt(terminal, llm, 2)
        expect(toolNames(llm, 1)).toEqual(expect.arrayContaining(['todo', 'ask']))
    }, 60_000)

    it('a mode chosen in the terminal is saved for the next session, keeping the capabilities', async () => {
        const llm = await startMockLlm(() => ({ text: 'ok' }))
        cleanup.push(() => llm.close())
        const terminal = await startTerminal(llm, { enabled: 'standard', approvalMode: 'ask' })
        await until(async () => (await terminal.pane()).includes('mock-1'), 'pi started')
        await terminal.type('/gui-approval edits')
        await until(async () => (await terminal.saved())['pi-capabilities']?.approvalMode === 'edits', 'mode saved')
        expect((await terminal.saved())['pi-capabilities']).toEqual({ enabled: 'standard', approvalMode: 'edits' })
    }, 60_000)
})
