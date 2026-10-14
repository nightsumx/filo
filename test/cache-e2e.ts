// Prompt-cache figures in the terminal and in the app, on one session, with a scripted model that
// reports cached tokens the way OpenAI does (prompt_tokens_details.cached_tokens):
//   - request 1 reads nothing, request 2 reads the prefix back, request 3 loses it at a new prompt,
//     request 4 reads most of it and is billed again for the tail
//   - pi-cc-tui's status line shows the conversation's hit rate, the turn that lost the cache says so
//     in its footer, and /cache lists the misses
//   - the app, opening the same session, shows the same figure and footer; clicking the figure lists
//     the misses, and a row scrolls the conversation to its request
//
//   bun run build && bun run e2e:cache
import type { AddressInfo } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { hasTmux, startTerminalPi } from './terminal'

const WORK = workDir('pi-gui-cache')
const SHOTS = process.env.SHOTS ?? ''

/** Prompt size and cached part of each request, in order. */
const USAGE = [
    { prompt: 50_000, cached: 0 },
    { prompt: 60_000, cached: 50_000 },
    { prompt: 70_000, cached: 0 },
    { prompt: 100_000, cached: 50_000 },
]

async function startModel() {
    let n = 0
    const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            const { prompt, cached } = USAGE[Math.min(n, USAGE.length - 1)]
            const i = ++n
            const chunk = (body: unknown) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-1', ...body as object })}\n\n`)
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `reply ${i}` }, finish_reason: null }] })
            chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            chunk({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10, prompt_tokens_details: { cached_tokens: cached } } })
            res.end('data: [DONE]\n\n')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => n, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
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
    await Promise.all([project, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    const model = await startModel()
    // Per million tokens: request 3 re-bills 60k at 3 − 0.3, about $0.16; request 4 re-bills a 20k tail, about $0.05.
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: model.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 1_000_000, maxTokens: 1000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }] } },
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

    const term = await startTerminalPi({ agentDir, cwd: project, extensions: ['cc-tui.ts', 'cc-statusline.ts', 'cc-presence.ts'] })
    try {
        await until('terminal pi ready', async () => (await term.pane()).includes('mock-1'))
        for (let i = 1; i <= USAGE.length; i++) {
            await term.type(`prompt ${i}`)
            await until(`reply ${i}`, async () => (await term.pane()).includes(`reply ${i}`))
            if (i === 2) {
                await until('hit rate', async () => (await term.pane()).includes('cache 45%'), 5000)
                check(true, 'terminal: a request that reads the prefix back raises the hit rate (50k of 110k)')
            }
        }
        const pane = await term.pane()
        check(pane.includes('cache 35%'), 'terminal: the status line shows the conversation\'s hit rate (100k of 280k)')
        check(pane.includes('cache miss (lost at a new prompt, +$0.16)'), 'terminal: the turn that lost the cache names the miss, why, and what it cost')
        check(pane.split('\n').filter(l => l.includes('cache miss')).length === 1, 'terminal: a re-billed tail does not flag its turn')
        await term.type('/cache')
        const report = await until('/cache report', async () => {
            const p = await term.pane()
            return p.includes('Significant misses') ? p : undefined
        })
        check(report.includes('2 misses, 80.0k re-billed') && report.includes('lost at a new prompt ×1') && report.includes('tail re-billed ×1'), '/cache sums the misses by reason')
        check(report.includes('read 0 of 60.0k · prompt 3') && report.includes('read 50.0k of 70.0k · prompt 4'), '/cache lists each miss with what it read and its prompt')
        if (SHOTS)
            await writeFile(path.join(SHOTS, 'cache-terminal.txt'), report)
        check(model.requests() === 4, 'one request per prompt')
    }
    catch (error) {
        console.error(await term.pane())
        throw error
    }

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const [{ page }] = await windows(1)
        const file = await until('terminal session in the app', async () => JSON.parse(await page.evaluate<string>(`JSON.stringify(window.__app.presence.find(p => p.session)?.session ?? null)`)) as string | null)
        await until('session listed', () => page.evaluate<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(file)})`))
        await page.evaluate(`window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(file)}))`)
        const thread = `window.__app.threads.get(${JSON.stringify(file)})`
        const text = () => page.evaluate<string>('document.body.innerText')
        await until('transcript', async () => (await text()).includes('reply 4'))
        check((await text()).includes('cache 35%'), 'app: the status line shows the same figure as the terminal')
        check((await text()).split('cache miss').length - 1 === 1, 'app: one turn footer says cache miss')

        // The footer's hover card sums the turn's misses.
        const at = await page.evaluate<{ x: number, y: number }>(`(() => { const r = [...document.querySelectorAll('span[tabindex="0"]')].find(e => e.textContent.includes('cache miss')).getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 } })()`)
        // Moved again on each probe: the first move can land before the tooltip listens.
        const card = await until('hover card', async () => {
            await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 1, y: at.y })
            await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
            const t = await text()
            return t.toLowerCase().includes('cache misses') ? t : undefined
        })
        check(card.includes('lost at a new prompt') && card.includes('60.0k re-billed') && card.includes('+$0.16'), 'app: the hover card lists the miss with its reason and cost')
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })

        // Clicking the figure lists the thread's misses.
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'cache 35%').click()`)
        const panel = await until('cache panel', async () => {
            const t = await text()
            return t.includes('Prompt cache') ? t : undefined
        })
        check(panel.includes('lost at a new prompt ×1') && panel.includes('tail re-billed ×1'), 'app: the panel sums the misses by reason')
        check(panel.includes('read 0 of 60.0k') && panel.includes('read 50.0k of 70.0k'), 'app: and lists each one with what it read')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'cache-panel.png'))
        // A row scrolls the conversation to its request.
        await page.evaluate(`[...document.querySelectorAll('ol button')].find(b => b.textContent.includes('read 0 of 60.0k')).click()`)
        const revealed = await until('revealed', () => page.evaluate<string | null>('window.__app.reveal?.entryId ?? null'))
        const replyKey = await page.evaluate<string>(`${thread}.items.find(i => i.message.role === 'assistant' && JSON.stringify(i.message.content).includes('reply 3')).key`)
        check(revealed === replyKey, 'app: a row reveals the request that missed')
        check(!(await text()).includes('Prompt cache'), 'app: and closes the panel')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'cache-app.png'))
        console.log('all cache checks passed')
    }
    finally {
        await stop()
        await term.kill()
        await model.close()
    }
}

main().then(() => process.exit(0), (error) => {
    console.error(error)
    process.exit(1)
})
