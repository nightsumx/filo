// The editor's TypeScript project against `tsc`: for this repo's own two projects, the errors the editor's
// service reports in full mode must be the ones `tsc` reports (same file, same code, same position).
// A difference is a false alarm (the editor says there is an error tsc does not) or a miss.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { clearTSServiceCache, getTSService, setTsCompilerOptions, setTsFiles, setTsLibLoader } from 'lite-monaco'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { checkOptions, loadConfig, Project, slashed } from '../src/lib/tsProject'
import { nodeProjectFs } from './projectFs'

const root = slashed(process.cwd())

beforeAll(() => {
    const libs = join(root, 'node_modules/typescript/lib')
    setTsLibLoader(async () => new Map(readdirSync(libs).filter(f => /^lib\..*\.d\.ts$/.test(f)).map(f => [f, readFileSync(join(libs, f), 'utf8')] as const)))
})

/** What tsc reports for the project: "file:code:start" for every error. */
function tscErrors(configPath: string, base = root): { errors: Set<string>, files: string[] } {
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, base, undefined, configPath)
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } })
    const errors = new Set<string>()
    for (const file of parsed.fileNames.map(slashed)) {
        const source = program.getSourceFile(file)
        if (!source)
            continue
        for (const d of [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)])
            errors.add(`${file.slice(base.length + 1)}:${d.code}:${d.start}`)
    }
    return { errors, files: parsed.fileNames.map(slashed) }
}

/** What the editor's service reports for the same files, handed the project the way the full level does. */
async function editorErrors(configPath: string, files: string[], base = root): Promise<Set<string>> {
    clearTSServiceCache()
    const first = files[0]
    const config = await loadConfig(ts, nodeProjectFs, first, base)
    expect(config.path).toBe(configPath)
    const project = new Project(ts, nodeProjectFs, config, { files: 5000, bytes: 200 * 1024 * 1024 })
    await project.add([{ path: first, text: readFileSync(first, 'utf8') }])
    await project.loadAmbient()
    await project.loadDeclarations()
    await project.loadAll()
    // The same options codeIntel hands the service.
    setTsCompilerOptions({ strict: false, ...checkOptions(config.options) } as never, { lang: 'typescript' })
    setTsFiles(project.output(), { lang: 'typescript' })
    const session = getTSService({ lang: 'typescript', fileName: first })
    const service = await session.ensure()
    const category = ts.DiagnosticCategory.Error
    const errors = new Set<string>()
    for (const file of files) {
        if (!project.files.has(file))
            continue
        for (const d of [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)]) {
            if (d.category === category)
                errors.add(`${file.slice(base.length + 1)}:${d.code}:${d.start}`)
        }
    }
    return errors
}

describe('editor diagnostics against tsc', () => {
    for (const name of ['tsconfig.app.json', 'tsconfig.node.json']) {
        it(`${name}: the same errors`, async () => {
            const configPath = join(root, name)
            const expected = tscErrors(configPath)
            // The repo type-checks clean, so a file with an error here is a false alarm of the editor; keep the
            // comparison anyway so that a project with real errors is compared the same way.
            const got = await editorErrors(configPath, expected.files)
            const extra = [...got].filter(e => !expected.errors.has(e))
            const missing = [...expected.errors].filter(e => !got.has(e))
            expect({ extra: extra.slice(0, 20), missing: missing.slice(0, 20) }).toEqual({ extra: [], missing: [] })
        }, 300_000)
    }

    it('a project with errors in it: the same ones', async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ts-conform-')))
        const put = (rel: string, text: string) => {
            mkdirSync(dirname(join(dir, rel)), { recursive: true })
            writeFileSync(join(dir, rel), text)
        }
        try {
            put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', target: 'es2022', lib: ['es2022', 'dom'], skipLibCheck: true, baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }))
            put('node_modules/@types/react/index.d.ts', 'export {}\n')
            put('node_modules/@types/react/jsx-runtime.d.ts', 'export namespace JSX { interface Element {}\n interface IntrinsicElements { [tag: string]: any } }\nexport function jsx(): any\nexport function jsxs(): any\nexport const Fragment: any\n')
            put('node_modules/typed/package.json', '{ "name": "typed", "types": "index.d.ts" }')
            put('node_modules/typed/index.d.ts', 'export declare function typed(n: number): string\nexport default typed\n')
            put('src/lib.ts', 'export function add(a: number, b: number): number {\n    return a + b\n}\nexport const label: string = 1\n')
            put('src/a.ts', 'import typed, { typed as named } from "typed"\nimport { add, nope } from "@/lib"\nimport missing from "./missing"\nconst unused = 1\nexport const r: string = add(1)\nexport const s: number = named(2) + typed("x")\n')
            put('src/b.tsx', 'import { add } from "./lib"\nexport const B = (p: { n: number }) => <div>{add(p.n, "2")}</div>\nexport const C = <B n="x" />\n')
            put('src/c.ts', 'export const x = (\n')
            const { errors, files } = tscErrors(join(dir, 'tsconfig.json'), dir)
            expect(errors.size).toBeGreaterThan(8)
            const got = await editorErrors(join(dir, 'tsconfig.json'), files, dir)
            expect({ extra: [...got].filter(e => !errors.has(e)), missing: [...errors].filter(e => !got.has(e)) }).toEqual({ extra: [], missing: [] })
        }
        finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }, 60_000)
})
