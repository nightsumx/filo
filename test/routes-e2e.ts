// Settings → 路由 and routing groups as models in the built app, with real pi, the real Codex CLI and
// fake providers in an empty agent dir (no account, no tokens; HOME's agent configs untouched):
//   - the page lists the providers' models; a group is built through it (new group, add models)
//   - a pi thread picks the group in its model picker, and its prompt is answered by the second
//     provider after the first one is overloaded; the page then shows the first one resting
//   - a Codex thread picks a group in its model picker (a restart onto the gateway); pinning a member
//     sends its next request to that one only, back to automatic after
//   - pausing a member in the page keeps requests off it
//   - the Codex thread switches to another group mid-conversation: its process restarts, resumes the
//     session (the history goes along), and the new group answers; reopened, the session is still on it
//   - picking one of Codex's own models takes the thread off the group
//   - terminal sync points Codex's (its group picked on the page) and pi's own files at the gateway
//     (Claude Code's not: no group picked), and back
//   - the provider models of Codex's API are channels in its picker; a channel added there from an
//     address and a key becomes a provider and goes into Codex's own config.toml (as cc-switch
//     writes it), so Codex itself answers through it with that key; going back puts the file back
//
//   bun run build && bun run e2e:routes
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-routes')
const SHOTS = process.env.SHOTS ?? ''

/** What the fake providers were asked: provider, path, model, the request body and its key. */
const seen: { provider: string, path: string, model: string, body: string, auth?: string }[] = []

function chat(res: http.ServerResponse, model: string, text: string) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    chunk({ role: 'assistant', content: '' })
    chunk({ content: text })
    chunk({}, 'stop')
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`)
    res.end('data: [DONE]\n\n')
}

function responses(res: http.ServerResponse, n: number, text: string) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const item = { type: 'message', role: 'assistant', id: `m${n}`, content: [{ type: 'output_text', text }] }
    ev('response.created', { response: { id: `r${n}` } })
    ev('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
    ev('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: text })
    ev('response.output_item.done', { output_index: 0, item })
    ev('response.completed', { response: { id: `r${n}`, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } })
    res.end()
}

async function main() {
    const codex = execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim()
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const codexHome = path.join(WORK, 'codex-home')
    const claudeHome = path.join(WORK, 'claude-home')
    const grokHome = path.join(WORK, 'grok-home')
    await Promise.all([repo, userData, agentDir, codexHome, claudeHome, grokHome].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

    // `bad` is overloaded; `good` answers, naming itself, so a reply says who served it.
    const upstream = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
            body += c
        })
        req.on('end', () => {
            const [, provider, ...rest] = (req.url ?? '').split('/')
            const route = `/${rest.join('/')}`
            const json = JSON.parse(body || '{}')
            seen.push({ provider, path: route, model: json.model, body, auth: req.headers.authorization })
            if (req.method === 'GET' && route === '/v1/models')
                return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'chan-m' }] }))
            if (provider === 'bad') {
                res.writeHead(529, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }))
            }
            if (route.startsWith('/v1/responses'))
                return responses(res, seen.length, `answered by ${provider}`)
            if (route.startsWith('/v1/chat/completions'))
                return chat(res, json.model, `answered by ${provider}`)
            res.writeHead(404).end()
        })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const provider = (id: string) => ({
        baseUrl: `${base}/${id}/v1`,
        api: 'openai-completions',
        apiKey: `real-key-${id}`,
        models: [
            { id: 'chat-m', name: `Chat ${id}`, contextWindow: 64000, maxTokens: 4000 },
            { id: 'resp-m', name: `Resp ${id}`, api: 'openai-responses', contextWindow: 64000, maxTokens: 4000 },
        ],
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { bad: provider('bad'), good: provider('good'), alt: provider('alt') } }, null, 2))
    await writeFile(path.join(codexHome, 'config.toml'), [
        `[projects.${JSON.stringify(repo)}]`,
        'trust_level = "trusted"',
        // Codex retries a failed request itself; one go is enough to see where it went.
        '[model_providers.filo]',
        // Named: an unrouted Codex validates the table too.
        'name = "Filo"',
        'request_max_retries = 0',
        'stream_max_retries = 0',
        '',
    ].join('\n'))
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
        PI_GUI_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_GUI_TEST: '1',
        PI_GUI_ACP_CODEX: JSON.stringify([codex, 'app-server']),
        CODEX_HOME: codexHome,
        // Terminal sync writes here, not to the user's ~/.claude.
        CLAUDE_CONFIG_DIR: claudeHome,
        // Groups Grok can use go in its config.toml: this one, not the user's ~/.grok.
        GROK_HOME: grokHome,
    }
    for (const key of Object.keys(process.env)) {
        if (key.endsWith('_API_KEY') || key.endsWith('_TOKEN') || key.startsWith('AWS_'))
            env[key] = ''
    }

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = <T = any>(code: string) => page.evaluate<T>(code)
        const T = 'window.__app.active'
        const R = JSON.stringify(repo)
        const dialog = `document.querySelector('[role="dialog"]')`
        const text = () => js<string>(`${dialog}?.innerText ?? ''`)
        const button = (label: string, scope = dialog) => `[...${scope}.querySelectorAll('button, [role="menuitem"]')].find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})`
        // Radix menus open on pointerdown; their items take a click.
        const openMenu = (label: string, scope = dialog) => js<boolean>(`(() => { const b = ${button(label, scope)}; if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); return true })()`)
        const menuItem = (label: string) => js<boolean>(`(() => { const i = [...document.querySelectorAll('[role="menuitem"]')].find(i => i.textContent.trim().startsWith(${JSON.stringify(label)})); if (!i) return false; i.click(); return true })()`)
        const reply = (needle: string) => js<boolean>(`!${T}.running && JSON.stringify([...${T}.items, ...${T}.live]).includes(${JSON.stringify(needle)})`)
        const send = (prompt: string) => js(`(() => { const t = ${T}; t.draft = ${JSON.stringify(prompt)}; void t.send(); return true })()`)
        const config = () => js<any>(`JSON.parse(JSON.stringify(window.__app.routes.config))`)

        // ---- build a group in the page
        await js(`(() => { window.__app.openSettings('routes'); return true })()`)
        await until('routing page', () => js<boolean>(`!!document.querySelector('[role="dialog"] section[aria-label="Routing"]')`))
        check((await text()).includes('No groups yet'), 'the page starts with no groups')
        check(await openMenu('New group'), 'new group menu')
        if (SHOTS) {
            await until('API menu', () => js<boolean>(`!!document.querySelector('[role="menuitem"]')`))
            await new Promise(r => setTimeout(r, 200))
            await page.screenshot(path.join(SHOTS, 'routes-new-group.png'))
            // Every item fits in its row: no text runs past its item's box.
            const overflow = await js<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].filter(i => i.scrollHeight > i.clientHeight + 1 || [...i.children].some(c => c.scrollWidth > c.clientWidth + 1)).map(i => i.textContent)`)
            check(!overflow.length, `the API menu's items fit (${overflow.join(' | ')})`)
        }
        await until('API choices', () => menuItem('OpenAI Chat'))
        await until('group card', async () => (await config()).groups.length === 1)
        const groupId = (await config()).groups[0].id as string
        const catalog = await js<any>(`window.pi.routeCatalog(false)`)
        check(catalog.models.length === 6, `the page reads the providers' models (${JSON.stringify(catalog)})`)
        const card = `document.querySelector('[role="dialog"] section[aria-label="Group 1"]')`
        for (const name of ['Chat bad', 'Chat good']) {
            await until(`add-model menu for ${name}`, () => openMenu('Add model', card))
            await until(`${name} in the menu`, () => menuItem(name))
            await until(`${name} added`, async () => (await config()).groups[0].members.some((m: any) => `Chat ${m.provider}` === name))
        }
        const members = (await config()).groups[0].members.map((m: any) => `${m.provider}/${m.model}`)
        check(members.join(',') === 'bad/chat-m,good/chat-m', `models are added in order (${members})`)
        check(!(await text()).includes('Resp bad'), 'the add menu only offers models of the group\'s API')
        // Two Responses groups for Codex go in through the store, as the page would.
        await js(`window.__app.saveRoutes({ ...JSON.parse(JSON.stringify(window.__app.routes.config)), groups: [...window.__app.routes.config.groups, { id: 'resp', name: 'Responses', api: 'openai-responses', mode: 'order', members: [{ provider: 'bad', model: 'resp-m' }, { provider: 'good', model: 'resp-m' }] }, { id: 'alt', name: 'Alt', api: 'openai-responses', mode: 'order', members: [{ provider: 'alt', model: 'resp-m' }] }] })`)
        await until('groups saved', async () => (await config()).groups.length === 3)
        const saved = JSON.parse(await readFile(path.join(userData, 'routes.json'), 'utf8'))
        check(saved.config.groups.length === 3 && !JSON.stringify(saved).includes('real-key'), 'routes.json holds the groups and no keys')
        const pageText = await text()
        check(!pageText.includes('Direct') && pageText.includes('shows up in the model list'), 'the page has no per-agent rows: groups are models')
        check(await js<boolean>(`${dialog}.querySelector('section[aria-label="Responses"]').textContent.includes('Codex')`), 'a group card names the agents that can pick it')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'routes-page.png'))
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)

        // ---- pi: the group is a model in its picker, and the overloaded provider is skipped
        const composer = 'document'
        /** Opens the composer's model picker, whatever it shows now. */
        const openModels = () => js<boolean>(`(() => { const b = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(b => b.querySelector('.lucide-cpu, .lucide-route')); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); return true })()`)
        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('pi ready', () => js<boolean>(`${T}?.agent === 'pi' && ${T}.agentStatus === 'ready' && ${T}.models.some(m => m.provider === 'filo')`), 30_000)
        check(await js<boolean>(`${T}.models.some(m => m.provider === 'filo' && m.id === 'resp')`), 'every group is in pi\'s model list')
        await until('model picker', openModels)
        await until('the menu lists groups', () => js<boolean>(`[...document.querySelectorAll('[role="menu"] [role="group"], [role="menu"] div')].some(l => l.textContent === 'Routing groups')`))
        check(!(await js<boolean>(`[...document.querySelectorAll('[role="menuitem"]')].some(i => i.textContent.startsWith('Filo ·'))`)), 'groups are listed once, under Routing groups')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'routes-picker-pi.png'))
        await until('pick Group 1', () => menuItem('Group 1'))
        await until('pi on the group', () => js<boolean>(`${T}.state?.model?.provider === 'filo' && ${T}.state.model.id === ${JSON.stringify(groupId)}`), 30_000)
        check(true, 'picking the group in pi\'s model picker puts the thread on it')
        await send('hi')
        await until('pi reply', () => reply('answered by good'), 30_000).catch(async (error) => {
            console.error(JSON.stringify(seen), await js(`JSON.stringify({ items: ${T}.items, live: ${T}.live, status: window.__app.routes.status, error: ${T}.error, retry: ${T}.retry })`))
            throw error
        })
        const piSeen = seen.map(s => `${s.provider}${s.path}`)
        check(piSeen[0] === 'bad/v1/chat/completions' && piSeen.includes('good/v1/chat/completions'), `pi's request went to bad first, then good (${piSeen.join(', ')})`)
        await js(`(() => { window.__app.openSettings('routes'); return true })()`)
        await until('bad shown resting', async () => (await text()).includes('tried last until'))
        check((await text()).includes('Recent switches'), 'the page lists the switch')
        if (SHOTS) {
            await js(`(() => { document.querySelector('[role="dialog"] section[aria-label="Group 1"]').scrollIntoView(); return true })()`)
            await page.screenshot(path.join(SHOTS, 'routes-status.png'))
            if (process.env.ROUTES_E2E_DEBUG)
                console.log(await js(`JSON.stringify([document.querySelector('[role="dialog"] section[aria-label="Group 1"]'), ...document.querySelector('[role="dialog"] section[aria-label="Group 1"] li').children].map(e => [e.tagName, e.className.baseVal ?? e.className, Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width)]))`))
        }
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)

        // ---- Codex: a group from its model picker; pinning a member
        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('a new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty`))
        await js(`${T}.setAgent('codex')`)
        await until('Codex ready', () => js<boolean>(`${T}.agent === 'codex' && ${T}.agentStatus === 'ready'`), 30_000)
        check(await js<boolean>(`${T}.routeInfo === null`), 'a Codex thread starts on Codex\'s own models (not routed)')
        const codexPid = await js<string>(`${T}.agentId`)
        await until('model picker', openModels)
        check(!(await js<boolean>(`[...document.querySelectorAll('[role="menuitem"]')].some(i => i.textContent.startsWith('Group 1'))`)), 'Codex\'s picker leaves out the groups of another API')
        const listed = await js<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent)`)
        check(listed.some(l => l.startsWith('Resp good')) && !listed.some(l => l.startsWith('Chat good')), `Codex's picker lists the provider models of its API as channels (${listed.join(' | ')})`)
        await until('pick Responses', () => menuItem('Responses'))
        await until('Codex restarted on the group', () => js<boolean>(`${T}.agentStatus === 'ready' && ${T}.agentId !== ${JSON.stringify(codexPid)} && ${T}.routeInfo?.group?.id === 'resp'`), 30_000).catch(async (error) => {
            console.error(await js(`JSON.stringify({ status: ${T}.agentStatus, id: ${T}.agentId, before: ${JSON.stringify(codexPid)}, route: ${T}.route, info: ${T}.routeInfo, error: ${T}.agentError, restartPending: ${T}.restartPending })`))
            throw error
        })
        seen.length = 0
        await send('hello codex')
        await until('Codex reply', () => reply('answered by good'), 60_000)
        check(seen.some(s => s.provider === 'bad') && seen.at(-1)?.provider === 'good', `Codex failed over (${seen.map(s => s.provider).join(', ')})`)
        await until('route picker', () => js<boolean>(`!!${button('Responses · resp-m', composer)}`))
        check(true, 'the composer shows the thread\'s group and the model that answered')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'routes-composer.png'))
        await openMenu('Responses · resp-m', composer)
        await until('pin bad', () => js<boolean>(`(() => { const i = [...document.querySelectorAll('[role="menuitem"]')].find(i => i.textContent.startsWith('Only resp-m') && i.textContent.includes('bad')); if (!i) return false; i.click(); return true })()`))
        await until('pinned', () => js<boolean>(`${T}.routeInfo?.override?.pin === 'bad/resp-m'`))
        seen.length = 0
        await send('only bad')
        await until('pinned request sent', async () => seen.length > 0)
        await until('pinned run over', () => js<boolean>(`!${T}.running`), 60_000)
        check(seen.length > 0 && seen.every(s => s.provider === 'bad'), `a pinned member gets the request alone (${seen.map(s => s.provider).join(', ')})`)
        await js(`${T}.setRoute({})`)
        seen.length = 0
        await send('any')
        await until('unpinned reply', async () => (await js<number>(`JSON.stringify([...${T}.items, ...${T}.live]).split('answered by good').length`)) > 2, 60_000)
        check(seen.at(-1)?.provider === 'good', 'back on automatic, the healthy member answers')

        // ---- pausing a member in the page
        await js(`(() => { window.__app.openSettings('routes'); return true })()`)
        await until('resp card', () => js<boolean>(`!!document.querySelector('[role="dialog"] section[aria-label="Responses"]')`))
        await js(`(() => { const row = [...document.querySelectorAll('[role="dialog"] section[aria-label="Responses"] li')].find(l => l.textContent.includes('Resp bad')); row.querySelector('[role="switch"]').click(); return true })()`)
        await until('bad paused', async () => (await config()).groups.find((g: any) => g.id === 'resp').members[0].off === true)
        check((await text()).includes('Paused'), 'a paused member says so')
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)
        seen.length = 0
        await js(`${T}.setRoute({})`)
        await send('still there')
        await until('reply without bad', async () => (await js<number>(`JSON.stringify([...${T}.items, ...${T}.live]).split('answered by good').length`)) > 3, 60_000)
        check(seen.length > 0 && seen.every(s => s.provider === 'good'), `a paused member gets nothing (${seen.map(s => s.provider).join(', ')})`)

        // ---- Codex switches group mid-conversation: a restart that resumes the session
        const sessionKey = await js<string>(`${T}.key`)
        const beforeSwitch = await js<string>(`${T}.agentId`)
        await until('model picker', openModels)
        await until('pick Alt', () => menuItem('Alt'))
        await until('Codex on Alt', () => js<boolean>(`${T}.agentStatus === 'ready' && ${T}.agentId !== ${JSON.stringify(beforeSwitch)} && ${T}.routeInfo?.group?.id === 'alt'`), 30_000)
        check(await js<string>(`${T}.key`) === sessionKey, 'the thread keeps its session')
        seen.length = 0
        await send('after the switch')
        await until('reply from alt', () => reply('answered by alt'), 60_000)
        check(seen.length > 0 && seen.every(s => s.provider === 'alt'), `the new group answers (${seen.map(s => s.provider).join(', ')})`)
        check(seen.at(-1)!.body.includes('hello codex') && seen.at(-1)!.body.includes('still there'), 'the resumed session sends the earlier conversation along')
        check(await js<string>(`window.pi.sessionRoute(${JSON.stringify(sessionKey)})`) === 'alt', 'the session\'s group is remembered')

        // Reopened, it starts on the group it was on.
        await js(`window.__app.closeTab(${JSON.stringify(sessionKey)})`)
        await until('the session is listed', () => js<boolean>(`window.__app.sessions.some(s => s.path === ${JSON.stringify(sessionKey)})`), 30_000)
        await js(`(() => { window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(sessionKey)})); return true })()`)
        await until('reopened on Alt', () => js<boolean>(`${T}?.key === ${JSON.stringify(sessionKey)} && ${T}.route.group === 'alt'`), 30_000)
        seen.length = 0
        await send('reopened')
        await until('reopened reply', async () => (await js<number>(`JSON.stringify([...${T}.items, ...${T}.live]).split('answered by alt').length`)) > 2, 60_000)
        check(seen.length > 0 && seen.every(s => s.provider === 'alt'), `a reopened session stays on its group (${seen.map(s => s.provider).join(', ')})`)

        // One of Codex's own models takes the thread off the group.
        const native = await js<{ provider: string, id: string } | null>(`(() => { const m = ${T}.models.find(m => !m.id.startsWith('filo')); return m ? { provider: m.provider, id: m.id } : null })()`)
        if (native) {
            const routedPid = await js<string>(`${T}.agentId`)
            await js(`(() => { void ${T}.setModel(${T}.models.find(m => m.id === ${JSON.stringify(native.id)})); return true })()`)
            await until('Codex off the group', () => js<boolean>(`${T}.agentStatus === 'ready' && ${T}.agentId !== ${JSON.stringify(routedPid)} && ${T}.routeInfo === null && !${T}.route.group`), 30_000)
            check(await js<string | undefined>(`window.pi.sessionRoute(${JSON.stringify(sessionKey)})`) === undefined, 'a native model takes the thread and its session off the group')
        }
        else {
            console.log('  (skipped: Codex lists no models of its own without an account)')
        }

        // A new Codex thread starts on what its config names, not on the group picked in another thread.
        await js(`(() => { window.__app.newThread(${R}); return true })()`)
        await until('a new thread', () => js<boolean>(`!!${T} && ${T}.isEmpty`))
        await js(`${T}.setAgent('codex')`)
        await until('new Codex thread ready', () => js<boolean>(`${T}.agent === 'codex' && ${T}.agentStatus === 'ready'`), 30_000)
        check(await js<boolean>(`${T}.routeInfo === null && !${T}.route.group`), 'a new Codex thread starts off the group')

        // ---- terminal sync
        const files = () => Promise.all([
            readFile(path.join(codexHome, 'config.toml'), 'utf8'),
            readFile(path.join(agentDir, 'models.json'), 'utf8'),
            readFile(path.join(claudeHome, 'settings.json'), 'utf8').catch(() => undefined),
        ])
        const before = await files()
        await js(`(() => { window.__app.openSettings('routes'); return true })()`)
        const toggle = `(() => { const s = [...document.querySelectorAll('[role="dialog"] [role="switch"]')].find(s => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent === 'Terminals too'); s.click(); return true })()`
        await until('terminal toggle', () => js<boolean>(toggle))
        await until('terminal sync on', async () => (await config()).syncTerminal === true)
        // Codex in a terminal: its group picked on the page.
        const codexRow = `[...document.querySelectorAll('[role="dialog"] [aria-labelledby]')].find(b => document.getElementById(b.getAttribute('aria-labelledby'))?.textContent === 'Codex in a terminal')`
        await until('terminal Codex picker', () => js<boolean>(`(() => { const b = ${codexRow}; if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); return true })()`))
        await until('pick Responses for the terminal', () => menuItem('Responses'))
        await until('terminal group saved', async () => (await config()).terminal.codex === 'resp')
        const [codexToml, models, claudeSettings] = await until('files written', async () => {
            const f = await files()
            return f[0].includes('model_provider = "filo"') && JSON.parse(f[1]).providers.filo ? f : undefined
        })
        const port = await js<number>(`window.__app.routes.status.port`)
        check(codexToml.includes(`base_url = "http://127.0.0.1:${port}/v1"`), 'Codex\'s config.toml names the gateway')
        check(claudeSettings === undefined, 'Claude Code, with no group, keeps its own settings')
        check(JSON.parse(models).providers.filo.models.length === 3, 'pi\'s models.json lists the groups')
        check((await readFile(path.join(grokHome, 'config.toml'), 'utf8')).includes('[model."filo-'), 'Grok\'s groups go in GROK_HOME\'s config.toml')
        check(!(await js<boolean>(`window.pi.providers().then(l => l.providers.some(p => p.id === 'filo'))`).catch(() => false)), 'the providers page does not list routing\'s own entry')
        await until('terminal toggle', () => js<boolean>(toggle))
        await until('files put back', async () => JSON.stringify(await files()) === JSON.stringify(before))
        check(true, 'turning it off puts the files back as they were')
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)

        // ---- a channel from Codex's model picker: an address and a key
        await until('model picker', openModels)
        await until('add a channel', () => menuItem('Add a channel'))
        await until('channel dialog', async () => (await text()).includes('Add a Codex channel'))
        const fill = (label: string, value: string) => js(`(() => { const i = ${dialog}.querySelector('input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
        await fill('Address', `${base}/chan/v1`)
        await fill('API key', 'chan-key')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'routes-channel.png'))
        const beforeChannel = await js<string>(`${T}.agentId`)
        const codexBefore = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
        seen.length = 0
        await js(`(() => { ${button('Save and use')}.click(); return true })()`)
        await until('Codex on the channel', () => js<boolean>(`${T}.agentStatus === 'ready' && ${T}.agentId !== ${JSON.stringify(beforeChannel)} && ${T}.channel?.current?.provider === '127.0.0.1'`), 30_000).catch(async (error) => {
            console.error(await text(), await js(`JSON.stringify({ route: ${T}.route, channel: ${T}.channel, error: ${T}.agentError })`))
            throw error
        })
        const codexChannel = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
        const topLevel = codexChannel.slice(0, codexChannel.indexOf('\n[')).split('\n')
        check(topLevel.includes('model = "chan-m"') && topLevel.includes('model_provider = "pi-127.0.0.1"') && codexChannel.includes(`[model_providers."pi-127.0.0.1"]\nname = "127.0.0.1"\nbase_url = "${base}/chan/v1"\nwire_api = "responses"\nexperimental_bearer_token = "chan-key"\n`), `Codex's own config.toml names the channel (${codexChannel})`)
        check(await js<boolean>(`${T}.routeInfo === null`), 'Codex reaches the channel itself, not through the gateway')
        check(seen[0]?.path === '/v1/models' && seen[0].auth === 'Bearer chan-key', 'the channel\'s models come from the endpoint, with its key')
        const added = JSON.parse(await readFile(path.join(agentDir, 'models.json'), 'utf8')).providers['127.0.0.1']
        check(added?.api === 'openai-responses' && added.baseUrl === `${base}/chan/v1` && added.models[0].id === 'chan-m', `the channel is a pi provider with Codex's API (${JSON.stringify(added)})`)
        seen.length = 0
        await send('via the channel')
        await until('channel reply', () => reply('answered by chan'), 60_000)
        check(seen.length > 0 && seen.every(s => s.provider === 'chan' && s.auth === 'Bearer chan-key' && s.model === 'chan-m'), `the channel answers with its own key and model (${seen.map(s => `${s.provider} ${s.auth} ${s.model}`).join(', ')})`)
        await until('picker names the channel', () => js<boolean>(`!!${button('chan-m', composer)}`))
        const onChannel = await js<string>(`${T}.agentId`)
        await until('model picker', openModels)
        await until('back to Codex\'s own', () => menuItem('Back to Codex'))
        await until('Codex off the channel', () => js<boolean>(`${T}.agentStatus === 'ready' && ${T}.agentId !== ${JSON.stringify(onChannel)} && !${T}.channel?.current`), 30_000).catch(async (error) => {
            console.error(await text(), await js(`JSON.stringify({ id: ${T}.agentId, before: ${JSON.stringify(onChannel)}, status: ${T}.agentStatus, channel: ${T}.channel, error: ${T}.agentError })`), await readFile(path.join(codexHome, 'config.toml'), 'utf8'))
            throw error
        })
        const codexAfter = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
        check(codexAfter.startsWith(codexBefore) && !codexAfter.includes('model_provider = ') && codexAfter.includes('[model_providers."pi-127.0.0.1"]'), `going back puts Codex's own lines back and keeps the channel's table for sessions that ran on it (${codexAfter})`)

        // ---- light theme
        if (SHOTS) {
            await js(`(() => { window.__app.setTheme('light'); window.__app.openSettings('routes'); return true })()`)
            await new Promise(r => setTimeout(r, 400))
            await page.screenshot(path.join(SHOTS, 'routes-light.png'))
        }
        console.log('routes e2e passed')
    }
    finally {
        await stop()
        await new Promise<void>(r => upstream.close(() => r()))
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
