// Codex threads in the built app over the native adapter, against the real `codex app-server` with
// a scripted Responses API for the model and a CODEX_HOME of its own (no account, no tokens, the
// user's Codex history untouched):
//   - a new thread switches to Codex and gets its model, reasoning and mode pickers
//   - an escalated command waits on the approval prompt; Allow runs it
//   - plan mode: Codex's question is answered in its form, the plan is reviewed in the thread, and
//     approving it leaves plan mode and starts on it
//   - the session is listed, and a reopened tab replays it
//
//   bun run build && bun run e2e:codex
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-codex')
const SHOTS = process.env.SHOTS ?? ''

type Step = { text: string } | { call: { name: string, args: Record<string, unknown> } }
const script: Step[] = []
const requests: any[] = []

function respond(res: http.ServerResponse, step: Step | undefined, n: number) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('response.created', { response: { id: `r${n}` } })
    if (step && 'call' in step) {
        const item = { type: 'function_call', id: `fc${n}`, call_id: `call_${n}`, name: step.call.name, arguments: JSON.stringify(step.call.args) }
        ev('response.output_item.added', { output_index: 0, item })
        ev('response.output_item.done', { output_index: 0, item })
    }
    else {
        const text = step?.text ?? 'out of script'
        const item = { type: 'message', role: 'assistant', id: `m${n}`, content: [{ type: 'output_text', text }] }
        ev('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
        ev('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: text })
        ev('response.output_item.done', { output_index: 0, item })
    }
    ev('response.completed', { response: { id: `r${n}`, usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 40, total_tokens: 1240 } } })
    res.end()
}

async function main() {
    const codex = execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim()
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const home = path.join(WORK, 'codex-home')
    await Promise.all([repo, userData, agentDir, home].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'init', '-q'], { cwd: repo })

    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
            body += c
        })
        req.on('end', () => {
            const n = requests.length
            requests.push(JSON.parse(body || '{}'))
            respond(res, script.shift(), n)
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await writeFile(path.join(home, 'config.toml'), [
        'model = "mock-model"',
        'model_provider = "mock"',
        // A folder the user trusts: Codex starts it in workspace-write.
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
        PI_GUI_ACP_CODEX: JSON.stringify([codex, 'app-server']),
        CODEX_HOME: home,
    })
    try {
        const [{ page }] = await windows(1)
        const js = <T = any>(expr: string) => page.evaluate<T>(expr)
        const T = 'window.__app.active'
        const R = JSON.stringify(repo)
        const click = (label: string) => js(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); return true })()`)

        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('a new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty`))
        await js(`${T}.setAgent('codex')`)
        await until('Codex ready', () => js<boolean>(`${T}.agent === 'codex' && ${T}.agentStatus === 'ready'`), 30_000)
        check(true, 'a new Codex thread starts (thread/start takes the approval policy now)')
        const options = await js<string[]>(`${T}.configOptions.map(o => o.id + '=' + o.currentValue)`)
        check(options.includes('mode=auto'), `the mode picker opens in Auto for a trusted folder (${options.join(', ')})`)
        await until('the mode picker', () => js<boolean>(`!![...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Mode: Auto')`))
        check(true, 'Codex\'s modes get a picker in the composer')

        // An escalated command: the approval prompt, then Allow.
        script.push({ call: { name: 'exec_command', args: { cmd: 'touch marker.txt && echo made', sandbox_permissions: 'require_escalated', justification: 'Create the marker file' } } }, { text: 'Made **marker.txt**.' })
        await js(`(() => { const t = ${T}; t.draft = 'make the marker'; void t.send(); return true })()`)
        await until('the approval prompt', () => js<boolean>(`!!${T}.uiRequests[0]?.approval`))
        const text = await js<string>(`document.body.innerText`)
        check(text.includes('needs your approval') && text.includes('Create the marker file'), 'the command waits on the approval prompt with Codex\'s reason')
        check(text.includes('Always allow touch marker.txt'), 'Always offers Codex\'s exec-policy rule')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-approval.png'))
        await click('Allow')
        await until('the run settles', () => js<boolean>(`(() => { const t = ${T}; return !t.running && t.persisted && t.key === t.sessionPath })()`), 20_000)
        check(existsSync(path.join(repo, 'marker.txt')), 'Allow ran the command')
        const key = await js<string>(`${T}.key`)
        check(key.startsWith('acp:codex:'), `the thread is keyed by its Codex thread (${key})`)
        const steps = await js<string[]>(`${T}.turns.at(-1).steps.map(s => s.kind === 'tool' ? 'tool:' + s.call.name + (s.result ? (s.result.isError ? ':error' : ':ok') : ':none') : s.kind)`)
        check(JSON.stringify(steps) === JSON.stringify(['tool:bash:ok', 'text']), `the turn reads Bash, then the answer (${steps.join(', ')})`)
        check((await js<string>(`document.body.innerText`)).includes('Made marker.txt.'), 'the answer is in the transcript')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-run.png'))

        // Plan mode: a question, then the plan to review.
        await js(`${T}.setConfigOption('mode', 'plan')`)
        await until('plan mode', () => js<boolean>(`${T}.configOptions.find(o => o.id === 'mode')?.currentValue === 'plan'`))
        script.push(
            { call: { name: 'request_user_input', args: { questions: [{ id: 'store', header: 'Storage', question: 'Where should notes live?', options: [{ label: 'SQLite', description: 'One file' }, { label: 'Markdown files', description: 'One per note' }] }] } } },
            { text: 'Here is the plan.\n<proposed_plan>\n# Notes storage\n\n1. Add a `notes/` folder\n2. Write one Markdown file per note\n</proposed_plan>' },
            { text: 'Done: notes live in `notes/`.' },
        )
        await js(`(() => { const t = ${T}; t.draft = 'plan the notes storage'; void t.send(); return true })()`)
        await until('the question form', () => js<boolean>(`document.body.innerText.includes('Where should notes live?')`))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-ask.png'))
        const askId = await js<string>(`[...${T}.tools.entries()].find(([, s]) => s.partial?.details?.kind === 'ask')[0]`)
        await js(`${T}.answerAsk(${JSON.stringify(askId)}, { answers: { store: { selected: ['Markdown files'] } } })`)
        await until('the plan review', () => js<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Approve and start')`), 20_000)
        check(JSON.stringify(requests.at(-1).input).includes('Markdown files'), 'the answer went back to Codex')
        check((await js<string>(`document.body.innerText`)).includes('Write one Markdown file per note'), 'the proposed plan shows for review')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-plan.png'))
        await click('Approve and start')
        await until('the plan runs', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('notes live in') })()`), 20_000)
        check(JSON.stringify(requests.at(-1).input).includes('Implement the plan.'), 'approving sends Codex\'s "Implement the plan."')
        check(await js<string>(`${T}.configOptions.find(o => o.id === 'mode')?.currentValue`) === 'auto', 'and leaves plan mode')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-plan-done.png'))

        // Listed, and replayed from Codex when reopened.
        await until('the session is listed', () => js<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(key)} && s.agent === 'codex')`))
        const prompts = await js<string[]>(`${T}.turns.map(t => t.user?.text)`)
        await js(`window.__app.closeTab(${JSON.stringify(key)})`)
        await until('tab closed', () => js<boolean>(`!window.__app.threads.has(${JSON.stringify(key)})`))
        await js(`(() => { window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(key)})); return true })()`)
        await until('replayed', () => js<boolean>(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); return !!t && t.loaded && t.turns.length === ${prompts.length} })()`), 20_000)
        const replayed = await js<string[]>(`window.__app.threads.get(${JSON.stringify(key)}).turns.map(t => t.user?.text)`)
        check(JSON.stringify(replayed) === JSON.stringify(prompts), `the reopened tab replays every prompt (${replayed.join(' | ')})`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-replayed.png'))
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
