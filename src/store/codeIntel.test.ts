import type { FileTab } from './fileTab'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getTSService, setTsLibLoader } from 'lite-monaco'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeProjectFs } from '../../test/projectFs'
import { appStore } from './app'
import { codeIntel } from './codeIntel'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const root = realpathSync(mkdtempSync(join(tmpdir(), 'code-intel-')))
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
    codeIntel.problems.clear()
    const { clearTSServiceCache } = await import('lite-monaco')
    clearTSServiceCache()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const session = (rel: string) => getTSService({ lang: 'typescript', fileName: at(rel) })
const entriesOf = () => (codeIntel as unknown as { entries: Map<string, { level: string }> }).entries

describe('codeIntel: attaching', () => {
    it('hands the service the files the open one imports', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        const s = session('src/main.ts')
        s.update(MAIN)
        const service = await s.ensure()
        expect(service.getSemanticDiagnostics(at('src/main.ts'))).toEqual([])
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
        expect(service.getSemanticDiagnostics(at('src/main.ts')).map(d => d.code)).toEqual([2322])
        // not written back: it came from the disk
        await wait(900)
        expect(written).toEqual([])
        link.release()
    })

    it('ignores files the project has not read', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', MAIN)
        codeIntel.dirsChanged([{ dir: at('src'), names: ['other.ts'], listed: true }])
        await wait(500)
        expect(session('src/main.ts').getFileText(at('src/other.ts'))).toBeNull()
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
})
