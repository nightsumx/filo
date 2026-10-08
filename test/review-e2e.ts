// End-to-end check of Review in the built app, with real pi and a scripted model (no tokens spent):
//   - a finished turn's footer offers Review; clicking it runs a read-only reviewer in the background
//   - its progress shows in that footer, then the report card lands in the transcript
//   - an issue the reviewer reproduced is marked so, with the command's exit code as evidence
//   - picked items and a note go back to the agent as one feedback prompt, and are marked sent
//   - the report and the sent marks survive reloading the session from disk
//
//   bun run build && bun run e2e:review
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, PORT, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-review')
const SHOTS = process.env.SHOTS ?? ''

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const toolNames = (r: any) => r.tools.map((t: any) => t.function?.name ?? t.name)

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'a.txt'), 'original\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')

    // Parent: "edit" writes a.txt, then claims success; feedback gets an acknowledgement.
    // Reviewer (offered submit_review): runs a failing check, then reports it with that command.
    let reviewerStep = 0
    const llm = await startMockLlm((request) => {
        const last = request.messages.at(-1)
        if (toolNames(request).includes('submit_review')) {
            if (reviewerStep++ === 0)
                return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 1.5; grep -q fixed a.txt' } }] }
            return { toolCalls: [{ name: 'submit_review', arguments: {
                verdict: 'needs_work',
                summary: 'The change does not do what the agent claims: a.txt never says fixed.',
                issues: [
                    { title: 'a.txt is missing the fix', severity: 'high', file: 'a.txt', line: 1, detail: 'The user asked for "fixed"; the file says "changed".', fix: 'Write "fixed" to a.txt.', repro: 'sleep 1.5; grep -q fixed a.txt' },
                    { title: 'No trailing newline check', severity: 'low', detail: 'Unverified guess.' },
                ],
                suggestions: [{ title: 'Add a test for a.txt', detail: 'A one-line check would catch this.' }],
            } }] }
        }
        if (last?.role === 'tool')
            return { text: 'Done: a.txt now says fixed, and I verified it.' }
        const prompt = JSON.stringify(last?.content ?? '')
        if (prompt.includes('independent reviewer'))
            return { text: 'R1: fixing it now.' }
        if (prompt.includes('edit'))
            return { toolCalls: [{ name: 'write', arguments: { path: 'a.txt', content: 'changed\n' } }] }
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
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: ['review'],
        windows: [{ projects: [repo] }],
    }))
    const env = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const text = () => page.evaluate<string>('document.body.innerText')
        const button = (label: string) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)}))`
        const key = await page.evaluate<string>('window.__app.active.key')
        await page.evaluate(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); t.draft = 'edit a.txt to say fixed'; void t.send(); return true })()`)
        await until('turn settled', () => page.evaluate<boolean>('(() => { const t = window.__app.active; return !!t && !t.running && t.persisted && t.key === t.sessionPath })()'), 30_000)
        const thread = 'window.__app.active'

        await until('Review in the footer', () => page.evaluate<boolean>(`!!${button('Review')}`))
        check(true, 'a finished turn that did work offers Review in its footer')
        await page.evaluate(`${button('Review')}.click()`)
        await until('review progress', async () => (await text()).includes('Reviewing'), 10_000)
        check(await page.evaluate<boolean>(`!!${button('Stop')}`), 'while it runs, the footer shows its progress and Stop')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'review-running.png'))

        await until('report card', async () => (await text()).includes('needs work'), 30_000)
        const card = await text()
        check(card.includes('a.txt is missing the fix') && card.includes('Add a test for a.txt'), 'the report card lists the issues and suggestions')
        check(card.includes('reproduced') && card.includes('suspected'), 'the reproduced issue and the guess are told apart')
        check(!card.includes('Reviewing'), 'the progress line is gone once the report is in')
        const parentCalls = () => llm.requests.filter(r => !toolNames(r).includes('submit_review'))
        check(parentCalls().length === 2 && !JSON.stringify(parentCalls().map(r => r.messages)).includes('missing the fix'), 'the agent was not told anything yet')

        // Open R1 for its evidence.
        await page.evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.includes('a.txt is missing the fix')).click()`)
        await until('evidence', async () => (await text()).includes('$ sleep 1.5; grep -q fixed a.txt'))
        check((await text()).includes('exit code 1'), 'its evidence is the command the reviewer ran, with exit code 1')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'review-report.png'))

        // Unsent issues start picked, suggestions not: swap R2 for S1, add a note, send.
        check(await page.evaluate<boolean>(`document.querySelector('input[aria-label="Pick R1"]').checked && document.querySelector('input[aria-label="Pick R2"]').checked && !document.querySelector('input[aria-label="Pick S1"]').checked`), 'issues start picked, suggestions do not')
        await page.evaluate(`document.querySelector('input[aria-label="Pick R2"]').click()`)
        await page.evaluate(`document.querySelector('input[aria-label="Pick S1"]').click()`)
        const noteSet = await page.evaluate<boolean>(`(() => {
            const input = document.querySelector('input[aria-label="Note"]')
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(input, 'keep the change small')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            return true
        })()`)
        check(noteSet, 'note typed')
        await until('send enabled', () => page.evaluate<boolean>(`${button('Send to agent (2)')}?.disabled === false`))
        await page.evaluate(`${button('Send to agent (2)')}.click()`)
        await until('feedback turn settled', () => page.evaluate<boolean>(`(() => { const t = ${thread}; return !t.running && JSON.stringify(t.items).includes('R1: fixing it now') })()`), 30_000)
        const fed = JSON.stringify(parentCalls().at(-1)!.messages)
        check(fed.includes('R1 [confirmed, high] a.txt is missing the fix') && fed.includes('S1 [suggestion]') && fed.includes('keep the change small'), 'the agent got the picked items with evidence and the note')
        check(!fed.includes('No trailing newline check'), 'and not the item left unpicked')
        await until('feedback bubble', async () => (await text()).includes('Sent back 2 review items'))
        check((await text()).includes('keep the change small'), 'the transcript shows what was sent back as a compact prompt')
        check(await page.evaluate<number>(`[...document.querySelectorAll('span')].filter(s => s.textContent === 'sent').length`) === 2, 'sent items are marked in the card')
        const order = await page.evaluate<string[]>(`${thread}.turns.map(t => t.user?.review ? 'feedback' : t.user ? 'prompt' : t.steps.map(s => s.kind).join('+'))`)
        check(order.join() === 'prompt,review,feedback', `the report sits between the reviewed turn and the feedback (${order.join()})`)
        if (SHOTS) {
            await page.evaluate(`(() => { const el = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY === 'auto' && e.textContent.includes('Sent back')); el.scrollTop = el.scrollHeight; return true })()`)
            await page.screenshot(path.join(SHOTS, 'review-sent.png'))
        }

        // From disk: the report and its sent marks come back.
        await page.evaluate(`(async () => { const t = ${thread}; t.items = []; await t.load(); return true })()`)
        await until('reloaded card', async () => (await text()).includes('needs work'))
        check(await page.evaluate<number>(`[...document.querySelectorAll('span')].filter(s => s.textContent === 'sent').length`) === 2, 'after reloading the session the report and sent marks are still there')
        await until('Review again', () => page.evaluate<boolean>(`!!${button('Review')}`))
        check(true, 'the latest turn offers Review again')
        page.close()
    }
    finally {
        await stop()
        await llm.close()
    }
    console.log(`all review checks passed (port ${PORT})`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
