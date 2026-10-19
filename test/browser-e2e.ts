// The browser capability in the built app, with real pi, a scripted model and a real page:
//   - browser_navigate opens a tab of the agent's in the Browser panel (which opens by itself)
//   - the snapshot lists the page's elements with refs; browser_click / browser_type act on them with
//     real input events, and the result reports what changed
//   - browser_screenshot returns an image; browser_console reports the page's console and errors
//   - the user's own tab is another tab, and the agent cannot close it
//   - the transcript row has "Show page"
//
//   bun run build && bun run e2e:browser
import { mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = process.platform === 'win32' ? workDir('pi-gui-browser') : '/tmp/pi-gui-browser'

const PAGE = `<!doctype html><title>Counter</title><body>
<h1>Counter demo</h1>
<p id="count">Count: 0</p>
<button id="inc" onclick="document.getElementById('count').textContent='Count: '+(++window.n); console.log('clicked', window.n)">Increment</button>
<label>Name <input id="name" onkeydown="if(event.key==='Enter'){document.getElementById('hello').textContent='Hello, '+this.value+'!'}"></label>
<p id="hello"></p>
<script>window.n=0; console.log('page ready'); setTimeout(() => { throw new Error('boom from page') }, 100)</script>`

const refOf = (outline: string, role: string, name: string) => outline.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`))?.[1] ?? ''

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const project = path.join(WORK, 'project')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([project, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://localhost:${(server.address() as any).port}/`

    let userTab = ''
    const llm = await startMockLlm((request) => {
        const r = request.toolResults
        switch (r.length) {
            case 0: return { toolCalls: [{ name: 'browser_navigate', arguments: { url } }] }
            case 1: return { toolCalls: [{ name: 'browser_click', arguments: { ref: refOf(r[0], 'button', 'Increment') } }] }
            case 2: return { toolCalls: [{ name: 'browser_type', arguments: { ref: refOf(r[0], 'textbox', 'Name'), text: 'Filo', submit: true } }] }
            case 3: return { toolCalls: [{ name: 'browser_screenshot', arguments: {} }] }
            case 4: return { toolCalls: [{ name: 'browser_console', arguments: {} }] }
            case 5: return { toolCalls: [{ name: 'browser_tabs', arguments: { action: 'list' } }] }
            case 6: return { toolCalls: [{ name: 'browser_tabs', arguments: { action: 'close', id: userTab } }] }
            default: return { text: 'The page works.' }
        }
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
        capabilities: ['browser'],
        windows: [{ projects: [project] }],
    }))

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const [{ page }] = await windows(1)
        await until('project shown', () => page.evaluate<boolean>('window.__app.activeProject !== null'))

        // The user's own tab, in front of the agent's later.
        await page.evaluate(`window.__browser.create('about:blank')`)
        userTab = await until('user tab', () => page.evaluate<string | undefined>('window.__browser.list.find(t => t.by === "user")?.id'))

        await page.evaluate(`(() => { const t = window.__app.active; t.draft = 'check the counter page'; void t.send(); return true })()`)
        await until('agent finished', () => page.evaluate<boolean>(`document.body.innerText.includes('The page works.')`), 60_000)

        const r = llm.requests.at(-1)!.toolResults
        check(r[0].includes('Counter demo') && r[0].includes('button "Increment"') && /\[ref=e\d+\]/.test(r[0]), 'browser_navigate returns the page as an outline with refs')
        check(r[1].includes('Count: 1'), `browser_click really clicked (${r[1].slice(0, 160).replace(/\n/g, ' | ')})`)
        check(r[2].includes('Hello, Filo!'), 'browser_type typed with real key events and Enter submitted')
        check(r[3].length < 400, 'browser_screenshot returns text alongside the image')
        check(r[4].includes('page ready') && r[4].includes('clicked 1') && r[4].includes('boom from page'), 'browser_console reports logs and uncaught errors')
        check(r[5].includes(userTab) && r[5].includes('opened by the user'), 'browser_tabs lists the user\'s tab too')
        check(/not|cannot|only/i.test(r[6]) && await page.evaluate<boolean>(`window.__browser.list.some(t => t.id === ${JSON.stringify(userTab)})`), 'the agent cannot close the user\'s tab')

        const agent = JSON.parse(await page.evaluate<string>('JSON.stringify(window.__browser.list.find(t => t.by === "agent") ?? null)'))
        check(!!agent && agent.url === url && agent.title === 'Counter', `the agent's tab shows the page (${agent?.url})`)
        check(await page.evaluate<boolean>('window.__browser.open'), 'the Browser panel opened by itself when the agent opened a tab')

        // Only one of two tabs is attached to the screen: the one in front.
        check(await page.evaluate<boolean>(`!!document.querySelector('section[aria-label=Browser] [role=tab][aria-selected=true] svg.lucide-bot')`), 'the agent\'s tab is marked as the agent\'s')

        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('other tools'))?.click()`)
        await until('tools unfolded', () => page.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Show page')`))
        check(true, 'tool rows about a page offer "Show page"')
        if (process.env.SHOTS) {
            await new Promise(r => setTimeout(r, 500))
            const { data } = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'png' })
            await writeFile(path.join(process.env.SHOTS, 'browser.png'), Buffer.from(data, 'base64'))
        }
        page.close()
    }
    finally {
        await stop()
        await llm.close()
        server.close()
    }
    console.log('browser e2e passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
