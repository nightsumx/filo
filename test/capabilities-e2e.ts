// End-to-end check that the capability choice lives in pi's settings.json, in the built app with real
// pi, an empty agent dir and a scripted model:
//   - an older state.json's choice moves into settings.json at startup
//   - the thread's pi loads that set; a change written by someone else (pi in a terminal) reaches the
//     app and restarts the idle thread with the new set
//   - Settings → Capabilities writes settings.json, says it is shared, marks Terminals as Filo only
//   - Web access installs with `pi install` from the page (a new thread gets its tools), then turns
//     off (PI_GUI_NETWORK_E2E=1)
//
//   bun run build && bun --tsconfig-override=tsconfig.node.json test/capabilities-e2e.ts
//   SHOTS=<dir> also saves screenshots, dark and light.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-capabilities')
const SHOTS = process.env.SHOTS ?? ''
const NETWORK = process.env.PI_GUI_NETWORK_E2E === '1'

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

    const llm = await startMockLlm(() => ({ text: 'ok' }))
    const settingsFile = path.join(agentDir, 'settings.json')
    const settings = async () => JSON.parse(await readFile(settingsFile, 'utf8'))
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(settingsFile, JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
    // An older build's choice, kept in the app's own state.
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [repo],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: ['todo', 'ask'],
        approvalMode: 'edits',
        windows: [{ projects: [repo] }],
    }))
    const env: Record<string, string> = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }
    for (const key of Object.keys(process.env)) {
        if (key.endsWith('_API_KEY') || key.endsWith('_TOKEN') || key.startsWith('AWS_'))
            env[key] = ''
    }

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = (code: string) => page.evaluate<any>(code)
        const clickButton = (text: string, scope = 'document') => js(`(() => { const b = [...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
        const toolsOfLast = () => llm.requests.at(-1)!.tools.map((t: any) => t.function?.name ?? t.name) as string[]
        const prompt = async (text: string) => {
            const before = llm.requests.length
            await js(`(() => { const t = window.__app.active; t.draft = ${JSON.stringify(text)}; void t.send(); return true })()`)
            await until(`request for "${text}"`, async () => llm.requests.length > before && await js(`!window.__app.active.running`), 30_000)
        }

        // ---------------------------------------------------------------- migration
        check((await settings())['pi-capabilities']?.approvalMode === 'edits', 'the old approval mode moved into settings.json')
        check(JSON.stringify((await settings())['pi-capabilities']?.enabled) === '["todo","ask"]', 'the old capability list moved into settings.json')
        check((await settings()).defaultModel === 'mock-1', 'pi\'s own settings are kept')
        await until('thread ready', () => js(`window.__app.active?.agentStatus === 'ready'`), 30_000)
        check(JSON.stringify(await js('window.__app.enabledCapabilities')) === '["todo","ask"]', 'the app shows the moved choice')
        await prompt('one')
        check(toolsOfLast().includes('ask') && !toolsOfLast().includes('terminal_run'), 'the thread\'s pi loads that set')

        // ---------------------------------------------------------------- written elsewhere
        const agentBefore = await js('window.__app.active.agentId')
        await writeFile(settingsFile, JSON.stringify({ ...await settings(), 'pi-capabilities': { enabled: 'standard', approvalMode: 'ask' } }, null, 2))
        await until('the app follows the file', () => js(`window.__app.capabilityPreset === 'standard' && window.__app.approvalMode === 'ask'`), 10_000)
        check(true, 'a change from pi in a terminal reaches the app')
        await until('thread restarted', () => js(`window.__app.active.agentStatus === 'ready' && window.__app.active.agentId !== ${JSON.stringify(agentBefore)}`), 30_000)
        await prompt('two')
        check(toolsOfLast().includes('terminal_run'), 'the idle thread restarted with the new set')

        // ---------------------------------------------------------------- Settings → Capabilities
        await js(`(() => { window.__app.setSettingsPage('capabilities'); window.__app.setSettingsOpen(true); return true })()`)
        const dialog = `document.querySelector('[role="dialog"]')`
        await until('capabilities page', () => js(`!!${dialog}?.textContent.includes('with pi in a terminal')`), 10_000)
        check(await js(`${dialog}.textContent.includes('Filo only')`), 'Terminals is marked Filo only')
        const presets = `[...${dialog}.querySelectorAll('[role="radiogroup"]')][0]`
        check(await clickButton('Lean', presets), 'Lean can be picked')
        await until('lean saved', async () => (await settings())['pi-capabilities']?.enabled === 'lean', 5_000)
        check((await settings())['pi-capabilities'].approvalMode === 'ask', 'the page writes only what changed')
        check(await clickButton('Full', presets), 'Full can be picked')
        await until('full saved', async () => (await settings())['pi-capabilities']?.enabled === 'full', 5_000)
        check(await js(`!!${dialog}.textContent.includes('pi-web-access')`), 'web access is offered')
        check(await js(`[...${dialog}.querySelectorAll('button')].some(b => b.textContent.trim() === 'Install')`), 'not installed: an Install button, nothing runs by itself')
        if (SHOTS) {
            await js(`${dialog}.querySelector('section')?.lastElementChild?.scrollIntoView({ block: 'end' })`)
            await page.screenshot(path.join(SHOTS, 'capabilities-dark.png'))
        }

        /** Waits for the active thread's pi to run what the settings now say, ready for a prompt. */
        const current = (what: string) =>
            until(what, () => js(`(() => { const t = window.__app.active; return t.agentStatus === 'ready' && !t.running && t.loadedConfig === t.configKey() })()`), 30_000)

        if (NETWORK) {
            await current('thread on the full set')
            check(await clickButton('Install'), 'Install starts pi install')
            await until('installing', () => js(`window.__app.webAccess.installing || window.__app.webAccess.installed`), 5_000)
            await until('installed', () => js(`window.__app.webAccess.installed && !window.__app.webAccess.installing`), 180_000)
            check((await settings()).packages?.includes('npm:pi-web-access@0.37.0'), 'pi install listed it in settings.json')
            await current('thread restarted after the install')
            // pi-web-access keeps an existing session's tools as they were (its prompt cache): a new
            // thread has them.
            await js(`(() => { window.__app.newThread(${JSON.stringify(repo)}); return true })()`)
            await current('new thread ready')
            await prompt('three')
            check(toolsOfLast().includes('web_search'), 'a new thread has web access')
            const webSwitch = `[...${dialog}.querySelectorAll('[role="switch"]')].at(-1)`
            check(await js(`${webSwitch}.getAttribute('aria-checked')`) === 'true', 'installed: a switch, on')
            await js(`${webSwitch}.click()`)
            await until('web off saved', async () => JSON.stringify((await settings()).packages) === '[{"source":"npm:pi-web-access@0.37.0","extensions":[]}]', 5_000)
            await current('thread restarted after turning it off')
            await prompt('four')
            check(!toolsOfLast().some(t => t.startsWith('web_')), 'off: the thread restarted without its tools')
            check(await js(`[...${dialog}.querySelectorAll('[role="switch"]')].at(-1).getAttribute('aria-checked')`) === 'false', 'the switch shows off')
        }

        if (SHOTS) {
            await js(`window.__app.setTheme('light')`)
            await until('light theme', () => js(`!document.documentElement.classList.contains('dark')`), 5_000)
            await page.screenshot(path.join(SHOTS, 'capabilities-light.png'))
        }
    }
    finally {
        await stop()
        await llm.close()
    }
    await rm(WORK, { recursive: true, force: true })
    console.log('capabilities e2e passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
