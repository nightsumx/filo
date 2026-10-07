// End-to-end check of a non-pi agent over ACP in the built app, against test/fakeAcp.mjs (no
// network, no tokens; it answers like codex-acp):
//   - a new thread switches from pi to Codex in the composer, and gets the agent's own pickers
//   - a run streams thinking, a command with output, an edit that waits on the approval prompt,
//     and a plan (todo card); Allow lets the edit through
//   - the session is listed with its agent, and a reopened tab replays it from the agent
//   - pi-only actions (fork, compaction) stay hidden
//
//   bun run build && bun run e2e:acp
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows } from './app'

const WORK = '/private/tmp/pi-gui-acp'
const SHOTS = process.env.SHOTS ?? ''

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const fakeDir = path.join(WORK, 'fake-acp')
    await Promise.all([repo, userData, agentDir, fakeDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [repo],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [repo] }],
    }))
    const env = {
        PI_GUI_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_GUI_TEST: '1',
        PI_GUI_ACP_CODEX: JSON.stringify(['node', path.resolve(import.meta.dirname, 'fakeAcp.mjs')]),
        FAKE_ACP_DIR: fakeDir,
    }
    const R = JSON.stringify(repo)

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = <T = any>(expr: string) => page.evaluate<T>(expr)
        const T = 'window.__app.active'

        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('a new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty`))
        const picker = await until('the agent picker lists Codex', () => js<boolean>(`(async () => (await window.pi.listAgents()).some(a => a.id === 'codex' && a.available))()`))
        check(picker, 'Codex is available (fake adapter)')
        await until('the agent picker shows', () => js<boolean>(`!![...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Agent: pi')`))
        check(true, 'a fresh thread offers the agent picker')

        await js(`${T}.setAgent('codex')`)
        await until('Codex ready', () => js<boolean>(`${T}.agent === 'codex' && ${T}.agentStatus === 'ready'`))
        check(await js<string>(`${T}.state?.model?.name`) === 'Fake One', 'the model picker shows the agent\'s model')
        check(JSON.stringify(await js<string[]>(`[...${T}.thinkingLevels]`)) === '["low","high"]', 'effort levels come from the agent\'s thought_level option')
        await until('the mode picker', () => js<boolean>(`!![...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Mode: Read-only')`))
        check(true, 'the agent\'s own Mode option gets a picker')
        check(await js<string>(`document.querySelector('textarea').placeholder`) === 'Ask Codex to do something, or type / for commands', 'the composer names the agent')
        await until('slash commands', () => js<boolean>(`${T}.commands.some(c => c.name === 'review')`))
        check(true, 'available_commands_update fills the slash menu')

        await js(`(() => { const t = ${T}; t.draft = 'edit notes.txt'; void t.send(); return true })()`)
        await until('the approval prompt', () => js<boolean>(`${T}.uiRequests[0]?.approval?.toolCallId === 'edit-1'`))
        const prompt = await js<string>(`document.body.innerText`)
        check(prompt.includes('needs your approval') && prompt.includes('Yes, and don\'t ask again for these files'), 'request_permission shows as the approval prompt, with the agent\'s "always" wording')
        check(await js<string>(`${T}.activity.phase`) !== 'idle', 'the sidebar sees the thread busy while it waits')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'acp-approval.png'))
        await js(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Allow').click(); return true })()`)

        await until('the run settles', () => js<boolean>(`(() => { const t = ${T}; return !t.running && t.persisted && t.key === t.sessionPath })()`), 20_000)
        const key = await js<string>(`${T}.key`)
        check(key.startsWith('acp:codex:fake-'), `the thread is keyed by its ACP session (${key})`)
        check(await readFile(path.join(repo, 'notes.txt'), 'utf8') === 'written by fake\n', 'Allow let the edit through')
        const steps = await js<string[]>(`${T}.turns.at(-1).steps.map(s => s.kind === 'tool' ? 'tool:' + s.call.name + (s.result ? (s.result.isError ? ':error' : ':ok') : ':none') : s.kind)`)
        check(JSON.stringify(steps) === JSON.stringify(['thinking', 'tool:bash:ok', 'tool:write:ok', 'tool:todo:ok', 'text']), `the turn reads thinking, Bash, Write, Todo, text (${steps.join(', ')})`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'acp-run.png'))
        const text = await js<string>(`document.body.innerText`)
        check(text.includes('Ran 1 command') && text.includes('edited 1 file'), 'the finished turn sums up its command and edit')
        check(!text.includes('until auto-compact'), 'the status line leaves out pi\'s auto-compaction')
        check(text.includes('Wrote notes.txt.'), 'the answer is in the transcript')
        check(await js<number>(`${T}.turns.at(-1).usage.output`) === 50, 'the prompt\'s usage lands on the turn')
        check(await js<number>(`Math.round(${T}.stats?.contextUsage?.percent * 10)`) === 12, 'usage_update feeds the context meter')

        await until('the session is listed', () => js<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(key)} && s.agent === 'codex')`))
        check(true, 'the session shows up in the project with its agent')
        check(await js<string>(`window.__app.sessions.find(s => s.path === ${JSON.stringify(key)}).name`) === 'Edit notes.txt', 'the agent\'s session title names it')
        check(await js<boolean>(`[...document.querySelectorAll('[role=treeitem]')].some(r => r.textContent.includes('Codex'))`), 'the sidebar row says Codex')
        check(await js<boolean>(`![...document.querySelectorAll('button')].some(b => b.getAttribute('title') === 'Fork from here')`), 'fork stays hidden for ACP threads')

        await js(`${T}.setConfigOption('mode', 'agent')`)
        await until('mode changed', () => js<boolean>(`${T}.configOptions.find(o => o.id === 'mode')?.currentValue === 'agent'`))
        check(true, 'a config picker choice goes to the agent')

        // Follow-up in the same process, then reopen from the list: the agent replays the session.
        await js(`(() => { const t = ${T}; t.draft = 'hello again'; void t.send(); return true })()`)
        await until('echo', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('echo: hello again') })()`))
        check(true, 'a second prompt runs in the same session')
        const turnsBefore = await js<number>(`${T}.turns.length`)
        await js(`window.__app.closeTab(${JSON.stringify(key)})`)
        await until('tab closed', () => js<boolean>(`!window.__app.threads.has(${JSON.stringify(key)})`))
        await js(`(() => { window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(key)})); return true })()`)
        await until('replayed', () => js<boolean>(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); return !!t && t.loaded && t.turns.length === ${turnsBefore} })()`), 20_000)
        const replayed = await js<string[]>(`window.__app.threads.get(${JSON.stringify(key)}).turns.map(t => t.user?.text)`)
        check(JSON.stringify(replayed) === JSON.stringify(['edit notes.txt', 'hello again']), 'the reopened tab replays both prompts from the agent')
        const replayedSteps = await js<string[]>(`window.__app.threads.get(${JSON.stringify(key)}).turns[0].steps.map(s => s.kind === 'tool' ? s.call.name + ':' + (s.result?.content?.[0]?.text ?? '') : s.kind)`)
        check(replayedSteps.includes('bash:README.md\n'), 'replayed commands keep their output')

        // Resuming: a prompt in the reopened tab starts the agent with session/load.
        await js(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); t.draft = 'third'; void t.send(); return true })()`)
        await until('resumed run', () => js<boolean>(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); return !t.running && t.turns.length === ${turnsBefore + 1} && JSON.stringify(t.turns.at(-1).steps).includes('echo: third') })()`), 20_000)
        check(await js<string>(`window.__app.threads.get(${JSON.stringify(key)}).key`) === key, 'the resumed session keeps its key')
        console.log('all ACP checks passed')
    }
    finally {
        await stop()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
