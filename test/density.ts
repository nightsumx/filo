// Transcript density benchmark. Records a fixed conversation with real pi and the mock model, opens
// it in the built app at a fixed window size, scrolls through it, and measures how much screen the
// transcript takes. A UI change that makes the same conversation taller fails the comparison.
//
//   bun run build && bun run density            compare against test/density-baseline.json
//   bun run density --save                       write the baseline
//   bun run density --shots /tmp/density         also save screenshots of each screen (--dark for dark)
import type { MockReply, MockRequest } from './harness'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { findPi, startMockLlm, startPi } from './harness'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE = path.join(ROOT, 'test/density-baseline.json')
const WORK = '/private/tmp/pi-gui-density'
const PORT = 9335
const VIEWPORT = { width: 1280, height: 820 }
/** Allowed growth of the transcript height before the comparison fails. */
const TOLERANCE = 0.02

const args = process.argv.slice(2)
const save = args.includes('--save')
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null
const theme = args.includes('--dark') ? 'dark' : 'light'

// ---------------------------------------------------------------- the conversation

const STORE_TS = `${Array.from({ length: 60 }, (_, i) => i === 12 ? 'export const MAX_RETRIES = 3' : `// line ${i + 1} of the store`).join('\n')}\n`
const UTIL_TS = 'export function clamp(n: number, lo: number, hi: number) {\n    return Math.min(hi, Math.max(lo, n))\n}\n'

const LONG_THINKING = Array.from({ length: 9 }, (_, i) => `Step ${i + 1}: check how the store retries failed requests and where MAX_RETRIES is read, then decide whether the change belongs in the store or in the caller.`).join('\n\n')

/** One entry per prompt; each lists the model replies for that turn in order. */
const TURNS: { prompt: string, replies: MockReply[] }[] = [
    {
        prompt: 'Explain how src/store.ts handles retries',
        replies: [
            { thinking: LONG_THINKING, toolCalls: [{ name: 'read', arguments: { path: 'src/store.ts' } }, { name: 'read', arguments: { path: 'src/util.ts' } }] },
            { text: 'The store retries failed requests up to `MAX_RETRIES` times:\n\n- `MAX_RETRIES` is a module constant (3).\n- Each retry waits with `clamp`ed backoff from `src/util.ts`.\n- After the last attempt the error propagates to the caller.\n\nNothing else reads the constant, so changing it is safe.' },
        ],
    },
    {
        prompt: 'Raise the retry limit to 5 and run the tests',
        replies: [
            { thinking: 'Simple constant change, then run the test script.', toolCalls: [{ name: 'edit', arguments: { path: 'src/store.ts', edits: [{ oldText: 'export const MAX_RETRIES = 3', newText: 'export const MAX_RETRIES = 5' }] } }] },
            { toolCalls: [{ name: 'bash', arguments: { command: 'for i in $(seq 1 14); do echo "ok $i - store test $i"; done; echo "14 passed"' } }] },
            { text: 'Done. `MAX_RETRIES` is now 5 and all 14 tests pass.' },
        ],
    },
    {
        prompt: 'What does clamp return for NaN?',
        replies: [
            { text: '`Math.max(lo, NaN)` is `NaN`, so `clamp` returns `NaN`. Guard with `Number.isNaN` if callers can pass it.' },
        ],
    },
    {
        prompt: 'Add a small README for the store module',
        replies: [
            { toolCalls: [{ name: 'write', arguments: { path: 'src/README.md', content: '# store\n\nRequest store with retries.\n\n- `MAX_RETRIES`: attempts before giving up (5)\n- Backoff uses `clamp` from `util.ts`\n' } }] },
            { text: 'Added `src/README.md` describing the retry limit and backoff.' },
        ],
    },
    {
        prompt: 'Show me the git status',
        replies: [
            { toolCalls: [{ name: 'bash', arguments: { command: 'printf " M src/store.ts\\n?? src/README.md\\n"' } }] },
            { text: 'Two changes: `src/store.ts` modified and `src/README.md` new.' },
        ],
    },
]

function reply(request: MockRequest): MockReply {
    const users = request.messages.filter(m => m.role === 'user').length
    const lastUser = request.messages.findLastIndex(m => m.role === 'user')
    const steps = request.messages.slice(lastUser + 1).filter(m => m.role === 'assistant').length
    return TURNS[users - 1]?.replies[steps] ?? { text: 'ok' }
}

/** Runs the conversation through real pi; returns the session file content and the cwd it used. */
async function record(): Promise<{ jsonl: string, cwds: string[] }> {
    const env = await findPi()
    if (!env)
        throw new Error('pi is not installed')
    const llm = await startMockLlm(reply)
    const pi = await startPi(env, llm, ['todo'])
    try {
        await mkdir(path.join(pi.cwd, 'src'), { recursive: true })
        await writeFile(path.join(pi.cwd, 'src/store.ts'), STORE_TS)
        await writeFile(path.join(pi.cwd, 'src/util.ts'), UTIL_TS)
        for (const turn of TURNS)
            await pi.run(turn.prompt)
        const sessionsDir = path.join(pi.agentDir, 'sessions')
        const [dir] = await readdir(sessionsDir)
        const [file] = await readdir(path.join(sessionsDir, dir))
        // pi records the realpath (/private/var/...), which contains the tmpdir path (/var/...): longest first.
        const cwds = [...new Set([await realpath(pi.cwd), pi.cwd])].sort((a, b) => b.length - a.length)
        return { jsonl: await readFile(path.join(sessionsDir, dir, file), 'utf8'), cwds }
    }
    finally {
        await pi.stop()
        await llm.close()
    }
}

// ---------------------------------------------------------------- the app

/** Lays out a userData + agent dir that open straight into the recorded session. */
async function prepare(recorded: { jsonl: string, cwds: string[] }) {
    await rm(WORK, { recursive: true, force: true })
    const cwd = path.join(WORK, 'project')
    const agentDir = path.join(WORK, 'agent')
    const userData = path.join(WORK, 'userdata')
    const sessionDir = path.join(agentDir, 'sessions', `--${cwd.slice(1).replace(/[/\\:]/g, '-')}--`)
    await Promise.all([cwd, userData, sessionDir].map(d => mkdir(d, { recursive: true })))
    let jsonl = recorded.jsonl
    for (const old of recorded.cwds)
        jsonl = jsonl.split(old).join(cwd)
    const sessionPath = path.join(sessionDir, 'density.jsonl')
    await writeFile(sessionPath, jsonl)
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', name: 'Mock', contextWindow: 200_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [cwd],
        hiddenProjects: [],
        activeProject: cwd,
        tabs: { [cwd]: [sessionPath] },
        activeTabs: { [cwd]: sessionPath },
        layout: 'single',
        theme,
        transcriptLang: 'en',
        capabilities: { [cwd]: ['todo'] },
    }))
    return { agentDir, userData }
}

class Cdp {
    private ws!: WebSocket
    private next = 0
    static async connect(): Promise<Cdp> {
        const cdp = new Cdp()
        for (let i = 0; ; i++) {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as any[]
                const page = targets.find(t => t.type === 'page')
                if (page) {
                    cdp.ws = new WebSocket(page.webSocketDebuggerUrl)
                    await new Promise(resolve => cdp.ws.addEventListener('open', resolve, { once: true }))
                    return cdp
                }
            }
            catch {}
            if (i > 100)
                throw new Error('the app did not open a debuggable page')
            await new Promise(r => setTimeout(r, 200))
        }
    }

    call(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = ++this.next
        return new Promise((resolve, reject) => {
            const onMessage = (e: MessageEvent) => {
                const msg = JSON.parse(String(e.data))
                if (msg.id !== id)
                    return
                this.ws.removeEventListener('message', onMessage)
                if (msg.error)
                    reject(new Error(msg.error.message))
                else
                    resolve(msg.result)
            }
            this.ws.addEventListener('message', onMessage)
            this.ws.send(JSON.stringify({ id, method, params }))
        })
    }

    async evaluate<T>(fn: string): Promise<T> {
        const { result, exceptionDetails } = await this.call('Runtime.evaluate', { expression: `(${fn})()`, awaitPromise: true, returnByValue: true })
        if (exceptionDetails)
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
        return result.value
    }

    close() {
        this.ws.close()
    }
}

interface RowSample { index: number, kind: string, top: number, height: number, ink: number, lines: number }
interface Metrics {
    viewport: { width: number, height: number }
    /** Height of the whole transcript, px. Lower is denser. */
    height: number
    /** Height covered by text line boxes and images, px; the rest is spacing and chrome. */
    ink: number
    lines: number
    turns: number
    /** Average height of one turn, and how many such turns fit in the visible transcript. */
    turnHeight: number
    turnsPerScreen: number
    byKind: Record<string, { rows: number, height: number }>
}

// Runs in the page: scrolls the virtualized list top to bottom and samples every row once.
const MEASURE = `async () => {
    const scroller = document.querySelector('[data-transcript]')
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const ink = (el) => {
        const origin = el.getBoundingClientRect().top
        const spans = []
        const range = document.createRange()
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue
            range.selectNodeContents(n)
            for (const r of range.getClientRects())
                if (r.width > 0 && r.height > 0) spans.push([r.top - origin, r.bottom - origin])
        }
        for (const img of el.querySelectorAll('img')) {
            const r = img.getBoundingClientRect()
            spans.push([r.top - origin, r.bottom - origin])
        }
        spans.sort((a, b) => a[0] - b[0])
        let total = 0, lines = 0, end = -Infinity
        for (const [top, bottom] of spans) {
            if (top >= end - 2) { lines++; total += bottom - top; end = bottom }
            else if (bottom > end) { total += bottom - end; end = bottom }
        }
        return { ink: total, lines }
    }
    const rows = new Map()
    const sample = () => {
        for (const el of scroller.querySelectorAll('[data-index]')) {
            const index = Number(el.dataset.index)
            if (rows.has(index)) continue
            const { ink: px, lines } = ink(el)
            rows.set(index, { index, kind: el.dataset.rowKind, top: el.offsetTop + Number(/translateY\\((-?[\\d.]+)px\\)/.exec(el.style.transform)?.[1] ?? 0), height: el.offsetHeight, ink: px, lines })
        }
    }
    scroller.scrollTop = 0
    await wait(150)
    for (let guard = 0; guard < 400; guard++) {
        sample()
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break
        scroller.scrollTop += Math.floor(scroller.clientHeight / 2)
        await wait(60)
    }
    sample()
    return { height: scroller.scrollHeight, viewport: { width: scroller.clientWidth, height: scroller.clientHeight }, rows: [...rows.values()].sort((a, b) => a.index - b.index) }
}`

async function measure(agentDir: string, userData: string): Promise<Metrics> {
    // The electron package's main export is the binary path; the .bin shim would outlive kill().
    const electron = createRequire(import.meta.url)('electron') as string
    const app = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
        cwd: ROOT,
        env: { ...process.env, PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir },
        stdio: 'ignore',
    })
    try {
        const cdp = await Cdp.connect()
        await cdp.call('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
        for (let i = 0; !(await cdp.evaluate<boolean>(`() => document.querySelectorAll('[data-transcript] [data-index]').length > 0`)); i++) {
            if (i > 100)
                throw new Error('the transcript never rendered')
            await new Promise(r => setTimeout(r, 200))
        }
        await new Promise(r => setTimeout(r, 800))
        const raw = await cdp.evaluate<{ height: number, viewport: Metrics['viewport'], rows: RowSample[] }>(MEASURE)
        if (shotsDir) {
            await mkdir(shotsDir, { recursive: true })
            for (let screen = 0; ; screen++) {
                const done = await cdp.evaluate<boolean>(`() => { const s = document.querySelector('[data-transcript]'); s.scrollTop = ${screen} * s.clientHeight; return s.scrollTop + s.clientHeight >= s.scrollHeight - 1 }`)
                await new Promise(r => setTimeout(r, 250))
                const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
                await writeFile(path.join(shotsDir, `screen-${screen + 1}.png`), Buffer.from(data, 'base64'))
                if (done || screen > 20)
                    break
            }
        }
        cdp.close()

        const turns = raw.rows.filter(r => r.kind === 'user').length
        const byKind: Metrics['byKind'] = {}
        for (const row of raw.rows) {
            byKind[row.kind] ??= { rows: 0, height: 0 }
            byKind[row.kind].rows++
            byKind[row.kind].height += row.height
        }
        const turnHeight = turns ? Math.round(raw.height / turns) : raw.height
        return {
            viewport: raw.viewport,
            height: raw.height,
            ink: Math.round(raw.rows.reduce((n, r) => n + r.ink, 0)),
            lines: raw.rows.reduce((n, r) => n + r.lines, 0),
            turns,
            turnHeight,
            turnsPerScreen: Math.round(raw.viewport.height / turnHeight * 100) / 100,
            byKind,
        }
    }
    finally {
        // Electron does not always quit on SIGTERM; pi children exit when their stdin closes.
        const exited = new Promise(resolve => app.once('exit', resolve))
        app.kill('SIGTERM')
        await Promise.race([exited, new Promise(r => setTimeout(r, 2000))])
        if (app.exitCode === null && app.signalCode === null)
            app.kill('SIGKILL')
    }
}

// ---------------------------------------------------------------- report

function report(now: Metrics, base: Metrics | null): boolean {
    const pct = (a: number, b: number) => `${a >= b ? '+' : ''}${Math.round((a - b) / b * 1000) / 10}%`
    const row = (label: string, value: number, old?: number, unit = '') =>
        console.log(`  ${label.padEnd(18)}${`${value}${unit}`.padStart(10)}${old == null ? '' : `${`${old}${unit}`.padStart(10)}  ${pct(value, old)}`}`)
    console.log(`\ntranscript density · ${now.viewport.width}×${now.viewport.height} visible · ${now.turns} turns${base ? '            baseline' : ''}`)
    row('height', now.height, base?.height, 'px')
    row('ink', now.ink, base?.ink, 'px')
    row('ink ratio', Math.round(now.ink / now.height * 100), base ? Math.round(base.ink / base.height * 100) : undefined, '%')
    row('text lines', now.lines, base?.lines)
    row('px per turn', now.turnHeight, base?.turnHeight)
    row('turns per screen', now.turnsPerScreen, base?.turnsPerScreen)
    for (const [kind, { rows, height }] of Object.entries(now.byKind))
        row(`  ${kind} (${rows})`, height, base?.byKind[kind]?.height, 'px')
    if (!base)
        return true
    const ok = now.height <= base.height * (1 + TOLERANCE)
    console.log(ok ? '\nok: not taller than the baseline' : `\nFAIL: transcript is ${pct(now.height, base.height)} taller than the baseline`)
    return ok
}

if (!existsSync(path.join(ROOT, 'dist-electron/main/main.js')))
    throw new Error('build the app first (bun run build)')
const recorded = await record()
const { agentDir, userData } = await prepare(recorded)
const metrics = await measure(agentDir, userData)
const base = save || !existsSync(BASELINE) ? null : JSON.parse(await readFile(BASELINE, 'utf8')) as Metrics
const ok = report(metrics, base)
if (save) {
    await writeFile(BASELINE, `${JSON.stringify(metrics, null, 4)}\n`)
    console.log(`saved ${path.relative(ROOT, BASELINE)}`)
}
if (!shotsDir)
    await rm(WORK, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
