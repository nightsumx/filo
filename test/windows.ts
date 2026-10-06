// End-to-end check of project windows in the built app, with real pi and a slow mock model:
// one window per project, merging windows while a thread streams (the run carries on in the merged
// window), moving a project back out, settings reaching every window, and the windows reopening.
//
//   bun run build && bun run e2e:windows
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows } from './app'

const WORK = '/private/tmp/pi-gui-windows'
const CHUNKS = Array.from({ length: 16 }, (_, i) => `part${i} `)
const FULL = CHUNKS.join('')
const CHUNK_MS = 150

/** OpenAI-compatible endpoint that streams FULL slowly, so a run is still going when windows merge. */
async function slowModel() {
    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
            body += c
        })
        req.on('end', async () => {
            const model = JSON.parse(body || '{}').model
            const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            for (const text of CHUNKS) {
                chunk({ role: 'assistant', content: text })
                await new Promise(r => setTimeout(r, CHUNK_MS))
            }
            chunk({}, 'stop')
            res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
            res.end('data: [DONE]\n\n')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() }
}

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const a = path.join(WORK, 'alpha')
    const b = path.join(WORK, 'beta')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([a, b, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    const model = await slowModel()
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: model.url, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [a, b],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'split',
        theme: 'dark',
        capabilities: [],
        windows: [{ projects: [a] }, { projects: [b] }],
    }))
    const env = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }

    let stop = await launch(env)
    try {
        let wins = await windows(2)
        const byProject = (cwd: string) => wins.find(w => w.projects.includes(cwd))!
        check(wins.map(w => w.projects.join(',')).sort().join(' | ') === [a, b].sort().join(' | '), 'one window per project')
        check(await byProject(a).page.evaluate<string>('document.title') === 'alpha', 'window title is the project name')
        check(await byProject(a).page.evaluate<number>('document.querySelectorAll(\'[role="tree"] [aria-level="1"]\').length') === 1, 'project tree lists only the window\'s project')
        check(await byProject(b).page.evaluate<boolean>(`window.__app.isOpen(${JSON.stringify(a)})`), 'other windows know the project is open')

        // A run in alpha, still streaming when beta merges every window into itself.
        await byProject(a).page.evaluate(`(() => { const t = window.__app.active; t.draft = 'stream please'; void t.send(); return true })()`)
        await until('alpha streaming', () => byProject(a).page.evaluate<boolean>('!!window.__app.active?.streaming?.content?.[0]?.text'))
        const before = await byProject(a).page.evaluate<string>('window.__app.active.streaming.content[0].text')
        const agentId = await byProject(a).page.evaluate<string>('window.__app.active.agentId')
        check(before.length < FULL.length, `merge starts mid-stream (${before.trim().split(' ').length}/${CHUNKS.length} chunks in)`)
        const beta = byProject(b).page
        await beta.evaluate('window.__app.mergeAllWindows()')
        wins.forEach(w => w.page !== beta && w.page.close())
        wins = await windows(1)
        const merged = wins[0].page
        check(wins[0].projects.join(',') === [b, a].join(','), 'merged window holds both projects')
        check(await merged.evaluate<number>('document.querySelectorAll(\'[role="tree"] [aria-level="1"]\').length') === 2, 'merged project tree lists both')
        check(await merged.evaluate<boolean>(`[...window.__app.threads.values()].some(t => t.cwd === ${JSON.stringify(a)} && t.running)`), 'the run is still going in the merged window')
        const thread = `[...window.__app.threads.values()].find(t => t.cwd === ${JSON.stringify(a)})`
        check(await merged.evaluate<string>(`${thread}.agentId`) === agentId, 'same pi process, not restarted')
        // Deltas keep streaming into the moved thread (not just the final reload from the session file).
        await until('stream grows after the move', () => merged.evaluate<boolean>(`(${thread}.streaming?.content?.[0]?.text?.length ?? 0) > ${before.length}`))
        const streamed = await merged.evaluate<string>(`${thread}.streaming?.content?.[0]?.text ?? ''`)
        check(!streamed || FULL.startsWith(streamed), 'streamed deltas keep arriving in the merged window, none lost in the hand-over')
        await until('run finishes', () => merged.evaluate<boolean>(`!${thread}.running && ${thread}.persisted`))
        const answer = await merged.evaluate<string>(`JSON.stringify(${thread}.items.at(-1)?.message?.content)`)
        check(answer.includes(FULL.trim()), 'the whole reply arrived after the move')
        check(await merged.evaluate<boolean>(`window.__app.activeProject === ${JSON.stringify(b)}`), 'merging keeps the target window on its own project')

        // Out again: alpha gets its own window and keeps the conversation.
        await merged.evaluate(`window.__app.detachProject(${JSON.stringify(a)})`)
        merged.close()
        wins = await windows(2)
        const alpha = byProject(a)
        check(alpha.projects.join(',') === a && byProject(b).projects.join(',') === b, 'moved to a new window')
        check(await alpha.page.evaluate<boolean>(`${thread}?.items.length >= 2`), 'the moved thread keeps its transcript')
        check(await alpha.page.evaluate<boolean>(`document.body.innerText.includes('part15')`), 'and shows it')

        // A shared setting changed in one window reaches the other.
        await byProject(b).page.evaluate('window.__app.toggleLayout()')
        await until('layout reaches alpha', () => alpha.page.evaluate<boolean>(`window.__app.layout === 'single'`), 5000)
        check(true, 'settings sync across windows')
        // Saves are async; give the last one a moment.
        await new Promise(r => setTimeout(r, 500))
        wins.forEach(w => w.page.close())
    }
    finally {
        await stop()
    }

    const state = JSON.parse(await readFile(path.join(userData, 'state.json'), 'utf8'))
    check(JSON.stringify(state.windows?.map((w: any) => w.projects)) === JSON.stringify([[b], [a]]), 'window list saved')
    const realA = await realpath(a)
    check(!!(state.tabs[a] ?? state.tabs[realA])?.length, 'alpha\'s tab saved')

    stop = await launch(env)
    try {
        const wins = await windows(2)
        check(wins.map(w => w.projects.join(',')).sort().join(' | ') === [a, b].sort().join(' | '), 'windows reopen on launch')
        const alpha = wins.find(w => w.projects.includes(a))!
        await until('alpha tab restored', () => alpha.page.evaluate<boolean>(`document.body.innerText.includes('part15')`))
        check(true, 'reopened window restores its tabs')
        wins.forEach(w => w.page.close())
    }
    finally {
        await stop()
        model.close()
    }
    console.log('all window checks passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
