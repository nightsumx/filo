import type { Presence } from '@shared/capabilities'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import presenceExtension from '../packages/pi-cc-tui/extensions/cc-presence'
import { PresenceWatcher, readPresence, SWEEP_MS } from './presence'

let dir: string
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pi-presence-'))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

/** A pid that is certainly gone: a child that already exited. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise(resolve => child.on('exit', resolve))
    return child.pid!
}

const entry = (pid: number, state: Presence['state'] = 'idle'): Presence => ({ pid, cwd: '/repo', session: '/s/a.jsonl', state, since: 1 })

describe('readPresence', () => {
    it('keeps live processes and deletes the files of dead or garbled ones', async () => {
        const dead = await deadPid()
        await writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify(entry(process.pid, 'running')))
        await writeFile(path.join(dir, `${dead}.json`), JSON.stringify(entry(dead)))
        await writeFile(path.join(dir, 'notes.txt'), 'not ours')
        expect(await readPresence(dir)).toEqual([entry(process.pid, 'running')])
        expect((await readdir(dir)).sort()).toEqual([`${process.pid}.json`, 'notes.txt'])
    })

    it('a garbled file is deleted only once its process is gone (a live one may be mid-write)', async () => {
        const dead = await deadPid()
        await writeFile(path.join(dir, `${dead}.json`), '{"half')
        await writeFile(path.join(dir, `${process.pid}.json`), '')
        expect(await readPresence(dir)).toEqual([])
        expect(await readdir(dir)).toEqual([`${process.pid}.json`])
    })

    it('a missing dir is no sessions', async () => {
        expect(await readPresence(path.join(dir, 'nope'))).toEqual([])
    })
})

describe('PresenceWatcher', () => {
    it('reports when a file appears, changes and goes away', async () => {
        const seen: Presence[][] = []
        const watcher = new PresenceWatcher(dir, list => seen.push(list))
        await watcher.start()
        const file = path.join(dir, `${process.pid}.json`)
        // fs.watch is the fast path, the sweep the guarantee: in loaded full test runs a rewrite was
        // sometimes not seen within 3s, so allow up to one sweep.
        const until = async (check: () => boolean) => {
            const end = Date.now() + SWEEP_MS + 2000
            while (!check() && Date.now() < end)
                await new Promise(r => setTimeout(r, 20))
            expect(check()).toBe(true)
        }
        try {
            await writeFile(file, JSON.stringify(entry(process.pid)))
            await until(() => seen.at(-1)?.[0]?.state === 'idle')
            await writeFile(file, JSON.stringify(entry(process.pid, 'waiting')))
            await until(() => seen.at(-1)?.[0]?.state === 'waiting')
            await rm(file)
            await until(() => seen.at(-1)?.length === 0)
        }
        finally {
            watcher.stop()
        }
    }, 3 * (SWEEP_MS + 2000))
})

describe('cc-presence extension', () => {
    const env = { ...process.env }
    afterEach(() => {
        process.env = { ...env }
    })

    /** Loads the extension against a fake pi and returns its handlers. */
    function load() {
        const handlers = new Map<string, (event: any, ctx?: any) => void>()
        presenceExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any)
        const fire = (name: string, event: any = {}, ctx?: any) => handlers.get(name)?.(event, ctx)
        return { handlers, fire }
    }
    const ctx = (mode: string) => ({ mode, cwd: '/repo', sessionManager: { getSessionFile: () => '/s/a.jsonl' } })
    const read = async () => JSON.parse(await readFile(path.join(dir, 'pi-kit-presence', `${process.pid}.json`), 'utf8')) as Presence

    it('writes idle, running, waiting (ask), and removes the file on shutdown', async () => {
        process.env.PI_CODING_AGENT_DIR = dir
        delete process.env.PI_KIT_HOST
        delete process.env.PI_KIT_SUBAGENT
        const { fire } = load()
        fire('session_start', {}, ctx('tui'))
        expect(await read()).toMatchObject({ pid: process.pid, cwd: '/repo', session: '/s/a.jsonl', state: 'idle' })
        fire('agent_start')
        expect((await read()).state).toBe('running')
        fire('tool_execution_start', { toolCallId: 'c1', toolName: 'ask' })
        expect((await read()).state).toBe('waiting')
        fire('tool_execution_end', { toolCallId: 'c1', toolName: 'ask' })
        expect((await read()).state).toBe('running')
        fire('agent_settled')
        expect((await read()).state).toBe('idle')
        fire('session_shutdown')
        expect(await readdir(path.join(dir, 'pi-kit-presence'))).toEqual([])
    })

    it('stays off in the desktop app, in subagents and outside the TUI', async () => {
        process.env.PI_CODING_AGENT_DIR = dir
        process.env.PI_KIT_HOST = 'gui'
        expect(load().handlers.size).toBe(0)
        delete process.env.PI_KIT_HOST
        process.env.PI_KIT_SUBAGENT = '1'
        expect(load().handlers.size).toBe(0)
        delete process.env.PI_KIT_SUBAGENT
        load().fire('session_start', {}, ctx('rpc'))
        expect(await readdir(dir)).toEqual([])
    })
})
