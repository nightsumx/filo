// Cache test (pi-capabilities/lib/channelTest.ts) end to end, in the terminal and in the app, with
// real pi and a scripted server that plays three channels (no tokens spent):
//   - real:  Anthropic API with a working cache: whole earlier prompts are read back, the rest written
//   - ratio: an OpenAI-compatible relay that reports 90% of every prompt as cached, a never-sent one too
//   - none:  an OpenAI-compatible endpoint that reports no cache figures
// pi-cc-tui's /channel-test runs on `real` and saves its result; the app, opened on the same agent
// dir, shows that result and the past week's record read from a session file, then runs `ratio` and
// `none` from Settings → Providers and saves them where the terminal reads them.
//
//   bun run build && bun run e2e:channel
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { hasTmux, startTerminalPi } from './terminal'

const WORK = workDir('pi-gui-channel')
const SHOTS = process.env.SHOTS ?? ''

/** Drops cache markers, so the same prefix serialises the same with or without its breakpoint. */
const strip = (value: unknown): unknown => {
    if (Array.isArray(value))
        return value.map(strip)
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'cache_control').map(([k, v]) => [k, strip(v)]))
    return value
}
const tokens = (chars: number) => Math.ceil(chars / 4)
/** pi sends a user message as a string, or as blocks when it carries the breakpoint. */
const normal = (m: any) => strip(typeof m?.content === 'string' ? { ...m, content: [{ type: 'text', text: m.content }] } : m)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function startChannels() {
    const seen: string[] = []
    const requests: Record<string, number> = {}
    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
            body += chunk
        })
        req.on('end', async () => {
            // Some time to the first token and to stream the rest, so the timings are real ones.
            await sleep(60)
            const channel = (req.url ?? '').split('/')[1]
            requests[channel] = (requests[channel] ?? 0) + 1
            const json = JSON.parse(body || '{}')
            const messages = json.messages ?? []
            const last = messages.at(-1)
            const lastText = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p: any) => p.text ?? '').join('')
            const reply = lastText.split('\n').filter((l: string) => /^\d+\.\d+ /.test(l)).join('\n') || 'ok'
            const output = tokens(reply.length)
            if (channel === 'real') {
                // Each message on its own line, so a prompt is a prefix of the next one's.
                const text = [JSON.stringify(strip(json.system)), ...messages.map((m: unknown) => JSON.stringify(normal(m)))].join('\n')
                const read = Math.max(0, ...seen.filter(s => text.startsWith(s)).map(s => tokens(s.length)))
                seen.push(text)
                const prompt = tokens(text.length)
                const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                event('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-mock', content: [], stop_reason: null, usage: { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: Math.max(0, prompt - read - 3), output_tokens: 1 } } })
                event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
                event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.slice(0, 20) } })
                await sleep(100)
                event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.slice(20) } })
                event('content_block_stop', { index: 0 })
                event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } })
                event('message_stop', {})
                res.end()
                return
            }
            const prompt = tokens(JSON.stringify(messages).length)
            const chunk = (data: object) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', ...data })}\n\n`)
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.slice(0, 20) }, finish_reason: null }] })
            await sleep(100)
            chunk({ choices: [{ index: 0, delta: { content: reply.slice(20) }, finish_reason: null }] })
            chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            const details = channel === 'ratio' ? { prompt_tokens_details: { cached_tokens: Math.round(prompt * 0.9) } } : {}
            chunk({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, ...details } })
            res.end('data: [DONE]\n\n')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

async function main() {
    if (!hasTmux) {
        console.log('skip: no tmux')
        return
    }
    await rm(WORK, { recursive: true, force: true })
    const project = path.join(WORK, 'project')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const sessions = path.join(agentDir, 'sessions', '--project--')
    await Promise.all([project, userData, sessions].map(d => mkdir(d, { recursive: true })))
    const channels = await startChannels()
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const model = (id: string) => ({ id, contextWindow: 200_000, maxTokens: 4096, cost })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: {
            real: { name: 'Real Cache', baseUrl: `${channels.url}/real`, api: 'anthropic-messages', apiKey: 'mock', models: [model('claude-mock')] },
            ratio: { name: 'Ratio Relay', baseUrl: `${channels.url}/ratio/v1`, api: 'openai-completions', apiKey: 'mock', models: [model('gpt-mock')] },
            none: { name: 'No Cache', baseUrl: `${channels.url}/none/v1`, api: 'openai-completions', apiKey: 'mock', models: [model('plain-mock')] },
        },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'real', defaultModel: 'claude-mock', defaultThinkingLevel: 'off' }))
    // Last week on `real`: two requests, the second lost the cache mid-run.
    const now = Date.now()
    const entry = (id: string, parentId: string | null, message: object) => JSON.stringify({ type: 'message', id, parentId, timestamp: new Date(now - 3_600_000).toISOString(), message })
    const reply = (usage: object, at: number) => ({ role: 'assistant', provider: 'real', model: 'claude-mock', stopReason: 'toolUse', timestamp: at, usage: { output: 10, ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    await writeFile(path.join(sessions, 'past.jsonl'), [
        JSON.stringify({ type: 'session', version: 3, id: 'past', timestamp: new Date(now - 3_600_000).toISOString(), cwd: project }),
        entry('u1', null, { role: 'user', content: 'hi', timestamp: now - 3_600_000 }),
        entry('a1', 'u1', reply({ input: 10, cacheRead: 0, cacheWrite: 40_000 }, now - 3_590_000)),
        entry('t1', 'a1', { role: 'toolResult', toolCallId: 'x', toolName: 'bash', content: [], timestamp: now - 3_589_000 }),
        entry('a2', 't1', reply({ input: 10, cacheRead: 0, cacheWrite: 42_000 }, now - 3_580_000)),
    ].join('\n'))
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
    const results = async () => JSON.parse(await readFile(path.join(agentDir, 'channel-tests.json'), 'utf8').catch(() => '{"results":{}}')).results

    // ---------------------------------------------------------------- terminal
    const term = await startTerminalPi({ agentDir, cwd: project, extensions: ['cc-tui.ts', 'cc-channel-test.ts'] })
    try {
        await until('terminal pi ready', async () => (await term.pane()).includes('claude-mock'))
        await term.type('/channel-test')
        await until('cost choice', async () => (await term.pane()).includes('Run: 7 requests'))
        check((await term.pane()).includes('up to $'), 'terminal: the choice shows what the run may cost')
        await term.keys('Enter')
        const report = await until('terminal verdict', async () => {
            const p = await term.pane()
            return p.includes('Cache works') ? p : undefined
        }, 60_000)
        check(report.includes('Every request read the previous prompt back'), 'terminal: a working cache passes')
        check(report.includes('1 first') && report.includes('7 append'), 'terminal: the report lists each request')
        check(report.includes('Past 7 days: 2 requests') && report.includes('1 unexpected miss,'), 'terminal: the past week\'s record of the model comes with it')
        if (SHOTS)
            await writeFile(path.join(SHOTS, 'channel-terminal.txt'), report)
        check(channels.requests.real === 7, 'seven requests went to the channel')
        check((await results())['real/claude-mock']?.verdict === 'healthy', 'terminal: the result is saved in pi\'s agent dir')
    }
    catch (error) {
        console.error(await term.pane())
        throw error
    }
    finally {
        await term.kill()
    }

    // ---------------------------------------------------------------- app
    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const [{ page }] = await windows(1)
        const js = (code: string) => page.evaluate<any>(code)
        const row = (name: string) => `[...document.querySelectorAll('[role="dialog"] button[aria-expanded]')].find(b => b.querySelector('.truncate')?.textContent === ${JSON.stringify(name)})?.parentElement`
        const openRow = (name: string) => js(`(() => { const b = ${row(name)}?.querySelector('button[aria-expanded]'); if (!b) return false; if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true })()`)
        const clickIn = (scope: string, text: string) => js(`(() => { const b = [...(${scope})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!b) return false; b.click(); return true })()`)
        const textOf = (scope: string) => js(`(${scope})?.textContent ?? ''`)

        await js(`window.__app.openSettings('providers')`)
        await until('providers page', () => js(`!!(${row('Real Cache')})`), 20_000)

        check(await openRow('Real Cache'), 'the Real Cache row opens')
        await until('saved result', async () => (await textOf(row('Real Cache'))).includes('Cache works'), 20_000)
        check(true, 'app: the terminal\'s result shows on the provider')
        await until('history', async () => (await textOf(row('Real Cache'))).includes('Past 7 days: 2 requests'), 20_000)
        check((await textOf(row('Real Cache'))).includes('1 unexpected miss,'), 'app: the past week\'s record matches the terminal\'s')

        const runTest = async (name: string, verdict: string) => {
            check(await openRow(name), `the ${name} row opens`)
            await until(`${name} test button`, () => clickIn(row(name), 'Test'), 20_000)
            await until(`${name} estimate`, async () => (await textOf(row(name))).includes('7 requests'))
            check((await textOf(row(name))).includes('if the cache works, up to'), `${name}: the cost is shown before anything is sent`)
            if (SHOTS && name === 'Ratio Relay') {
                await js(`${row(name)}.scrollIntoView({ block: 'center' })`)
                await page.screenshot(path.join(SHOTS, 'channel-confirm.png'))
            }
            check(await clickIn(row(name), 'Run test'), `${name}: the run starts`)
            await until(`${name} verdict`, async () => (await textOf(row(name))).includes(verdict), 60_000)
        }

        await runTest('Ratio Relay', 'Figures don\'t add up')
        check((await textOf(row('Ratio Relay'))).includes('never sent before'), 'app: a relay billing by ratio is called out')
        check((await textOf(row('Ratio Relay'))).includes('too much'), 'app: the request table marks the impossible reads')
        if (SHOTS) {
            await js(`${row('Ratio Relay')}.scrollIntoView({ block: 'center' })`)
            await page.screenshot(path.join(SHOTS, 'channel-dark.png'))
        }
        await runTest('No Cache', 'No cache figures')
        const saved = await results()
        check(saved['ratio/gpt-mock']?.verdict === 'fabricated' && saved['none/plain-mock']?.verdict === 'unreported' && saved['real/claude-mock']?.verdict === 'healthy', 'app: results are saved next to the terminal\'s')

        if (SHOTS) {
            await js(`window.__app.setTheme('light')`)
            await until('light', () => js(`!document.documentElement.classList.contains('dark')`), 5_000)
            await js(`${row('Ratio Relay')}.querySelector('button[aria-expanded]').click()`)
            await js(`${row('Real Cache')}.querySelector('button[aria-expanded]').getAttribute('aria-expanded') === 'true' || ${row('Real Cache')}.querySelector('button[aria-expanded]').click()`)
            await until('real open', async () => (await textOf(row('Real Cache'))).includes('Cache works'))
            await clickIn(row('Real Cache'), 'Cache works')
            await until('details', async () => (await textOf(row('Real Cache'))).includes('Every request read'))
            await js(`${row('Real Cache')}.scrollIntoView({ block: 'center' })`)
            await page.screenshot(path.join(SHOTS, 'channel-light.png'))
        }
    }
    finally {
        await stop()
        await channels.close()
    }
}

main().then(() => process.exit(0), (error) => {
    console.error(error)
    process.exit(1)
})
