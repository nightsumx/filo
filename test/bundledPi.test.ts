// The pi the app ships, for users without one: the pi devDependency run on the electron package's
// binary as node, as the packaged app runs Resources/pi (electron/pi-env.ts, electron/piLauncher.mjs).
import type { SubagentDetails } from '@shared/capabilities'
import type { MockReply, MockRequest } from './harness'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { resetPiEnv, resolvePiEnv } from '../electron/pi-env'
import { findPi, startMockLlm, startPi } from './harness'

const saved = { pi: process.env.PI_GUI_PI, node: process.env.PI_GUI_NODE }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
    for (const fn of cleanup.splice(0))
        await fn()
    process.env.PI_GUI_PI = saved.pi
    process.env.PI_GUI_NODE = saved.node
    if (saved.pi === undefined)
        delete process.env.PI_GUI_PI
    if (saved.node === undefined)
        delete process.env.PI_GUI_NODE
    resetPiEnv()
})

const toolNames = (r: MockRequest) => r.tools.map((t: any) => t.function?.name ?? t.name)
// Prints the variable Electron needs to act as node, as seen by a command pi runs.
const PROBE = 'echo "flag=[${ELECTRON_RUN_AS_NODE:-}]"'

describe.runIf(process.env.PI_GUI_SKIP_E2E !== '1')('bundled pi', () => {
    it('runs on Electron, keeps its flag from pi\'s commands, and starts subagents', async () => {
        process.env.PI_GUI_PI = 'bundled'
        const env = await findPi()
        expect(env?.bundled).toBeTruthy()
        expect(env?.nodePath).toMatch(/Electron$/)
        expect(env?.version).toMatch(/^\d+\.\d+\.\d+/)

        // The parent runs the probe, then delegates; the child runs it too.
        let child = 0
        const llm = await startMockLlm((r: MockRequest, i: number): MockReply => {
            if (!toolNames(r).includes('subagent'))
                return child++ === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: PROBE } }] } : { text: 'child result' }
            if (i === 0)
                return { toolCalls: [{ name: 'bash', arguments: { command: PROBE } }] }
            if (r.toolResults.length === 1 && !r.toolResults[0].includes('child result') && !JSON.stringify(r.messages).includes('"subagent"'))
                return { toolCalls: [{ name: 'subagent', arguments: { title: 'Probe', task: 'CHILD TASK' } }] }
            return { text: 'parent done' }
        })
        cleanup.push(() => llm.close())
        const pi = await startPi(env!, llm, ['subagent'])
        cleanup.push(() => pi.stop())
        await pi.run('go')

        const ends: any[] = pi.events.filter(e => e.type === 'tool_execution_end')
        const bash = ends.find(e => e.toolName === 'bash')
        expect(JSON.stringify(bash.result)).toContain('flag=[]')
        const sub = ends.find(e => e.toolName === 'subagent')
        expect(sub?.isError).toBe(false)
        const details = sub.result.details as SubagentDetails
        expect(details.status).toBe('done')
        expect(JSON.stringify(details.messages)).toContain('flag=[]')
    }, 60_000)

    it('the user\'s own pi wins; one that fails to start falls back with a note', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-bundled-'))
        cleanup.push(() => rm(dir, { recursive: true, force: true }))
        const broken = path.join(dir, 'pi.mjs')
        await writeFile(broken, 'process.stderr.write("boom\\n"); process.exit(1)\n')
        process.env.PI_GUI_PI = broken
        process.env.PI_GUI_NODE = process.execPath
        const fallback = await findPi()
        expect(fallback?.bundled).toBeTruthy()
        expect(fallback?.note).toContain('boom')

        // A working one is used as it is.
        const working = path.join(dir, 'ok.mjs')
        await writeFile(working, 'console.log("9.9.9")\n')
        process.env.PI_GUI_PI = working
        resetPiEnv()
        const result = await resolvePiEnv()
        expect(result).toMatchObject({ ok: true, env: { piPath: working, version: '9.9.9' } })
        expect(result.ok && result.env.bundled).toBeFalsy()
    }, 60_000)
})
