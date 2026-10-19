import type { FileTab } from './fileTab'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path/posix'
import { getTSService, setTsLibLoader } from 'lite-monaco'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeProjectFs } from '../../test/projectFs'
import { appStore } from './app'
import { slashed, vpath } from '@/lib/tsProject'
import { codeIntel } from './codeIntel'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// The editor works on slashed paths (codeIntel slashes what it gets), so the fixtures do too, on Windows as well.
const root = slashed(realpathSync(mkdtempSync(`${tmpdir()}/code-intel-`)))
const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
}
const at = (rel: string) => join(root, rel)
const disk = (rel: string) => readFileSync(at(rel), 'utf8')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) {
    const end = Date.now() + ms
    while (!(await ok())) {
        if (Date.now() > end)
            throw new Error(`timed out waiting for: ${what}`)
        await wait(25)
    }
}

/** A tab as the editor would hand it over: only where the file is matters here. */
const tabOf = (rel: string) => ({ path: at(rel), cwd: root, key: `file:${at(rel)}`, name: rel }) as unknown as FileTab

const UTIL = 'export function double(n: number): number {\n    return n * 2\n}\n'
const MAIN = 'import { double } from "./util"\nexport const out: number = double(2)\n'

let written: string[]

beforeAll(() => {
    const libs = join(process.cwd(), 'node_modules/typescript/lib')
    setTsLibLoader(async () => new Map(readdirSync(libs).filter(f => /^lib\..*\.d\.ts$/.test(f)).map(f => [f, readFileSync(join(libs, f), 'utf8')] as const)))
})

beforeEach(() => {
    written = []
    vi.stubGlobal('window', {
        addEventListener: () => {},
        pi: {
            ...nodeProjectFs,
            readFile: nodeProjectFs.read,
            realPath: nodeProjectFs.realPath,
            projectSources: nodeProjectFs.sources,
            projectConfigs: nodeProjectFs.configs,
            listDir: async (dir: string) => ({ entries: (await nodeProjectFs.folders(dir)).map(name => ({ name, dir: true })) }),
            // The same refuse-if-changed rule as electron/files.ts.
            writeFile: async (file: string, text: string, { expected }: { expected: string | null }) => {
                const now = readFileSync(file, 'utf8')
                if (expected !== null && now !== expected)
                    return { ok: false, disk: { kind: 'text', text: now, bom: false, size: now.length } }
                writeFileSync(file, text)
                written.push(file)
                return { ok: true }
            },
        },
    })
    put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' }, include: ['src'] }))
    put('src/util.ts', UTIL)
    put('src/main.ts', MAIN)
    put('src/other.ts', 'export const other = 1\n')
    put('src/broken.ts', 'export const bad: number = "text"\n')
    appStore.editorIntel = 'standard'
    toast.success.mockClear()
    toast.error.mockClear()
})
afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    // Projects of one test must not be there for the next.
    const entries = (codeIntel as unknown as { entries: Map<string, { links: Set<unknown>, project: { own: () => string[] } }> }).entries
    entries.clear()
    const inner = codeIntel as unknown as { warmed: Map<string, symbol>, opened: string[], active: string | null }
    inner.warmed.clear()
    inner.opened = []
    inner.active = null
    codeIntel.problems.clear()
    const { clearTSServiceCache } = await import('lite-monaco')
    clearTSServiceCache()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const session = (rel: string) => getTSService({ lang: 'typescript', fileName: at(rel) })
const entriesOf = () => (codeIntel as unknown as { entries: Map<string, { level: string, root: string }> }).entries

describe('codeIntel: attaching', () => {
    it('hands the service the files the open one imports', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const s = session('src/main.ts')
        s.update(MAIN)
        const service = await s.ensure()
        expect(service.getSemanticDiagnostics(vpath(at('src/main.ts')))).toEqual([])
        expect(s.getFileText(at('src/util.ts'))).toBe(UTIL)
        link.release()
    })

    it('sync reads what a changed import needs', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const next = `${MAIN}import { other } from "./other"\nexport const o: number = other\n`
        await link.sync(next)
        expect(session('src/main.ts').getFileText(at('src/other.ts'))).toBe('export const other = 1\n')
        link.release()
    })

    it('a second tab of the same project shares it', async () => {
        const a = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const b = await codeIntel.attach(tabOf('src/util.ts'), 'typescript', 'standard', UTIL)
        expect(entriesOf().size).toBe(1)
        a.release()
        b.release()
    })

    it('lets go of a project some time after its last tab', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        vi.useFakeTimers()
        link.release()
        link.release() // a second release changes nothing
        vi.advanceTimersByTime(1000)
        expect(entriesOf().size).toBe(1)
        vi.advanceTimersByTime(10_000)
        expect(entriesOf().size).toBe(0)
    })

    it('a tab that comes back in time finds the project there', async () => {
        const first = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        vi.useFakeTimers()
        first.release()
        vi.advanceTimersByTime(3000)
        vi.useRealTimers()
        const second = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        vi.useFakeTimers()
        vi.advanceTimersByTime(20_000)
        expect(entriesOf().size).toBe(1)
        second.release()
    })
})

describe('codeIntel: the index', () => {
    const request = (text: string, overrides: object = {}) => ({ fileName: at('src/main.ts'), text, mode: 'full' as const, wantTags: false, options: {}, ...overrides })

    it('reads the whole project once, not just what the open file imports', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        await until('other.ts read', () => session('src/main.ts').getFileText(at('src/other.ts')) !== null)
        expect(session('src/main.ts').getFileText(at('src/broken.ts'))).toContain('"text"')
        // a second tab of the project reads nothing more: one project, one index
        const again = await codeIntel.attach(tabOf('src/util.ts'), 'typescript', 'standard', UTIL)
        expect(entriesOf().size).toBe(1)
        link.release()
        again.release()
    })

    it('diagnostics come from the checker, for the text the editor holds', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const clean = await link.check(request(MAIN))
        expect(clean?.diagnostics).toEqual([])
        const wrong = 'import { double } from "./util"\nexport const out: string = double(2)\n'
        const found = await link.check(request(wrong))
        expect(found?.diagnostics.map(d => d.severity)).toEqual(['error'])
        expect(found?.diagnostics[0].message).toContain('number')
        link.release()
    })

    it('a file imported by the open one is found without the editor asking for it first', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const text = `${MAIN}import { other } from "./other"\nexport const o: number = other\n`
        const result = await link.check(request(text))
        expect(result?.diagnostics).toEqual([])
        link.release()
    })

    it('a missing module is reported once the index is there', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const result = await link.check(request('import { nope } from "./nowhere"\nexport const n = nope\n'))
        expect(result?.diagnostics.map(d => d.code)).toContain('(2307)')
        link.release()
    })

    it('says nothing once the link is let go of', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        link.release()
        expect(await link.check(request(MAIN))).toBeNull()
    })
})

describe('codeIntel: a folder with several tsconfigs', () => {
    const PKG = { compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' }, include: ['src'] }

    beforeEach(() => {
        put('packages/a/tsconfig.json', JSON.stringify(PKG))
        put('packages/a/src/a.ts', 'export const a: number = 1\n')
        put('packages/b/tsconfig.json', JSON.stringify(PKG))
        put('packages/b/src/b.ts', 'export const b: number = "no"\n')
        // a solution-style config at the root of web: its files live in the configs it points at
        put('web/tsconfig.json', JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }))
        put('web/tsconfig.app.json', JSON.stringify({ ...PKG, include: ['app'] }))
        put('web/app/w.ts', 'export const w = 1\n')
    })
    afterEach(() => {
        for (const dir of ['packages', 'web'])
            rmSync(at(dir), { recursive: true, force: true })
    })

    it('showing a project indexes every tsconfig of it, before any file is opened', async () => {
        codeIntel.openProject(root)
        await until('a is read', () => entriesOf().size >= 4)
        const files = () => [...entriesOf().values()].flatMap(e => [...(e as unknown as { project: { files: Map<string, string> } }).project.files.keys()])
        await until('every package and the config a solution one points at are read', () => [at('src/util.ts'), at('packages/a/src/a.ts'), at('packages/b/src/b.ts'), at('web/app/w.ts')].every(f => files().includes(f)))
        // the editor's service has them too, with no file open
        const s = getTSService({ lang: 'typescript', fileName: at('src/main.ts') })
        expect(s.getFileText(at('packages/b/src/b.ts'))).toContain('"no"')
    })

    it('opening a file of an already shown project makes nothing more', async () => {
        codeIntel.openProject(root)
        await until('indexed', () => entriesOf().size >= 4)
        const before = entriesOf().size
        const link = await codeIntel.attach(tabOf('packages/b/src/b.ts'), 'typescript', 'standard', 'export const b: number = "no"\n')
        expect(entriesOf().size).toBe(before)
        link.release()
    })

    it('a file opened in a project that is not shown still gets its own index', async () => {
        const link = await codeIntel.attach(tabOf('packages/a/src/a.ts'), 'typescript', 'standard', 'export const a: number = 1\n')
        await until('a read', () => session('packages/a/src/a.ts').getFileText(at('packages/a/src/a.ts')) !== null)
        expect(entriesOf().size).toBe(1)
        link.release()
    })

    it('squiggles in a package come from its own tsconfig', async () => {
        const link = await codeIntel.attach(tabOf('packages/b/src/b.ts'), 'typescript', 'standard', 'export const b: number = "no"\n')
        const result = await link.check({ fileName: at('packages/b/src/b.ts'), text: 'export const b: number = "no"\n', mode: 'full', wantTags: false, options: {} })
        expect(result?.diagnostics.map(d => d.code)).toEqual(['(2322)'])
        link.release()
    })

    it('stays while the project is shown, even with every tab closed', async () => {
        codeIntel.openProject(root)
        const link = await codeIntel.attach(tabOf('packages/a/src/a.ts'), 'typescript', 'standard', 'export const a: number = 1\n')
        await until('indexed', () => entriesOf().size >= 4)
        vi.useFakeTimers()
        link.release()
        vi.advanceTimersByTime(60_000)
        expect(entriesOf().size).toBeGreaterThanOrEqual(4)
    })

    it('goes when the project is let go of; a tsconfig with an editor open stays until the editor goes', async () => {
        codeIntel.openProject(root)
        const link = await codeIntel.attach(tabOf('packages/a/src/a.ts'), 'typescript', 'standard', 'export const a: number = 1\n')
        await until('indexed', () => entriesOf().size >= 4)
        codeIntel.closeProject(root)
        expect(entriesOf().size).toBe(1)
        vi.useFakeTimers()
        link.release()
        vi.advanceTimersByTime(20_000)
        expect(entriesOf().size).toBe(0)
    })

    it('keeps the few most recent projects, and not a project with a file open', async () => {
        const other = slashed(realpathSync(mkdtempSync(`${tmpdir()}/code-intel-`)))
        const more = [1, 2, 3].map(() => slashed(realpathSync(mkdtempSync(`${tmpdir()}/code-intel-`))))
        try {
            const opened = () => (codeIntel as unknown as { opened: string[] }).opened
            codeIntel.openProject(root)
            const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
            codeIntel.openProject(other)
            codeIntel.openProject(more[0])
            codeIntel.openProject(more[1])
            // root has a file open: `other` is the oldest that can go
            expect(opened()).toEqual([root, more[0], more[1]])
            codeIntel.openProject(more[2])
            expect(opened()).toEqual([root, more[1], more[2]])
            link.release()
        }
        finally {
            for (const dir of [other, ...more])
                rmSync(dir, { recursive: true, force: true })
        }
    })

    it('follow: the shown project is indexed, light indexes nothing, a project that left the window goes', async () => {
        codeIntel.follow(root, [root], 'standard')
        await until('indexed', () => entriesOf().size >= 4)
        codeIntel.follow(root, [root], 'light')
        expect(entriesOf().size).toBe(0)
        codeIntel.follow(root, [root], 'standard')
        await until('indexed again', () => entriesOf().size >= 4)
        codeIntel.follow(null, [], 'standard')
        expect(entriesOf().size).toBe(0)
    })

    it('follow at full checks the shown project only', async () => {
        appStore.editorIntel = 'full'
        codeIntel.follow(root, [root], 'full')
        await until('the unopened package is marked', () => codeIntel.problemCount(at('packages/b/src/b.ts')) > 0, 30_000)
        expect([...entriesOf().values()].every(e => e.level === 'full')).toBe(true)
        appStore.editorIntel = 'standard'
        codeIntel.follow(root, [root], 'standard')
        expect(codeIntel.problems.size).toBe(0)
    })

    it('at full, the packages nobody opened are checked and marked too', async () => {
        appStore.editorIntel = 'full'
        const link = await codeIntel.attach(tabOf('packages/a/src/a.ts'), 'typescript', 'full', 'export const a: number = 1\n')
        codeIntel.openProject(root)
        await until('b/src/b.ts marked', () => codeIntel.problemCount(at('packages/b/src/b.ts')) > 0, 30_000)
        expect(codeIntel.hasProblem(at('packages/b'))).toBe(true)
        expect(codeIntel.hasProblem(at('packages/a'))).toBe(false)
        // the root tsconfig's folder holds packages/b: its own check must not take b's marks for gone files
        const rootEntry = [...entriesOf().entries()].find(([key]) => key.endsWith(`${root}/tsconfig.json`))![1]
        await (codeIntel as unknown as { scan: (e: unknown) => Promise<void> }).scan(rootEntry)
        expect(codeIntel.problemCount(at('packages/b/src/b.ts'))).toBeGreaterThan(0)
        link.release()
    })
})

describe('codeIntel: the level', () => {
    it('full checks the whole project and marks the files with errors', async () => {
        appStore.editorIntel = 'full'
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'full', MAIN)
        await until('broken.ts marked', () => codeIntel.problemCount(at('src/broken.ts')) > 0)
        expect(codeIntel.hasProblem(at('src'))).toBe(true)
        expect(codeIntel.hasProblem(at('src/other.ts'))).toBe(false)
        expect(codeIntel.problemCount(at('src/main.ts'))).toBe(0)
        link.release()
    })

    it('standard does not check the project', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        await wait(2500)
        expect(codeIntel.problems.size).toBe(0)
        link.release()
    })

    it('going back to standard clears the marks', async () => {
        appStore.editorIntel = 'full'
        const full = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'full', MAIN)
        await until('broken.ts marked', () => codeIntel.problemCount(at('src/broken.ts')) > 0)
        appStore.editorIntel = 'standard'
        const standard = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        expect(codeIntel.problems.size).toBe(0)
        full.release()
        standard.release()
    })

    it('an attach that began under another setting does not change the level', async () => {
        appStore.editorIntel = 'full'
        const stale = codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const current = codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'full', MAIN)
        const links = await Promise.all([stale, current])
        await until('level is full', () => [...entriesOf().values()][0]?.level === 'full')
        await until('broken.ts marked', () => codeIntel.problemCount(at('src/broken.ts')) > 0)
        links.forEach(l => l.release())
    })

    it('other languages of a family: javascript is its own project', async () => {
        put('src/script.js', 'export const j = 1\n')
        const ts = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const js = await codeIntel.attach(tabOf('src/script.js'), 'javascript', 'standard', 'export const j = 1\n')
        expect(entriesOf().size).toBe(2)
        ts.release()
        js.release()
    })
})

describe('codeIntel: edits to files that are not open', () => {
    const edit = async (rel: string, text: string) => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        // The index is handed over in one go when it is read; an edit before that would be taken back with it.
        await until('indexed', () => session('src/main.ts').getFileText(at('src/other.ts')) !== null)
        session('src/main.ts').updateFile(at(rel), text)
        return link
    }

    it('writes them to disk', async () => {
        const link = await edit('src/util.ts', 'export function twice(n: number): number {\n    return n * 2\n}\n')
        await until('written', () => written.includes(at('src/util.ts')))
        expect(disk('src/util.ts')).toContain('function twice')
        expect(toast.success).toHaveBeenCalled()
        link.release()
    })

    it('leaves a file alone that changed on disk since it was read', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        await until('indexed', () => session('src/main.ts').getFileText(at('src/other.ts')) !== null)
        // Somebody else wrote the file after the editor read it.
        put('src/util.ts', `${UTIL}// from the agent\n`)
        session('src/main.ts').updateFile(at('src/util.ts'), 'export function twice(n: number): number {\n    return n * 2\n}\n')
        await until('told', () => toast.error.mock.calls.length > 0)
        expect(disk('src/util.ts')).toBe(`${UTIL}// from the agent\n`)
        expect(written).toEqual([])
        link.release()
    })

    it('does not write a file an editor has open', async () => {
        appStore.files.set('file:util', { path: at('src/util.ts'), view: {} } as never)
        const link = await edit('src/util.ts', 'export const changed = 1\n')
        await wait(900)
        expect(written).toEqual([])
        expect(disk('src/util.ts')).toBe(UTIL)
        appStore.files.delete('file:util')
        link.release()
    })

    it('does not write what it wrote itself again', async () => {
        const link = await edit('src/util.ts', 'export const once = 1\n')
        await until('written', () => written.length === 1)
        await wait(900)
        expect(written).toHaveLength(1)
        link.release()
    })
})

describe('codeIntel: the disk changes', () => {
    it('reads a project file again and hands the service the new text', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        put('src/util.ts', 'export function double(n: number): string {\n    return String(n)\n}\n')
        codeIntel.dirsChanged([{ dir: at('src'), names: ['util.ts'], listed: false }])
        await until('new text', () => session('src/main.ts').getFileText(at('src/util.ts'))?.includes('string') === true)
        const service = await session('src/main.ts').ensure()
        session('src/main.ts').update(MAIN)
        expect(service.getSemanticDiagnostics(vpath(at('src/main.ts'))).map(d => d.code)).toEqual([2322])
        // not written back: it came from the disk
        await wait(900)
        expect(written).toEqual([])
        link.release()
    })

    it('takes in a file that appears, at any level', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        put('src/fresh.ts', 'export const f = 1\n')
        codeIntel.dirsChanged([{ dir: at('src'), names: ['fresh.ts'], listed: true }])
        await until('fresh.ts read', () => session('src/main.ts').getFileText(at('src/fresh.ts')) !== null)
        link.release()
    })

    it('ignores a file the project does not cover', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        put('scripts/tool.ts', 'export const t = 1\n')
        codeIntel.dirsChanged([{ dir: at('scripts'), names: ['tool.ts'], listed: true }])
        await wait(500)
        expect(session('src/main.ts').getFileText(at('scripts/tool.ts'))).toBeNull()
        link.release()
    })

    it('full takes in a file that appears, and checks it', async () => {
        appStore.editorIntel = 'full'
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'full', MAIN)
        await until('first pass', () => codeIntel.problemCount(at('src/broken.ts')) > 0)
        put('src/fresh.ts', 'export const f: number = "no"\n')
        codeIntel.dirsChanged([{ dir: at('src'), names: ['fresh.ts'], listed: true }])
        await until('fresh.ts marked', () => codeIntel.problemCount(at('src/fresh.ts')) > 0)
        put('src/fresh.ts', 'export const f: number = 1\n')
        codeIntel.dirsChanged([{ dir: at('src'), names: ['fresh.ts'], listed: false }])
        await until('fresh.ts clear', () => codeIntel.problemCount(at('src/fresh.ts')) === 0)
        link.release()
    })

    it('a change in an importer\'s dependency checks the importer again', async () => {
        appStore.editorIntel = 'full'
        put('src/user.ts', 'import { double } from "./util"\nexport const u: number = double(1)\n')
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'full', MAIN)
        await until('first pass done', () => codeIntel.problemCount(at('src/broken.ts')) > 0)
        expect(codeIntel.problemCount(at('src/user.ts'))).toBe(0)
        put('src/util.ts', 'export function double(n: number): string {\n    return String(n)\n}\n')
        codeIntel.dirsChanged([{ dir: at('src'), names: ['util.ts'], listed: false }])
        await until('importers marked', () => codeIntel.problemCount(at('src/user.ts')) > 0 && codeIntel.problemCount(at('src/main.ts')) > 0)
        link.release()
    })

    it('the folders to watch are the project\'s source folders', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        expect(codeIntel.dirs.get()).toContain(at('src'))
        expect(codeIntel.dirs.get().some(d => d.includes('node_modules'))).toBe(false)
        link.release()
    })
})

describe('codeIntel: jumping', () => {
    it('finds a definition in another file, as line and column', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        await session('src/main.ts').ensure()
        const pos = MAIN.indexOf('double(2)') + 1
        expect(codeIntel.definitionElsewhere(tabOf('src/main.ts'), 'typescript', MAIN, pos)).toEqual({ path: at('src/util.ts'), line: 1, col: 17 })
        link.release()
    })

    it('has none for a name defined in the file itself', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        await session('src/main.ts').ensure()
        const pos = MAIN.indexOf('out') + 1
        expect(codeIntel.definitionElsewhere(tabOf('src/main.ts'), 'typescript', MAIN, pos)).toBeNull()
        link.release()
    })

    it('a package leads to its declarations on disk', async () => {
        put('node_modules/typed/package.json', '{ "name": "typed", "types": "index.d.ts" }')
        put('node_modules/typed/index.d.ts', 'export declare function typed(n: number): string\n')
        const text = 'import { typed } from "typed"\nexport const t = typed(1)\n'
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', text)
        await session('src/main.ts').ensure()
        const to = codeIntel.definitionElsewhere(tabOf('src/main.ts'), 'typescript', text, text.indexOf('typed(1)') + 1)
        expect(to?.path).toBe(at('node_modules/typed/index.d.ts'))
        link.release()
    })

    it('a stylesheet import leads to the file itself', async () => {
        put('src/style.css', 'a {}\n')
        const text = 'import css from "./style.css"\nexport const c = css\n'
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', text)
        await session('src/main.ts').ensure()
        expect(codeIntel.definitionElsewhere(tabOf('src/main.ts'), 'typescript', text, text.indexOf('style.css'))).toEqual({ path: at('src/style.css'), line: 1, col: 1 })
        link.release()
    })
})

describe('codeIntel: the link under ⌘', () => {
    const text = 'import { double } from "./util"\nimport nothing from "./missing"\nexport const out = double(2) + nothing\n'
    const span = (needle: string, offset = 1, source = text) => codeIntel.definitionSpan(tabOf('src/main.ts'), 'typescript', source, source.indexOf(needle) + offset)

    it('is the name, or the path without its quotes', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', text)
        await session('src/main.ts').ensure()
        const sliced = (r: { from: number, to: number } | null) => r && text.slice(r.from, r.to)
        expect(sliced(span('double(2)'))).toBe('double')
        expect(sliced(span('./util', 2))).toBe('./util')
        link.release()
    })

    it('is also a name defined in the same file', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', text)
        await session('src/main.ts').ensure()
        expect(span('out', 1)).toBeNull() // the declaration itself has nowhere further to go
        const source = 'const a = 1\nexport const b = a + 1\n'
        const r = span('a + 1', 0, source)
        expect(r && source.slice(r.from, r.to)).toBe('a')
        link.release()
    })

    it('is none for a module that does not exist, or for plain syntax', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', text)
        await session('src/main.ts').ensure()
        expect(span('./missing', 2)).toBeNull()
        expect(span('import', 1)).toBeNull()
        link.release()
    })
})
