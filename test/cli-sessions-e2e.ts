// Terminal chats the agents keep in their own files, in the built app: a Cursor CLI chat opens
// read-only and continues in the terminal panel; a Gemini CLI session (made by the real gemini in a
// temp HOME, against a fake model server) lists, opens without Gemini's preamble, and continues here.
//
// Needs Gemini CLI installed by the app (Settings → Agents) or GEMINI_JS pointing at its gemini.js.

import type { AddressInfo } from 'node:net'
import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-cli-sessions')
const SHOTS = process.env.SHOTS ?? ''
const GEMINI_JS = process.env.GEMINI_JS ?? path.join(os.homedir(), 'Library/Application Support/pi-gui/agents/gemini/node_modules/@google/gemini-cli/bundle/gemini.js')

const jsonl = (...lines: unknown[]) => `${lines.map(l => JSON.stringify(l)).join('\n')}\n`

/** A value of a JSON schema (Gemini's OBJECT / STRING / INTEGER …); a `next_speaker` hands back to the user. */
function fill(schema: any): unknown {
    switch (String(schema?.type ?? '').toUpperCase()) {
        case 'OBJECT':
            return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, key === 'next_speaker' ? 'user' : fill(value)]))
        case 'ARRAY':
            return []
        case 'INTEGER':
        case 'NUMBER':
            return 1
        case 'BOOLEAN':
            return false
        default:
            return schema?.enum?.[0] ?? 'ok'
    }
}

async function main() {
    const node = await realpath(execFileSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim())
    await rm(WORK, { recursive: true, force: true })
    const home = path.join(WORK, 'home')
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([home, repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')

    // ---- a fake Gemini API: every answer says which call it was
    let calls = 0
    const asked: string[] = []
    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
            body += c
        })
        req.on('end', () => {
            asked.push(`${req.url} ${body}`)
            // Gemini's own side calls (model routing, next speaker) want JSON of a schema: fill it in.
            const schema = JSON.parse(body || '{}').generationConfig?.responseJsonSchema
            const text = schema ? JSON.stringify(fill(schema)) : `gemini-answer-${++calls}`
            const chunk = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }
            if (req.url?.includes(':countTokens')) {
                res.writeHead(200, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ totalTokens: 10 }))
            }
            if (req.url?.includes(':streamGenerateContent')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                return res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`)
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(chunk))
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const geminiEnv = {
        HOME: home,
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        GEMINI_API_KEY: 'fake-key',
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
    }

    // ---- a Gemini session started in a terminal, by the real CLI
    await mkdir(path.join(home, '.gemini'), { recursive: true })
    await writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }))
    // Not execFileSync: the fake server answering it runs in this process.
    await promisify(execFile)(node, [GEMINI_JS, '-p', 'terminal question'], { cwd: repo, env: { ...process.env, ...geminiEnv }, timeout: 120_000 })
    const chats = path.join(home, '.gemini', 'tmp', path.basename(repo), 'chats')
    const [file] = await readdir(chats)
    const geminiId = JSON.parse((await readFile(path.join(chats, file), 'utf8')).split('\n')[0]).sessionId as string
    check(!!geminiId, 'gemini wrote its session')

    // ---- a Cursor CLI chat, as cursor-agent writes one; the fake agent only notes how it was run
    const cursorId = '7e048bd9-a608-4010-9fcc-d9df4612368c'
    const chat = path.join(home, '.cursor', 'chats', 'd5271b8a09404bb4a90fce4b1ef126e0', cursorId)
    await mkdir(chat, { recursive: true })
    await writeFile(path.join(chat, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.now() - 60_000, hasConversation: true, updatedAtMs: Date.now() - 30_000, cwd: repo }))
    const transcript = path.join(home, '.cursor', 'projects', repo.slice(1).replace(/\//g, '-'), 'agent-transcripts', cursorId)
    await mkdir(transcript, { recursive: true })
    await writeFile(path.join(transcript, `${cursorId}.jsonl`), jsonl(
        { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Friday, Oct 9, 2026, 11:39 PM (UTC+8)</timestamp>\n<user_query>\nread the readme\n</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: `${repo}/README.md` } }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'cursor-says-hello' }] } },
        { type: 'turn_ended', status: 'success' },
    ))
    const ran = path.join(WORK, 'cursor-ran.txt')
    const cursor = path.join(WORK, 'bin', 'cursor-agent')
    await mkdir(path.dirname(cursor), { recursive: true })
    await writeFile(cursor, `#!/bin/sh\necho "$@" >> ${JSON.stringify(ran)}\n[ "$1" = acp ] && exit 1\nexit 0\n`)
    await chmod(cursor, 0o755)

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
    const env: Record<string, string> = {
        ...geminiEnv,
        PI_GUI_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_GUI_TEST: '1',
        PI_GUI_ACP_CURSOR: JSON.stringify([cursor, 'acp']),
        PI_GUI_ACP_GEMINI: JSON.stringify([node, GEMINI_JS, '--acp']),
    }
    for (const key of Object.keys(process.env)) {
        if ((key.endsWith('_API_KEY') && key !== 'GEMINI_API_KEY') || key.endsWith('_TOKEN') || key.startsWith('AWS_'))
            env[key] = ''
    }

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = <T = any>(code: string) => page.evaluate<T>(code)
        const T = 'window.__app.active'
        const open = (key: string) => js(`(() => { window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(key)})); return true })()`)
        const shown = () => js<string>(`JSON.stringify([...${T}.items, ...${T}.live])`)

        // ---- both are listed under the project
        const cursorKey = `acp:cursor:${cursorId}`
        const geminiKey = `acp:gemini:${geminiId}`
        // The first list waits only a few seconds for the agents' own; a hidden window re-lists on focus.
        await until('the terminal chats are listed', () => js<boolean>(`(() => { void window.__app.refreshSessions(); return [${JSON.stringify(cursorKey)}, ${JSON.stringify(geminiKey)}].every(k => window.__app.sessions.some(s => s.path === k)) })()`), 30_000)
        const names = await js<string[]>(`window.__app.sessions.filter(s => s.agent === 'cursor' || s.agent === 'gemini').map(s => s.name)`)
        check(names.includes('read the readme') && names.includes('terminal question'), `listed by their first prompt (${names})`)

        // ---- Cursor: read-only, continued in the terminal panel
        await open(cursorKey)
        await until('the cursor chat loads', () => js<boolean>(`${T}?.loaded && ${T}.items.length > 0`))
        const cursorShown = await shown()
        check(cursorShown.includes('read the readme') && cursorShown.includes('cursor-says-hello') && !cursorShown.includes('user_query'), 'the cursor chat shows what was said')
        check(await js<boolean>(`!!${T}.terminalOnly && !document.querySelector('textarea[aria-label^="Message"]')`), 'no composer, the terminal note instead')
        check((await js<string>(`document.querySelector('[role="status"]')?.innerText ?? ''`)).includes('continues it only there'), 'the note says why')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'cli-cursor-readonly.png'))
        await js(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue in a terminal').click(); return true })()`)
        await until('the terminal ran cursor-agent --resume', async () => (await readFile(ran, 'utf8').catch(() => '')).includes(`--resume ${cursorId}`), 15_000)
        check(await js<boolean>(`window.__terminals.list.some(t => t.command?.includes('--resume ${cursorId}'))`), 'a terminal tab for it')
        check(!(await readFile(ran, 'utf8')).split('\n').some(l => l.startsWith('acp') && l.includes(cursorId)), 'the agent was never asked to load it')

        // ---- Gemini: opens through session/load, without its preamble, and continues here
        await open(geminiKey)
        await until('the gemini session loads', () => js<boolean>(`${T}?.loaded && ${T}.items.length > 0`), 60_000).catch(async (error) => {
            console.error(await js(`JSON.stringify({ path: ${T}?.sessionPath, loaded: ${T}?.loaded, items: ${T}?.items.length, live: ${T}?.live.length, status: ${T}?.agentStatus, error: ${T}?.agentError, toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(t => t.innerText) })`))
            console.error(await js(`window.pi.readSession(${JSON.stringify(geminiKey)}).then(s => 'items ' + s.items.length, e => 'error ' + e.message)`))
            throw error
        })
        const geminiShown = await shown()
        check(geminiShown.includes('terminal question') && geminiShown.includes('gemini-answer'), 'the terminal turn shows')
        check(!geminiShown.includes('session_context'), 'without Gemini\'s preamble')
        check(await js<boolean>(`!${T}.terminalOnly`), 'gemini is not read-only')
        await until('gemini is ready', () => js<boolean>(`${T}.agentStatus === 'ready'`), 60_000)
        await js(`(() => { const t = ${T}; t.draft = 'follow-up from filo'; void t.send(); return true })()`)
        const userTurns = () => js<string[]>(`[...${T}.items, ...${T}.live, ...(${T}.pendingPrompt ? [{ message: { role: 'user', content: [{ text: ${T}.pendingPrompt.text }] } }] : [])].filter(i => i.message.role === 'user').map(i => i.message.content[0].text)`)
        await until('the follow-up runs', () => js<boolean>(`${T}.running`))
        check(JSON.stringify(await userTurns()) === JSON.stringify(['terminal question', 'follow-up from filo']), `while it runs, each turn once (${await userTurns()})`)
        await until('the follow-up is answered', async () => !(await js<boolean>(`${T}.running`)) && (await shown()).includes('follow-up from filo') && (await shown()).match(/gemini-answer-\d+/g)!.length >= 2, 60_000).catch(async (error) => {
            console.error(await js(`JSON.stringify({ status: ${T}.agentStatus, error: ${T}.agentError, running: ${T}.running })`), (await shown()).slice(-1500))
            throw error
        })
        check(asked.some(a => a.includes('follow-up from filo') && a.includes('terminal question')), 'the follow-up went with the terminal turn as history')
        check(JSON.stringify(await userTurns()) === JSON.stringify(['terminal question', 'follow-up from filo']), `afterwards, each turn once (${await userTurns()})`)
        const saved = await readFile(path.join(chats, file), 'utf8')
        check(saved.includes('follow-up from filo'), 'gemini wrote the follow-up into the same session file')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'cli-gemini.png'))
        console.log('cli-sessions e2e: ok')
    }
    finally {
        await stop()
        server.close()
        if (!process.env.KEEP)
            await rm(WORK, { recursive: true, force: true })
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
