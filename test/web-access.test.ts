// Web access end to end: `pi install npm:pi-web-access` by the user's pi, then the app's pi (rpc, as
// the app starts it) offers the package's tools, and none once it is turned off. Downloads the
// package, so it runs only when asked:
//   PI_GUI_NETWORK_E2E=1 bunx vitest run test/web-access.test.ts
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { AgentManager } from '../electron/agents'
import { resolvePiEnv } from '../electron/pi-env'
import { installPackage } from '../electron/piPackages'
import { piSettingsState, setWebAccess } from '../electron/piSettings'
import { EXTENSIONS_DIR, startMockLlm } from './harness'

describe.runIf(process.env.PI_GUI_NETWORK_E2E === '1')('web access (network)', () => {
    it('installs with the user\'s pi; the app\'s pi gets the tools, and loses them when off', async () => {
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-web-'))
        const agentDir = path.join(tmp, 'agent')
        const llm = await startMockLlm(() => ({ text: 'ok' }))
        const previous = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = agentDir
        try {
            const env = await resolvePiEnv()
            if (!env.ok)
                throw new Error(env.error)

            await installPackage()
            expect((await piSettingsState()).webAccess).toEqual({ installed: true, enabled: true })
            expect(existsSync(path.join(agentDir, 'npm/node_modules/pi-web-access/package.json'))).toBe(true)

            await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } } }))
            const settings = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'))
            await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ ...settings, defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
            const tools = async () => {
                let settled!: () => void
                const done = new Promise<void>(resolve => settled = resolve)
                const manager = new AgentManager({ onEvent: (_id, e) => e.type === 'agent_settled' && settled(), onExit: () => {} }, EXTENSIONS_DIR, () => ({}))
                const before = llm.requests.length
                const id = manager.start(env.env, { cwd: tmp, capabilities: [] })
                const response = await manager.request(id, { type: 'prompt', message: 'hi' })
                if (!response.success)
                    throw new Error(response.error)
                await done
                await manager.stopAll()
                return llm.requests[before].tools.map((t: any) => t.function?.name ?? t.name) as string[]
            }
            expect(await tools()).toContain('web_search')
            await setWebAccess(false)
            expect((await piSettingsState()).webAccess).toEqual({ installed: true, enabled: false })
            expect((await tools()).filter(t => t.startsWith('web_'))).toEqual([])
        }
        finally {
            process.env.PI_CODING_AGENT_DIR = previous
            await llm.close()
            await rm(tmp, { recursive: true, force: true })
        }
    }, 300_000)
})
