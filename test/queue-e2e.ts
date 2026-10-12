// End-to-end check of taking queued messages back, in the built app with real pi and a scripted
// model (no tokens spent):
//   - a message typed mid-run shows queued; its row's button puts it (and its image) back in the
//     editor, and the others stay queued in order
//   - Alt+Up (Alt+Q on Windows), as in the terminal's pi, takes the whole queue back
//   - what stays queued still reaches the model; what was taken back never does
//
//   bun run build && bun run e2e:queue
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-queue')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGO8o6HBAAZMEIqBgQEAFggBMBhSqiYAAAAASUVORK5CYII='

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    // "slow" holds its answer back long enough to queue behind it; anything else is echoed.
    const llm = await startMockLlm((request) => {
        const last = request.messages.at(-1)
        const prompt = String(typeof last?.content === 'string' ? last.content : last?.content?.map((p: any) => p.text ?? '').join('') ?? '')
        return prompt.startsWith('slow') ? { text: 'slow done', delayMs: 4000 } : { text: `echo: ${prompt}` }
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', input: ['text', 'image'], contextWindow: 100_000, maxTokens: 1000 }] } },
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
        const send = (text: string, image = false) => page.evaluate(`(() => {
            const t = ${T}
            t.draft = ${JSON.stringify(text)}
            t.images = ${image ? `[{ type: 'image', data: ${JSON.stringify(PNG)}, mimeType: 'image/png' }]` : '[]'}
            void t.send()
            return true
        })()`)
        const steering = () => page.evaluate<string>(`${T}.queue.steering.join('|')`)
        const draft = () => page.evaluate<string>(`${T}.draft`)
        const seen = () => llm.requests.map(r => JSON.stringify(r.messages)).join('\n')

        // ---------------------------------------------------------------- one message back
        await send('slow first')
        // Queued behind a model call under way, as typed while pi works.
        await until('the model is answering', async () => llm.requests.length === 1)
        await send('one')
        await until('one queued', async () => (await steering()) === 'one')
        await send('two', true)
        await until('two queued', async () => (await steering()) === 'one|two')
        await send('three')
        await until('three queued', async () => (await steering()) === 'one|two|three')
        const buttons = 'document.querySelectorAll(\'button[aria-label="Take back this queued message"]\')'
        check(await page.evaluate<number>(`${buttons}.length`) === 3, 'each queued message has a take-back button')

        await page.evaluate(`${buttons}[1].click()`)
        await until('two taken back', async () => (await draft()) === 'two' && (await steering()) === 'one|three')
        check(true, 'the button puts its message in the editor; the others stay queued, in order')
        check(await page.evaluate<number>(`${T}.images.length`) === 1, 'with the image it was sent with')

        // ---------------------------------------------------------------- Alt+Up takes all
        const altUp = process.platform === 'win32' ? { key: 'q', code: 'KeyQ' } : { key: 'ArrowUp', code: 'ArrowUp' }
        await page.evaluate(`(() => {
            const el = document.querySelector('textarea')
            el.focus()
            el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(altUp.key)}, code: ${JSON.stringify(altUp.code)}, altKey: true, bubbles: true }))
            return true
        })()`)
        await until('all taken back', async () => (await draft()) === 'one\nthree\ntwo' && (await steering()) === '')
        check(true, 'Alt+Up takes the whole queue back, in front of what is typed')
        check(await page.evaluate<boolean>(`${T}.running`), 'and the run goes on')

        await until('first run done', () => page.evaluate<boolean>(`!${T}.running`), 20_000)
        check(!seen().includes('"one"') && !seen().includes('"three"') && !seen().includes('"two"'), 'taken-back messages never reach the model')

        // ---------------------------------------------------------------- the rest still goes
        await page.evaluate(`(() => { ${T}.draft = ''; ${T}.images = []; return true })()`)
        await send('slow second')
        await until('the model is answering again', async () => llm.requests.length === 2)
        await send('four')
        await send('five')
        await until('four and five queued', async () => (await steering()) === 'four|five')
        await page.evaluate(`${buttons}[0].click()`)
        await until('four taken back', async () => (await draft()) === 'four' && (await steering()) === 'five')
        await until('second run done', () => page.evaluate<boolean>(`!${T}.running && ${T}.queue.steering.length === 0`), 20_000)
        check(seen().includes('five') && !seen().includes('four'), 'the message queued again after one was taken back still reaches the model')

        console.log('\nall queue checks passed')
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
