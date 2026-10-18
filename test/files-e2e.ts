// File tree and editor tabs in the built app (no model calls):
//   - ⌘⇧E shows the "Files" view: the project folder, node_modules a labelled library root, other folders plain, changed files
//     coloured by git, folders above a change coloured too
//   - double click folds a folder and opens a file in an editor tab next to the threads
//   - typing autosaves shortly after; a write from outside (an agent) shows up in place while
//     there are no unsaved edits, and turns into a conflict notice while there are
//   - the editor tab comes back after a reload, and ⌘W closes it
//
//   bun run build && bun run e2e:files
import type { Page } from './app'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, COMMAND, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-files')
const SHOTS = process.env.SHOTS ?? ''
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function key(page: Page, key: string, code: string, keyCode: number, modifiers = 0) {
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode })
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode })
}

/** Clicks the middle of the first element matching `selector`, `count` times in a row. */
async function click(page: Page, selector: string, count = 1) {
    const box = await until(`element ${selector}`, () => page.evaluate<{ x: number, y: number } | null>(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()
        return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
    })()`))
    for (let n = 1; n <= count; n++) {
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: n })
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: n })
    }
}

const row = (p: string) => `[data-tree-path=${JSON.stringify(p)}]`

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([path.join(repo, 'src'), path.join(repo, 'node_modules/dep'), userData, agentDir].map(d => mkdir(d, { recursive: true })))
    const main = path.join(repo, 'src/main.ts')
    await writeFile(main, '// A greeting\nimport { join } from \'node:path\'\n\nexport interface Greeting { text: string, times: number }\n\nexport function hello(name: string, times = 2): Greeting {\n    const text = `hello ${join(name)}`\n    return { text, times }\n}\n')
    await writeFile(path.join(repo, 'README.md'), '# repo\n')
    await writeFile(path.join(repo, '.gitignore'), 'node_modules\n')
    await writeFile(path.join(repo, 'node_modules/dep/index.js'), '\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
    await writeFile(path.join(repo, 'README.md'), '# repo\n\nchanged\n')
    await writeFile(path.join(repo, 'src/new.ts'), 'export const x = 1\n')

    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [repo],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'split',
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [repo] }],
    }))

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        let [{ page }] = await windows(1)
        await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false })
        await key(page, 'e', 'KeyE', 69, COMMAND | 8)
        await until('files view', () => page.evaluate<boolean>(`window.__app.sidebarView === 'files'`))
        await until('project folder listed', () => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(row(path.join(repo, 'README.md')))})`))
        check(true, '⌘⇧E shows the files view with the project folder open')

        const classOf = (p: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(row(p))} + ' span.truncate, ' + ${JSON.stringify(row(p))} + ' span.flex-1')?.className ?? ''`)
        check((await classOf(path.join(repo, 'node_modules'))).includes('--ide-icon-excluded'), 'node_modules has an orange name')
        await until('git colours', async () => (await classOf(path.join(repo, 'README.md'))).includes('text-blue-600'))
        check(!(await classOf(path.join(repo, 'src'))).includes('text-blue-600'), 'a modified file is blue; the folder holding a change stays plain')

        await click(page, row(path.join(repo, 'src')), 2)
        await until('src expanded', () => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(row(main))})`))
        await until('new file green', async () => (await classOf(path.join(repo, 'src/new.ts'))).includes('text-green-600'))
        check(true, 'double click expands a folder; an untracked file is green')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'files-tree.png'))

        await click(page, row(main), 2)
        const fileKey = `file:${main}`
        await until('editor tab', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(fileKey)}`))
        await until('editor shows the file', () => page.evaluate<boolean>(`document.querySelector('.cm-content')?.textContent.includes('hello')`))
        check(await page.evaluate<boolean>(`[...document.querySelectorAll('[role=tab]')].some(t => t.textContent.includes('main.ts'))`), 'double click opens the file in an editor tab')
        await until('syntax colours', () => page.evaluate<boolean>(`document.querySelectorAll('.cm-content span[style*="color"]').length > 3`), 5000)
        check(true, 'the editor colours the syntax')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'files-code-dark.png'))
        await page.evaluate(`window.__app.setTheme('light')`)
        await new Promise(r => setTimeout(r, 600))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'files-code-light.png'))
        await page.evaluate(`window.__app.setTheme('dark')`)
        await new Promise(r => setTimeout(r, 400))

        // Typing: autosaved shortly after.
        await click(page, '.cm-line')
        await page.evaluate(`(() => { const v = window.__app.activeFile.view; v.dispatch(v.state.update({ selection: { anchor: v.state.doc.length } })) })()`)
        await page.call('Input.insertText', { text: '// typed\n' })
        await until('autosaved', async () => (await readFile(main, 'utf8')).endsWith('// typed\n'), 5000)
        check(await page.evaluate<boolean>(`window.__app.activeFile.view.state.doc.toString().endsWith('// typed\\n')`), 'the editor has the typed text')
        check(true, 'typing is saved to disk after a moment')

        // An agent appends a line: the editor follows without a prompt.
        await writeFile(main, `${await readFile(main, 'utf8')}// from the agent\n`)
        await until('outside write shown', () => page.evaluate<boolean>(`document.querySelector('.cm-content').textContent.includes('from the agent')`), 5000)
        check(!(await page.evaluate<boolean>(`document.body.innerText.includes('changed on disk')`)), 'a write from outside shows up in place when there are no unsaved edits')

        // Unsaved edits and an outside write: the user picks.
        await page.call('Input.insertText', { text: 'mine' })
        await writeFile(main, 'agent rewrote it\n')
        await until('conflict notice', () => page.evaluate<boolean>(`document.body.innerText.includes('changed on disk')`), 5000)
        await new Promise(r => setTimeout(r, 1500))
        check(await readFile(main, 'utf8') === 'agent rewrote it\n', 'unsaved edits do not overwrite the outside write; a notice offers both sides')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'files-conflict.png'))
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Load disk version').click()`)
        await until('took disk', () => page.evaluate<boolean>(`document.querySelector('.cm-content').textContent === 'agent rewrote it'`))
        check(true, 'loading the disk version replaces the editor contents')

        await page.evaluate(`window.__app.setTheme('light')`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'files-light.png'))
        await page.evaluate(`window.__app.setTheme('dark')`)

        // Reload: the editor tab is restored.
        await page.evaluate(`window.__app.flushFiles()`)
        await new Promise(r => setTimeout(r, 600))
        await page.evaluate('location.reload()').catch(() => {})
        page.close()
        ;[{ page }] = await windows(1)
        await until('tab restored', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(fileKey)} && !!document.querySelector('.cm-content')?.textContent.includes('agent rewrote it')`))
        check(true, 'the editor tab comes back after a reload')

        await click(page, '.cm-line')
        await key(page, 'w', 'KeyW', 87, COMMAND)
        await until('tab closed', () => page.evaluate<boolean>(`!window.__app.files.size`))
        check(true, '⌘W closes the editor tab')
    }
    finally {
        await stop()
    }
}

main().then(() => process.exit(0), (err) => {
    console.error(err)
    process.exit(1)
})
