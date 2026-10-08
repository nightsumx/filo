// The terminal capability in the built app, with real pi, a scripted model and real shells:
//   - the agent starts a "dev server" with terminal_run; it runs in the app's Terminal panel as a
//     tab of the project, marked as the agent's, and the tool returns once it is ready
//   - its transcript row has "Show terminal", which opens the panel on that terminal
//   - terminal_read lists the user's own shell too, and reads what it printed
//   - the project folder is given as /tmp/…; pi reports /private/tmp/…, and the terminal still
//     lands under the project the window shows
//
//   bun run build && bun run e2e:shell-agent        (SHOTS=<dir> saves screenshots)
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

// Unresolved on purpose: /tmp is a symlink to /private/tmp. Windows has no /tmp.
const WORK = process.platform === 'win32' ? workDir('pi-gui-shell-agent') : '/tmp/pi-gui-shell-agent'
const SHOTS = process.env.SHOTS ?? ''

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const project = path.join(WORK, 'project')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([project, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    let userShell = ''
    const llm = await startMockLlm((request) => {
        const n = request.toolResults.length
        if (n === 0)
            return { toolCalls: [{ name: 'terminal_run', arguments: { command: 'echo compiling; sleep 1; echo "Local: http://localhost:5199/"; sleep 600', label: 'web dev', wait_for: 'Local:', timeout: 20 } }] }
        if (n === 1)
            return { toolCalls: [{ name: 'terminal_read', arguments: {} }] }
        if (n === 2)
            return { toolCalls: [{ name: 'terminal_read', arguments: { id: userShell, lines: 20 } }] }
        return { text: 'The dev server is up on 5199.' }
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [project],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: process.env.E2E_THEME ?? 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: ['terminal'],
        windows: [{ projects: [project] }],
    }))

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const [{ page }] = await windows(1)
        const shot = async (name: string) => {
            if (!SHOTS)
                return
            // At the window's own scale (see shell-e2e.ts).
            await new Promise(r => setTimeout(r, 300))
            const { data } = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'png' })
            await writeFile(path.join(SHOTS, name), Buffer.from(data, 'base64'))
        }
        await until('project shown', () => page.evaluate<boolean>('window.__app.activeProject !== null'))
        const screen = (tid: string) => page.evaluate<string>(`(() => { const t = window.__terminalView(${JSON.stringify(tid)})?.term; if (!t) return ''; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s })()`)

        // The user's own shell, with something on its screen for the agent to read.
        await page.evaluate(`window.__terminals.create(${JSON.stringify(project)})`)
        userShell = await until('user shell', () => page.evaluate<string | undefined>('window.__terminals.list.find(t => t.by === "user")?.id'))
        // To stderr; PowerShell (Windows) has its own way to write there.
        const toStderr = process.platform === 'win32' ? '[Console]::Error.WriteLine("TypeError: x is undefined")' : 'echo "TypeError: x is undefined" >&2'
        await page.evaluate(`window.pi.terminalWrite(${JSON.stringify(userShell)}, ${JSON.stringify(`${toStderr}\r`)})`)
        await until('user shell output', async () => (await screen(userShell)).includes('TypeError: x is undefined\n'))
        await page.evaluate('window.__terminals.hide()')

        await page.evaluate(`(() => { const t = window.__app.active; t.draft = 'start the dev server'; void t.send(); return true })()`)
        await until('agent finished', () => page.evaluate<boolean>(`document.body.innerText.includes('The dev server is up on 5199.')`), 40_000)

        const agent = JSON.parse(await page.evaluate<string>('JSON.stringify(window.__terminals.list.find(t => t.by === "agent") ?? null)'))
        check(!!agent && agent.cwd === project, `the agent's server runs in a terminal of the project as the window has it (${agent?.cwd})`)
        check(agent?.title === 'web dev' || agent?.command?.includes('5199'), 'the terminal is named after what it runs')
        const toolTexts = llm.requests.at(-1)!.toolResults
        check(toolTexts[0].includes('"Local:" appeared') && toolTexts[0].includes('compiling'), 'terminal_run returned once the server printed it was ready, with its output')
        check(toolTexts[1].includes(agent.id) && toolTexts[1].includes(userShell) && toolTexts[1].includes('opened by the user'), 'terminal_read lists the agent\'s and the user\'s terminals')
        check(toolTexts[2].includes('TypeError: x is undefined'), 'terminal_read reads what the user\'s shell printed')

        // The finished turn folds its tools; unfolded, the rows about a terminal can open it.
        check(await page.evaluate<boolean>(`document.body.innerText.includes('Ran 1 command')`), 'the folded turn counts the server start as a command')
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('Ran 1 command')).click()`)
        await until('tools unfolded', () => page.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Show terminal')`))
        await shot('shell-agent-transcript.png')
        // The row's button opens the panel on the agent's terminal.
        const button = `[...document.querySelectorAll('button')].find(b => b.textContent === 'Show terminal')`
        check(await page.evaluate<number>(`[...document.querySelectorAll('button')].filter(b => b.textContent === 'Show terminal').length`) >= 2, 'tool rows about a terminal offer "Show terminal"')
        await page.evaluate(`${button}.click()`)
        await until('panel on the agent terminal', () => page.evaluate<boolean>(`!!document.querySelector("section[aria-label=Terminal] .xterm") && window.__terminals.tabs.find(t => t.id === ${JSON.stringify(agent.id)}) && window.__terminals.active?.id === ${JSON.stringify(agent.id)}`))
        await until('server output on screen', async () => (await screen(agent.id)).includes('Local: http://localhost:5199/'))
        check(true, '"Show terminal" opens the panel on the agent\'s terminal, with the server\'s output')
        check(await page.evaluate<boolean>(`!!document.querySelector('section[aria-label=Terminal] [role=tab][aria-selected=true] svg.lucide-bot')`), 'the agent\'s tab is marked as the agent\'s')
        await shot('shell-agent.png')
        page.close()
    }
    finally {
        await stop()
        await llm.close()
    }
    console.log('shell agent e2e passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
