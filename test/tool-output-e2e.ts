// End-to-end check that a tool's output can always be seen in full, in the built app with real pi
// and a scripted model (no tokens spent):
//   - a QR code a command prints shows whole under it, with its rows drawn touching, while it runs
//   - a running command expands into its output so far; the preview there doesn't cut the QR code
//   - when pi kept only the end of a long output, "open full output" opens the rest in a tab
//
//   bun run build && bun run e2e:tool-output
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-tool-output')
const SHOTS = process.env.SHOTS ?? ''
const QR_ROWS = 12
const QR_LINE = '█▀▀▀█ ▄▄ ▀█▄ █▀▀▀█'

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    // "qr": a login-style command that prints a QR code and waits; "big": more output than pi keeps.
    const qrCommand = `for i in $(seq ${QR_ROWS}); do echo '${QR_LINE}'; done; printf '\\033[93mScan this QR\\033[0m\\nhint\\nwaiting\\n'; sleep 8`
    const llm = await startMockLlm((request) => {
        const last = request.messages.at(-1)
        if (last?.role === 'tool')
            return { text: 'done' }
        const prompt = String(typeof last?.content === 'string' ? last.content : last?.content?.map((p: any) => p.text ?? '').join('') ?? '')
        if (prompt === 'qr')
            return { toolCalls: [{ name: 'bash', arguments: { command: qrCommand } }] }
        if (prompt === 'big')
            return { toolCalls: [{ name: 'bash', arguments: { command: 'seq 1 5000' } }] }
        return { text: `echo: ${prompt}` }
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
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

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const page = (await windows(1))[0].page
        const T = 'window.__app.active'
        const send = (text: string) => page.evaluate(`(() => { const t = ${T}; t.draft = ${JSON.stringify(text)}; void t.send(); return true })()`)
        /** Clicks the first button whose text includes `text`. */
        const click = (text: string) => page.evaluate<boolean>(`(() => {
            const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))
            b?.click()
            return !!b
        })()`)
        const outputText = () => page.evaluate<string>(`(() => {
            const label = [...document.querySelectorAll('span')].find(s => s.textContent === 'Output')
            return label?.parentElement?.nextElementSibling?.textContent ?? ''
        })()`)

        // ---------------------------------------------------------------- QR while running
        await send('qr')
        await until('the QR code is printed', () => page.evaluate<boolean>(`[...document.querySelectorAll('pre')].some(p => p.textContent.includes('Scan this QR'))`))
        const art = await page.evaluate<{ rows: number, lineHeight: string, wrap: string }>(`(() => {
            const span = [...document.querySelectorAll('pre span.leading-none')].find(s => s.textContent.includes(${JSON.stringify(QR_LINE)}))
            return span ? { rows: span.textContent.split('\\n').length, lineHeight: getComputedStyle(span).lineHeight, wrap: getComputedStyle(span).whiteSpace } : { rows: 0, lineHeight: '', wrap: '' }
        })()`)
        check(art.rows === QR_ROWS, `the tail shows the whole QR code (${art.rows} of ${QR_ROWS} rows), not just the last five lines`)
        check(art.lineHeight === '12px' && art.wrap === 'pre', `its rows touch and don't wrap (line-height ${art.lineHeight}, white-space ${art.wrap})`)
        check(!(await page.evaluate<boolean>(`[...document.querySelectorAll('pre')].some(p => p.textContent.includes('[93m'))`)), 'color codes are stripped, as in pi\'s TUI')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'tool-output-qr.png'))

        check(await page.evaluate<boolean>(`${T}.running`), 'the command is still running')
        check(await click('Pending'), 'a running command has a clickable result line')
        const rows = await until('its output opens while it runs', async () => (await outputText()).split(QR_LINE).length - 1)
        check(rows === QR_ROWS, `the preview doesn't cut the QR code at ten lines (${rows} of ${QR_ROWS} rows)`)
        check(await click('more lines'), 'the rest is a click away')
        await until('the whole output shows', async () => (await outputText()).includes('waiting'))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'tool-output-expanded.png'))
        check(await page.evaluate<boolean>(`${T}.running`), 'expanded before it finished')
        await until('qr run done', () => page.evaluate<boolean>(`!${T}.running`), 30_000)

        // ---------------------------------------------------------------- truncated output
        await send('big')
        await until('big run done', async () => llm.requests.length >= 4 && page.evaluate<boolean>(`!${T}.running`), 30_000)
        // The finished turn folds to "Ran 1 command"; open the last one.
        await page.evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('Ran 1 command')).at(-1).click()`)
        await until('the command row', () => page.evaluate<boolean>(`document.body.innerText.includes('lines returned')`))
        check(await click('lines returned'), 'the long output expands')
        await until('the open-full-output link', () => page.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent === 'open full output')`))
        await click('open full output')
        const tab = await until('the full output opens in a tab', () => page.evaluate<{ kind: string, path: string } | null>(`(() => {
            const t = window.__app.activeTab
            return t?.kind === 'file' ? { kind: t.kind, path: t.path } : null
        })()`))
        const text = await until('the file loads', () => page.evaluate<string>(`(() => { const t = window.__app.activeTab; return t?.loaded ? t.base : '' })()`))
        check(text.startsWith('1\n') && text.trimEnd().endsWith('5000'), `${path.basename(tab.path)} holds all 5000 lines`)

        console.log('\nall tool output checks passed')
    }
    finally {
        await stop()
        await llm.close()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
