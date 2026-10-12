// Web access end to end: `pi install npm:pi-web-access` by the pi shipped in the app with the npm it
// ships, then the app's pi (rpc, as the app starts it) offers the package's tools, and none once it
// is turned off. Downloads the package, so it runs only when asked:
//   env -i HOME=/tmp/empty-home PATH=/usr/bin:/bin PI_GUI_NETWORK_E2E=1 $(which node) node_modules/vitest/vitest.mjs run test/web-access.test.ts
// (an empty HOME and that PATH are a Mac without Node.js).
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { setAppNode } from '../electron/acp/node'
import { AgentManager } from '../electron/agents'
import { resolvePiEnv, setBundledPi } from '../electron/pi-env'
import { installPackage } from '../electron/piPackages'
import { piSettingsState, setWebAccess } from '../electron/piSettings'
import { EXTENSIONS_DIR, startMockLlm } from './harness'

describe.runIf(process.env.PI_GUI_NETWORK_E2E === '1')('web access (network)', () => {
    it('installs with the shipped pi and npm; the app\'s pi gets the tools, and loses them when off', async () => {
        const root = path.resolve(import.meta.dirname, '..')
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-web-'))
        const agentDir = path.join(tmp, 'agent')
        const llm = await startMockLlm(() => ({ text: 'ok' }))
        const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, pi: process.env.PI_GUI_PI }
        process.env.PI_CODING_AGENT_DIR = agentDir
        process.env.PI_GUI_PI = 'bundled'
        try {
            const electron = createRequire(import.meta.url)('electron') as unknown as string
            setBundledPi({ cli: path.join(root, 'bundled-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), launcher: path.join(root, 'electron/piLauncher.mjs'), runtime: electron })
            setAppNode({ dir: path.join(tmp, 'node'), electron, npm: path.join(root, 'bundled-pi/node_modules/npm') })
            const env = await resolvePiEnv()
            if (!env.ok || !env.env.bundled)
                throw new Error('the shipped pi did not start (run scripts/bundle-pi.sh)')

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
            process.env.PI_CODING_AGENT_DIR = previous.agentDir
            if (previous.pi === undefined)
                delete process.env.PI_GUI_PI
            else
                process.env.PI_GUI_PI = previous.pi
            await llm.close()
            await rm(tmp, { recursive: true, force: true })
        }
    }, 300_000)
})
