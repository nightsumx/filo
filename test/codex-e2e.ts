// Codex threads in the built app over the native adapter, against the real `codex app-server` with
// a scripted Responses API for the model and a CODEX_HOME of its own (no account, no tokens, the
// user's Codex history untouched):
//   - a new thread switches to Codex and gets its model, reasoning and mode pickers
//   - an escalated command waits on the approval prompt; Allow runs it
//   - plan mode: Codex's question is answered in its form, the plan is reviewed in the thread, and
//     approving it leaves plan mode and starts on it
//   - the session is listed, and a reopened tab replays it
//   - steer, stop, ask again, fork, compact, a subagent with its own approval
//   - an MCP tool call asks first; the server's form is the ask form; request_permissions asks
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

/** One model reply; `when` answers only a request whose user messages have that text (a subagent's). */
type Step = ({ text: string } | { call: { name: string, namespace?: string, args: Record<string, unknown> } }) & { when?: string }
const script: Step[] = []
const requests: any[] = []

function respond(res: http.ServerResponse, step: Step | undefined, n: number, input: unknown) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('response.created', { response: { id: `r${n}` } })
    if (step && 'call' in step) {
        // `$AGENT`: the id spawn_agent returned, as the model would pass it on.
        const agentId = /\\"agent_id\\":\\"([^\\"]+)/.exec(JSON.stringify(input))?.[1] ?? ''
        const args = JSON.stringify(step.call.args).replaceAll('$AGENT', agentId)
        const item = { type: 'function_call', id: `fc${n}`, call_id: `call_${n}`, name: step.call.name, ...(step.call.namespace ? { namespace: step.call.namespace } : {}), arguments: args }
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
            const users = JSON.stringify((requests[n].input ?? []).filter((i: any) => i.role === 'user'))
            let at = script.findIndex(st => st.when && users.includes(st.when))
            if (at === -1)
                at = script.findIndex(st => !st.when)
            respond(res, at === -1 ? undefined : script.splice(at, 1)[0], n, requests[n].input)
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
        '[features]',
        'request_permissions_tool = true',
        // An MCP server with a tool that asks the user through a form (elicitation).
        '[mcp_servers.demo]',
        'command = "node"',
        `args = [${JSON.stringify(path.resolve('test/fakeMcp.mjs'))}]`,
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

        // The reopened tab writes again: a prompt resumes the thread.
        const exec = (cmd: string): Step => ({ call: { name: 'exec_command', args: { cmd } } })
        const settle = (what: string, ms = 20_000) => until(what, () => js<boolean>(`(() => { const t = ${T}; return t.key === ${JSON.stringify(key)} && !t.running })()`), ms)
        check(await js<string>(`${T}.key`) === key, 'the reopened tab is the active one')
        script.push({ text: 'Third answer.' })
        await js(`(() => { const t = ${T}; t.draft = 'third'; void t.send(); return true })()`)
        await until('the third answer', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('Third answer.') })()`), 20_000)
        check(true, 'a prompt in the reopened tab resumes the thread')

        // Steer: typed mid-run, it joins the running turn.
        script.push(exec('sleep 2'), { text: 'Took it in.' })
        await js(`(() => { const t = ${T}; t.draft = 'slow'; void t.send(); return true })()`)
        await until('the command runs', () => js<boolean>(`${T}.running && document.body.innerText.includes('sleep 2')`))
        check((await js<string>(`document.querySelector('textarea').placeholder`)).startsWith('Type to steer Codex'), 'mid-run the composer offers to steer')
        await js(`(() => { const t = ${T}; t.draft = 'also this'; void t.send(); return true })()`)
        await settle('the steered turn ends')
        check(JSON.stringify(requests.at(-1).input).includes('also this'), 'the steer reached the model in the same turn')
        const steered = await js<string[]>(`${T}.turns.map(t => t.user?.text)`)
        check(steered.at(-1) === 'slow' || steered.at(-1) === 'also this', `the steer shows in the transcript (${steered.slice(-2).join(' | ')})`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-steer.png'))

        // Stop: interrupts a running command.
        script.push(exec('sleep 30'))
        await js(`(() => { const t = ${T}; t.draft = 'wait'; void t.send(); return true })()`)
        await until('the long command runs', () => js<boolean>(`${T}.running && document.body.innerText.includes('sleep 30')`))
        const t0 = Date.now()
        await js(`${T}.abort()`)
        await settle('stopped', 8000)
        check(Date.now() - t0 < 5000, `Stop ends the run (${Date.now() - t0}ms)`)

        // Ask again from the last prompt: thread/revert, and the prompt comes back to edit.
        const before = await js<number>(`${T}.turns.length`)
        await js(`(() => { void window.__app.forkThread(${T}, ${T}.turns.at(-1).key, true); return true })()`)
        await until('rewound', () => js<boolean>(`${T}.turns.length === ${before - 1} && ${T}.draft === 'wait'`))
        check(true, 'Ask again drops the last turn and puts its prompt back in the composer')
        await js(`(() => { ${T}.draft = ''; return true })()`)

        // Fork from here (a new tab) while this tab has the thread open.
        const kept = await js<number>(`${T}.turns.length`)
        await js(`(() => { void window.__app.forkThread(${T}, ${T}.turns[1].key, false); return true })()`)
        const forkKey = await until('the fork tab', () => js<string>(`(() => { const t = ${T}; return t.key !== ${JSON.stringify(key)} && t.key.startsWith('acp:codex:') && !t.running && t.turns.length === 1 && t.draft === 'plan the notes storage' ? t.key : '' })()`))
        check(true, `Fork from here opens a tab on a new thread with the turns before the prompt (${forkKey})`)
        check(await js<number>(`window.__app.threads.get(${JSON.stringify(key)}).turns.length`) === kept, 'the thread it came from keeps its turns')
        script.push({ text: 'Branch answer.' })
        await js(`(() => { const t = ${T}; t.draft = 'another way'; void t.send(); return true })()`)
        await until('the fork answers', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('Branch answer.') })()`), 20_000)
        check(!JSON.stringify(requests.at(-1).input).includes('Third answer.'), 'the fork\'s model input leaves out the later turns')
        await until('the fork is listed', () => js<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(forkKey)})`))
        check(true, 'the fork is listed')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-fork.png'))

        // Compact, back in the first tab.
        await js(`window.__app.focus(${JSON.stringify(key)})`)
        await until('back on the first tab', () => js<boolean>(`${T}.key === ${JSON.stringify(key)}`))
        check(await js<boolean>(`${T}.features.compaction`), 'Compact is offered (Codex lists /compact)')
        script.push({ text: 'Summary: notes in Markdown.' })
        await js(`(() => { void ${T}.compact(); return true })()`)
        await until('compacted', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('compaction') })()`), 20_000)
        check(true, 'Compact runs as a turn and leaves a compaction note')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-compact.png'))

        // A subagent: its call shows its work, its command asks in the thread.
        script.push(
            { call: { name: 'spawn_agent', namespace: 'multi_agent_v1', args: { message: 'CHILD TASK: list the repo' } } },
            { when: 'CHILD TASK', call: { name: 'exec_command', args: { cmd: 'touch child.txt && ls', sandbox_permissions: 'require_escalated', justification: 'The subagent writes child.txt' } } },
            { when: 'CHILD TASK', text: 'The repo has README.md and child.txt.' },
            { call: { name: 'wait_agent', namespace: 'multi_agent_v1', args: { targets: ['$AGENT'], timeout_ms: 30000 } } },
            { text: 'The subagent listed the repo.' },
        )
        await js(`(() => { const t = ${T}; t.draft = 'delegate the listing'; void t.send(); return true })()`)
        await until('the subagent\'s approval', () => js<boolean>(`!!${T}.uiRequests[0]?.approval && document.body.innerText.includes('The subagent writes child.txt')`))
        const sub = await js<any>(`(() => { const s = ${T}.turns.at(-1).steps.find(s => s.kind === 'tool' && s.call.name === 'subagent') ?? null; return s && { id: s.call.id, running: s.running } })()`)
            ?? await js<any>(`(() => { const c = ${T}.streaming?.content?.find(c => c.type === 'toolCall' && c.name === 'subagent'); return c && { id: c.id } })()`)
        check(!!sub, 'spawn_agent shows as a subagent call')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-subagent-approval.png'))
        await click('Allow')
        await until('the run with the subagent ends', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('The subagent listed the repo.') })()`), 20_000)
        check(existsSync(path.join(repo, 'child.txt')), 'Allow let the subagent\'s command run')
        const run = await js<any>(`(() => { const s = ${T}.turns.at(-1).steps.find(s => s.kind === 'tool' && s.call.name === 'subagent'); return { status: s.result?.details?.status, title: s.result?.details?.title, n: s.result?.details?.messages?.length } })()`)
        check(run.status === 'done' && run.n === 4, `the subagent call ends done with the child's transcript (${JSON.stringify(run)})`)
        check(!!run.title && run.title !== 'Subagent', `it carries Codex's name for the subagent (${run.title})`)
        const wait = await js<string>(`${T}.turns.at(-1).steps.find(s => s.kind === 'tool' && s.call.name === 'agent')?.call.arguments.description`)
        check(wait === `Wait for ${run.title}`, `wait_agent reads as "Wait for <name>" (${wait})`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-subagent.png'))
        await js(`${T}.showSubagent(${JSON.stringify(sub.id)})`)
        await until('the subagent pane', () => js<boolean>(`document.body.innerText.includes('The repo has README.md and child.txt.')`))
        check(true, 'the subagent opens in the thread pane with its transcript')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-subagent-pane.png'))
        await js(`${T}.showSubagent(null)`)

        // An MCP tool: Codex asks before it runs, then the server asks the user with a form.
        script.push({ call: { name: 'pick_color', namespace: 'mcp__demo', args: {} } }, { text: 'Theme color set.' })
        await js(`(() => { const t = ${T}; t.draft = 'pick the theme color'; void t.send(); return true })()`)
        await until('the MCP approval', () => js<boolean>(`!!${T}.uiRequests[0]?.approval && document.body.innerText.includes('demo.pick_color')`))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-mcp-approval.png'))
        await click('Allow')
        await until('the MCP form', () => js<boolean>(`document.body.innerText.includes('Pick a color for the theme')`))
        check(true, 'Allow runs the MCP tool, whose form shows as questions')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-mcp-form.png'))
        const formId = await js<string>(`[...${T}.tools.entries()].find(([, s]) => s.partial?.details?.kind === 'ask' && s.partial.details.status === 'pending')[0]`)
        await js(`${T}.answerAsk(${JSON.stringify(formId)}, { answers: { color: { selected: ['green'] }, shade: { selected: [], text: 'mint' } } })`)
        await until('the MCP run ends', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('Theme color set.') })()`), 20_000)
        const answered = JSON.stringify(requests.at(-1).input)
        check(answered.includes('\\"color\\":\\"green\\"') && answered.includes('\\"shade\\":\\"mint\\"'), 'the form\'s answers went to the MCP server')

        // request_permissions: the access asked for, on an approval prompt.
        script.push({ call: { name: 'request_permissions', args: { permissions: { network: { enabled: true } }, reason: 'Fetch the color palette' } } }, { text: 'Palette fetched.' })
        await js(`(() => { const t = ${T}; t.draft = 'fetch the palette'; void t.send(); return true })()`)
        await until('the permission prompt', () => js<boolean>(`!!${T}.uiRequests[0]?.approval && document.body.innerText.includes('Fetch the color palette')`))
        check((await js<string>(`document.body.innerText`)).includes('Network access'), 'it lists the access asked for')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'codex-permissions.png'))
        await click('Allow')
        await until('the permission run ends', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.turns.at(-1).steps).includes('Palette fetched.') })()`), 20_000)
        check(JSON.stringify(requests.at(-1).input).includes('\\"enabled\\":true'), 'Allow granted it')

        // Fork the whole thread (tab menu).
        const copy = await js<string>(`${T}.forkSession()`)
        check(!!copy && copy.startsWith('acp:codex:') && copy !== key, `Fork session copies the thread (${copy})`)
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
