// End-to-end check of subagents in the project tree and their own view, in the built app with real
// pi and a scripted model (no tokens spent):
//   - two parallel subagents show as rows under their thread, with what each is doing
//   - one waiting on an approval turns amber; opening it shows the prompt, and allowing it there works
//   - the other opens like a thread: its task as the prompt, a steer from its composer reaches it
//   - finished, the open one stays in the tree, read-only; Esc goes back to the thread
//
//   bun run build && bun run e2e:subagents   (SHOTS=/some/dir to save screenshots)
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, PORT, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-subagents')
const SHOTS = process.env.SHOTS ?? ''

const text = (m: any) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join('')

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), '# demo\n')

    // Parent (offered the subagent tool): two subagents at once, then an answer. Child A sleeps in
    // bash long enough to be steered, then answers (acknowledging a steer if it got one). Child B
    // runs a command that needs approval.
    const llm = await startMockLlm((request) => {
        const all = JSON.stringify(request.messages)
        if (request.tools.some((t: any) => t.function?.name === 'subagent')) {
            return request.toolResults.length
                ? { text: 'Both subagents reported back.' }
                : { toolCalls: [
                        { name: 'subagent', arguments: { title: 'Survey the docs', task: 'TASK A: read the docs and summarize them' } },
                        { name: 'subagent', arguments: { title: 'Touch a marker', task: 'TASK B: create the marker file' } },
                    ] }
        }
        const last = request.messages.at(-1)
        if (all.includes('TASK A')) {
            if (!request.toolResults.length)
                // Held back so B's approval always comes first (pi asks one at a time).
                return { delayMs: 1500, thinking: 'Look at the files first.', toolCalls: [{ name: 'bash', arguments: { command: 'sleep 5; ls' } }] }
            return { text: text(last).includes('only README') ? 'Steered: README.md says demo.' : 'Docs: README.md.' }
        }
        if (all.includes('TASK B'))
            return request.toolResults.length ? { text: 'Marker created.' } : { toolCalls: [{ name: 'bash', arguments: { command: 'touch marker.txt' } }] }
        return { text: 'ok' }
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
        theme: process.env.E2E_THEME ?? 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: ['approval', 'subagent'],
        approvalMode: 'ask',
        windows: [{ projects: [repo] }],
    }))
    const env = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }

    const stop = await launch(env)
    let current: Awaited<ReturnType<typeof windows>>[number]['page'] | undefined
    try {
        const page = (await windows(1))[0].page
        current = page
        const shot = async (name: string) => SHOTS && page.screenshot(path.join(SHOTS, name))
        const T = 'window.__app.active'
        const rows = `[...document.querySelectorAll('[role="treeitem"][aria-level="3"]')]`
        const row = (title: string) => `${rows}.find(r => r.innerText.includes(${JSON.stringify(title)}))`

        await page.evaluate(`(() => { const t = ${T}; t.draft = 'split the work'; void t.send(); return true })()`)

        // ---------------------------------------------------------------- the tree
        await until('two subagent rows', () => page.evaluate<boolean>(`${rows}.length === 2`), 30_000)
        check(true, 'two parallel subagents show as rows under their thread')
        await until('B waiting', () => page.evaluate<boolean>(`!!${row('Touch a marker')}?.innerText.includes('Waiting for approval')`), 20_000)
        check(await page.evaluate<boolean>(`!!${row('Touch a marker')}.querySelector('.bg-amber-500')`), 'the one waiting on an approval is marked amber')
        check(await page.evaluate<boolean>(`[...document.querySelectorAll('[role="treeitem"][aria-level="2"]')].some(r => r.innerText.includes('2 subagents running') || r.innerText.includes('Waiting for approval'))`), 'the thread row sums them up instead of naming one')
        await shot('subagents-tree.png')

        // ---------------------------------------------------------------- B: approve from its view
        await page.evaluate(`${row('Touch a marker')}.click()`)
        await until('B view', () => page.evaluate<boolean>(`${T}.openSubagent?.title === 'Touch a marker' && document.body.innerText.includes('TASK B: create the marker file')`))
        check(await page.evaluate<boolean>(`${row('Touch a marker')}.getAttribute('aria-selected') === 'true'`), 'its row becomes the selection')
        await until('approval in B view', () => page.evaluate<boolean>(`document.body.innerText.includes('needs your approval')`))
        check(true, 'the subagent view shows its task as the prompt and the approval it waits on')
        await shot('subagents-approval.png')
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Allow').click()`)
        await until('B done', () => page.evaluate<boolean>(`${T}.openSubagent?.status === 'done' && document.body.innerText.includes('Marker created.')`), 20_000)
        check(await page.evaluate<boolean>(`document.body.innerText.includes('The subagent finished; its reply went to the thread.')`), 'allowed there, it finishes; its composer turns read-only')

        // ---------------------------------------------------------------- A: steer from its composer
        await page.evaluate(`${row('Survey the docs')}.click()`)
        await until('A view', () => page.evaluate<boolean>(`${T}.openSubagent?.title === 'Survey the docs' && !!document.querySelector('textarea[aria-label^="Steer subagent"]')`))
        check(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label')?.startsWith('Steer subagent') === true`), 'opening it from the tree focuses its composer')
        // Its sleep asks too (pi asks one at a time, so only now that B's was answered).
        await until('approval in A view', () => page.evaluate<boolean>(`document.body.innerText.includes('needs your approval')`), 10_000)
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Allow').click()`)
        await until('A running', () => page.evaluate<boolean>(`!document.body.innerText.includes('needs your approval') && !!${row('Survey the docs')}?.innerText.includes('Running sleep 5; ls')`), 10_000)
        check(true, 'its own approval, answered in its view, lets it run; the row says what it runs')
        await page.evaluate(`(() => {
            const el = document.querySelector('textarea[aria-label^="Steer subagent"]')
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            set.call(el, 'only README please')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true
        })()`)
        await page.evaluate(`document.querySelector('button[aria-label="Send steering message"]').click()`)
        await until('steer queued', () => page.evaluate<boolean>(`document.body.innerText.includes('Queued')`), 10_000)
        await shot('subagents-steer.png')
        await until('steer answered', () => page.evaluate<boolean>(`document.body.innerText.includes('Steered: README.md says demo.')`), 30_000)
        check(true, 'a steer sent from its composer reaches the child, and shows as its own prompt')

        // ---------------------------------------------------------------- after the run
        await until('parent settled', () => page.evaluate<boolean>(`!${T}.running`), 30_000)
        const left = await page.evaluate<string[]>(`${rows}.map(r => r.innerText.split('\\n')[0])`)
        check(left.length === 2 && left.includes('Survey the docs'), `after the run the open subagent's set stays in the tree (${left.join(', ')})`)
        await shot('subagents-done.png')
        await page.evaluate(`document.querySelector('section[aria-label*=" / "]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await until('back to thread', () => page.evaluate<boolean>(`!${T}.openSubagent && document.body.innerText.includes('Both subagents reported back.')`))
        check(await page.evaluate<boolean>(`${rows}.length === 0`), 'Esc goes back to the thread; idle, the tree drops the subagent rows')
        // The finished turn folds its process; unfolded, each card has an open button.
        await page.evaluate(`document.querySelector('[data-row-kind="fold"] button[aria-expanded="false"]').click()`)
        await until('open buttons', () => page.evaluate<boolean>(`document.querySelectorAll('button[aria-label^="Open subagent"]').length === 2`))
        await page.evaluate(`document.querySelector('button[aria-label="Open subagent “Touch a marker”"]').click()`)
        await until('opened from its card', () => page.evaluate<boolean>(`${T}.openSubagent?.title === 'Touch a marker' && document.body.innerText.includes('Marker created.')`))
        check(await page.evaluate<boolean>(`${row('Touch a marker')}?.getAttribute('aria-selected') === 'true'`), 'its card in the transcript opens it too, and the tree shows it selected')
        page.close()
    }
    catch (error) {
        // What the tree and the pane showed when a check gave up.
        console.error(error)
        console.error(await current?.evaluate<string>(`[...document.querySelectorAll('[role="treeitem"]')].map(r => r.getAttribute('aria-level') + ' ' + r.innerText.replace(/\\n/g, ' | ')).join('\\n')`))
        if (SHOTS)
            await current?.screenshot(path.join(SHOTS, 'subagents-failure.png'))
        throw error
    }
    finally {
        await stop()
        await llm.close()
    }
    console.log(`all subagent checks passed (port ${PORT})`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
