// The browser capability in the built app, with real pi, a scripted model and a real page:
//   - browser_navigate opens a tab of the agent's in the Browser panel (which opens by itself)
//   - the snapshot lists the page's elements with refs; browser_click / browser_type act on them with
//     real input events, and the result reports what changed
//   - browser_screenshot returns an image; browser_console reports the page's console and errors
//   - the user's own tab is another tab, and the agent cannot close it
//   - the transcript row has "Show page"
//
//   bun run build && bun run e2e:browser
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
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

// 2000px tall: a red band at the top, a blue one at the bottom, a red 200x100 button at y=1000 in
// between, on grey. Screenshots of the button or the whole page must show exactly those colours.
const TALL = `<!doctype html><title>Tall</title><body style="margin:0;background:#888">
<div style="height:100px;background:#f00"></div>
<button aria-label="Red box" style="position:absolute;left:30px;top:1000px;width:200px;height:100px;border:0;padding:0;background:#f00"></button>
<div style="position:absolute;top:1900px;left:0;right:0;height:100px;background:#00f"></div>
<div style="height:1900px"></div>`

/** Decodes an 8-bit non-interlaced PNG (what Chrome writes) to RGBA rows. */
function decodePng(buf: Buffer) {
    let width = 0
    let height = 0
    let channels = 4
    const idat: Buffer[] = []
    for (let i = 8; i < buf.length;) {
        const len = buf.readUInt32BE(i)
        const type = buf.toString('latin1', i + 4, i + 8)
        const body = buf.subarray(i + 8, i + 8 + len)
        if (type === 'IHDR') {
            width = body.readUInt32BE(0)
            height = body.readUInt32BE(4)
            channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 4
        }
        if (type === 'IDAT')
            idat.push(body)
        i += 12 + len
    }
    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = width * channels
    const out = Buffer.alloc(height * stride)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]
        for (let x = 0; x < stride; x++) {
            const cur = raw[y * (stride + 1) + 1 + x]
            const left = x >= channels ? out[y * stride + x - channels] : 0
            const up = y ? out[(y - 1) * stride + x] : 0
            const upLeft = y && x >= channels ? out[(y - 1) * stride + x - channels] : 0
            const paeth = () => {
                const p = left + up - upLeft
                const pa = Math.abs(p - left)
                const pb = Math.abs(p - up)
                const pc = Math.abs(p - upLeft)
                return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
            }
            const add = [0, left, up, (left + up) >> 1, paeth()][filter]
            out[y * stride + x] = (cur + add) & 255
        }
    }
    const pixel = (x: number, y: number) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)]
    return { width, height, pixel }
}

/** The images tools returned in this run's session file, in order. */
async function sessionImages(agentDir: string): Promise<Buffer[]> {
    const root = path.join(agentDir, 'sessions')
    const files: string[] = []
    for (const dir of await readdir(root, { recursive: true }))
        if (String(dir).endsWith('.jsonl'))
            files.push(path.join(root, String(dir)))
    const images: Buffer[] = []
    for (const line of (await readFile(files[0], 'utf8')).split('\n').filter(Boolean)) {
        const entry = JSON.parse(line)
        const content = entry.message?.role === 'toolResult' ? entry.message.content : []
        for (const c of content)
            if (c.type === 'image')
                images.push(Buffer.from(c.data, 'base64'))
    }
    return images
}

// A login-style popup: the opener opens a small window, which posts a message back and closes itself.
const OPENER = `<!doctype html><title>Opener</title><body>
<button onclick="window.open('/popup', 'login', 'width=420,height=360')">Sign in with Popup</button>
<p id="out">waiting</p>
<script>document.cookie = 'seen=1'; addEventListener('message', e => { document.getElementById('out').textContent = 'popup said ' + e.data; document.title = 'Signed in' })</script>`
const POPUP = `<!doctype html><title>Popup</title><body>Logging in…
<script>setTimeout(() => { window.opener.postMessage('hello from ' + document.cookie.includes('seen=1') + (window.opener ? ' with opener' : ''), '*'); window.close() }, 300)</script>`

const refOf = (outline: string, role: string, name: string) => outline.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`))?.[1] ?? ''

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const project = path.join(WORK, 'project')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([project, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/tall' ? TALL : req.url === '/opener' ? OPENER : req.url === '/popup' ? POPUP : PAGE))
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
            case 7: return { toolCalls: [{ name: 'browser_navigate', arguments: { url: `${url}tall` } }] }
            case 8: return { toolCalls: [{ name: 'browser_scroll', arguments: { dy: 300 } }] }
            case 9: return { toolCalls: [{ name: 'browser_screenshot', arguments: { ref: refOf(r[7], 'button', 'Red box') } }] }
            case 10: return { toolCalls: [{ name: 'browser_screenshot', arguments: { full_page: true } }] }
            case 11: return { toolCalls: [{ name: 'browser_navigate', arguments: { url: `${url}opener` } }] }
            case 12: return { toolCalls: [{ name: 'browser_click', arguments: { ref: refOf(r[11], 'button', 'Sign in with Popup') } }] }
            case 13: return { toolCalls: [{ name: 'browser_wait', arguments: { text: 'popup said', timeout: 10 } }] }
            case 14: return { toolCalls: [{ name: 'browser_eval', arguments: { expression: "document.getElementById('out').textContent" } }] }
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

        // Screenshots: the first is the counter page's, then the red button (after scrolling), then the whole page.
        const images = (await sessionImages(agentDir)).map(decodePng)
        check(images.length === 3, `three screenshots came back as images (${images.length})`)
        const [, box, full] = images
        const scale = box.width / 200
        check(box.height === Math.round(100 * scale), `the element screenshot is the button's size (${box.width}x${box.height})`)
        // The screen's colour profile shifts pure colours a little (red comes out as 234,51,35).
        const red = (p: number[]) => p[0] > 200 && p[1] < 80 && p[2] < 80
        const blue = (p: number[]) => p[2] > 200 && p[0] < 80 && p[1] < 80
        const grey = (p: number[]) => Math.abs(p[0] - p[1]) < 12 && Math.abs(p[1] - p[2]) < 12 && p[0] > 100 && p[0] < 170
        const allRed = [[0, 0], [box.width - 1, 0], [0, box.height - 1], [box.width - 1, box.height - 1], [box.width >> 1, box.height >> 1]].every(([x, y]) => red(box.pixel(x, y)))
        check(allRed, 'the element screenshot shows only the button, after the page was scrolled')
        // (Chrome draws a beyond-the-viewport capture at 1x even where the element capture is 2x.)
        const fscale = full.height / 2000
        check(fscale === 1 || fscale === 2, `the full-page screenshot is the whole page (${full.width}x${full.height})`)
        check(red(full.pixel(5, 5)) && grey(full.pixel(5, Math.round(500 * fscale))) && blue(full.pixel(5, full.height - 5)), 'full page: red band at the top, grey between, blue band at the bottom')

        check(r[14].includes('popup said hello from true with opener'), `a popup window (sharing the cookie jar) reached its opener with window.opener / postMessage (${r[14]})`)
        check(await page.evaluate<boolean>('window.__browser.list.length === 2'), 'the popup is a window, not a tab, and it closed itself')

        const agent = JSON.parse(await page.evaluate<string>('JSON.stringify(window.__browser.list.find(t => t.by === "agent") ?? null)'))
        check(!!agent && agent.url === `${url}opener` && agent.title === 'Signed in', `the agent's tab shows the last page it opened (${agent?.url})`)
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
