// The GUI entries that used to be slash commands only, in the built app with real pi and a scripted model:
//   - the tab's right-click menu: Export as HTML (/export), Session info (/session), Reload extensions and
//     skills (/reload; disabled while the thread runs, and a prompt template added meanwhile shows up)
//   - Settings → Shortcuts (/hotkeys): the list, and the keys it lists work
//   - Settings → Project trust (/trust): toggling writes pi's trust.json, and a parent folder's decision shows
//   - the tab menu's Clone thread (/clone), and Rewind to here on an answer (/tree onto an assistant entry,
//     with the summary of the branch left as an option)
// Screenshots go to SHOTS (default ~/Documents/filo-command-shots) as 30-gui-<entry>.png (31-gui-… for the last two).
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
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }, { id: 'mock-2', contextWindow: 100_000, maxTokens: 1000 }] } },
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
        await writeFile(path.join(agentDir, 'prompts', 'greet.md'), '---\ndescription: greet someone politely\n---\nSay hello to $1 politely\n')
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


        // ---------------------------------------------------------------- Skills and commands picker (typing "/" no longer opens a menu)
        const pickerButton = () => js<boolean>(`(() => { const b = document.querySelector('button[aria-label="Skills and commands"]'); b?.click(); return !!b })()`)
        const options = () => js<string[]>(`[...document.querySelectorAll('#command-picker-list [role="option"]')].map(o => o.querySelector('span')?.textContent ?? '')`)
        const chip = () => js<string | null>(`document.querySelector('[data-command-chip]')?.getAttribute('data-command-chip') ?? null`)
        const focusComposer = () => js(`(() => { document.querySelector('textarea[aria-label^="Message"]').focus(); return true })()`)
        await until('the prompt templates', () => js<boolean>(`${T}.commands.some(c => c.name === 'greet')`))
        check(await pickerButton(), 'the composer has a Skills button')
        await until('the picker', () => js<boolean>(`!!document.querySelector('#command-picker-list')`))
        let listed = await options()
        check(listed.includes('greet') && listed.includes('added-later'), `the picker lists the prompt templates (${listed.join(', ')})`)
        const withControls = ['compact', 'model', 'thinking', 'tree', 'fork', 'clone', 'reload', 'name', 'autopilot', 'review']
        check(withControls.every(n => !listed.includes(n)), 'and none of the commands the app has a control for')
        check(await js<boolean>(`!!document.querySelector('#command-picker-list [role="group"][aria-label="Prompt templates"]')`), 'grouped by what they are')
        await shot('picker')
        await page.call('Input.insertText', { text: 'gre' })
        await until('the search', async () => (await options()).join() === 'greet')
        check(true, 'searching narrows the list')
        await press('Enter', 'Enter', 0, 13)
        await until('the chip', async () => (await chip()) === 'greet')
        check(await js<boolean>(`!document.querySelector('#command-picker-list')`), 'picking closes the picker and puts the command above the draft as a chip')
        await until('focus back in the composer', () => js<boolean>(`document.activeElement?.matches('textarea[aria-label^="Message"]')`))
        check(await js<string>(`${T}.draft`) === '', 'the draft itself stays empty')
        await page.call('Input.insertText', { text: 'Bob' })
        await shot('picker-chip')
        await press('Enter', 'Enter', 0, 13)
        await until('the templated answer', () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.items).includes('echo: Say hello to Bob politely') })()`), 30_000)
        check(await chip() === null, 'sending uses the chip as "/greet Bob" (pi expanded the template) and clears it')
        // Backspace in an empty draft takes the chip back; so does its cross.
        await pickerButton()
        await until('the picker again', () => js<boolean>(`!!document.querySelector('#command-picker-list')`))
        await page.call('Input.insertText', { text: 'added' })
        await press('Enter', 'Enter', 0, 13)
        await until('the chip again', async () => (await chip()) === 'added-later')
        await press('Backspace', 'Backspace', 0, 8)
        await until('the chip to go', async () => (await chip()) === null)
        check(true, 'Backspace with nothing typed takes the chip back')
        // ⌘/ (Ctrl+/ elsewhere) opens it from the keyboard.
        await focusComposer()
        const commandKey = process.platform === 'darwin' ? 4 : 2
        await press('/', 'Slash', commandKey, 191)
        await until('the picker from the keyboard', () => js<boolean>(`!!document.querySelector('#command-picker-list')`))
        check(true, 'the keyboard shortcut opens the picker')
        await press('Escape', 'Escape', 0, 27)
        await until('the picker to close', () => js<boolean>(`!document.querySelector('#command-picker-list')`))
        // Typing "/" is just typing.
        await focusComposer()
        await page.call('Input.insertText', { text: '/gre' })
        await sleep(300)
        check(await js<boolean>(`!document.querySelector('[role="listbox"]') && ${T}.draft === '/gre'`), 'typing "/" opens no menu and changes nothing')
        await js(`(() => { ${T}.draft = ''; return true })()`)

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

        // ---------------------------------------------------------------- Scoped models, Changelog
        {
            const settingsFile = path.join(agentDir, 'settings.json')
            const enabledOf = async () => JSON.parse(await readFile(settingsFile, 'utf8')).enabledModels as string[] | undefined
            await js(`(() => { window.__app.openSettings('pi'); return true })()`)
            const modelChip = (name: string) => `[...document.querySelectorAll('[data-provider="mock"] label')].find(l => l.textContent.trim() === ${JSON.stringify(name)})`
            await until('the Pi page', () => js<boolean>(`!!${modelChip('mock-1')} && !!${modelChip('mock-2')}`))
            const ticked = (name: string) => js<boolean>(`${modelChip(name)}.querySelector('input').checked`)
            check(await ticked('mock-1') && await ticked('mock-2') && await enabledOf() === undefined, 'with no enabledModels every model is ticked')
            await shot('pi-page')
            await js(`(() => { ${modelChip('mock-2')}.click(); return true })()`)
            await until('enabledModels to hold only mock-1', async () => JSON.stringify(await enabledOf()) === JSON.stringify(['mock/mock-1']))
            check(!(await ticked('mock-2')) && await ticked('mock-1'), 'unticking a model writes enabledModels, as pi\'s /scoped-models does')
            await js(`(() => { ${modelChip('mock-1')}.click(); return true })()`)
            await sleep(500)
            check(await ticked('mock-1') && JSON.stringify(await enabledOf()) === JSON.stringify(['mock/mock-1']), 'the last ticked model cannot be unticked: pi would have nothing to cycle')
            // The composer's model menu opens on the scoped models, with the rest one click away.
            await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)
            const openModelMenu = async () => {
                await js(`(() => { [...document.querySelectorAll('button')].find(b => b.querySelector('.lucide-cpu')).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return true })()`)
                await until('the model menu', () => js<boolean>(`!!document.querySelector('[role="menuitem"]')`))
            }
            const menuItems = () => js<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim())`)
            await openModelMenu()
            await until('the scoped list', async () => (await menuItems()).some(t => t.startsWith('Show all models')))
            let scopedMenu = await menuItems()
            check(scopedMenu.some(t => t.startsWith('mock-1')) && !scopedMenu.some(t => t.startsWith('mock-2')), `the model menu lists only the scoped model (${scopedMenu.join(' | ')})`)
            await shot('scoped-model-menu')
            await js(`(() => { [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim().startsWith('Show all models')).click(); return true })()`)
            await sleep(300)
            scopedMenu = await menuItems()
            check(scopedMenu.some(t => t.startsWith('mock-2')) && scopedMenu.some(t => t.startsWith('Show scoped models only')), 'Show all models adds the rest')
            await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
            await js(`(() => { window.__app.openSettings('pi'); return true })()`)
            await until('the Pi page again', () => js<boolean>(`!!${modelChip('mock-1')}`))
            await js(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'All models').click(); return true })()`)
            await until('enabledModels to go', async () => (await enabledOf()) === undefined)
            check(await ticked('mock-1') && await ticked('mock-2'), 'All models removes enabledModels, like /scoped-models')
            const changelog = await js<{ headings: number, text: number }>(`(() => { const e = document.querySelector('[data-changelog]'); return { headings: e ? e.querySelectorAll('h2').length : 0, text: e ? e.textContent.length : 0 } })()`)
            check(changelog.headings > 0 && changelog.text > 100, `the changelog shows pi's CHANGELOG.md (${changelog.headings} versions)`)
            await shot('pi-changelog')
            await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)

        }

        // ---------------------------------------------------------------- Import session
        {
            const source = path.join(WORK, 'import-me.jsonl')
            const stamp = '2026-01-01T00:00:00.000Z'
            const record = (o: object) => JSON.stringify(o)
            await writeFile(source, `${[
                record({ type: 'session', version: 3, id: 'imported-1', timestamp: stamp, cwd: repo }),
                record({ type: 'message', id: 'i1', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: 'a question from another machine' }], timestamp: 1 } }),
                record({ type: 'message', id: 'i2', parentId: 'i1', timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: 'an answer from another machine' }], stopReason: 'stop', timestamp: 2 } }),
            ].join('\n')}\n`)
            await js(`(() => { window.__app.setSettingsOpen(false); return true })()`)
            // The project's menu has the entry.
            await js(`(() => { const b = document.querySelector('button[aria-label="Project actions"]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return true })()`)
            await until('the project menu', () => js<boolean>(`[...document.querySelectorAll('[role="menuitem"]')].some(e => e.textContent.trim() === 'Import session…')`))
            check(true, 'the project menu has Import session…')
            await shot('import-menu')
            await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
            await js(`(() => { void window.__app.importSession(${JSON.stringify(repo)}, ${JSON.stringify(source)}); return true })()`)
            const copy = path.join(agentDir, 'sessions', `--${repo.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`, 'import-me.jsonl')
            await until('the copy in pi\'s sessions folder', () => Promise.resolve(existsSync(copy)))
            await until('the imported session open', () => js<boolean>(`document.body.innerText.includes('an answer from another machine')`), 15_000)
            check(true, 'importing a session JSONL copies it where pi keeps sessions and opens it with its conversation')
            check(existsSync(source), 'and leaves the original file')
            await shot('import-opened')
        }

        // ---------------------------------------------------------------- Clone thread, Rewind to here
        const shot31 = async (name: string) => {
            await sleep(500)
            await page.screenshot(path.join(SHOTS, `31-gui-${name}.png`))
            console.log(`   shot 31-gui-${name}.png`)
        }
        const thread = (k: string) => `window.__app.threads.get(${JSON.stringify(k)})`
        // role:text of every message on the branch the thread shows.
        const transcript = (k: string) => js<string[]>(`${thread(k)}.items.map(i => i.message.role + ':' + (typeof i.message.content === 'string' ? i.message.content : Array.isArray(i.message.content) ? i.message.content.filter(p => p.type === 'text').map(p => p.text).join('') : (i.message.summary ?? '')))`)
        const idle = (k: string) => until('the thread to be idle', () => js<boolean>(`(() => { const t = ${thread(k)}; return !!t && !t.running && t.persisted && t.key === t.sessionPath })()`), 30_000)
        const tabCount = () => js<number>(`window.__app.tabItemsOf(${JSON.stringify(repo)}).length`)
        const sessionEntries = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as any)
        const entryText = (e: any) => e.type === 'message' ? (typeof e.message.content === 'string' ? e.message.content : e.message.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')) : ''

        await js(`(() => { window.__app.newThread(${JSON.stringify(repo)}); return true })()`)
        for (const word of ['alpha', 'beta', 'gamma']) {
            await send(word)
            await until(`the answer to ${word}`, () => js<boolean>(`(() => { const t = ${T}; return !t.running && JSON.stringify(t.items).includes('echo: ${word}') })()`), 30_000)
        }
        const orig = await js<string>(`${T}.key`)
        await idle(orig)
        const origFile = await js<string>(`${T}.sessionPath`)
        check(origFile.endsWith('.jsonl') && (await transcript(orig)).length === 6, 'a thread with three turns to work on')

        // ---- Clone thread
        await send('slow')
        await until('the thread to run', () => js<boolean>(`${T}.running`))
        await openMenu()
        check(await itemDisabled('Clone thread'), 'Clone thread is disabled while the thread runs')
        await closeMenu()
        await js(`${T}.abort()`)
        await until('the run to stop', () => js<boolean>(`!${T}.running`), 30_000)
        await idle(orig)
        const origBefore = await transcript(orig)
        const origEntries = (await sessionEntries(origFile)).length
        const tabs = await tabCount()
        await openMenu()
        check(!(await itemDisabled('Clone thread')), 'and enabled once it stops')
        await choose('Clone thread')
        const clone = await until('the clone to open in a new tab', () => js<string | null>(`(() => { const t = ${T}; return t.key !== ${JSON.stringify(orig)} && t.key.endsWith('.jsonl') && t.persisted && !t.running ? t.key : null })()`))
        check(await tabCount() === tabs + 1, 'cloning opens a new tab')
        const cloneBefore = await transcript(clone)
        check(clone !== orig && JSON.stringify(cloneBefore) === JSON.stringify(origBefore) && cloneBefore.length > 6, `the clone holds the same messages as the thread's branch (${cloneBefore.length} of them, same text)`)
        check(await js<string>(`${thread(clone)}.sessionPath`) === clone && existsSync(clone), 'in a session file of its own')
        check(JSON.stringify(await transcript(orig)) === JSON.stringify(origBefore) && (await sessionEntries(origFile)).length === origEntries, 'the original thread and its file are untouched')
        await shot31('clone')
        // Each carries on by itself.
        await send('only in the clone')
        await until('the clone to answer', () => js<boolean>(`JSON.stringify(${thread(clone)}.items).includes('echo: only in the clone')`), 30_000)
        await idle(clone)
        check(JSON.stringify(await transcript(orig)) === JSON.stringify(origBefore), 'what the clone says does not reach the original')

        // ---- Rewind to here
        await js(`(() => { window.__app.focus(${JSON.stringify(orig)}, true); return true })()`)
        await until('the original thread in view', () => js<boolean>(`document.body.innerText.includes('echo: gamma')`))
        const rewindButtons = () => js<number>(`document.querySelectorAll('[role="button"][aria-label="Rewind to here"]').length`)
        const turnsShown = await js<number>(`${thread(orig)}.turns.filter(t => t.user).length`)
        check(await rewindButtons() === turnsShown - 1, `every answer but the last has Rewind to here (${turnsShown - 1} of ${turnsShown})`)
        const clickRewind = (n: number) => js<boolean>(`(() => { const b = document.querySelectorAll('[role="button"][aria-label="Rewind to here"]')[${n}]; b?.click(); return !!b })()`)
        const dialogText = () => js<string>(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
        const toggleBox = (set?: boolean) => js<boolean>(`(() => { const box = document.querySelector('[role="dialog"] input[type="checkbox"]'); if (${set === undefined ? 'false' : 'true'} && box.checked !== ${!!set}) box.click(); return box.checked })()`)
        const confirmRewind = () => js<boolean>(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === 'Rewind'); b?.click(); return !!b })()`)

        // Cancelling changes nothing.
        check(await clickRewind(0), 'the first answer has the button')
        await until('the confirm dialog', async () => (await dialogText()).includes('Rewind to this answer'))
        check(await toggleBox() === false, 'the summary switch is off by default')
        await shot31('rewind-confirm')
        await press('Escape', 'Escape', 0, 27)
        await until('the dialog to close', () => js<boolean>(`!document.querySelector('[role="dialog"]')`))
        check(JSON.stringify(await transcript(orig)) === JSON.stringify(origBefore), 'cancelling leaves the thread as it was')

        // Without a summary.
        await clickRewind(0)
        await until('the confirm dialog', async () => (await dialogText()).includes('Rewind to this answer'))
        await confirmRewind()
        await until('the thread to go back', async () => (await transcript(orig)).length === 2)
        const back = await transcript(orig)
        check(back[0] === 'user:alpha' && back[1] === 'assistant:echo: alpha', 'rewinding to the first answer keeps the prompt and that answer')
        await until('the view to drop the rest', () => js<boolean>(`document.body.innerText.includes('echo: alpha') && !document.body.innerText.includes('echo: beta') && !document.body.innerText.includes('echo: gamma')`))
        check(true, 'and the view no longer shows what came after')
        check(await js<boolean>(`!${thread(orig)}.running`), 'nothing runs: it only moved the position')
        await shot31('rewind')
        await send('epsilon')
        await until('the answer after rewinding', () => js<boolean>(`(() => { const t = ${thread(orig)}; return !t.running && JSON.stringify(t.items).includes('echo: epsilon') })()`), 30_000)
        await idle(orig)
        check(JSON.stringify(await transcript(orig)) === JSON.stringify(['user:alpha', 'assistant:echo: alpha', 'user:epsilon', 'assistant:echo: epsilon']), 'a new question is answered and continues from that answer')
        const entries = await sessionEntries(origFile)
        const texts = entries.map(entryText)
        check(['beta', 'echo: beta', 'gamma', 'echo: gamma'].every(t => texts.includes(t)), 'the old branch is still in the session file')
        const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]))
        const epsilon = entries.find(e => entryText(e) === 'epsilon')
        const ancestors: string[] = []
        for (let e = epsilon; e; e = byId.get(e.parentId))
            ancestors.push(entryText(e))
        check(ancestors.includes('echo: alpha') && !ancestors.includes('beta') && !ancestors.includes('echo: gamma'), 'the new prompt hangs off the first answer, so the old turns are another branch (what /tree shows)')
        check(!entries.some(e => e.type === 'branch_summary'), 'no summary was written')
        const ondisk = await js<string[]>(`window.pi.readSession(${JSON.stringify(origFile)}).then(s => s.items.filter(i => i.message.role === 'user').map(i => i.message.content[0]?.text ?? i.message.content))`)
        check(JSON.stringify(ondisk) === JSON.stringify(['alpha', 'epsilon']), 'a restarted pi would resume on the new branch')

        // With a summary of the branch left.
        const answers = await js<number>(`${thread(orig)}.items.filter(i => i.message.role === 'assistant').length`)
        check(await rewindButtons() === 1 && answers === 2, 'the first answer still has the button')
        await clickRewind(0)
        await until('the confirm dialog', async () => (await dialogText()).includes('Rewind to this answer'))
        check(await toggleBox(true) === true, 'the summary switch can be turned on')
        await shot31('rewind-summary-confirm')
        await confirmRewind()
        await until('the summary to be written', async () => (await sessionEntries(origFile)).some(e => e.type === 'branch_summary'), 60_000)
        await until('the thread to show the summary', () => js<boolean>(`${thread(orig)}.items.at(-1)?.message.role === 'branchSummary'`))
        const afterSummary = await transcript(orig)
        check(afterSummary[0] === 'user:alpha' && afterSummary[1] === 'assistant:echo: alpha' && afterSummary.length === 3, 'the thread is back at the first answer, then the summary')
        const summaries = (await sessionEntries(origFile)).filter(e => e.type === 'branch_summary')
        const firstAnswer = entries.find(e => entryText(e) === 'echo: alpha')
        check(summaries.length === 1 && summaries[0].parentId === firstAnswer.id && summaries[0].summary.includes('epsilon'), 'the file has one branch_summary under that answer, about the branch left (the epsilon turn)')
        await shot31('rewind-summary')
        await send('zeta')
        await until('the answer after the summary', () => js<boolean>(`(() => { const t = ${thread(orig)}; return !t.running && JSON.stringify(t.items).includes('echo: zeta') })()`), 30_000)
        check(true, 'and the thread carries on from there')
        await idle(orig)

        // No button while it runs.
        await send('slow')
        await until('the thread to run', () => js<boolean>(`${thread(orig)}.running`))
        check(await rewindButtons() === 0, 'Rewind to here is not offered while the thread runs')
        await js(`${thread(orig)}.abort()`)
        await until('the run to stop', () => js<boolean>(`!${thread(orig)}.running`), 30_000)

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
