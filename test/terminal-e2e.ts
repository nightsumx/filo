// The app next to a terminal pi on the same session, in the built app with a scripted model:
//   - with pi-cc-tui's bridge, the thread joins the terminal pi instead of starting its own: a run
//     typed in the terminal streams into the app, a prompt sent from the app runs in the terminal,
//     and the session file stays one line of conversation
//   - quitting the terminal pi leaves the thread as it was, on its own again
//   - a terminal pi without the bridge: the thread follows the file it writes, and its own pi reads
//     those turns before the next prompt from the app
//
//   bun run build && bun run e2e:terminal
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'
import { hasTmux, startTerminalPi } from './terminal'

const WORK = workDir('pi-gui-term')
const SHOTS = process.env.SHOTS ?? ''

const userText = (m: any) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join('')

async function main() {
    if (!hasTmux) {
        console.log('skip: no tmux')
        return
    }
    await rm(WORK, { recursive: true, force: true })
    const project = path.join(WORK, 'project')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([project, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    // "slow" thinks first and takes a while, so the app can be seen following it mid-run.
    const llm = await startMockLlm((request) => {
        const prompt = userText(request.messages.filter(m => m.role === 'user').at(-1))
        return prompt.includes('slow')
            ? { thinking: 'thinking it over in the terminal', text: 'slow reply', delayMs: 2500 }
            : { text: `reply to: ${prompt}` }
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
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [project] }],
    }))

    const terminals: { kill: () => Promise<void> }[] = []
    const bridged = await startTerminalPi({ agentDir, cwd: project, extensions: ['cc-presence.ts', 'cc-bridge.ts'] })
    terminals.push(bridged)
    await until('terminal pi ready', async () => (await bridged.pane()).includes('mock-1'))
    await bridged.type('hello from the terminal')
    await until('terminal reply', async () => (await bridged.pane()).includes('reply to: hello from the terminal'))

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const [{ page }] = await windows(1)
        const text = () => page.evaluate<string>('document.body.innerText')
        const terminal = await until('terminal session in the app', async () => JSON.parse(await page.evaluate<string>(`JSON.stringify(window.__app.presence.find(p => p.session && p.bridge) ?? null)`)) as { pid: number, session: string } | null)
        const file = terminal.session
        await until('session listed', () => page.evaluate<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(file)})`))
        await page.evaluate(`window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(file)}))`)
        const thread = `window.__app.threads.get(${JSON.stringify(file)})`
        const items = () => page.evaluate<string>(`JSON.stringify(${thread}.items)`)

        // Joined: one process, both sides.
        await until('joined the terminal pi', () => page.evaluate<boolean>(`${thread}?.terminalPid === ${terminal.pid}`))
        check(true, 'the thread joins the terminal pi instead of starting its own')
        await until('notice', async () => (await text()).includes('Joined the pi in your terminal'))
        check(!(await text()).includes('splits the conversation'), 'the notice says so, without the fork warning')
        check((await items()).includes('reply to: hello from the terminal'), 'the earlier terminal turn is in the transcript')

        await bridged.type('slow one from the terminal')
        await until('live thinking', () => page.evaluate<boolean>(`(() => { const t = ${thread}; return t.running && JSON.stringify(t.streaming ?? null).includes('thinking it over') })()`))
        check(true, 'a run typed in the terminal streams into the app while it runs')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'terminal-live.png'))
        await until('slow reply settled', async () => !(await page.evaluate<boolean>(`${thread}.running`)) && (await items()).includes('slow reply'))
        check((await items()).includes('slow one from the terminal'), 'and the finished turn stays in the transcript')

        await page.evaluate(`(() => { const t = ${thread}; t.draft = 'hi from the app'; void t.send(); return true })()`)
        await until('app prompt ran in the terminal', async () => (await bridged.pane()).includes('reply to: hi from the app'))
        check(true, 'a prompt sent from the app runs in the terminal pi')
        await until('app reply', async () => !(await page.evaluate<boolean>(`${thread}.running`)) && (await items()).includes('reply to: hi from the app'))
        check(llm.requests.length === 3, `one process answered every turn (${llm.requests.length} model calls)`)
        const entries = (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.id)
        const parents = entries.map(e => e.parentId).filter(Boolean)
        check(new Set(parents).size === parents.length, 'the session file is one line of conversation, no branches')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'terminal-joined.png'))

        // The terminal pi quits: the thread keeps everything and is on its own again.
        await bridged.kill()
        await until('detached', () => page.evaluate<boolean>(`(() => { const t = ${thread}; return !t.terminalPid && t.agentStatus === 'none' })()`))
        check(!(await page.evaluate<string>(`${thread}.agentError`)), 'quitting the terminal pi detaches quietly')
        await until('notice gone', async () => !(await text()).includes('Joined the pi in your terminal'))
        check((await items()).includes('reply to: hi from the app'), 'the transcript is kept')

        // Without the bridge: follow the file, and catch the own pi up before sending.
        await page.evaluate(`${thread}.ensureAgent()`)
        const plain = await startTerminalPi({ agentDir, cwd: project, extensions: ['cc-presence.ts'], args: ['--session', file] })
        terminals.push(plain)
        await until('plain terminal pi ready', async () => (await plain.pane()).includes('mock-1'))
        await until('fork warning', async () => (await text()).includes('splits the conversation'))
        check(true, 'a terminal pi without the bridge gets the fork warning')
        await plain.type('from the plain terminal')
        await until('followed', async () => (await items()).includes('reply to: from the plain terminal'), 15_000)
        check(true, 'the thread follows what that terminal pi writes')
        await plain.kill()
        await page.evaluate(`(() => { const t = ${thread}; t.draft = 'after following'; void t.send(); return true })()`)
        await until('reply after following', async () => !(await page.evaluate<boolean>(`${thread}.running`)) && (await items()).includes('reply to: after following'))
        const seen = JSON.stringify(llm.requests.at(-1)!.messages)
        check(seen.includes('from the plain terminal'), 'the app\'s own pi read the terminal\'s turn before answering')
        console.log('all terminal checks passed')
    }
    finally {
        await stop()
        for (const t of terminals)
            await t.kill()
        await llm.close()
    }
}

main().then(() => process.exit(0), (error) => {
    console.error(error)
    process.exit(1)
})
