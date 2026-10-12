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
//
//   bun run build && bun run e2e:claude-tui
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
        if (result) {
            const out = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
            return [{ type: 'text', text: `Tool finished: ${out.slice(0, 200)}` }]
        }
        const text = textOf(m)
        const n = requests.length
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
    }
    catch (error) {
        // What the thread, the TUI and the session file looked like.
        const [{ page }] = await windows(1)
        const js = <T = any>(expr: string) => page.evaluate<T>(expr)
        console.error('thread:', await js(`JSON.stringify({ running: window.__app.active?.running, status: window.__app.active?.agentStatus, error: window.__app.active?.agentError, turns: window.__app.active?.turns.length, tui: window.__app.active?.tuiShown, reason: window.__app.active?.tuiReason })`).catch(String))
        console.error('requests:', requests.length)
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
