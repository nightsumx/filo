// Claude Code threads in the built app through its own TUI, against the real interactive `claude`
// with a scripted Anthropic API and a CLAUDE_CONFIG_DIR of its own (no account, no tokens, the
// user's Claude Code history untouched):
//   - a new thread runs `claude` in a terminal of the app's, and its transcript is the session file
//   - a command waits on Claude Code's permission dialog, answered from the approval card
//   - AskUserQuestion with one single-choice question is answered in the thread
//   - the thread can show the TUI itself, and what is typed there shows in the transcript
//   - the session is listed, and a reopened tab replays it and resumes it
//   - hooks turned off in the user's settings: the thread shows the TUI and says why, follows the
//     session file still, and one click turns them on for Filo's threads
//   - switching between the chat and the TUI, idle, mid-stream, with a dialog up, with a line typed
//     in the TUI: the view moves only when the user or a dialog the GUI cannot show moves it, the
//     terminal keeps the pane's size, focus follows the click, cards and prompts stay in step
//
//   bun run build && bun run e2e:claude-tui
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-claude-tui')
const SHOTS = process.env.SHOTS ?? ''
const requests: any[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const textOf = (message: any): string => typeof message.content === 'string'
    ? message.content
    : message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')

/**
 * The model: the main loop's requests (they carry the tools) answer by a keyword in the last
 * prompt; after a tool result, a closing line with what the tool returned. Side requests (titles,
 * summaries) get a short title.
 */
function reply(body: any): any[] {
    if (!Array.isArray(body.tools) || body.tools.length < 5)
        return [{ type: 'text', text: 'Fake title' }]
    for (let i = (body.messages?.length ?? 0) - 1; i >= 0; i--) {
        const m = body.messages[i]
        // Claude Code puts its reminders in system turns between the user's.
        if (m.role === 'system')
            continue
        if (m.role !== 'user')
            break
        const result = Array.isArray(m.content) ? m.content.find((b: any) => b.type === 'tool_result') : undefined
        // After a resume Claude Code folds the new prompt into the user turn that holds the last tool result
        // (the API wants them together); that is a prompt, not a tool turn. Reminders are tags: `<…>`.
        const prompted = Array.isArray(m.content) && m.content.some((b: any) => b.type === 'text' && b.text.trim() && !b.text.trimStart().startsWith('<'))
        if (result && !prompted) {
            const out = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
            return [{ type: 'text', text: `Tool finished: ${out.slice(0, 200)}` }]
        }
        const text = textOf(m)
        const n = requests.length
        if (text.includes('BASHSLOW'))
            return [{ type: 'tool_use', id: `toolu_bash_${n}`, name: 'Bash', input: { command: 'sleep 4 && touch slept.txt && echo slept', description: 'Wait a while' } }]
        if (text.includes('ASK2')) {
            const question = (q: string, header: string, a: string, b: string) => ({ question: q, header, multiSelect: false, options: [{ label: a, description: a }, { label: b, description: b }] })
            return [{ type: 'tool_use', id: `toolu_ask_${n}`, name: 'AskUserQuestion', input: { questions: [question('Pick a colour?', 'Colour', 'Red', 'Blue'), question('Pick a size?', 'Size', 'Small', 'Large')] } }]
        }
        if (/\bBASH\b/.test(text))
            return [{ type: 'text', text: 'Making the marker.' }, { type: 'tool_use', id: `toolu_bash_${n}`, name: 'Bash', input: { command: 'touch marker.txt && echo made', description: 'Make the marker' } }]
        if (/\bASK\b/.test(text))
            return [{ type: 'tool_use', id: `toolu_ask_${n}`, name: 'AskUserQuestion', input: { questions: [{ question: 'Pick a colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] } }]
        if (/\bSLOW\b/.test(text))
            return [{ type: 'text', text: Array.from({ length: 40 }, (_, k) => `Slow line ${k}.`).join('\n'), slow: 100 }]
        if (text.trim())
            return [{ type: 'text', text: `Hello from the fake model: ${text.trim().split('\n').at(-1)!.slice(0, 40)}` }]
    }
    return [{ type: 'text', text: 'out of script' }]
}

async function respond(res: http.ServerResponse, body: any) {
    const blocks = reply(body)
    const n = requests.length
    const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    const message = { id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: body.model || 'fake', content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } }
    if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: blocks.map(({ slow, ...b }) => b), stop_reason: stop }))
        return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (name: string, data: Record<string, unknown>) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`)
    ev('message_start', { message })
    for (const [index, b] of blocks.entries()) {
        if (b.type === 'text') {
            ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
            for (const word of String(b.text).split(/(?<=\s)/)) {
                ev('content_block_delta', { index, delta: { type: 'text_delta', text: word } })
                await sleep(b.slow ?? 5)
            }
        }
        else {
            ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
            ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
        }
        ev('content_block_stop', { index })
    }
    ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 20 } })
    ev('message_stop', {})
    res.end()
}

async function main() {
    const claude = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const config = path.join(WORK, 'claude-config')
    await Promise.all([repo, userData, agentDir, config].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'init', '-q'], { cwd: repo })
    // Past the first-run screens, the folder trusted.
    await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [repo]: { hasTrustDialogAccepted: true } } }))
    // The user turned hooks off; Filo turns them on for its own threads when asked to.
    await writeFile(path.join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true }))

    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
            body += c
        })
        req.on('end', () => {
            if (req.method !== 'POST' || !req.url?.includes('/messages')) {
                res.writeHead(404).end()
                return
            }
            if (req.url.includes('count_tokens')) {
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
                return
            }
            const parsed = JSON.parse(body || '{}')
            requests.push(parsed)
            void respond(res, parsed)
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
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
    const env: Record<string, string> = {
        PI_GUI_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_GUI_TEST: '1',
        // Manual approvals: a fresh config starts in auto mode.
        PI_GUI_ACP_CLAUDE: JSON.stringify([claude, '--permission-mode', 'default']),
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: 'fake-local',
        ANTHROPIC_API_KEY: '',
    }
    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = <T = any>(expr: string) => page.evaluate<T>(expr)
        const T = 'window.__app.active'
        const R = JSON.stringify(repo)
        const click = (label: string) => js(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); return true })()`)
        const send = (text: string) => js(`(() => { const t = ${T}; t.draft = ${JSON.stringify(text)}; void t.send(); return true })()`)
        const lastSteps = () => js<string>(`JSON.stringify(${T}.turns.at(-1)?.steps ?? [])`)
        const settled = (what: string, needle: string, ms = 30_000) => until(what, async () => !(await js<boolean>(`${T}.running`)) && (await lastSteps()).includes(needle), ms)

        const startThread = async () => {
            await js(`(() => { window.__app.newThread(${R}); return true })()`)
            await until('a new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty`))
            await js(`${T}.setAgent('claude')`)
            await until('Claude Code ready', () => js<boolean>(`${T}.agent === 'claude' && ${T}.agentStatus === 'ready'`), 30_000)
        }

        // Hooks off: the TUI in view, the reason and the way back above it.
        await startThread()
        await until('the hooks notice', () => js<boolean>(`${T}.state?.tuiHooks?.cause === 'disabled' && ${T}.tuiShown`), 15_000)
        const notice = await js<string>(`document.querySelector('[role=alert]')?.innerText ?? ''`)
        check(notice.includes('disableAllHooks') && notice.includes('Turn hooks on for Filo'), 'hooks turned off: the thread shows the TUI, says why and offers to turn them on')
        const offTerminal = await js<string>(`${T}.tuiTerminal`)
        // Typed in the TUI itself: the transcript still follows the session file.
        // No SessionStart to tell when it is at its prompt (WebGL draws the screen: no text to read).
        await sleep(10_000)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'claude-hooks-off.png'))
        const typeIn = (data: string) => js(`window.pi.terminalWrite(${JSON.stringify(offTerminal)}, ${JSON.stringify(data)})`)
        await typeIn('\x1B[200~typed in the tui\x1B[201~')
        await sleep(150)
        await typeIn('\r')
        await settled('the answer without hooks', 'Hello from the fake model: typed in the tui')
        check(true, 'without hooks, a prompt typed in the TUI and its answer still show in the transcript')
        await click('Turn hooks on for Filo')
        await until('hooks on', () => js<boolean>(`!${T}.state?.tuiHooks && !!${T}.tuiTerminal && ${T}.tuiTerminal !== ${JSON.stringify(offTerminal)} && !${T}.tuiShown`), 30_000)
        check(true, 'one click starts the TUI again with hooks on, and the chat view comes back')
        await send('after the fix')
        await settled('the answer with hooks', 'Hello from the fake model: after the fix')
        check(JSON.stringify(await js<string[]>(`${T}.turns.map(t => t.user?.text)`)) === JSON.stringify(['typed in the tui', 'after the fix']), 'the same session goes on, prompts from both sides in order')
        check(!(await js<boolean>(`${T}.state?.tuiHooks`)), 'and the thread stays on hooks')

        // From here on the setting is on for every thread.
        await startThread()
        const terminal = await until('its terminal', () => js<string | undefined>(`${T}.tuiTerminal`), 10_000)
        check(!!terminal, `the thread runs claude in a terminal of the app's (${terminal})`)
        check(!(await js<boolean>(`window.__app.terminals?.some?.(t => t.id === ${JSON.stringify(terminal)}) ?? false`)), 'that terminal is not among the project\'s')

        // A plain prompt: typed into the TUI, the answer read back from the session file.
        await send('hello there')
        await settled('the first answer', 'Hello from the fake model: hello there')
        check(true, 'a prompt from the composer runs in the TUI and its answer shows in the thread')
        check(!(await js<boolean>(`${T}.tuiShown`)), 'the transcript stays in view (no dialog the GUI cannot show)')
        const key = await js<string>(`${T}.key`)
        check(key.startsWith('acp:claude:'), `the thread is keyed by Claude Code's session (${key})`)

        // The model picker: Opus, Sonnet, Haiku (the aliases Claude Code resolves). Picking one types /model into the TUI.
        const modelLabel = () => js<string>(`[...document.querySelectorAll('button')].find(b => b.querySelector('.lucide-cpu'))?.textContent ?? ''`)
        await js(`(() => { [...document.querySelectorAll('button')].find(b => b.querySelector('.lucide-cpu')).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return true })()`)
        await until('the model menu', () => js<boolean>(`[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim()).join('|').includes('Sonnet')`))
        const models = await js<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim())`)
        check(['Opus', 'Sonnet', 'Haiku'].every(m => models.some(x => x.startsWith(m))), `the model menu lists Opus, Sonnet and Haiku (${models.join(' | ')})`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'claude-model-menu.png'))
        await js(`(() => { [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim().startsWith('Sonnet')).click(); return true })()`)
        // It re-reads the history: the app asks first.
        await until('the switch question', () => js<boolean>(`[...document.querySelectorAll('[role="dialog"]')].some(d => d.textContent.includes('Switch model?'))`))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'claude-model-switch-confirm.png'))
        await click('Switch')
        await until('the picker shows Sonnet', async () => (await modelLabel()).includes('Sonnet'), 15_000)
        check(!(await js<boolean>(`${T}.running`)) && !(await js<boolean>(`${T}.tuiShown`)), 'choosing Sonnet leaves the thread idle and in the chat')
        await send('which model')
        await settled('the answer on Sonnet', 'Hello from the fake model: which model')
        check(String(requests.at(-1)?.model).includes('sonnet'), `the next request is for Sonnet (${requests.at(-1)?.model})`)
        const answers = await js<number>(`${T}.turns.at(-1).steps.filter(s => s.kind === 'text' && s.text.includes('which model')).length`)
        check(answers === 1, `the answer after the switch shows once (${answers})`)
        await until('the picker shows the model that answered', async () => (await modelLabel()).includes('sonnet'), 10_000)
        // The effort: /effort, and the level stays in the picker.
        await js(`${T}.setThinkingLevel('low')`)
        await until('the effort level', () => js<boolean>(`${T}.state?.thinkingLevel === 'low'`), 15_000)
        await send('with low effort')
        await settled('the answer on low effort', 'Hello from the fake model: with low effort')
        const everyAnswer = await js<number[]>(`${T}.turns.map(t => t.steps.filter(s => s.kind === 'text').length)`)
        check(everyAnswer.every(n => n <= 1), `no turn shows an answer twice (${everyAnswer.join(',')})`)
        check(requests.at(-1)?.output_config?.effort === 'low', `the next request asks for low effort (${JSON.stringify(requests.at(-1)?.output_config)})`)
        check((await js<string>(`document.body.innerText`)).includes('Low'), 'and the thinking picker shows Low')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'claude-effort-low.png'))

        // The compact popover's auto-compact threshold (/autocompact): Claude Code writes it for the model in use.
        {
            const windowOf = async () => Object.values(JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8')).modelSettings ?? {}).map((m: any) => m.autoCompactWindow).find(w => w !== undefined)
            await js(`(() => { const b = document.querySelector('button[aria-label="Compact context"]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true })()`)
            await until('the auto-compact field', () => js<boolean>(`!!document.querySelector('[data-auto-compact] input')`))
            if (SHOTS)
                await page.screenshot(path.join(SHOTS, 'claude-auto-compact.png'))
            await js(`(() => { document.querySelector('[data-auto-compact] input').focus(); return true })()`)
            await page.call('Input.insertText', { text: '500' })
            await js(`(() => { [...document.querySelectorAll('[data-auto-compact] button')].find(b => b.textContent.trim() === 'Set').click(); return true })()`)
            await until('settings.json to hold the window', async () => (await windowOf()) === 500_000)
            await until('Claude Code\'s answer in the thread', () => js<boolean>(`JSON.stringify(${T}.turns.at(-1)).includes('Auto-compact window')`))
            check(true, 'Set sends /autocompact: Claude Code writes 500000 under the model in use and says so in the thread')
            check(await js<boolean>(`!${T}.running && !${T}.tuiShown`), 'and the thread stays idle, in the chat')
            await js(`(() => { const b = document.querySelector('button[aria-label="Compact context"]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true })()`)
            await until('the field again', () => js<boolean>(`!!document.querySelector('[data-auto-compact] input')`))
            await js(`(() => { [...document.querySelectorAll('[data-auto-compact] button')].find(b => b.textContent.trim() === 'Auto').click(); return true })()`)
            await until('settings.json to hold auto', async () => (await windowOf()) === 'auto')
            check(true, 'Auto puts it back to auto')
        }

        // The goal button (/goal): set a condition, see it on the button, clear it.
        {
            const openGoal = async () => {
                await js(`(() => { const b = document.querySelector('button[aria-label="Goal"]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true })()`)
                await until('the goal popover', () => js<boolean>(`!!document.querySelector('[data-goal-popover] input')`))
            }
            await openGoal()
            await js(`(() => { document.querySelector('[data-goal-popover] input').focus(); return true })()`)
            await page.call('Input.insertText', { text: 'the file marker.txt exists' })
            if (SHOTS)
                await page.screenshot(path.join(SHOTS, 'claude-goal.png'))
            await js(`(() => { [...document.querySelectorAll('[data-goal-popover] button')].find(b => b.textContent.trim() === 'Set').click(); return true })()`)
            await until('the goal on the thread', () => js<boolean>(`${T}.goal === 'the file marker.txt exists'`), 30_000)
            await until('the goal turn to end', () => js<boolean>(`!${T}.running`), 30_000)
            check(await js<boolean>(`document.querySelector('button[aria-label="Goal"]').textContent.trim() === 'the file marker.txt exists'`), 'Set sends /goal: Claude Code records the condition and the button shows it')
            check(await js<boolean>(`JSON.stringify(${T}.turns.at(-1).steps).includes('Goal set: the file marker.txt exists')`), 'and says so in the thread')
            await openGoal()
            check(await js<boolean>(`document.querySelector('[data-goal-current]').textContent.includes('the file marker.txt exists')`), 'the popover shows the current goal')
            await js(`(() => { [...document.querySelectorAll('[data-goal-popover] button')].find(b => b.textContent.trim() === 'Clear goal').click(); return true })()`)
            await until('the goal cleared', () => js<boolean>(`${T}.goal === undefined`), 30_000)
            await until('the button back to Goal', () => js<boolean>(`document.querySelector('button[aria-label="Goal"]').textContent.trim() === 'Goal'`))
            check(true, 'Clear goal sends /goal clear: the condition is gone')
        }

        // Settings → Claude Code (/mcp): the servers it has, added and removed with the user's claude.
        {
            const claudeJson = path.join(config, '.claude.json')
            const mcpOf = async () => existsSync(claudeJson) ? (JSON.parse(await readFile(claudeJson, 'utf8')).projects?.[repo]?.mcpServers ?? {}) as Record<string, any> : {}
            await js(`(() => { window.__app.openSettings('claude'); return true })()`)
            await until('the Claude Code page', () => js<boolean>(`!!document.querySelector('[data-mcp-form]')`))
            // /memory: the auto memory switch is autoMemoryEnabled in Claude Code's settings.json (on until set to false).
            const memoryOn = async () => JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8')).autoMemoryEnabled
            const memorySwitch = `document.querySelector('[role="switch"]')`
            check(await js<string>(`${memorySwitch}.getAttribute('aria-checked')`) === 'true', 'auto memory shows on by default')
            await js(`(() => { ${memorySwitch}.click(); return true })()`)
            await until('autoMemoryEnabled false', async () => (await memoryOn()) === false)
            await until('the switch off', () => js<boolean>(`${memorySwitch}.getAttribute('aria-checked') === 'false'`))
            check(JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8')).modelSettings !== undefined, 'the switch writes autoMemoryEnabled false and keeps the other settings')
            await js(`(() => { ${memorySwitch}.click(); return true })()`)
            await until('autoMemoryEnabled true', async () => (await memoryOn()) === true)
            check(await js<boolean>(`!!document.querySelector('[data-memory-files]')`), 'and the memory files are offered')
            const type = async (label: string, text: string) => {
                await js(`(() => { document.querySelector('[aria-label=${JSON.stringify(label)}]').focus(); return true })()`)
                await page.call('Input.insertText', { text })
            }
            await type('Name', 'files')
            await type('Command', 'node -e "setTimeout(()=>{},1)" "a b"')
            await type('Environment variables', 'TOKEN=abc')
            if (SHOTS)
                await page.screenshot(path.join(SHOTS, 'claude-mcp-form.png'))
            await click('Add')
            await until('the server in .claude.json', async () => !!(await mcpOf()).files)
            const added = (await mcpOf()).files
            check(added.command === 'node' && JSON.stringify(added.args) === JSON.stringify(['-e', 'setTimeout(()=>{},1)', 'a b']) && added.env?.TOKEN === 'abc', `Add runs claude mcp add: the server is in Claude Code's own config (${JSON.stringify(added)})`)
            await until('the server listed', () => js<boolean>(`!!document.querySelector('[data-mcp="files"]')`))
            check(true, 'and the page lists it')
            if (SHOTS)
                await page.screenshot(path.join(SHOTS, 'claude-mcp-list.png'))
            await js(`(() => { document.querySelector('[data-mcp="files"] button').click(); return true })()`)
            await until('the confirmation', () => js<boolean>(`[...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].some(b => b.textContent.trim() === 'Remove' && !b.closest('[data-mcp]'))`))
            await js(`(() => { [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find(b => b.textContent.trim() === 'Remove' && !b.closest('[data-mcp]')).click(); return true })()`)
            await until('the server gone', async () => !(await mcpOf()).files)
            await until('the list empty', () => js<boolean>(`!document.querySelector('[data-mcp="files"]')`))
            check(true, 'Remove runs claude mcp remove, and the list follows')
            await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)
        }

        // A command: Claude Code's permission dialog, answered by the approval card.
        await send('BASH make the marker')
        await until('the approval card', () => js<boolean>(`!!${T}.uiRequests[0]?.approval`), 30_000)
        check((await js<string>(`document.body.innerText`)).includes('touch marker.txt'), 'the card shows the command')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'claude-approval.png'))
        await click('Allow')
        await settled('the command ran', 'Tool finished')
        check(existsSync(path.join(repo, 'marker.txt')), 'Allow pressed the dialog\'s Yes and the command ran')
        check((await lastSteps()).includes('made'), 'the command\'s output is in the transcript')

        // A question: answered in the thread, by the dialog's number key.
        await send('ASK which colour')
        await until('the question form', () => js<boolean>(`document.body.innerText.includes('Pick a colour?')`), 30_000)
        const askId = await until('the pending ask', () => js<string | undefined>(`[...${T}.tools.entries()].find(([, s]) => s.partial?.details?.kind === 'ask' && s.partial.details.status === 'pending')?.[0]`), 10_000)
        await js(`${T}.answerAsk(${JSON.stringify(askId)}, { answers: { [${T}.tools.get(${JSON.stringify(askId)}).partial.details.questions[0].id]: { selected: ['Blue'] } } })`)
        await settled('the answer went back', 'Tool finished')
        check(JSON.stringify(requests.at(-1)?.messages ?? []).includes('Blue'), 'the answer reached the model')

        // The TUI itself: shown in place of the transcript; what is typed there shows in the thread.
        await js(`${T}.showTui(true)`)
        await until('the TUI in view', () => js<boolean>(`!!document.querySelector('section .xterm')`), 10_000)
        check(true, 'the thread can show the TUI')
        await js(`${T}.showTui(false)`)

        // A long answer streams into the transcript before its record lands.
        await send('SLOW please')
        const seen: string[] = []
        const partial = await until('streamed text', async () => {
            const live = await js<string>(`JSON.stringify(${T}.streaming ?? null) + JSON.stringify(document.body.innerText)`)
            const lines = [...live.matchAll(/Slow line (\d+)/g)].map(m => Number(m[1]))
            seen.push(`${Date.now() % 100000}:${lines.length ? Math.max(...lines) : '-'}:${await js<boolean>(`${T}.running`)}`)
            return live.includes('Slow line 3.') && !live.includes('Slow line 39.') ? live : undefined
        }, 30_000).catch((error) => {
            console.error('seen:', seen.join(' '))
            throw error
        })
        check(!!partial, 'a long answer streams in as it is written')
        await settled('the long answer', 'Slow line 39.')

        // Listed, and replayed when reopened; a prompt there resumes the session.
        await until('the session is listed', () => js<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(key)} && s.agent === 'claude')`), 30_000)
        const prompts = await js<string[]>(`${T}.turns.map(t => t.user?.text)`)
        await js(`window.__app.closeTab(${JSON.stringify(key)})`)
        await until('tab closed', () => js<boolean>(`!window.__app.threads.has(${JSON.stringify(key)})`))
        await js(`(() => { window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(key)})); return true })()`)
        await until('reopened', () => js<boolean>(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); return !!t && t.loaded })()`), 20_000)
        await until(`replayed (${JSON.stringify(prompts)})`, () => js<boolean>(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); return !!t && t.loaded && t.turns.length === ${prompts.length} })()`), 20_000)
        const replayed = await js<string[]>(`window.__app.threads.get(${JSON.stringify(key)}).turns.map(t => t.user?.text)`)
        check(JSON.stringify(replayed) === JSON.stringify(prompts), `the reopened tab replays every prompt (${replayed.join(' | ')})`)
        await send('again')
        await settled('the resumed answer', 'Hello from the fake model: again')
        check(await js<string>(`${T}.key`) === key, 'a prompt in the reopened tab resumes the same session')

        // Back and forth between the chat and the TUI, by the switch in the corner.
        const tab = (label: 'Chat' | 'Terminal') => js(`(() => { document.querySelector('section [role=tab][title=${JSON.stringify(label)}]').click(); return true })()`)
        const view = () => js<{ shown: boolean, reason: string, xterm: boolean, composer: boolean, focusTerm: boolean, focusComposer: boolean, cols: number, rows: number, fit?: { cols?: number, rows?: number } }>(`(() => {
            const t = ${T}
            const v = window.__terminalView(t.tuiTerminal)
            const composer = document.querySelector('section textarea:not(.xterm-helper-textarea)')
            return { shown: t.tuiShown, reason: t.tuiReason, xterm: !!document.querySelector('section .xterm'), composer: !!composer, focusTerm: !!v && v.focused, focusComposer: !!composer && document.activeElement === composer, cols: v?.term.cols ?? 0, rows: v?.term.rows ?? 0, fit: v?.fitter.proposeDimensions() }
        })()`)
        const shownView = (what: string, ms = 5000) => until(what, async () => {
            const v = await view()
            return v.shown && v.xterm ? v : undefined
        }, ms)
        // Claude Code draws its rules across the whole width: the last one is as wide as the PTY.
        const ptyCols = async () => [...(await js<string>(`window.pi.terminalText(${T}.tuiTerminal, 80)`)).split('\n').filter(l => l.startsWith('───')).at(-1) ?? ''].length
        /** Whether the TUI stayed out of view all along `run`. */
        const neverShown = async (run: () => Promise<unknown>) => {
            const samples: boolean[] = []
            const sampling = setInterval(() => void view().then(v => samples.push(v.shown), () => {}), 50)
            await run()
            clearInterval(sampling)
            return samples.length > 0 && !samples.includes(true)
        }
        const press = (data: string) => js(`(() => { window.pi.terminalWrite(${T}.tuiTerminal, ${JSON.stringify(data)}); return true })()`)
        await startThread()
        // Sent while the TUI is still coming up: nothing to answer there, so it stays out of view.
        check(await neverShown(async () => {
            await send('warm up')
            await settled('the warm-up answer', 'Hello from the fake model: warm up')
        }), 'a prompt sent as the TUI comes up runs without showing it')
        await js(`(() => { document.querySelector('section textarea:not(.xterm-helper-textarea)').focus(); return true })()`)
        for (let i = 0; i < 8; i++) {
            await tab('Terminal')
            const shown = await until('the TUI fitted', async () => {
                const v = await view()
                return v.xterm && v.cols && v.fit?.cols === v.cols && v.fit?.rows === v.rows ? v : undefined
            }, 5000)
            check(shown.shown && !shown.composer && shown.focusTerm, `switch ${i}: the TUI takes the pane, fitted (${shown.cols}x${shown.rows}) and focused`)
            await until(`the PTY at ${shown.cols} columns`, async () => (await ptyCols()) === shown.cols, 5000)
            if (SHOTS && i === 7)
                await page.screenshot(path.join(SHOTS, 'claude-tui-switched.png'))
            await tab('Chat')
            const back = await until('the chat in view', async () => {
                const v = await view()
                return !v.xterm && v.composer ? v : undefined
            }, 5000)
            check(!back.shown && back.focusComposer, `switch ${i}: the chat comes back with the composer focused`)
        }

        // A line typed in the TUI holds the GUI's prompt back; erased, it does not.
        await tab('Terminal')
        await shownView('the TUI')
        await press('half')
        await sleep(200)
        await tab('Chat')
        await send('from the chat')
        const draft = await shownView('the TUI for its draft')
        check(draft.reason === 'draft' && await js<string>(`${T}.draft`) === 'from the chat', 'a line typed in the TUI: the prompt waits in the composer and the TUI shows why')
        for (const _ of 'half')
            await press('\x7F')
        await sleep(300)
        await tab('Chat')
        await send('from the chat')
        await settled('the answer once erased', 'Hello from the fake model: from the chat')
        check(!(await view()).shown, 'erased in the TUI, the prompt goes in and the chat stays in view')

        // Mid-stream: every switch holds, and the turn streams and ends as it would.
        await send('SLOW toggling')
        await until('streaming', () => js<boolean>(`${T}.running && JSON.stringify(${T}.streaming ?? null).includes('Slow line')`), 20_000)
        let held = true
        for (let i = 0; i < 16; i++) {
            const label = i % 2 === 0 ? 'Terminal' : 'Chat'
            await tab(label)
            await sleep(150)
            held &&= (await view()).shown === (label === 'Terminal')
        }
        check(held && await js<boolean>(`${T}.running`), 'mid-stream, the view goes where the user switches it and nowhere else')
        await settled('the streamed answer', 'Slow line 39.')
        check(!(await view()).shown, 'the turn ends in the view the user left it in')

        // A permission dialog: its card holds through the switches; answered in the TUI, the card goes at once.
        await send('BASHSLOW wait')
        await until('the approval card', () => js<boolean>(`!!${T}.uiRequests[0]?.approval`), 30_000)
        for (let i = 0; i < 6; i++) {
            await tab(i % 2 === 0 ? 'Terminal' : 'Chat')
            await sleep(150)
        }
        check(await js<number>(`${T}.uiRequests.length`) === 1, 'the approval card holds through the switches (one card)')
        await tab('Terminal')
        await sleep(300)
        await press('1')
        await until('the card gone', () => js<boolean>(`${T}.uiRequests.length === 0`), 3000)
        check(await js<boolean>(`${T}.running`), 'answered in the TUI, the card goes while the command still runs')
        await tab('Chat')
        await settled('the slow command', 'slept')
        await send('after the tui answer')
        await settled('the answer after the TUI answered', 'Hello from the fake model: after the tui answer')
        check(!(await view()).shown, 'a dialog answered with its number key is not a line in progress')

        // A dialog the GUI cannot show: the TUI comes up without taking the keyboard, and no prompt
        // from the chat goes into it as its answer.
        const before = (await js<string[]>(`${T}.turns.map(t => t.user?.text)`)).length
        await send('ASK2 two questions')
        const dialog = await shownView('the TUI for the dialog', 30_000)
        check(dialog.reason === 'dialog' && !dialog.focusTerm, 'a form only the TUI has: it shows, and keys typed elsewhere stay out of it')
        await tab('Chat')
        const asked = requests.length
        await send('not an answer')
        await sleep(1500)
        check(requests.length === asked && await js<boolean>(`${T}.running`) && await js<string>(`${T}.draft`) === 'not an answer', 'a prompt from the chat does not answer the TUI\'s dialog')
        await tab('Terminal')
        await sleep(300)
        await press('\x1B')
        await until('the dialog dismissed', async () => !(await js<boolean>(`${T}.running`)), 30_000)
        await tab('Chat')
        await js(`${T}.draft = ''`)
        check((await js<string[]>(`${T}.turns.map(t => t.user?.text)`)).length === before + 1, 'dismissed in the TUI, the turn ends')

        // The TUI's own /exit: the chat comes back, and a new prompt starts it again in the chat.
        await tab('Terminal')
        await sleep(300)
        await press('/exit')
        await sleep(300)
        await press('\r')
        await until('claude exited', () => js<boolean>(`!${T}.tuiTerminal`), 15_000)
        check(await neverShown(async () => {
            await send('back again')
            await settled('the answer after /exit', 'Hello from the fake model: back again')
        }), 'started again by a prompt, the TUI stays out of view')
    }
    catch (error) {
        // What the thread, the TUI and the session file looked like.
        const [{ page }] = await windows(1)
        const js = <T = any>(expr: string) => page.evaluate<T>(expr)
        console.error('thread:', await js(`JSON.stringify({ running: window.__app.active?.running, status: window.__app.active?.agentStatus, error: window.__app.active?.agentError, turns: window.__app.active?.turns.length, tui: window.__app.active?.tuiShown, reason: window.__app.active?.tuiReason })`).catch(String))
        console.error('requests:', requests.length)
        console.error('tui:', await js(`window.pi.terminalText(window.__app.active?.tuiTerminal, 60)`).catch(String))
        console.error('threads:', await js(`JSON.stringify([...window.__app.threads.values()].map(t => ({ key: t.key, loaded: t.loaded, prompts: t.turns.map(u => u.user?.text) })))`).catch(String))
        console.error(execFileSync('/bin/sh', ['-c', `ls -la ${JSON.stringify(path.join(config, 'projects'))}/* 2>&1; tail -c 3000 ${JSON.stringify(path.join(config, 'projects'))}/*/*.jsonl 2>&1; true`], { encoding: 'utf8' }))
        await js(`window.__app.active?.showTui(true)`).catch(() => {})
        await sleep(1000)
        throw error
    }
    finally {
        await stop()
        server.close()
    }
}

main().then(() => process.exit(0), (error) => {
    console.error(error)
    process.exit(1)
})
