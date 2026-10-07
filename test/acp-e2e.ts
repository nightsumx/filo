// End-to-end check of a non-pi agent over ACP in the built app, against test/fakeAcp.mjs (no
// network, no tokens; it answers like codex-acp):
//   - a new thread switches from pi to Codex in the composer, and gets the agent's own pickers
//   - a run streams thinking, a command with output, an edit that waits on the approval prompt,
//     and a plan (todo card); Allow lets the edit through
//   - the session is listed with its agent, and a reopened tab replays it from the agent
//   - pi-only actions (fork, compaction) stay hidden
//   - Claude Code and Grok Build are offered too; a Claude thread carries its own label
//   - a session the agent lists itself (started in a terminal) shows up and opens
//   - ACP threads are in session search and in the changes panel's edit log
//   - typing mid-run queues a follow-up; /compact, fork and delete-from-agent go to the agent
//   - an agent without image prompts hides the image button
//
//   bun run build && bun run e2e:acp
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows } from './app'

const WORK = '/private/tmp/pi-gui-acp'
const SHOTS = process.env.SHOTS ?? ''
const FAKE = path.resolve(import.meta.dirname, 'fakeAcp.mjs')

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const fakeDir = path.join(WORK, 'fake-acp')
    await Promise.all([repo, userData, agentDir, fakeDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: repo })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'init')
    // A Codex session from a terminal: the agent lists it, the app has never seen it.
    await writeFile(path.join(fakeDir, 'term-1.jsonl'), [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'from the terminal' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: from the terminal' } },
    ].map(u => JSON.stringify(u)).join('\n'))
    await writeFile(path.join(fakeDir, 'term-1.meta.json'), JSON.stringify({ agent: 'codex', cwd: repo, title: 'From the terminal', updatedAt: new Date(Date.now() - 60_000).toISOString() }))
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
        // Every ACP agent runs the same scripted one here.
        PI_GUI_ACP_CODEX: JSON.stringify(['node', FAKE, '--agent=codex']),
        PI_GUI_ACP_CLAUDE: JSON.stringify(['node', FAKE, '--agent=claude']),
        PI_GUI_ACP_GROK: JSON.stringify(['node', FAKE, '--agent=grok', '--no-images']),
        PI_GUI_ACP_OPENCODE: JSON.stringify(['node', FAKE, '--agent=opencode']),
        PI_GUI_ACP_GEMINI: JSON.stringify(['node', FAKE, '--agent=gemini']),
        PI_GUI_ACP_COPILOT: JSON.stringify(['node', FAKE, '--agent=copilot']),
        PI_GUI_ACP_CURSOR: JSON.stringify(['node', FAKE, '--agent=cursor']),
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
        const ids = await js<string[]>(`(async () => (await window.pi.listAgents()).map(a => a.id))()`)
        check(JSON.stringify(ids) === '["codex","claude","grok","opencode","gemini","copilot","cursor"]', `the picker offers every ACP agent (${ids.join(', ')})`)
        await until('the agent picker shows', () => js<boolean>(`!![...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Agent: pi')`))
        check(true, 'a fresh thread offers the agent picker')
        if (SHOTS) {
            await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Agent: pi'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); return true })()`)
            await until('picker menu', () => js<boolean>(`!!document.querySelector('[role=menu]')`))
            await page.screenshot(path.join(SHOTS, 'acp-picker.png'))
            await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
            await until('picker closed', () => js<boolean>(`!document.querySelector('[role=menu]')`))
        }

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

        // The app's copy of the transcript feeds search and the edit log.
        const found = await until('search finds the ACP thread', () => js<boolean>(`(async () => (await window.pi.searchSessions('wrote notes')).some(r => r.session === ${JSON.stringify(key)} && r.hits.length > 0))()`))
        check(found, 'session search finds the Codex thread by its reply, under its session key')
        await until('the edit log names the thread', () => js<boolean>(`(async () => ((await window.pi.repoEdits(${R})).files['notes.txt'] ?? []).some(e => e.session === ${JSON.stringify(key)}))()`))
        check(true, 'the changes panel knows the Codex thread wrote notes.txt')

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

        // Typed mid-run: the agent has no steering, so it waits as a follow-up and goes next.
        const K = `window.__app.threads.get(${JSON.stringify(key)})`
        await js(`(() => { const t = ${K}; t.draft = 'slow'; void t.send(); return true })()`)
        await until('slow run', () => js<boolean>(`${K}.running`))
        await js(`(() => { const t = ${K}; t.draft = 'after slow'; void t.send(); return true })()`)
        await until('queued', () => js<boolean>(`${K}.queue.followUp.includes('after slow')`))
        check(await js<boolean>(`document.querySelector('textarea').placeholder.includes('gets it after this run')`), 'mid-run input reads as a follow-up for an agent without steering')
        await until('the follow-up ran', () => js<boolean>(`(() => { const t = ${K}; return !t.running && !t.queue.followUp.length && JSON.stringify(t.turns.at(-1).steps).includes('echo: after slow') })()`), 20_000)
        const lastTwo = await js<string[]>(`${K}.turns.slice(-2).map(t => t.user?.text)`)
        check(JSON.stringify(lastTwo) === '["slow","after slow"]', 'the follow-up went as the next prompt, after the slow one')

        // The agent's own /compact, from the thread menu.
        check(await js<boolean>(`${K}.features.compaction`), 'Compact context is offered: the agent has /compact')
        await js(`(() => { void ${K}.compact(); return true })()`)
        await until('compacted', () => js<boolean>(`(() => { const t = ${K}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('Compacted.') })()`), 20_000)
        check(true, 'Compact context runs the agent\'s /compact')

        // Fork: the agent copies the session; the copy opens in its own tab with the history.
        check(await js<boolean>(`!!${K}.state.agentCaps.fork`), 'the agent says it can fork')
        const forkKey = await js<string>(`${K}.forkSession()`)
        check(!!forkKey && forkKey.startsWith('acp:codex:fork-'), `session/fork makes a new session (${forkKey})`)
        await js(`window.__app.revealHere(${JSON.stringify(forkKey)})`)
        await until('the fork opens', () => js<boolean>(`(() => { const t = window.__app.threads.get(${JSON.stringify(forkKey)}); return !!t && t.loaded && JSON.stringify(t.turns).includes('echo: after slow') })()`), 20_000)
        check(await js<string>(`window.__app.sessions.find(s => s.path === ${JSON.stringify(forkKey)}).name`) === 'Edit notes.txt (fork)', 'the fork is listed under its source\'s name')

        // Delete from the agent: its own record goes too.
        await js(`(() => { void window.__app.deleteSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(forkKey)}), { history: true }); return true })()`)
        await until('the fork is gone', () => js<boolean>(`!window.__app.sessions.some(s => s.path === ${JSON.stringify(forkKey)})`))
        const forkFile = path.join(fakeDir, `${forkKey.slice('acp:codex:'.length)}.jsonl`)
        check(!(await readFile(forkFile).then(() => true, () => false)), 'Delete from Codex removes the agent\'s own session')

        // The terminal session the agent listed: in the sidebar with its agent, and it opens.
        const termKey = 'acp:codex:term-1'
        check(await js<boolean>(`window.__app.sessions.some(s => s.path === '${termKey}' && s.name === 'From the terminal' && s.agent === 'codex')`), 'a session the agent lists itself shows up in the project')
        await js(`(() => { window.__app.openSession(window.__app.sessions.find(s => s.path === '${termKey}')); return true })()`)
        await until('the terminal session replays', () => js<boolean>(`(() => { const t = window.__app.threads.get('${termKey}'); return !!t && t.loaded && JSON.stringify(t.turns).includes('echo: from the terminal') })()`), 20_000)
        check(true, 'it opens with its history from the agent')
        await until('search finds the opened terminal session', () => js<boolean>(`(async () => (await window.pi.searchSessions('from the terminal')).some(r => r.session === '${termKey}'))()`))
        check(true, 'once opened it is in search too')

        // An agent without image prompts: no image button.
        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('a thread for Grok', () => js<boolean>(`!!${T} && ${T}.isEmpty && ${T}.agent === 'pi'`))
        await js(`${T}.setAgent('grok')`)
        await until('Grok ready', () => js<boolean>(`${T}.agent === 'grok' && ${T}.agentStatus === 'ready'`))
        await until('Grok\'s capabilities', () => js<boolean>(`${T}.state?.agentCaps?.images === false`))
        check(await js<boolean>(`!${T}.features.images && !document.querySelector('button[aria-label="Add image"]')`), 'Grok Build (no image prompts) has no image button')
        await js(`window.__app.closeTab(${T}.key)`)

        // Another agent in a second thread: its own label everywhere.
        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('another new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty && ${T}.key !== ${JSON.stringify(key)}`))
        await js(`${T}.setAgent('claude')`)
        await until('Claude ready', () => js<boolean>(`${T}.agent === 'claude' && ${T}.agentStatus === 'ready'`))
        check(await js<string>(`document.querySelector('textarea').placeholder`) === 'Ask Claude Code to do something, or type / for commands', 'a Claude Code thread names its agent')
        await js(`(() => { const t = ${T}; t.draft = 'hi claude'; void t.send(); return true })()`)
        await until('Claude answers', () => js<boolean>(`(() => { const t = ${T}; return !t.running && t.persisted && t.key.startsWith('acp:claude:') && JSON.stringify(t.turns.at(-1).steps).includes('echo: hi claude') })()`), 20_000)
        check(true, 'a Claude Code session runs and is keyed acp:claude:…')
        await until('Claude listed', () => js<boolean>(`[...document.querySelectorAll('[role=treeitem]')].some(r => r.textContent.includes('hi claude') && r.textContent.includes('Claude Code'))`))
        check(true, 'its sidebar row says Claude Code')

        // Settings → Agents lists every agent with how it runs.
        await js(`(() => { window.__app.setSettingsPage('agents'); window.__app.setSettingsOpen(true); return true })()`)
        await until('the Agents page', () => js<boolean>(`(() => { const p = document.querySelector('section[aria-label="Agents"]'); return !!p && p.textContent.includes('Grok Build') && !p.textContent.includes('Checking') })()`))
        const page2 = await js<string>(`document.querySelector('section[aria-label="Agents"]').textContent`)
        check(['pi', 'Codex', 'Claude Code', 'OpenCode', 'Gemini CLI', 'GitHub Copilot', 'Cursor', 'Sign in:'].every(t => page2.includes(t)), 'Settings → Agents lists every agent and how to sign in')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'acp-settings.png'))
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)
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
