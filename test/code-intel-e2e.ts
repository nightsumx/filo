// The editor's TypeScript project in the built app (no model calls), per level of Settings → Editor:
//   - standard: the whole project is read once and the type check runs in a worker; imports
//     (relative, tsconfig paths, packages with types, assets) resolve; a missing module still shows
//     an error; ⌘-click / F12 on a name from another file opens that file
//   - a project is indexed when it is shown, every tsconfig of it (a second package too), with no file opened
//   - full: errors in files that are not open mark them (and their folders) red in the tree, and a
//     file changed on disk is checked again
//   - light: no diagnostics at all
//
//   bun run build && bun run e2e:code-intel
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, COMMAND, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-code-intel')
const SHOTS = process.env.SHOTS ?? ''

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([path.join(repo, 'src/lib'), path.join(repo, 'packages/other/src'), path.join(repo, 'node_modules/dep'), userData, agentDir].map(d => mkdir(d, { recursive: true })))
    const w = (f: string, text: string) => writeFile(path.join(repo, f), text)
    await w('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }))
    await w('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0', types: 'index.d.ts' }))
    await w('node_modules/dep/index.d.ts', 'export declare function depFn(n: number): string\n')
    await w('src/lib/util.ts', 'export function double(n: number): number {\n    return n * 2\n}\n')
    await w('src/broken.ts', 'export const bad: number = \'text\'\n')
    await w('src/other.ts', 'export const fine = 1\n')
    const main = path.join(repo, 'src/main.ts')
    const util = path.join(repo, 'src/lib/util.ts')
    await w('src/main.ts', 'import { depFn } from \'dep\'\nimport { double } from \'@/lib/util\'\nimport { fine } from \'./other\'\nimport css from \'./style.css\'\nimport App from \'./App.vue\'\nimport nothing from \'./missing\'\n\nexport const out = depFn(double(fine)) + css + nothing + String(App)\n')
    await w('src/style.css', 'a {}\n')
    // CSS, HTML and Vue
    await w('src/Comp.vue', '<template><i class="box">{{ label }}</i></template>\n<script setup lang="ts">\nconst label: string = \'x\'\n</script>\n')
    await w('src/App.vue', '<template>\n  <section class="card">\n    <Comp />\n  </section>\n</template>\n\n<script setup lang="ts">\nimport Comp from \'./Comp.vue\'\nconst shown = Comp\n</script>\n\n<style scoped>\n.card { colour: red }\n</style>\n')
    await w('site.css', '.hero { margin: 0 }\n')
    await w('index.html', '<!doctype html>\n<html><head><link rel="stylesheet" href="./site.css"></head>\n<body class="hero"></body></html>\n')
    // A second package with its own tsconfig, never opened
    await w('packages/other/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' }, include: ['src'] }))
    await w('packages/other/src/p.ts', 'export const p: number = \'no\'\n')

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
        const [{ page }] = await windows(1)
        await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false })
        await until('app ready', () => page.evaluate<boolean>(`!!window.__app && !!window.__codeIntel`))
        const squiggles = () => page.evaluate<string[]>(`[...document.querySelectorAll('.cm-diagnostic-error')].map(e => e.textContent)`)
        const open = async (file: string) => {
            await page.evaluate(`window.__app.openFile(${JSON.stringify(file)}, ${JSON.stringify(repo)})`)
            await until('editor shows the file', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${file}`)} && !!document.querySelector('.cm-content')`))
        }

        // standard
        await page.evaluate(`window.__app.setEditorIntel('standard')`)
        // The project is indexed as soon as it is shown: both tsconfigs, with no file opened yet
        await until('both tsconfigs indexed with no file open', () => page.evaluate<boolean>(`window.__app.openFiles.length === 0 && [...window.__codeIntel.entries.values()].filter(e => e.project.files.size > 0).length === 2`), 20000)
        check(await page.evaluate<boolean>(`window.__app.openFiles.length === 0 && window.__tsChecker.runsIn !== 'window'`), 'standard: showing the project indexes all its tsconfigs before any file is opened')
        await open(main)
        await until('only the missing module is reported', async () => (await squiggles()).length === 1, 15000)
        check((await squiggles())[0].includes('missing'), 'standard: package, alias, relative and css imports resolve; the missing module is the one error')
        check(await page.evaluate<string>(`window.__tsChecker.runsIn`) === 'worker', 'the type check runs in a worker, not on the window\'s thread')

        // go to definition into another file
        const pos = await page.evaluate<number>(`window.__app.activeFile.view.state.doc.toString().indexOf('double(fine)')`)
        const where = await page.evaluate<{ path: string, line: number } | null>(`(() => { const t = window.__app.activeFile; return window.__codeIntel.definitionElsewhere(t, 'typescript', t.view.state.doc.toString(), ${pos}) })()`)
        check(where?.path === path.join(repo, 'src/lib/util.ts') && where.line === 1, `standard: the definition of double is in util.ts line 1 (${JSON.stringify(where)})`)

        // ⌘-click and F12 on a name from another file open that file at the definition
        const caret = async (at: number) => page.evaluate(`(() => { const v = window.__app.activeFile.view; v.dispatch(v.state.update({ selection: { anchor: ${at} } })); v.focus() })()`)
        await caret(pos + 2)
        await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 })
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 })
        await until('F12 opened util.ts', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${util}`)}`), 5000)
        await until('caret on the definition', () => page.evaluate<boolean>(`(() => { const v = window.__app.activeFile.view; return !!v && v.state.doc.lineAt(v.state.selection.main.head).number === 1 })()`), 5000)
        check(true, 'F12 on a name from another file opens it with the caret on the definition')
        await page.evaluate(`window.__app.focus(${JSON.stringify(`file:${main}`)})`)
        await until('back in main.ts', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${main}`)} && !!document.querySelector('.cm-content')`))
        // Holding ⌘ over a name or a path that leads somewhere underlines it as a link; over one that does not, nothing
        const where_ = (needle: string, offset: number) => page.evaluate<{ x: number, y: number }>(`(() => { const v = window.__app.activeFile.view; const c = v.caretCoords(v.state.doc.toString().indexOf(${JSON.stringify(needle)}) + ${offset}); return { x: c.left + 2, y: (c.top + c.bottom) / 2 } })()`)
        const linked = () => page.evaluate<string>(`[...document.querySelectorAll('.cm-def-link')].map(e => e.textContent).join('|')`)
        const hover = async (needle: string, offset: number, modifiers = COMMAND) => {
            await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await where_(needle, offset), modifiers })
        }
        await hover('\'@/lib/util\'', 3)
        await until('the alias path is a link', async () => (await linked()) === '@/lib/util', 5000)
        check(true, '⌘-hover on an import path underlines the whole path')
        const style = await page.evaluate<{ line: string, cursor: string }>(`(() => { const s = getComputedStyle(document.querySelector('.cm-def-link')); return { line: s.textDecorationLine, cursor: s.cursor } })()`)
        check(style.line.includes('underline') && style.cursor === 'pointer', `the link is underlined with a pointer (${JSON.stringify(style)})`)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'code-intel-link.png'))
        await hover('./style.css', 4)
        await until('the stylesheet path is a link', async () => (await linked()) === './style.css', 5000)
        await hover('depFn(double', 8)
        await until('the name is a link', async () => (await linked()) === 'double', 5000)
        await hover('./missing', 4)
        await until('a path that does not exist is not', async () => (await linked()) === '', 5000)
        check(true, '⌘-hover on a name, a stylesheet and a missing module: link, link, none')
        await hover('depFn(double', 8)
        await until('linked again', async () => (await linked()) === 'double', 5000)
        await hover('depFn(double', 8, 0)
        await until('released ⌘ clears it', async () => (await linked()) === '', 5000)
        check(true, 'without ⌘ nothing is underlined')

        const spot = await page.evaluate<{ x: number, y: number }>(`(() => {
            const span = [...document.querySelectorAll('.cm-line span')].find(e => e.textContent === 'double')
            const r = span.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })()`)
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...spot, button: 'left', clickCount: 1, modifiers: COMMAND })
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...spot, button: 'left', clickCount: 1, modifiers: COMMAND })
        await until('⌘-click opened util.ts', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${util}`)}`), 5000)
        check(true, '⌘-click on a name from another file opens it')
        await page.evaluate(`window.__app.focus(${JSON.stringify(`file:${main}`)})`)

        // A component is imported by its name (no "cannot find module" for it), and the file itself is read by the editor
        await page.evaluate(`window.__app.focus(${JSON.stringify(`file:${main}`)})`)
        await new Promise(r => setTimeout(r, 1500))
        check((await squiggles()).length === 1, `standard: a .vue import resolves ${JSON.stringify(await squiggles())}`)
        const app = path.join(repo, 'src/App.vue')
        const comp = path.join(repo, 'src/Comp.vue')
        await open(app)
        await until('the CSS squiggle in the style block', () => page.evaluate<boolean>(`[...document.querySelectorAll('.cm-diagnostic-warning')].some(e => e.textContent === 'colour')`), 15000)
        check(true, 'vue: an unknown property in <style> is reported')
        const f12 = async () => {
            await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 })
            await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 })
        }
        await caret(await page.evaluate<number>(`window.__app.activeFile.view.state.doc.toString().indexOf('<Comp') + 2`))
        await f12()
        await until('F12 on a component tag opened it', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${comp}`)}`), 8000)
        check(true, 'vue: F12 on <Comp /> opens Comp.vue')
        await page.evaluate(`window.__app.focus(${JSON.stringify(`file:${app}`)})`)
        await until('back in App.vue', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${app}`)} && !!document.querySelector('.cm-content')`))
        await hover('<Comp', 2)
        await until('the tag is a link', async () => (await linked()) === 'Comp', 5000)
        check(true, 'vue: ⌘-hover on a component tag underlines it')
        await hover('<Comp', 2, 0)
        const html = path.join(repo, 'index.html')
        const site = path.join(repo, 'site.css')
        await open(html)
        await caret(await page.evaluate<number>(`window.__app.activeFile.view.state.doc.toString().indexOf('hero') + 1`))
        await f12()
        await until('F12 on a class opened the stylesheet', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(`file:${site}`)}`), 8000)
        check(true, 'html: F12 on a class opens the rule in the linked stylesheet')
        // completion in a stylesheet
        await until('site.css has its editor', () => page.evaluate<boolean>(`!!window.__app.activeFile?.view`), 8000)
        await page.evaluate(`(() => { const v = window.__app.activeFile.view; v.dispatch(v.state.update({ changes: { from: v.state.doc.length, insert: '.a { disp' }, selection: { anchor: v.state.doc.length + 9 } })); v.focus() })()`)
        await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 })
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 })
        await until('the CSS service completes display', () => page.evaluate<boolean>(`[...document.querySelectorAll('[class*="completion"], [class*="suggest"]')].some(e => e.textContent.includes('display'))`), 8000)
        check(true, 'css: ⌃Space completes a property from the CSS service')
        // hover on a property
        await page.evaluate(`(() => { const v = window.__app.activeFile.view; v.dispatch(v.state.update({ selection: { anchor: 0 } })) })()`)
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await where_('margin', 2), modifiers: 0 })
        await until('the CSS service explains margin', () => page.evaluate<boolean>(`[...document.querySelectorAll('[class*="hover"], [class*="tooltip"]')].some(e => e.textContent.includes('margin') && e.textContent.length > 20)`), 8000)
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'web-hover.png'))
        check(true, 'css: hovering a property shows the CSS service\'s card')
        await page.evaluate(`window.__app.focus(${JSON.stringify(`file:${main}`)})`)

        // full
        await page.evaluate(`window.__app.setEditorIntel('full')`)
        await until('broken.ts is marked', () => page.evaluate<boolean>(`window.__codeIntel.problemCount(${JSON.stringify(path.join(repo, 'src/broken.ts'))}) > 0`), 30000)
        check(await page.evaluate<boolean>(`window.__codeIntel.hasProblem(${JSON.stringify(path.join(repo, 'src'))})`), 'full: the project is checked; a file with an error is marked, and its folder')
        await until('the other package is marked', () => page.evaluate<boolean>(`window.__codeIntel.problemCount(${JSON.stringify(path.join(repo, 'packages/other/src/p.ts'))}) > 0`), 30000)
        check(true, 'full: a package with its own tsconfig that was never opened is indexed and checked too')
        if (SHOTS) {
            // The tree, with the failing file red and the folder above it
            await page.evaluate(`window.__app.showSidebarView('files')`)
            await page.evaluate(`window.__files.toggle(${JSON.stringify(path.join(repo, 'src'))}, true)`)
            await new Promise(r => setTimeout(r, 800))
            await page.screenshot(path.join(SHOTS, 'code-intel-tree.png'))
            await page.evaluate(`window.__app.showSidebarView('threads')`)
        }
        await writeFile(path.join(repo, 'src/broken.ts'), 'export const bad: number = 1\n')
        await until('broken.ts clears', () => page.evaluate<boolean>(`window.__codeIntel.problemCount(${JSON.stringify(path.join(repo, 'src/broken.ts'))}) === 0`), 30000)
        check(true, 'full: a change on disk is checked again')

        // A rename (or quick fix) in the service edits other files; as in Monaco, they follow the edit wherever
        // it lands, here onto the disk. Done with the service's own call, as the rename action does it.
        const renamed = 'export function twice(n: number): number {\n    return n * 2\n}\n'
        await page.evaluate(`(() => { const ci = window.__codeIntel; const e = [...ci.entries.values()][0]; e.session.updateFile(${JSON.stringify(util)}, ${JSON.stringify(renamed)}) })()`)
        await until('edit written to the unopened file', async () => (await readFile(util, 'utf8')) === renamed, 5000)
        check(true, 'an edit the service makes to a file that is not open is written to disk')
        await writeFile(util, 'export function double(n: number): number {\n    return n * 2\n}\n')
        await new Promise(r => setTimeout(r, 800))

        // The real thing: F2 on a name in util.ts, a new name, Enter. main.ts is not open and gets the new name on disk.
        await open(util)
        await page.evaluate(`(() => { const v = window.__app.activeFile.view; v.dispatch(v.state.update({ selection: { anchor: v.state.doc.toString().indexOf('double') + 2 } })); v.focus() })()`)
        await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 })
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 })
        await until('rename box', () => page.evaluate<boolean>(`!!document.querySelector('.cm-rename-input')`), 8000)
        await page.evaluate(`(() => { const i = document.querySelector('.cm-rename-input'); i.focus(); i.select() })()`)
        await page.call('Input.insertText', { text: 'twice' })
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'code-intel-rename.png'))
        await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await until('main.ts renamed on disk', async () => (await readFile(main, 'utf8')).includes('import { twice }'), 10000)
        await until('util.ts saved', async () => (await readFile(util, 'utf8')).includes('function twice'), 10000)
        const after = await readFile(main, 'utf8')
        check(after.includes('twice(fine)') && !after.includes('double'), 'F2 rename: the other file that was not open has the new name on disk, in the import and the call')

        // The settings page
        await page.evaluate(`window.__app.openSettings('editor')`)
        await until('settings page', () => page.evaluate<boolean>(`document.body.innerText.includes('Light') || document.body.innerText.includes('轻量')`))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'code-intel-settings.png'))
        check(await page.evaluate<boolean>(`document.body.innerText.includes('Standard') || document.body.innerText.includes('标准')`), 'the Editor settings page lists the levels')
        await page.evaluate(`window.__app.setSettingsOpen(false)`)

        // light
        await page.evaluate(`window.__app.setEditorIntel('light')`)
        await until('editor rebuilt', () => page.evaluate<boolean>(`!!document.querySelector('.cm-content')`))
        await new Promise(r => setTimeout(r, 2500))
        check((await squiggles()).length === 0, `light: no diagnostics ${JSON.stringify(await squiggles())} ${await page.evaluate<string>('window.__app.editorIntel')}`)
    }
    finally {
        await stop()
    }
}

main().then(() => process.exit(0), (err) => {
    console.error(err)
    process.exit(1)
})
