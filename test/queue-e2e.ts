// End-to-end check of the queue as pi's TUI keeps it, in the built app with real pi and a scripted
// model (no tokens spent):
//   - a message typed mid-run shows queued; a row's button, or Alt+Up (Alt+Q on Windows), takes the
//     whole queue (with its images) back into the editor, and the run goes on
//   - Alt+Enter queues a follow-up; what was taken back never reaches the model
//   - a message typed during a compaction is held, then sent once it ends
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

    // "slow" holds its answer back long enough to queue behind it, and so does the compaction summary
    // once asked to; anything else is echoed.
    let compactSlowly = false
    const llm = await startMockLlm((request) => {
        const last = request.messages.at(-1)
        const prompt = String(typeof last?.content === 'string' ? last.content : last?.content?.map((p: any) => p.text ?? '').join('') ?? '')
        if (compactSlowly && prompt.includes('<conversation>'))
            return { text: '## Goal\nsummary', delayMs: 3000 }
        return prompt.startsWith('slow') ? { text: 'slow done', delayMs: 4000 } : { text: `echo: ${prompt}` }
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', input: ['text', 'image'], contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off', compaction: { keepRecentTokens: 1 } }))
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

        // ---------------------------------------------------------------- taking the queue back
        await send('slow first')
        // Queued behind a model call under way, as typed while pi works.
        await until('the model is answering', async () => llm.requests.length === 1)
        await send('one')
        await until('one queued', async () => (await steering()) === 'one')
        await send('two', true)
        await until('two queued', async () => (await steering()) === 'one|two')
        const buttons = 'document.querySelectorAll(\'button[aria-label="Take back the queued messages"]\')'
        check(await page.evaluate<number>(`${buttons}.length`) === 2, 'each queued message has a take-back button')
        await page.evaluate(`${buttons}[1].click()`)
        await until('all taken back', async () => (await draft()) === 'one\ntwo' && (await steering()) === '')
        check(true, 'it takes the whole queue back, as pi takes it')
        check(await page.evaluate<number>(`${T}.images.length`) === 1, 'with the image it was sent with')

        await page.evaluate(`(() => { ${T}.draft = ''; ${T}.images = []; return true })()`)
        await send('three')
        await until('three queued', async () => (await steering()) === 'three')
        const key = (init: Record<string, unknown>) => page.evaluate(`(() => {
            const el = document.querySelector('textarea')
            el.focus()
            el.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ ...init, bubbles: true })}))
            return true
        })()`)
        await key(process.platform === 'win32' ? { key: 'q', code: 'KeyQ', altKey: true } : { key: 'ArrowUp', code: 'ArrowUp', altKey: true })
        await until('Alt+Up takes it back', async () => (await draft()) === 'three' && (await steering()) === '')
        check(true, 'Alt+Up (Alt+Q on Windows) takes the queue back, as in the terminal\'s pi')
        check(await page.evaluate<boolean>(`${T}.running`), 'and the run goes on')

        // ---------------------------------------------------------------- Alt+Enter: a follow-up
        await page.evaluate(`(() => { ${T}.draft = 'later'; return true })()`)
        await key({ key: 'Enter', code: 'Enter', altKey: true })
        await until('later queued as a follow-up', () => page.evaluate<boolean>(`${T}.queue.followUp.join('|') === 'later' && ${T}.queue.steering.length === 0`))
        check(true, 'Alt+Enter queues a follow-up, as pi\'s app.message.followUp')

        await until('first run done', () => page.evaluate<boolean>(`!${T}.running && ${T}.queue.followUp.length === 0`), 20_000)
        check(!seen().includes('"one"') && !seen().includes('"two"') && !seen().includes('"three"'), 'taken-back messages never reach the model')
        check(seen().includes('later'), 'the follow-up does')

        // ---------------------------------------------------------------- typed during a compaction
        compactSlowly = true
        await page.evaluate(`(() => { void ${T}.compact(); return true })()`)
        await until('compacting', () => page.evaluate<boolean>(`${T}.compacting`))
        await send('after compaction', true)
        check(await page.evaluate<string>(`${T}.compactionQueue.map(q => q.text).join('|')`) === 'after compaction', 'a message typed while pi compacts is held, as its TUI holds it')
        await until('sent once compaction ends', () => page.evaluate<boolean>(`!${T}.compacting && ${T}.compactionQueue.length === 0`), 20_000)
        await until('it reaches the model', async () => seen().includes('after compaction'), 20_000)
        check(JSON.stringify(llm.requests.find(r => JSON.stringify(r.messages).includes('after compaction'))?.messages.at(-1)).includes('image_url'), 'and goes in once compaction ends, with its image')

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
