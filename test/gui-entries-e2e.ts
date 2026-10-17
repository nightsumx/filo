// The GUI entries that used to be slash commands only, in the built app with real pi and a scripted model:
//   - the tab's right-click menu: Export as HTML (/export), Session info (/session), Reload extensions and
//     skills (/reload; disabled while the thread runs, and a prompt template added meanwhile shows up)
//   - Settings → Shortcuts (/hotkeys): the list, and the keys it lists work
//   - Settings → Project trust (/trust): toggling writes pi's trust.json, and a parent folder's decision shows
// Screenshots go to SHOTS (default ~/Documents/filo-command-shots) as 30-gui-<entry>.png.
//
//   bun run build && bun run e2e:gui-entries
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { check, COMMAND, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-gui-entries')
const SHOTS = process.env.SHOTS || path.join(os.homedir(), 'Documents', 'filo-command-shots')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
    await rm(WORK, { recursive: true, force: true })
    await mkdir(SHOTS, { recursive: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([path.join(repo, '.pi'), userData, agentDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'README.md'), 'hello\n')
    // A project folder with its own pi settings: the kind of project trust is about.
    await writeFile(path.join(repo, '.pi', 'settings.json'), '{}\n')

    // "slow" holds the thread in a long command; anything else gets an echo.
    const llm = await startMockLlm((request) => {
        const last = request.messages.at(-1)
        if (last?.role === 'tool')
            return { text: 'done' }
        const prompt = String(typeof last?.content === 'string' ? last.content : last?.content?.map((p: any) => p.text).join('') ?? '')
        if (prompt === 'slow')
            return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 60' } }] }
        return { text: `echo: ${prompt}`, usage: { input: 1234, output: 56 } }
    })
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    // Never trusting keeps pi from asking before the thread starts; the Trust page changes that per project.
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off', defaultProjectTrust: 'never' }))
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
        const [{ page }] = await windows(1)
        const js = <T = any>(expression: string) => page.evaluate<T>(expression)
        const T = 'window.__app.active'
        const shot = async (name: string) => {
            await sleep(500)
            await page.screenshot(path.join(SHOTS, `30-gui-${name}.png`))
            console.log(`   shot 30-gui-${name}.png`)
        }
        const send = (text: string) => js(`(() => { const t = ${T}; t.draft = ${JSON.stringify(text)}; void t.send(); return true })()`)
        const settled = () => until('the thread to settle', () => js<boolean>(`(() => { const t = ${T}; return !!t && !t.running && t.persisted && t.key === t.sessionPath })()`), 30_000)
        const toastText = () => js<string>(`[...document.querySelectorAll('[data-sonner-toast]')].map(e => e.textContent).join(' | ')`)
        const key = (type: 'keyDown' | 'keyUp', k: string, code: string, modifiers = 0, vk = 0) => page.call('Input.dispatchKeyEvent', { type, key: k, code, modifiers, windowsVirtualKeyCode: vk })
        const press = async (k: string, code: string, modifiers: number, vk: number) => {
            await key('keyDown', k, code, modifiers, vk)
            await key('keyUp', k, code, modifiers, vk)
        }

        // A background run does not open the file manager; main writes what it was asked to show here.
        const revealLog = path.join(userData, 'revealed.log')
        const revealed = async () => existsSync(revealLog) ? (await readFile(revealLog, 'utf8')).split('\n').filter(Boolean) : []

        const openMenu = async () => {
            // The thread's tab in the tab bar (the sidebar's Threads/Files switch has the tab role too).
            const at = await js<{ x: number, y: number }>(`(() => { const r = document.querySelector('[role="tab"][draggable][aria-selected="true"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
            // A dialog that just closed still covers the page while it fades out.
            await until('nothing over the tab', () => js<boolean>(`document.elementFromPoint(${at.x}, ${at.y})?.closest('[role="tab"]') !== null`))
            // A right click, which the browser turns into the contextmenu event the tab listens for.
            await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 })
            await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', buttons: 0, clickCount: 1 })
            await until('the tab menu', () => js<boolean>(`!!document.querySelector('[role="menu"]')`))
        }
        const items = () => js<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(e => e.textContent.trim())`)
        const itemDisabled = (text: string) => js<boolean>(`[...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === ${JSON.stringify(text)})?.hasAttribute('data-disabled') ?? null`)
        const choose = async (text: string) => {
            const found = await js<boolean>(`(() => { const el = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === ${JSON.stringify(text)}); el?.click(); return !!el })()`)
            check(found, `the menu has "${text}"`)
        }
        const closeMenu = async () => {
            await press('Escape', 'Escape', 0, 27)
            await until('the menu to close', () => js<boolean>(`!document.querySelector('[role="menu"]')`))
        }

        // ---------------------------------------------------------------- a thread with some history
        await send('hello')
        await settled()
        const session = await js<string>(`${T}.sessionPath`)
        await until('stats', () => js<boolean>(`${T}.stats?.tokens?.total > 0`))

        await openMenu()
        const menu = await items()
        check(['Export as HTML', 'Session info', 'Reload extensions and skills'].every(i => menu.includes(i)), `the pi tab menu lists the three entries (${menu.join(' | ')})`)
        await shot('menu')

        // ---------------------------------------------------------------- Export as HTML
        await choose('Export as HTML')
        const exported = await until('the export to reach the file manager', async () => (await revealed()).length ? await revealed() : null)
        const file = exported[0]
        check(path.isAbsolute(file) && file.startsWith(repo) && file.endsWith('.html') && existsSync(file), `export wrote ${path.basename(file)} in the project and showed it in the file manager`)
        check((await readFile(file, 'utf8')).toLowerCase().includes('<html'), 'the exported file is an HTML page')
        await until('the export toast', async () => (await toastText()).includes(`Exported ${path.basename(file)}`))
        check(true, 'the toast names the file')
        await shot('export-html')

        // ---------------------------------------------------------------- Session info
        const shown = (await revealed()).length
        await openMenu()
        await choose('Session info')
        const dialog = await until('the session info dialog', () => js<string>(`document.querySelector('[role="dialog"]')?.textContent ?? ''`).then(t => t.includes('Session file') ? t : ''))
        const sessionId = await js<string>(`${T}.stats.sessionId`)
        const row = (id: string) => js<string>(`document.querySelector('[role="dialog"] [data-row="${id}"] dd')?.textContent ?? ''`)
        check((await row('path')).includes(session) && (await row('id')) === sessionId, 'the dialog shows the session file and its id')
        check(['Messages', 'Model', 'Input tokens', 'Output tokens', 'Cache read', 'Cache write', 'Total tokens', 'Context usage'].every(l => dialog.includes(l)), 'and the messages, model, tokens and context rows')
        check(dialog.includes('mock/mock-1') && dialog.includes('1,234'), 'with the model and the token counts the model reported')
        await shot('session-info')
        const clicked = await js<boolean>(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent.startsWith('Show in')); b?.click(); return !!b })()`)
        await until('the session file to be shown', async () => (await revealed()).length > shown)
        check(clicked && (await revealed()).at(-1) === session, 'its button shows the session file in the file manager')
        await press('Escape', 'Escape', 0, 27)
        await until('the dialog to close', () => js<boolean>(`!document.querySelector('[role="dialog"]')`))

        // ---------------------------------------------------------------- Reload extensions and skills
        check(!(await js<boolean>(`${T}.commands.some(c => c.name === 'added-later')`)), 'no "added-later" template yet')
        await mkdir(path.join(agentDir, 'prompts'), { recursive: true })
        await writeFile(path.join(agentDir, 'prompts', 'added-later.md'), '---\ndescription: added after the thread started\n---\nsay hi\n')
        await send('slow')
        await until('the thread to run', () => js<boolean>(`${T}.running`))
        await openMenu()
        check(await itemDisabled('Reload extensions and skills'), 'Reload is disabled while the thread runs')
        await closeMenu()
        await js(`${T}.abort()`)
        await until('the run to stop', () => js<boolean>(`!${T}.running`), 30_000)
        await sleep(500)
        await openMenu()
        check(!(await itemDisabled('Reload extensions and skills')), 'and enabled once it stops')
        await choose('Reload extensions and skills')
        await until('the reload toast', async () => (await toastText()).includes('Reloaded extensions and skills'))
        check(true, 'reload shows a toast')
        await until('the new template', () => js<boolean>(`${T}.commands.some(c => c.name === 'added-later')`))
        check(true, 'and pi now knows the prompt template added meanwhile')
        await shot('reload')
        await send('after reload')
        await until('the reply after reload', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.items).includes('echo: after reload') })()`), 30_000)
        check(true, 'the thread still answers after the reload')

        // ---------------------------------------------------------------- Shortcuts
        await js(`(() => { window.__app.openSettings('shortcuts'); return true })()`)
        await until('the shortcuts page', () => js<boolean>(`!!document.querySelector('[data-shortcut="new-thread"]')`))
        const keysOf = (id: string) => js<string>(`document.querySelector('[data-shortcut="${id}"]')?.textContent ?? ''`)
        const mac = process.platform === 'darwin'
        check(await keysOf('new-thread') === (mac ? '⌘T' : 'Ctrl+T') && await keysOf('files') === (mac ? '⌘⇧E' : 'Ctrl+Shift+E') && await keysOf('dequeue') === (mac ? '⌥↑' : 'Alt+↑'), 'the page lists window and composer shortcuts')
        check(await keysOf('next-tab') === (mac ? '⌃Tab⌘⇧]' : 'Ctrl+TabCtrl+Shift+]') && await keysOf('terminal') !== '' && await keysOf('terminal-clear') !== '', 'tab, panel and terminal shortcuts too')
        const scopes = await js<string[]>(`[...document.querySelectorAll('[data-scope]')].map(e => e.getAttribute('data-scope'))`)
        check(['app', 'composer', 'terminal', 'editor'].every(s => scopes.includes(s)), `grouped by where they work (${scopes.join(', ')})`)
        await shot('shortcuts')
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)
        await until('settings to close', () => js<boolean>(`!document.querySelector('[role="dialog"]')`))

        // The keys it lists are the ones that work.
        const before = await js<number>(`window.__app.tabItemsOf(${JSON.stringify(repo)}).length`)
        await press('t', 'KeyT', COMMAND, 84)
        await until('⌘T to open a thread', () => js<boolean>(`window.__app.tabItemsOf(${JSON.stringify(repo)}).length === ${before + 1}`))
        check(true, '⌘T opens a thread')
        await press('1', 'Digit1', COMMAND, 49)
        await until('⌘1 to go to the first tab', () => js<boolean>(`window.__app.activeTab.key === window.__app.tabItemsOf(${JSON.stringify(repo)})[0].key`))
        check(true, '⌘1 goes to the first tab')
        const sidebar = await js<boolean>('window.__app.sidebarOpen')
        await press('b', 'KeyB', COMMAND, 66)
        await until('⌘B to toggle the sidebar', () => js<boolean>(`window.__app.sidebarOpen === ${!sidebar}`))
        await press('b', 'KeyB', COMMAND, 66)
        check(true, '⌘B toggles the projects panel')
        await press('F', 'KeyF', COMMAND | 8, 70)
        await until('⌘⇧F to open search', () => js<boolean>('window.__app.searchOpen'))
        await press('Escape', 'Escape', 0, 27)
        await until('search to close', () => js<boolean>('!window.__app.searchOpen'))
        check(true, '⌘⇧F opens the search')

        // ---------------------------------------------------------------- Project trust
        const trustFile = path.join(agentDir, 'trust.json')
        const trustOf = async () => existsSync(trustFile) ? JSON.parse(await readFile(trustFile, 'utf8')) as Record<string, boolean | null> : {}
        const openTrust = async () => {
            await js(`(() => { window.__app.openSettings('trust'); return true })()`)
            await until('the trust page', () => js<boolean>(`!!document.querySelector('[data-project=${JSON.stringify(repo)}]')`))
        }
        const rowText = () => js<string>(`document.querySelector('[data-project=${JSON.stringify(repo)}]').closest('.py-3').textContent`)
        const radio = (label: string) => js<boolean>(`(() => { const b = [...document.querySelectorAll('[data-project=${JSON.stringify(repo)}]')].flatMap(p => [...p.closest('.py-3').querySelectorAll('[role="radio"]')]).find(e => e.textContent === ${JSON.stringify(label)}); b?.click(); return !!b })()`)
        const selected = () => js<string>(`[...document.querySelector('[data-project=${JSON.stringify(repo)}]').closest('.py-3').querySelectorAll('[role="radio"]')].find(e => e.getAttribute('aria-checked') === 'true')?.textContent ?? ''`)
        await openTrust()
        check(await selected() === 'Not recorded' && (await rowText()).includes('the default (never trust) does not trust it'), 'a project with no decision follows defaultProjectTrust')
        await shot('project-trust')

        check(await radio('Trust'), 'Trust is on the page')
        await until('trust.json to trust the project', async () => (await trustOf())[repo] === true)
        await until('the saved toast', async () => (await toastText()).includes('New threads use it'))
        check(await selected() === 'Trust', 'Trust writes trust.json and says new threads pick it up')
        await radio('Do not trust')
        await until('trust.json to distrust the project', async () => (await trustOf())[repo] === false)
        check(await selected() === 'Do not trust', 'Do not trust writes false')
        await radio('Not recorded')
        await until('trust.json to forget the project', async () => !(repo in await trustOf()))
        check(await selected() === 'Not recorded', 'Not recorded removes its entry')

        // A parent folder's decision applies to the project, as in pi.
        await writeFile(trustFile, `${JSON.stringify({ [WORK]: true })}\n`)
        await js(`(() => { window.__app.setSettingsPage('appearance'); return true })()`)
        await sleep(300)
        await js(`(() => { window.__app.setSettingsPage('trust'); return true })()`)
        await until('the inherited decision', async () => (await rowText()).includes(`Inherited from ${WORK}: trusted`))
        check(await selected() === 'Not recorded', 'a parent folder\'s decision is shown as inherited, not as the project\'s own')
        await radio('Do not trust')
        await until('the project\'s own decision', async () => (await trustOf())[repo] === false)
        check((await trustOf())[WORK] === true, 'its own decision is written next to the parent\'s, which stays')
        await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)

        console.log(`all GUI entry checks passed; screenshots in ${SHOTS}`)
    }
    catch (error) {
        const [{ page }] = await windows(1).catch(() => [{ page: undefined }])
        if (page) {
            await page.screenshot(path.join(SHOTS, '30-gui-FAILED.png')).catch(() => {})
            console.error(await page.evaluate<string>(`JSON.stringify({ toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(e => e.textContent), dialog: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 400), running: window.__app.active?.running })`).catch(() => ''))
        }
        throw error
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
