// Screenshots for the website, from the built app with real pi and a scripted model (no tokens
// spent, nothing from this machine's own sessions): a demo project, a few threads, one that edits
// code and runs its tests, a terminal pi working on another, then search and a review.
//
//   bun run build && bun run site:shots     → site/public/shots/{zh,en}/*.webp, og.png
import type { Page } from '../test/app'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { launch, until, windows } from '../test/app'
import { startMockLlm } from '../test/harness'

const WORK = '/private/tmp/pi-site'
// The project lives where the app shows it as ~/code/acme-api (it abbreviates /Users/<name>), and
// not under this user's home. Created and removed by this script.
const CODE = '/Users/Shared/code'
const OUT = path.join(import.meta.dir, 'public/shots')
const WIDTH = 1440
const HEIGHT = 900

type Lang = 'zh' | 'en'

const DURATION = `/** "1m30s" → 90. Units: m, s. */
export function parseDuration(text: string): number {
    const match = /^(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(text.trim())
    if (!match || text.trim() === '')
        throw new RangeError(\`not a duration: \${text}\`)
    const [, m = '0', s = '0'] = match
    return Number(m) * 60 + Number(s)
}
`
const DURATION_TEST = `import { expect, test } from 'bun:test'
import { parseDuration } from './duration'

test('minutes and seconds', () => {
    expect(parseDuration('1m30s')).toBe(90)
    expect(parseDuration('45s')).toBe(45)
})

test('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow(RangeError)
})
`

/** The demo project: a small API with a duration parser that only knows minutes and seconds. */
async function demoProject(dir: string) {
    const files: Record<string, string> = {
        'package.json': `${JSON.stringify({ name: 'acme-api', private: true, type: 'module', scripts: { test: 'bun test' } }, null, 2)}\n`,
        'README.md': '# acme-api\n\nInternal API for the Acme dashboard.\n',
        'src/duration.ts': DURATION,
        'src/duration.test.ts': DURATION_TEST,
        'src/server.ts': `import { users } from './routes/users'\n\nBun.serve({ port: 3000, routes: { '/users': users } })\n`,
        'src/routes/users.ts': `export function users(): Response {\n    return Response.json([{ id: 1, name: 'Ada' }])\n}\n`,
    }
    for (const [name, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
        await writeFile(path.join(dir, name), content)
    }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...args], { cwd: dir })
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'Initial commit')
}

const copy = {
    zh: {
        main: 'parseDuration 现在只认 m 和 s，加上小时（比如 1h30m），顺便补测试',
        think: '先看现有实现和测试，再改正则。',
        done: '已支持小时单位：\n\n- `parseDuration(\'1h30m\')` 返回 `5400`（秒）\n- 单位可以任意组合，顺序固定为 h → m → s\n- 无法解析的输入仍然抛 `RangeError`\n\n`bun test` 全部通过。',
        others: [
            ['GET /users 加上分页，默认每页 20 条', '好的，计划用 `?page=` 和 `?limit=` 两个参数，返回体加上 `total`。要我直接改吗？'],
            ['解释一下 server.ts 的启动流程', '`server.ts` 只做一件事：用 `Bun.serve` 在 3000 端口起服务，把 `/users` 路由交给 `routes/users.ts`。没有中间件，也没有优雅退出。'],
            ['把 zod 升级到 v4，看看哪些地方要改', '正在检查 zod 的用法…'],
        ],
        search: '小时',
        review: { summary: '小时单位已支持，测试通过；但常见的带空格写法会被拒绝。', issue: '"1h 30m" 抛 RangeError', detail: '单位之间带空格的写法很常见，正则不允许空白，`parseDuration(\'1h 30m\')` 直接报错。', fix: '匹配前去掉单位之间的空白，或在正则的每段后允许 `\\s*`。', suggestion: '补一条带空格写法的测试', suggestionDetail: '比如 "1h 30m" 和 " 2h "。' },
    },
    en: {
        main: 'parseDuration only knows m and s. Add hours (like 1h30m) and cover it with tests',
        think: 'Look at the current implementation and tests first, then change the regex.',
        done: 'Hours are supported now:\n\n- `parseDuration(\'1h30m\')` returns `5400` (seconds)\n- Units combine freely, always in h → m → s order\n- Anything unparseable still throws `RangeError`\n\n`bun test` passes.',
        others: [
            ['Paginate GET /users, 20 per page by default', 'Sure: `?page=` and `?limit=`, with a `total` in the response. Want me to make the change?'],
            ['Walk me through how server.ts starts up', '`server.ts` does one thing: `Bun.serve` on port 3000, with `/users` handled by `routes/users.ts`. No middleware, no graceful shutdown.'],
            ['Upgrade zod to v4 and see what needs to change', 'Checking how zod is used…'],
        ],
        search: 'hours',
        review: { summary: 'Hours work and the tests pass, but the common spaced form is rejected.', issue: '"1h 30m" throws RangeError', detail: 'Spaces between units are common, and the regex allows none: `parseDuration(\'1h 30m\')` throws.', fix: 'Drop whitespace between units before matching, or allow `\\s*` after each part.', suggestion: 'Test the spaced form', suggestionDetail: 'Such as "1h 30m" and " 2h ".' },
    },
} as const

const NEW_DURATION = `/** "1h30m" → 5400. Units: h, m, s, in that order. */
export function parseDuration(text: string): number {
    const match = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(text.trim())
    if (!match || text.trim() === '')
        throw new RangeError(\`not a duration: \${text}\`)
    const [, h = '0', m = '0', s = '0'] = match
    return Number(h) * 3600 + Number(m) * 60 + Number(s)
}
`

async function shoot(lang: Lang) {
    const t = copy[lang]
    const root = path.join(WORK, lang)
    await rm(root, { recursive: true, force: true })
    const repo = path.join(CODE, 'acme-api')
    await rm(repo, { recursive: true, force: true })
    const userData = path.join(root, 'userdata')
    const agentDir = path.join(root, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    await demoProject(repo)

    const toolNames = (r: any) => r.tools.map((x: any) => x.function?.name ?? x.name)
    const promptOf = (r: any) => {
        const user = [...r.messages].reverse().find((m: any) => m.role === 'user')
        return typeof user?.content === 'string' ? user.content : user?.content?.map((p: any) => p.text ?? '').join('') ?? ''
    }
    let reviewerStep = 0
    const llm = await startMockLlm((request) => {
        if (toolNames(request).includes('submit_review')) {
            if (reviewerStep++ === 0)
                return { delayMs: 2000, toolCalls: [{ name: 'bash', arguments: { command: 'bun -e "import { parseDuration } from \'./src/duration\'; console.log(parseDuration(\'1h 30m\'))"' } }] }
            return { delayMs: 3000, toolCalls: [{ name: 'submit_review', arguments: {
                verdict: 'needs_work',
                summary: t.review.summary,
                issues: [{ title: t.review.issue, severity: 'medium', file: 'src/duration.ts', line: 3, detail: t.review.detail, fix: t.review.fix, repro: 'bun -e "import { parseDuration } from \'./src/duration\'; console.log(parseDuration(\'1h 30m\'))"' }],
                suggestions: [{ title: t.review.suggestion, detail: t.review.suggestionDetail }],
            } }] }
        }
        const prompt = promptOf(request)
        const other = t.others.find(([q]) => prompt.includes(q))
        if (other)
            return { text: other[1], delayMs: 1800, usage: { input: 9400, output: 160 } }
        // The main thread: read → edit both files → run the tests → summary.
        const step = request.messages.filter((m: any) => m.role === 'tool').length
        if (step === 0)
            return { thinking: t.think, delayMs: 3200, usage: { input: 11_800, output: 240 }, toolCalls: [{ name: 'read', arguments: { path: 'src/duration.ts' } }, { name: 'read', arguments: { path: 'src/duration.test.ts' } }] }
        if (step === 2) {
            return { delayMs: 4100, usage: { input: 13_200, output: 610 }, toolCalls: [
                { name: 'edit', arguments: { path: 'src/duration.ts', edits: [{ oldText: DURATION, newText: NEW_DURATION }] } },
                { name: 'edit', arguments: { path: 'src/duration.test.ts', edits: [{ oldText: 'test(\'rejects garbage\'', newText: 'test(\'hours\', () => {\n    expect(parseDuration(\'1h30m\')).toBe(5400)\n    expect(parseDuration(\'2h\')).toBe(7200)\n    expect(parseDuration(\'1h0m5s\')).toBe(3605)\n})\n\ntest(\'rejects garbage\'' }] } },
            ] }
        }
        if (step === 4)
            return { delayMs: 1300, usage: { input: 14_100, output: 40 }, toolCalls: [{ name: 'bash', arguments: { command: 'bun test' } }] }
        return { text: t.done, delayMs: 2600, usage: { input: 14_700, output: 180 } }
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { demo: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'demo', models: [{ id: 'claude-sonnet-4-5', contextWindow: 200_000, maxTokens: 8000, reasoning: true }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'demo', defaultModel: 'claude-sonnet-4-5', defaultThinkingLevel: 'medium' }))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [repo],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: 'dark',
        lang,
        transcriptLang: lang,
        capabilities: ['todo', 'ask', 'approval', 'plan', 'review'],
        approvalMode: 'auto',
        windows: [{ projects: [repo] }],
        windowBounds: { [repo]: { x: 0, y: 0, width: WIDTH, height: HEIGHT } },
    }))
    const env = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }
    // Stands in for a terminal pi: presence entries need a live pid.
    const terminal = spawn('sleep', ['600'], { stdio: 'ignore' })

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const R = JSON.stringify(repo)
        const settled = () => until('turn settled', () => page.evaluate<boolean>('(() => { const t = window.__app.active; return !!t && !t.running && t.persisted && t.key === t.sessionPath })()'), 30_000)
        const send = async (text: string) => {
            await page.evaluate(`(() => { const t = window.__app.active; t.draft = ${JSON.stringify(text)}; void t.send(); return true })()`)
            await settled()
        }

        // History first, so the main thread is the newest. The zod one is "running in a terminal".
        const sessions: string[] = []
        for (const [question] of [...t.others].reverse()) {
            await page.evaluate(`window.__app.newThread(${R})`)
            await send(question)
            sessions.push(await page.evaluate<string>('window.__app.active.sessionPath'))
        }
        const zod = sessions[0]
        await page.evaluate(`(async () => { for (const t of [...window.__app.tabs]) await window.__app.closeTab(t.key); return true })()`)
        await writeFile(path.join(agentDir, 'pi-kit-presence', `${terminal.pid}.json`), JSON.stringify({ pid: terminal.pid, cwd: repo, session: zod, state: 'running', since: Date.now() - 83_000 }))

        await page.evaluate(`window.__app.newThread(${R})`)
        await send(t.main)
        await page.evaluate(`window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(sessions[2])}))`)
        await page.evaluate(`window.__app.focus(${JSON.stringify(await page.evaluate<string>('window.__app.tabs.at(0).key'))})`)
        await page.evaluate('(() => { if (!window.__app.reviewOpen) window.__app.toggleReview(); return true })()')
        await until('changes panel', () => page.evaluate<boolean>(`document.body.innerText.includes('duration.test.ts')`))
        // The turn's steps unfolded, and duration.ts's diff open in the panel.
        await page.evaluate(`[...document.querySelectorAll('button[aria-expanded="false"]')].find(b => /运行了|Ran /.test(b.textContent))?.click()`)
        await page.evaluate(`document.querySelector('[role="button"][aria-expanded="false"][title="src/duration.test.ts"]')?.click()`)
        await until('panel diff', () => page.evaluate<boolean>(`document.querySelector('[title="src/duration.test.ts"]')?.getAttribute('aria-expanded') === 'true'`))
        await until('terminal status', () => page.evaluate<boolean>(`!!document.querySelector('[aria-label^="pi in a terminal"], [aria-label^="终端中的 pi"]')`))
        await capture(page, path.join(OUT, lang, 'main.webp'))
        if (lang === 'en')
            await capture(page, path.join(OUT, '../og.png'), 1)

        // Search.
        await page.evaluate('window.__app.setSearchOpen(true)')
        await until('search dialog', () => page.evaluate<boolean>(`!!document.querySelector('[role="dialog"] input')`))
        await page.call('Input.insertText', { text: t.search })
        await until('search results', () => page.evaluate<boolean>(`document.querySelectorAll('[role="dialog"] [role="option"]').length >= 2`))
        await capture(page, path.join(OUT, lang, 'search.webp'))
        await page.evaluate('window.__app.setSearchOpen(false)')

        // Review the main thread's turn.
        await page.evaluate('(() => { if (window.__app.reviewOpen) window.__app.toggleReview(); return true })()')
        const reviewButton = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Review')`
        await until('Review button', () => page.evaluate<boolean>(`!!${reviewButton}`))
        await page.evaluate(`${reviewButton}.click()`)
        await until('report card', () => page.evaluate<boolean>(`!!document.querySelector('input[aria-label="Pick R1"], input[aria-label="选中 R1"]')`), 30_000)
        await page.evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.includes(${JSON.stringify(t.review.issue)}))?.click()`)
        await new Promise(r => setTimeout(r, 300))
        await page.evaluate(`(() => { const el = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY === 'auto' && e.textContent.includes(${JSON.stringify(t.review.issue)})); if (el) el.scrollTop = el.scrollHeight; return true })()`)
        await capture(page, path.join(OUT, lang, 'review.webp'))
        page.close()
    }
    finally {
        await stop()
        terminal.kill()
        await llm.close()
    }
}

/** The window's content, at 2x for the page (WebP) or 1x for link previews (PNG). */
async function capture(page: Page, file: string, scale = 2) {
    const { writeFile } = await import('node:fs/promises')
    await mkdir(path.dirname(file), { recursive: true })
    await page.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: scale, mobile: false })
    await new Promise(r => setTimeout(r, 500))
    const { data } = await page.call<{ data: string }>('Page.captureScreenshot', file.endsWith('.webp') ? { format: 'webp', quality: 90 } : { format: 'png' })
    await writeFile(file, Buffer.from(data, 'base64'))
    console.log(`wrote ${path.relative(process.cwd(), file)}`)
}

if (await Bun.file(path.join(CODE, '.pi-site')).exists() === false && (await import('node:fs')).existsSync(CODE))
    throw new Error(`${CODE} exists and is not this script's; move it away first`)
await mkdir(CODE, { recursive: true })
await writeFile(path.join(CODE, '.pi-site'), '')
for (const lang of (process.argv[2] ? [process.argv[2]] : ['zh', 'en']) as Lang[])
    await shoot(lang)
await rm(WORK, { recursive: true, force: true })
await rm(CODE, { recursive: true, force: true })
