// The editor's TypeScript project in the built app (no model calls), per level of Settings → Editor:
//   - standard: imports (relative, tsconfig paths, packages with types, assets) resolve; a missing
//     module still shows an error; ⌘-click / F12 on a name from another file opens that file
//   - full: errors in files that are not open mark them (and their folders) red in the tree, and a
//     file changed on disk is checked again
//   - light: no diagnostics at all
//
//   bun run build && bun run e2e:code-intel
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-code-intel')

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([path.join(repo, 'src/lib'), path.join(repo, 'node_modules/dep'), userData, agentDir].map(d => mkdir(d, { recursive: true })))
    const w = (f: string, text: string) => writeFile(path.join(repo, f), text)
    await w('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }))
    await w('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0', types: 'index.d.ts' }))
    await w('node_modules/dep/index.d.ts', 'export declare function depFn(n: number): string\n')
    await w('src/lib/util.ts', 'export function double(n: number): number {\n    return n * 2\n}\n')
    await w('src/broken.ts', 'export const bad: number = \'text\'\n')
    await w('src/other.ts', 'export const fine = 1\n')
    const main = path.join(repo, 'src/main.ts')
    await w('src/main.ts', 'import { depFn } from \'dep\'\nimport { double } from \'@/lib/util\'\nimport { fine } from \'./other\'\nimport css from \'./style.css\'\nimport nothing from \'./missing\'\n\nexport const out = depFn(double(fine)) + css + nothing\n')
    await w('src/style.css', 'a {}\n')

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
        await open(main)
        await until('only the missing module is reported', async () => (await squiggles()).length === 1, 15000)
        check((await squiggles())[0].includes('missing'), 'standard: package, alias, relative and css imports resolve; the missing module is the one error')

        // go to definition into another file
        const pos = await page.evaluate<number>(`window.__app.activeFile.view.state.doc.toString().indexOf('double(fine)')`)
        const where = await page.evaluate<{ path: string, line: number } | null>(`(() => { const t = window.__app.activeFile; return window.__codeIntel.definitionElsewhere(t, 'typescript', t.view.state.doc.toString(), ${pos}) })()`)
        check(where?.path === path.join(repo, 'src/lib/util.ts') && where.line === 1, `standard: the definition of double is in util.ts line 1 (${JSON.stringify(where)})`)

        // full
        await page.evaluate(`window.__app.setEditorIntel('full')`)
        await until('broken.ts is marked', () => page.evaluate<boolean>(`window.__codeIntel.problemCount(${JSON.stringify(path.join(repo, 'src/broken.ts'))}) > 0`), 30000)
        check(await page.evaluate<boolean>(`window.__codeIntel.hasProblem(${JSON.stringify(path.join(repo, 'src'))})`), 'full: the project is checked; a file with an error is marked, and its folder')
        await writeFile(path.join(repo, 'src/broken.ts'), 'export const bad: number = 1\n')
        await until('broken.ts clears', () => page.evaluate<boolean>(`window.__codeIntel.problemCount(${JSON.stringify(path.join(repo, 'src/broken.ts'))}) === 0`), 30000)
        check(true, 'full: a change on disk is checked again')

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
