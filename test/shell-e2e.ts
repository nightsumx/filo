// The Terminal tool window in the built app, with real shells:
//   - ⌃` opens it with a shell in the project folder; keys typed reach the shell and its output the screen
//   - a reload brings the terminal back with its screen (main's snapshot), not a blank one
//   - a command terminal ends with its command and shows the exit code; it can run again
//   - ⌘W inside the terminal closes the terminal, not the thread tab; ⌃` from inside hides the panel
//   - the project leaving the window ends its terminals and everything running in them
//
//   bun run build && bun run e2e:shell        (SHOTS=<dir> saves screenshots)
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type { Page } from './app'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-shell')
const SHOTS = process.env.SHOTS ?? ''

async function key(page: Page, key: string, code: string, modifiers: number, text?: string) {
    // CDP modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
    const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : key === 'Enter' ? 13 : 0
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) })
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode })
}

/** At the window's own scale: emulating another devicePixelRatio leaves xterm's WebGL canvas drawn at the old one. */
async function shot(page: Page, name: string) {
    if (!SHOTS)
        return
    const { writeFile } = await import('node:fs/promises')
    await new Promise(r => setTimeout(r, 300))
    const { data } = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(SHOTS, name), Buffer.from(data, 'base64'))
}

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const project = path.join(WORK, 'project')
    const userData = path.join(WORK, 'userdata')
    await Promise.all([project, userData].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [project],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [project] }],
    }))

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_GUI_TEST: '1' })
    try {
        let [{ page }] = await windows(1)
        await page.call('Emulation.setFocusEmulationEnabled', { enabled: true })
        await until('project shown', () => page.evaluate<boolean>('window.__app.activeProject !== null'))
        const threadTabs = () => page.evaluate<number>('window.__app.tabs.length')
        const tabsBefore = await threadTabs()

        // ⌃` right after launch: the terminal keeps focus when the window's first thread gets its
        // session a moment later (the thread's key changes then; its composer must not take focus back).
        const firstKey = await page.evaluate<string>('window.__app.activeKey')
        await key(page, '`', 'Backquote', 2)
        await until('first terminal focused', () => page.evaluate<boolean>('!!document.activeElement?.closest(".xterm")'))
        if (firstKey?.startsWith('new:'))
            await until('the first thread has its session', () => page.evaluate<boolean>(`window.__app.activeKey !== ${JSON.stringify(firstKey)}`))
        await new Promise(r => setTimeout(r, 500))
        check(await page.evaluate<boolean>('!!document.activeElement?.closest(".xterm")'), `⌃\` at launch keeps the focus in the terminal once the thread has started (${firstKey?.slice(0, 4)}…)`)
        await page.evaluate('window.__terminals.close(window.__terminals.list[0].id)')
        await until('no terminal yet again', () => page.evaluate<boolean>('window.__terminals.list.length === 0 && !document.querySelector("section[aria-label=Terminal]")'))

        // The status bar button is there with no terminal yet; it opens one and closes the panel again.
        const statusButton = `document.querySelector('footer button[aria-label="Terminal"]')`
        check(await page.evaluate<boolean>(`!!${statusButton} && window.__terminals.list.length === 0`), 'the status bar has a Terminal button before any terminal exists')
        await page.evaluate(`${statusButton}.click()`)
        await until('panel from the status bar', () => page.evaluate<boolean>(`!!document.querySelector("section[aria-label=Terminal] .xterm") && ${statusButton}.getAttribute('aria-pressed') === 'true'`))
        check(await page.evaluate<number>('window.__terminals.list.length') === 1, 'it opens the panel with a first shell')
        await page.evaluate(`${statusButton}.click()`)
        await until('panel closed from the status bar', () => page.evaluate<boolean>('!document.querySelector("section[aria-label=Terminal]")'))
        check(true, 'clicked again, it closes the panel')
        await page.evaluate('window.__terminals.close(window.__terminals.list[0].id)')
        await until('back to none', () => page.evaluate<boolean>('window.__terminals.list.length === 0'))

        // ⌃` opens the tool window with a shell, focused.
        await key(page, '`', 'Backquote', 2)
        const id = await until('a terminal', () => page.evaluate<string | undefined>('window.__terminals.tabs[0]?.id'))
        await until('xterm on screen', () => page.evaluate<boolean>('!!document.querySelector("section[aria-label=Terminal] .xterm")'))
        check(await until('terminal focused', () => page.evaluate<boolean>('!!document.activeElement?.closest(".xterm")')), '⌃` opens the terminal and focuses it')

        // Typing goes through xterm → main → the PTY, and the shell's output comes back to the screen.
        await page.call('Input.insertText', { text: 'echo "in=$PWD" e2e-$((6*7))' })
        await key(page, 'Enter', 'Enter', 0, '\r')
        const screen = (tid: string) => page.evaluate<string>(`(() => { const t = window.__terminalView(${JSON.stringify(tid)})?.term; if (!t) return ''; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s })()`)
        await until('shell output on screen', async () => (await screen(id)).includes('e2e-42'))
        check((await screen(id)).includes(`in=${project}`), 'the shell runs in the project folder and its output reaches the screen')
        await shot(page, 'terminal-dark.png')

        // Moved to a display of another scale: the cells change size, so the grid is fitted again
        // (else a strip stays blank or the last row is cut off).
        const grid = () => page.evaluate<{ cols: number, rows: number, cell: number, fit?: { cols: number, rows: number } }>(`(() => { const v = window.__terminalView(${JSON.stringify(id)}); return { cols: v.term.cols, rows: v.term.rows, fit: v.fitter.proposeDimensions(), cell: v.term._core._renderService.dimensions.css.cell.width } })()`)
        const scale = await page.evaluate<number>('devicePixelRatio')
        for (const dpr of [1, 1.5, scale]) {
            await page.call('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: dpr, mobile: false })
            // xterm measures the cells again on its own time.
            await new Promise(r => setTimeout(r, 800))
            const fitted = await until(`refit at ${dpr}x`, async () => {
                const g = await grid()
                return g.fit && g.cols === g.fit.cols && g.rows === g.fit.rows ? g : undefined
            }, 3000).catch(async () => grid())
            check(!!fitted.fit && fitted.cols === fitted.fit.cols && fitted.rows === fitted.fit.rows, `at ${dpr}x the grid fits the panel again (${fitted.cols}x${fitted.rows}, fits ${fitted.fit?.cols}x${fitted.fit?.rows}, cell ${fitted.cell}px)`)
        }
        await page.call('Emulation.clearDeviceMetricsOverride')

        // A reload: the view comes back with the screen as it was.
        await page.call('Page.reload')
        page.close()
        ;[{ page }] = await windows(1)
        await page.call('Emulation.setFocusEmulationEnabled', { enabled: true })
        await until('terminal listed again', () => page.evaluate<boolean>(`window.__terminals.list.some(t => t.id === ${JSON.stringify(id)})`))
        await page.evaluate('window.__terminals.show()')
        await until('screen restored after reload', async () => (await screen(id)).includes('e2e-42'))
        check(true, 'a reloaded window gets the terminal back with its screen')

        // A command terminal: ends with the command, keeps output and exit code, runs again.
        await page.evaluate(`window.__terminals.create(${JSON.stringify(project)}, { command: 'echo built-ok; exit 4' })`)
        const cmd = await until('command terminal exited', () => page.evaluate<string | undefined>('window.__terminals.list.find(t => t.command && t.exit)?.id'))
        check(await page.evaluate<number>(`window.__terminals.list.find(t => t.id === ${JSON.stringify(cmd)}).exit.code`) === 4, 'a command terminal reports its exit code')
        check(await until('exit code in the tab', async () => (await page.evaluate<string>('document.querySelector("section[aria-label=Terminal] [role=tablist]").innerText')).includes('4')), 'the tab shows the exit code')
        await until('command output', async () => (await screen(cmd)).includes('built-ok'))
        await page.evaluate(`window.__terminals.restart(${JSON.stringify(cmd)})`)
        await until('ran again', async () => ((await screen(cmd)).match(/built-ok/g)?.length ?? 0) === 2)
        check(true, 'Run again runs the command a second time in the same tab')
        await shot(page, 'terminal-command.png')

        // ⌘W inside the terminal closes the terminal tab, not the thread.
        await page.evaluate(`window.__terminals.select(${JSON.stringify(cmd)})`)
        await until('command terminal focused', () => page.evaluate<boolean>('!!document.activeElement?.closest(".xterm")'))
        await key(page, 'w', 'KeyW', 4)
        await until('command terminal closed', () => page.evaluate<boolean>(`!window.__terminals.list.some(t => t.id === ${JSON.stringify(cmd)})`))
        check(await threadTabs() === tabsBefore, '⌘W in the terminal closes the terminal, the thread tab stays')

        // ⌃` from inside hides the panel; the shell keeps running.
        await page.evaluate(`window.__terminals.select(${JSON.stringify(id)})`)
        await until('shell focused', () => page.evaluate<boolean>('!!document.activeElement?.closest(".xterm")'))
        await key(page, '`', 'Backquote', 2)
        await until('panel hidden', () => page.evaluate<boolean>('!document.querySelector("section[aria-label=Terminal]")'))
        check(await page.evaluate<boolean>(`window.__terminals.list.some(t => t.id === ${JSON.stringify(id)})`), '⌃` from inside hides the panel and the shell keeps running')
        check(await until('composer focused', () => page.evaluate<boolean>('document.activeElement?.tagName === "TEXTAREA" && !document.activeElement.closest(".xterm")'), 3000).catch(() => false), 'and the keyboard goes back to the composer')
        // A new thread focuses its composer too (another request, after the one already handled).
        await page.evaluate('document.activeElement?.blur()')
        await page.evaluate(`window.__app.newThread(${JSON.stringify(project)})`)
        check(await until('new thread composer focused', () => page.evaluate<boolean>('document.activeElement?.tagName === "TEXTAREA"'), 3000).catch(() => false), 'a new thread focuses its composer')

        // Light theme: same layout, the terminal follows the colours.
        await page.evaluate('window.__app.setTheme("light")')
        await page.evaluate('window.__terminals.show()')
        await until('panel back', () => page.evaluate<boolean>('!!document.querySelector("section[aria-label=Terminal] .xterm")'))
        await new Promise(r => setTimeout(r, 400))
        const [bg, panel] = await page.evaluate<[string, string]>(`[window.__terminalView(${JSON.stringify(id)}).term.options.theme.background, getComputedStyle(document.documentElement).getPropertyValue('--ide-panel').trim()]`)
        check(bg === panel && bg !== '#191a1c', `the light theme gives the terminal the light panel background (${bg})`)
        await shot(page, 'terminal-light.png')

        // A long-running job; then the project leaves the window and takes the terminal and job with it.
        const marker = `filo-e2e-${Date.now()}`
        await page.evaluate(`window.pi.terminalWrite(${JSON.stringify(id)}, ${JSON.stringify(`sh -c 'sleep 600; :' ${marker} &\r`)})`)
        const jobs = async () => (await import('node:child_process')).execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter(l => l.includes(marker) && !l.includes('ps -axo')).length
        await until('job running', async () => (await jobs()) > 0)
        await page.evaluate(`window.pi.closeProject(${JSON.stringify(project)})`)
        await until('terminals ended with the project', async () => (await page.evaluate<number>('window.pi.terminals().then(l => l.length)')) === 0, 10_000)
        await until('job ended', async () => (await jobs()) === 0, 5000)
        check(true, 'closing the project ends its terminals and the jobs in them')
        page.close()
    }
    finally {
        await stop()
    }
    console.log('shell e2e passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
