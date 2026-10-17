// Slash commands typed into the composer of each agent in the built app, with a screenshot of each
// case in SHOTS (default ~/Documents/filo-command-shots):
//   - Grok Build (test/fakeGrok.mjs): the menu, a command that prints nothing, /compact typed,
//     /compact from the context figure, /compact while running (queued), an unknown command, /new, /resume
//   - OpenCode (test/fakeAcp.mjs): a listed command goes through, an unlisted one is refused
//   - Codex (the real `codex app-server`, scripted model): the menu, an unlisted command is refused
//   - Claude Code (the real `claude`, scripted API): what a local command prints shows under it
//   - pi: the menu keeps all of its app commands
//
//   bun run build && bun run e2e:commands
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-commands')
const SHOTS = process.env.SHOTS || path.join(os.homedir(), 'Documents', 'filo-command-shots')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const FAKE_ACP = path.resolve(import.meta.dirname, 'fakeAcp.mjs')
const FAKE_GROK = path.resolve(import.meta.dirname, 'fakeGrok.mjs')

/** A model API that answers every request with a short text, for Codex (Responses) and Claude Code (Messages). */
function modelServer() {
    return http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
            body += c
        })
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}')
            if (req.url?.includes('count_tokens')) {
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
                return
            }
            if (req.url?.includes('/messages')) {
                const answer = () => {
                    const message = { id: 'msg_fake', type: 'message', role: 'assistant', model: parsed.model || 'fake', content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
                    const text = Array.isArray(parsed.tools) && parsed.tools.length >= 5 ? 'Hello from the fake model.' : 'Fake title'
                    if (!parsed.stream) {
                        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' }))
                        return
                    }
                    res.writeHead(200, { 'content-type': 'text/event-stream' })
                    const ev = (name: string, data: Record<string, unknown>) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`)
                    ev('message_start', { message })
                    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
                    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
                    ev('content_block_stop', { index: 0 })
                    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } })
                    ev('message_stop', {})
                    res.end()
                    return
                }
                // Claude Code's /compact asks for a summary as the last message: real ones take many seconds.
                if (JSON.stringify(parsed.messages?.at(-1)?.content ?? '').includes('detailed summary'))
                    setTimeout(answer, 3000)
                else
                    answer()
                return
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
            const text = 'Hello from the fake model.'
            const item = { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text }] }
            ev('response.created', { response: { id: 'r1' } })
            ev('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
            ev('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: text })
            ev('response.output_item.done', { output_index: 0, item })
            ev('response.completed', { response: { id: 'r1', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, total_tokens: 1240 } } })
            res.end()
        })
    })
}

async function main() {
    const sh = (cmd: string) => execFileSync('/bin/sh', ['-lc', cmd], { encoding: 'utf8' }).trim()
    const codex = sh('command -v codex')
    const claude = sh('command -v claude')
    await rm(WORK, { recursive: true, force: true })
    await mkdir(SHOTS, { recursive: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const fakeDir = path.join(WORK, 'fake-acp')
    const codexHome = path.join(WORK, 'codex-home')
    const claudeConfig = path.join(WORK, 'claude-config')
    await Promise.all([repo, userData, agentDir, fakeDir, codexHome, claudeConfig].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'init', '-q'], { cwd: repo })
    await writeFile(path.join(claudeConfig, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [repo]: { hasTrustDialogAccepted: true } } }))
    await writeFile(path.join(claudeConfig, 'settings.json'), JSON.stringify({ disableAllHooks: false }))

    const server = modelServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await writeFile(path.join(codexHome, 'config.toml'), [
        'model = "mock-model"',
        'model_provider = "mock"',
        `[projects.${JSON.stringify(repo)}]`,
        'trust_level = "trusted"',
        '[model_providers.mock]',
        'name = "mock"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'wire_api = "responses"',
        '',
    ].join('\n'))
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
    const stop = await launch({
        PI_GUI_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_GUI_TEST: '1',
        PI_GUI_ACP_GROK: JSON.stringify(['node', FAKE_GROK]),
        PI_GUI_ACP_OPENCODE: JSON.stringify(['node', FAKE_ACP, '--agent=opencode']),
        PI_GUI_ACP_CODEX: JSON.stringify([codex, 'app-server']),
        PI_GUI_ACP_CLAUDE: JSON.stringify([claude, '--permission-mode', 'default']),
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: 'fake-local',
        ANTHROPIC_API_KEY: '',
        FAKE_ACP_DIR: fakeDir,
        FAKE_GROK_DIR: fakeDir,
        FAKE_GROK_BASH_MS: '1500',
        FAKE_GROK_COMPACT_MS: '2500',
    })
    try {
        const [{ page }] = await windows(1)
        const js = <T = any>(expr: string) => page.evaluate<T>(expr)
        const T = 'window.__app.active'
        const R = JSON.stringify(repo)
        const shot = async (name: string) => {
            await sleep(500)
            await page.screenshot(path.join(SHOTS, `${name}.png`))
            console.log(`   shot ${name}.png`)
        }
        const startThread = async (agent: string, ready = 30_000) => {
            await js(`(() => { window.__app.newThread(${R}); return true })()`)
            await until('a new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty && ${T}.agent === 'pi'`))
            await js(`${T}.setAgent(${JSON.stringify(agent)})`)
            await until(`${agent} ready`, () => js<boolean>(`${T}.agent === ${JSON.stringify(agent)} && ${T}.agentStatus === 'ready'`), ready)
        }
        /** Typed into the composer and sent with Enter, as a person does. */
        const typeLine = async (text: string, send = true) => {
            await js(`(() => { const t = ${T}; t.draft = ${JSON.stringify(text)}; document.querySelector('textarea').focus(); return true })()`)
            await until('the draft shows', () => js<boolean>(`document.querySelector('textarea').value === ${JSON.stringify(text)}`))
            if (!send)
                return
            const enter = async () => {
                await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
                await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
            }
            // A command typed out in full goes with one Enter, menu open or not.
            await enter()
        }
        const menu = () => js<string[]>(`[...document.querySelectorAll('[role=option]')].map(o => o.textContent)`)
        const toasts = () => js<string[]>(`[...document.querySelectorAll('[data-sonner-toast]')].map(t => t.textContent)`)
        const turns = () => js<number>(`${T}.turns.length`)
        const settled = (what: string, needle: string, ms = 30_000) => until(what, async () => !(await js<boolean>(`${T}.running`)) && (await js<string>(`JSON.stringify(${T}.turns.at(-1)?.steps ?? [])`)).includes(needle), ms)
        const notes = (needle: string) => js<number>(`${T}.turns.flatMap(t => t.steps).filter(s => s.kind === 'note' && JSON.stringify(s).includes(${JSON.stringify(needle)})).length`)

        // ------------------------------------------------------------------ Grok Build
        console.log('# Grok Build')
        await startThread('grok')
        await until('Grok commands', () => js<boolean>(`${T}.commands.some(c => c.name === 'compact')`))
        await typeLine('/', false)
        await until('the menu', async () => (await menu()).length > 0)
        let names = (await menu()).join(' | ')
        check(names.includes('new') && names.includes('resume') && names.includes('compact'), `the menu lists /new and /resume beside Grok's own commands (${names})`)
        await shot('01-grok-slash-menu')
        // A partial name is completed by Enter, not sent.
        await typeLine('/cont')
        await until('the name completed', async () => (await js<string>(`${T}.draft`)) === '/context ')
        check((await turns()) === 0, 'Enter on a partial name completes it and sends nothing')

        await js(`${T}.draft = ''`)
        await typeLine('hello')
        await settled('the first answer', 'echo: hello')
        const before = await js<number>(`${T}.stats?.contextUsage?.tokens ?? 0`)
        check(before > 0, `the status line has a context figure (${before} tokens)`)
        await shot('02-grok-after-first-prompt')

        const t0 = await turns()
        await typeLine('/context')
        await until('the note', async () => (await notes('Done, with no output')) === 1)
        check((await turns()) === t0 + 1, '/context (Grok prints nothing) makes one turn, with a note instead of a bare prompt')
        check(await js<boolean>(`${T}.draft === ''`), 'the draft is cleared')
        await shot('03-grok-silent-command')

        await typeLine('/compact')
        // It takes a while: the thread says so (a working line), not nothing.
        const workingLine = () => js<boolean>(`[...document.querySelectorAll('span')].some(e => e.children.length === 0 && e.textContent === 'Compacting context…')`)
        await until('the compacting line', workingLine, 5000)
        check(true, 'while Grok compacts the thread shows a "Compacting context…" working line')
        await shot('04a-grok-compacting')
        await until('compacted', async () => (await notes('Context compacted')) === 1, 15_000)
        check(!(await workingLine()), 'and the line is gone once it is done')
        check(await js<number>(`${T}.stats.contextUsage.tokens`) < before + 100, 'typed /compact compacts, and the context figure shrinks without reopening the thread')
        check(!(await js<boolean>(`${T}.compacting`)) && (await js<string>(`${T}.draft`)) === '', 'the compacting state ends and the draft is cleared')
        await shot('04-grok-compact-typed')

        await typeLine('hello again')
        await settled('a second answer', 'echo: hello again')
        await until('the figure button', () => js<boolean>(`!!document.querySelector('button[title*="/compact"]')`))
        await shot('05-grok-context-figure')
        await js(`(() => { document.querySelector('button[title*="/compact"]').click(); return true })()`)
        await until('compacted again', async () => (await notes('Context compacted')) === 2, 15_000)
        check(true, 'clicking the context figure compacts too, with its own note')
        await shot('06-grok-compact-click')

        await typeLine('bash')
        await until('running', () => js<boolean>(`${T}.running`))
        await typeLine('/compact')
        // Enter while it runs steers, as in pi: the text reaches the agent as a message, no compaction starts on top of the command.
        await until('steered', () => js<boolean>(`JSON.stringify(${T}.turns.at(-1)).includes('/compact')`))
        check(!(await js<boolean>(`${T}.compacting`)), '/compact typed while a command runs is steered like any text; no compaction starts on top of it')
        await shot('07-grok-compact-while-running')
        await until('the run ends', () => js<boolean>(`!${T}.running`), 40_000)
        check(await notes('Context compacted') === 2, 'and no third compaction note appeared')

        const t1 = await turns()
        await typeLine('/nonsense')
        await until('the toast', async () => (await toasts()).some(t => t.includes('has no /nonsense')))
        check((await turns()) === t1 && (await js<string>(`${T}.draft`)) === '/nonsense', 'an unlisted command is refused with a toast: nothing is sent, the text stays')
        await shot('08-grok-unknown-command')

        const tabs = await js<number>(`window.__app.tabs.length`)
        const grokKey = await js<string>(`${T}.key`)
        await js(`${T}.draft = ''`)
        await typeLine('/new')
        await until('a new tab', () => js<boolean>(`${T}.key !== ${JSON.stringify(grokKey)} && ${T}.isEmpty`))
        check((await js<number>(`window.__app.tabs.length`)) === tabs + 1, '/new opens a new thread (the app\'s own command)')
        await shot('09-grok-new')
        await js(`window.__app.closeTab(${T}.key)`)
        await until('back on Grok', () => js<boolean>(`${T}.key === ${JSON.stringify(grokKey)}`))

        await typeLine('/resume')
        await until('search open', () => js<boolean>(`window.__app.searchOpen === true`))
        check(true, '/resume opens the session search')
        await shot('10-grok-resume')
        await js(`(() => { window.__app.setSearchOpen(false); return true })()`)
        await js(`${T}.draft = ''`)

        // ------------------------------------------------------------------ OpenCode
        console.log('# OpenCode')
        await startThread('opencode')
        await until('OpenCode commands', () => js<boolean>(`${T}.commands.some(c => c.name === 'review')`))
        await typeLine('/re', false)
        await until('the menu', async () => (await menu()).length > 0)
        names = (await menu()).join(' | ')
        check(names.includes('review') && names.includes('resume'), `the menu filters the agent's and the app's commands (${names})`)
        await shot('11-opencode-slash-menu')
        await js(`${T}.draft = ''`)
        await typeLine('/review')
        await settled('the review ran', 'echo: /review')
        check(true, 'a command the agent lists (/review) goes to it')
        await shot('12-opencode-listed-command')
        const o0 = await turns()
        await typeLine('/undo')
        await until('the toast', async () => (await toasts()).some(t => t.includes('has no /undo')))
        check((await turns()) === o0, 'a command it does not list (/undo) is refused, not sent to the model')
        await shot('13-opencode-unknown-command')
        await js(`${T}.draft = ''`)

        // ------------------------------------------------------------------ Codex
        console.log('# Codex')
        await startThread('codex')
        await typeLine('/', false)
        await until('the menu', async () => (await menu()).length > 0)
        names = (await menu()).join(' | ')
        check(names.includes('compact') && names.includes('new') && names.includes('resume'), `the menu lists /compact, /new, /resume (${names})`)
        await shot('14-codex-slash-menu')
        await js(`${T}.draft = ''`)
        await typeLine('hello codex')
        await settled('the answer', 'Hello from the fake model')
        check(true, 'a plain prompt still runs')
        const c0 = await turns()
        await typeLine('/status')
        await until('the toast', async () => (await toasts()).some(t => t.includes('has no /status')))
        check((await turns()) === c0 && (await js<string>(`${T}.draft`)) === '/status', 'Codex\'s terminal-only /status is refused with a toast, not sent as text')
        await shot('15-codex-unknown-command')
        await js(`${T}.draft = ''`)
        // Codex's /diff has a place in the app: the changes panel.
        const d0 = await turns()
        const panel = () => js<boolean>(`window.__app.reviewOpen`)
        const open0 = await panel()
        await typeLine('/diff')
        await until('the panel toggled', async () => (await panel()) !== open0)
        check((await turns()) === d0 && (await js<string>(`${T}.draft`)) === '', '/diff opens the changes panel, sends nothing and clears the draft')
        await shot('16-codex-diff')
        // Codex's /model opens the model menu.
        const menuOpen = () => js<boolean>(`!!document.querySelector('[role="menu"]')`)
        await typeLine('/model')
        await until('the model menu', menuOpen)
        check((await turns()) === d0 && (await js<string>(`${T}.draft`)) === '', '/model opens the model menu and sends nothing')
        await shot('17-codex-model')
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await until('the menu closed', async () => !(await menuOpen()))
        await typeLine('/diff')
        await until('the panel toggled back', async () => (await panel()) === open0)

        // ------------------------------------------------------------------ Claude Code
        console.log('# Claude Code')
        await startThread('claude')
        await until('the TUI at its prompt', () => js<boolean>(`!!${T}.tuiTerminal`), 15_000)
        await sleep(8000)
        await typeLine('hello claude')
        await settled('the answer', 'Hello from the fake model')
        const customNotes = `${T}.turns.flatMap(t => t.steps).filter(s => s.kind === 'note' && s.variant === 'command')`
        let shotN = 18
        for (const command of ['/cost', '/context', '/zzz-unknown']) {
            await js(`${T}.showTui(false)`)
            const k0 = await js<number>(`${customNotes}.length`)
            await typeLine(command)
            await sleep(800)
            // Either Claude Code wrote what it printed to the session file (a note under the command), or it only drew it on
            // its screen: then the thread shows the TUI, and must not wait for a turn that never comes.
            const how = await until(`${command} settled`, async () => {
                if (!(await js<boolean>(`${T}.running`)))
                    return (await js<number>(`${customNotes}.length`)) > k0 ? 'note' : (await js<boolean>(`${T}.tuiShown`)) ? 'tui' : 'bare'
                return undefined
            }, 25_000)
            const note = how === 'note' ? await js<string>(`${customNotes}.at(-1).text`) : ''
            if (how === 'note')
                check(await js<string>(`${customNotes}.at(-1).title`) === command, `${command}'s note sits under ${command}`)
            check(how !== 'bare' && !note.includes('\u001B'), `${command}: ${how === 'note' ? `shows what Claude Code printed ("${note.trim().replaceAll('\n', ' ').slice(0, 60)}")` : 'answered on its screen: the thread is not left running, and shows the TUI'}`)
            // The terminal behind the dialog redraws a moment after the thread shows it.
            if (how === 'tui')
                await sleep(2500)
            await shot(`${shotN++}-claude-${command.slice(1).replaceAll(' ', '-')}${how === 'tui' ? '-tui' : ''}`)
            await js(`${T}.showTui(false)`)
            check(!(await js<boolean>(`${T}.running`)), `${command}: the thread is idle again`)
            // What it printed lands in the session file once any dialog it opened is closed (the next prompt does that, below).
            if (how === 'note')
                await shot(`${shotN++}-claude-${command.slice(1).replaceAll(' ', '-')}-chat`)
        }

        // Claude Code's /compact takes a while: the thread shows it working (its PreCompact and PostCompact hooks),
        // and leaves the summary note when it is done.
        {
            await js(`${T}.showTui(false)`)
            await typeLine('/compact')
            const workingLine = () => js<boolean>(`[...document.querySelectorAll('span')].some(e => e.children.length === 0 && e.textContent === 'Compacting context…')`)
            const t0 = Date.now()
            await until('the compacting line', workingLine, 8000)
            const seen = Date.now() - t0
            await shot(`${shotN++}-claude-compacting`)
            await until('the summary note', () => js<boolean>(`${T}.turns.flatMap(t => t.steps).some(s => s.kind === 'note' && s.variant === 'compaction')`), 20_000)
            check(!(await js<boolean>(`${T}.compacting`)) && !(await workingLine()), `/compact: "Compacting context…" showed ${seen}ms in, and gave way to the summary note`)
            check(Date.now() - t0 > 2000, '/compact: the working line stayed for the whole compaction, not just a blink')
            // After it settles: the command first, then the summary note, then what it printed; none of our hooks in it.
            await until('what /compact printed', () => js<boolean>(`document.body.innerText.includes('Compacted (ctrl+o')`), 8000)
            const text = await js<string>(`document.body.innerText`)
            const at = (needle: string) => text.lastIndexOf(needle)
            check(at('/compact') < at('Context compacted') && at('Context compacted') < at('Compacted (ctrl+o'), '/compact: the command, then the "Context compacted" note, then what Claude Code printed')
            check(!text.includes('claude-hook'), '/compact: our hooks\' lines are not in what it printed')
            await shot(`${shotN++}-claude-compacted`)
        }
        // /cost's dialog took no keys from this prompt: the GUI closed it first, and the dialog's printout landed.
        await typeLine('still there')
        await settled('the answer after the commands', 'Hello from the fake model')
        check(true, 'a prompt after a screen-only command still runs (the dialog it left open was closed first)')
        await until('the /usage printout', () => js<boolean>(`${customNotes}.some(s => s.title === '/usage')`), 8000)
        check(true, '/cost\'s printout shows under it once the dialog is closed')
        // Each command ran: /context was not swallowed by /cost's dialog (hiding the TUI sends focus reports, which are not keys).
        await until('the /context printout', () => js<boolean>(`${customNotes}.some(s => s.title === '/context')`), 8000)
        check(true, '/context ran after /cost and shows its own printout')
        await shot(`${shotN++}-claude-after-commands`)

        // ------------------------------------------------------------------ pi
        console.log('# pi')
        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('a pi thread', () => js<boolean>(`!!${T} && ${T}.isEmpty && ${T}.agent === 'pi'`))
        await typeLine('/', false)
        await until('the menu', async () => (await menu()).length > 0)
        names = (await menu()).join(' | ')
        check(['new', 'resume', 'settings', 'login', 'copy', 'export'].every(n => names.includes(n)), `pi's menu keeps every app command (${names.slice(0, 120)})`)
        check(!names.includes('diff'), 'and has no /diff, which pi\'s terminal does not either')
        await shot('27-pi-slash-menu')
        await js(`${T}.draft = ''`)
        console.log(`all command checks passed; screenshots in ${SHOTS}`)
    }
    catch (error) {
        const [{ page }] = await windows(1).catch(() => [{ page: undefined }])
        if (page) {
            await page.screenshot(path.join(SHOTS, 'FAILED.png')).catch(() => {})
            console.error(await page.evaluate<string>(`JSON.stringify({ draft: window.__app.active?.draft, running: window.__app.active?.running, turns: window.__app.active?.turns.slice(-2).map(t => ({ user: t.user?.text, steps: t.steps.map(s => s.kind + ':' + (s.text ?? s.title ?? '')) })) })`).catch(() => ''))
        }
        throw error
    }
    finally {
        await stop()
        server.close()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
