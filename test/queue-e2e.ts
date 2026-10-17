// End-to-end check of the queue as pi's TUI keeps it, in the built app with real pi and a scripted
// model (no tokens spent):
//   - a message typed mid-run shows queued; a row's button, or Alt+Up (Alt+Q on Windows), takes the
//     whole queue (with its images) back into the editor, and the run goes on
//   - Alt+Enter queues a follow-up; what was taken back never reaches the model
//   - a message typed during a compaction is held, then sent once it ends
//   - `!cmd` runs in pi at once (mid-run too), streams, Esc cancels it; `!!cmd` stays out of the context
//   - a project with its own pi resources: the thread asks pi's trust question before pi starts, a
//     session-only answer stays with the thread, a saved one goes into pi's trust.json
//
//   bun run build && bun run e2e:queue
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-queue')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGO8o6HBAAZMEIqBgQEAFggBMBhSqiYAAAAASUVORK5CYII='

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const trusting = path.join(WORK, 'trusting')
    await mkdir(path.join(trusting, '.pi', 'extensions'), { recursive: true })
    await writeFile(path.join(trusting, '.pi', 'extensions', 'mine.ts'), `export default function (pi) { pi.registerCommand('from-project', { handler: async () => {} }) }`)
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
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', input: ['text', 'image'], contextWindow: 100_000, maxTokens: 1000 }, { id: 'mock-2', reasoning: true, contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off', compaction: { keepRecentTokens: 1 } }))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [repo, trusting],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [repo, trusting] }],
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
        await page.evaluate(`(() => { const b = document.querySelector('button[aria-label="Compact context"]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true })()`)
        await until('the compact popover', () => page.evaluate<boolean>(`!!document.querySelector('[data-compact-popover]')`))
        await page.evaluate(`(() => { [...document.querySelectorAll('[data-compact-popover] button')].find(b => b.textContent.trim() === 'Compact').click(); return true })()`)
        await until('compacting', () => page.evaluate<boolean>(`${T}.compacting`))
        await send('after compaction', true)
        check(await page.evaluate<string>(`${T}.compactionQueue.map(q => q.text).join('|')`) === 'after compaction', 'a message typed while pi compacts is held, as its TUI holds it')
        await until('sent once compaction ends', () => page.evaluate<boolean>(`!${T}.compacting && ${T}.compactionQueue.length === 0`), 20_000)
        await until('it reaches the model', async () => seen().includes('after compaction'), 20_000)
        check(JSON.stringify(llm.requests.find(r => JSON.stringify(r.messages).includes('after compaction'))?.messages.at(-1)).includes('image_url'), 'and goes in once compaction ends, with its image')

        // ---------------------------------------------------------------- `!cmd`, as pi's TUI runs it
        await until('idle', () => page.evaluate<boolean>(`!${T}.running && !${T}.compacting`), 20_000)
        const asked = llm.requests.length
        const bashes = () => page.evaluate<any[]>(`${T}.live.filter(l => l.message.role === 'bashExecution').map(l => ({ ...l.message }))`)
        await send('!echo bang-out')
        await until('!cmd ran', async () => (await bashes()).some(b => b.output === 'bang-out\n' && b.exitCode === 0))
        check(llm.requests.length === asked, '`!cmd` runs in pi without a turn')
        check(await page.evaluate<boolean>(`document.body.innerText.includes('echo bang-out')`), 'and shows as `$ command` with its output')
        await send('!!echo hidden-out')
        await until('!!cmd ran', async () => (await bashes()).some(b => b.output === 'hidden-out\n'))
        await send('!echo started; sleep 30')
        await until('its output streams', () => page.evaluate<boolean>(`!!${T}.bash?.output.includes('started')`))
        check(true, 'its output streams in while it runs')
        await key({ key: 'Escape', code: 'Escape' })
        await until('Esc cancels it', async () => (await bashes()).some(b => b.command === 'echo started; sleep 30' && b.cancelled) && !(await page.evaluate<boolean>(`!!${T}.bash`)))
        check(true, 'Esc cancels it, as in the terminal')
        await send('slow with bash')
        await until('running', () => page.evaluate<boolean>(`${T}.running`))
        await send('!echo mid-run')
        await until('!cmd mid-run', async () => (await bashes()).some(b => b.output === 'mid-run\n'))
        check(await steering() === '', 'mid-run it runs at once, not queued')
        await until('slow run done', () => page.evaluate<boolean>(`!${T}.running`), 20_000)
        const context = JSON.stringify(llm.requests.at(-1)?.messages)
        check(context.includes('bang-out') && !context.includes('hidden-out'), '`!` output reaches the model, `!!` output does not')

        // ---------------------------------------------------------------- project trust, as pi's TUI asks it
        const question = async () => JSON.parse(await page.evaluate<string>(`JSON.stringify(${T}.uiRequests[0] ?? null)`))
        const projectCommand = () => page.evaluate<boolean>(`${T}.commands.some(c => c.name === 'from-project')`)
        const answer = (label: string) => page.evaluate(`(() => { const t = ${T}; t.respondUi(t.uiRequests[0], { value: ${JSON.stringify(label)} }); return true })()`)
        await page.evaluate(`(() => { window.__app.newThread(${JSON.stringify(trusting)}); return true })()`)
        const trustAsked = await until('pi\'s trust question', question)
        check(trustAsked.title === 'Trust project folder?' && trustAsked.options.includes('Trust (this session only)') && trustAsked.options.includes('Do not trust'), 'a project with its own extensions asks pi\'s trust question first')
        check(await page.evaluate<string>(`${T}.agentStatus`) === 'starting' && !(await page.evaluate<string | null>(`${T}.agentId`)), 'and pi waits for the answer')
        await answer('Trust (this session only)')
        await until('pi ready, trusting', async () => (await page.evaluate<string>(`${T}.agentStatus`)) === 'ready' && await projectCommand())
        check(true, 'trusted for this session: pi loads the project\'s extension')
        const trustFile = path.join(agentDir, 'trust.json')
        check(!(await readFile(trustFile, 'utf8').catch(() => '')), 'and nothing is saved')
        await page.evaluate(`(async () => { await window.__app.closeTab(${T}.key); window.__app.newThread(${JSON.stringify(trusting)}); return true })()`)
        await until('asked again in a new thread', question)
        await answer('Do not trust')
        await until('pi ready, not trusting', async () => (await page.evaluate<string>(`${T}.agentStatus`)) === 'ready')
        check(!(await projectCommand()), 'not trusted: the project\'s extension stays off')
        check(JSON.parse(await readFile(trustFile, 'utf8'))[await realpath(trusting)] === false, 'the choice is in pi\'s trust.json, as its TUI saves it')
        await page.evaluate(`(async () => { await window.__app.closeTab(${T}.key); window.__app.newThread(${JSON.stringify(trusting)}); return true })()`)
        await until('a third thread starts', async () => (await page.evaluate<string>(`${T}.agentStatus`)) === 'ready')
        check(!(await question()), 'a saved choice is not asked again')

        // ---------------------------------------------------------------- picking is pi's Ctrl+S
        const settings = async () => JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'))
        await page.evaluate(`(async () => { await ${T}.setModel(${T}.models.find(m => m.id === 'mock-2')); await ${T}.setThinkingLevel('high'); return true })()`)
        await until('the default saved', async () => (await settings()).defaultModel === 'mock-2' && (await settings()).defaultThinkingLevel === 'high')
        check((await settings()).compaction?.keepRecentTokens === 1, 'a picked model and level become pi\'s defaults, the other settings kept')
        await page.evaluate(`(async () => { await window.__app.closeTab(${T}.key); window.__app.newThread(${JSON.stringify(repo)}); return true })()`)
        await until('a new thread on the picked model', () => page.evaluate<boolean>(`${T}.agentStatus === 'ready' && ${T}.state?.model?.id === 'mock-2' && ${T}.state?.thinkingLevel === 'high'`), 30_000)
        check(true, 'a new thread starts on them')

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
