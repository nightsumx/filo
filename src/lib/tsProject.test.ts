import type { FileRead } from '@shared/ipc'
import type { ProjectFs } from './tsProject'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { clearTSServiceCache, getTSService, setTsCompilerOptions, setTsFiles, setTsLibLoader } from 'lite-monaco'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkOptions, loadConfig, namedImports, Project } from './tsProject'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ts-project-')))
const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
}

const fs: ProjectFs = {
    read: async (path): Promise<FileRead> => {
        try {
            if (statSync(path).isDirectory())
                return { kind: 'missing' }
            const text = readFileSync(path, 'utf8')
            return { kind: 'text', text, bom: false, size: text.length }
        }
        catch {
            return { kind: 'missing' }
        }
    },
    realPath: async path => realpathSync(path),
    sources: async (dir) => {
        const out: string[] = []
        const walk = (d: string) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                if (e.name === 'node_modules')
                    continue
                if (e.isDirectory())
                    walk(join(d, e.name))
                else if (/\.[cm]?[jt]sx?$/.test(e.name))
                    out.push(join(d, e.name))
            }
        }
        walk(dir)
        return out
    },
    folders: async (dir) => {
        try {
            return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        }
        catch {
            return []
        }
    },
}

beforeAll(() => {
    put('tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }')
    put('tsconfig.app.json', '// c\n{ "compilerOptions": { "jsx": "react-jsx", "module": "esnext", "moduleResolution": "bundler", "strict": true, "baseUrl": ".", "paths": { "@/*": ["./src/*"] },}, "include": ["src"] }')
    put('tsconfig.node.json', '{ "compilerOptions": { "strict": false, "types": ["node"] }, "include": ["electron"] }')
    put('src/core/keyos.ts', 'export type KeyOS = "mac" | "win"\nexport function keyOS(): KeyOS { return "mac" }\n')
    put('src/core/chrome/codicon-font.ts', 'export const CODICON_FONT_FACE = "x"\nexport const CODICON_ICON_CSS = 1\n')
    put('src/lib/util.ts', 'import { keyOS } from "../core/keyos"\nexport const os = keyOS()\nexport default function d(): number { return 1 }\n')
    put('src/ui/Box.tsx', 'export function Box(p: { n: number }) { return <div>{p.n}</div> }\n')
    put('src/style.css', '.a{}')
    put('src/env.d.ts', 'declare const __APP_VERSION__: string\ninterface ImportMeta { env: Record<string, string> }\n')
    put('src/data.json', '{ "a": 1 }')
    put('electron/main.ts', 'import { sep } from "node:path"\nexport const s: string = sep + process.arch\n')
    put('node_modules/typed/package.json', '{ "name": "typed", "exports": { ".": { "types": "./dist/index.d.ts" }, "./sub": { "types": "./dist/sub.d.ts" } } }')
    put('node_modules/typed/dist/index.d.ts', 'export * from "./more"\nexport declare function typed(n: number): string\n')
    put('node_modules/typed/dist/more.d.ts', 'export declare const more: number\n')
    put('node_modules/typed/dist/sub.d.ts', 'export declare const sub: "sub"\n')
    put('node_modules/@types/eq/package.json', '{ "name": "@types/eq" }')
    put('node_modules/@types/eq/index.d.ts', 'declare function eq(): number\ndeclare namespace eq { const x: string }\nexport = eq\n')
    put('node_modules/@types/node/package.json', '{ "name": "@types/node" }')
    put('node_modules/@types/node/index.d.ts', '/// <reference path="path.d.ts" />\ndeclare const process: { arch: string }\n')
    put('node_modules/@types/node/path.d.ts', 'declare module "node:path" { export const sep: string }\n')
    put('node_modules/@types/react/package.json', '{ "name": "@types/react" }')
    put('node_modules/@types/react/index.d.ts', 'export {}\n')
    put('node_modules/@types/react/jsx-runtime.d.ts', 'export namespace JSX { interface Element {}\n interface IntrinsicElements { [tag: string]: any } }\nexport function jsx(): any\nexport function jsxs(): any\nexport const Fragment: any\n')
    put('node_modules/untyped/package.json', '{ "name": "untyped", "main": "index.js" }')
    put('node_modules/untyped/index.js', 'module.exports = {}')
    // A package manager that keeps packages outside node_modules and links them in: its dependency lives next to the real folder.
    put('node_modules/.store/linked@1/node_modules/linked/package.json', '{ "name": "linked", "types": "index.d.ts" }')
    put('node_modules/.store/linked@1/node_modules/linked/index.d.ts', 'import { dep } from "dep"\nexport declare const linked: typeof dep\n')
    put('node_modules/.store/linked@1/node_modules/dep/package.json', '{ "name": "dep", "types": "index.d.ts" }')
    put('node_modules/.store/linked@1/node_modules/dep/index.d.ts', 'export declare const dep: 42\n')
    symlinkSync(join(root, 'node_modules/.store/linked@1/node_modules/linked'), join(root, 'node_modules/linked'))
    const libs = join(process.cwd(), 'node_modules/typescript/lib')
    setTsLibLoader(async () => new Map(readdirSync(libs).filter(f => /^lib\..*\.d\.ts$/.test(f)).map(f => [f, readFileSync(join(libs, f), 'utf8')] as const)))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** What the editor shows for a file: the project around it handed to lite-monaco's service. */
async function diagnose(rel: string, text: string, mode: 'standard' | 'full' = 'standard'): Promise<string[]> {
    clearTSServiceCache()
    const path = join(root, rel)
    const config = await loadConfig(ts, fs, path, root)
    const project = new Project(ts, fs, config)
    await project.add([{ path, text }])
    await project.loadAmbient()
    await project.loadDeclarations()
    if (mode === 'full')
        await project.loadAll()
    setTsCompilerOptions({ strict: false, ...checkOptions(config.options) }, { lang: 'typescript' })
    setTsFiles(project.output())
    const session = getTSService({ lang: rel.endsWith('x') ? 'tsx' : 'typescript', fileName: path })
    session.update(text)
    const service = await session.ensure()
    const compiler = session.ts()!
    return [...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path)].map(d => `${d.code}: ${compiler.flattenDiagnosticMessageText(d.messageText, ' ')}`)
}

describe('namedImports', () => {
    it('lists names without type modifiers and aliases', () => {
        expect(namedImports('import d, { a, type B, c as e } from "x"\nexport { f } from "y"')).toEqual(new Map([['x', ['a', 'B', 'c']], ['y', ['f']]]))
    })
})

describe('loadConfig', () => {
    it('picks the referenced config that lists the file', async () => {
        const app = await loadConfig(ts, fs, join(root, 'src/lib/util.ts'), root)
        expect(app.path).toBe(join(root, 'tsconfig.app.json'))
        expect(app.options.strict).toBe(true)
        expect(app.options.jsx).toBe(ts.JsxEmit.ReactJSX)
        const node = await loadConfig(ts, fs, join(root, 'electron/main.ts'), root)
        expect(node.path).toBe(join(root, 'tsconfig.node.json'))
        expect(node.options.strict).toBe(false)
    })
    it('falls back without a tsconfig', async () => {
        const config = await loadConfig(ts, fs, '/nonexistent-dir/a.ts', '/nonexistent-dir')
        expect(config.path).toBeNull()
        expect(config.covers('/anything.ts')).toBe(true)
    })
    it('keeps only options that change the errors shown', async () => {
        const app = await loadConfig(ts, fs, join(root, 'src/lib/util.ts'), root)
        const kept = checkOptions(app.options)
        expect(kept.paths).toBeUndefined()
        expect(kept.baseUrl).toBeUndefined()
        expect(kept.strict).toBe(true)
    })
})

describe('Project', () => {
    it('resolves relative imports', async () => {
        expect(await diagnose('src/lib/a.ts', 'import { keyOS, type KeyOS } from "../core/keyos"\nimport { CODICON_ICON_CSS } from "../core/chrome/codicon-font"\nconst k: KeyOS = keyOS()\nconst n: number = CODICON_ICON_CSS\nexport { k, n }\n')).toEqual([])
    })
    it('still reports a wrong use of what it resolved', async () => {
        const errors = await diagnose('src/lib/a.ts', 'import { keyOS } from "../core/keyos"\nconst k: number = keyOS()\nexport { k }\n')
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain('2322')
    })
    it('reports a relative import that does not exist', async () => {
        expect((await diagnose('src/lib/a.ts', 'import { x } from "../core/nope"\nexport { x }\n'))[0]).toContain('2307')
    })
    it('follows tsconfig paths, default exports and tsx', async () => {
        expect(await diagnose('src/ui/b.tsx', 'import d, { os } from "@/lib/util"\nimport { Box } from "@/ui/Box"\nexport const x = <Box n={d()} />\nexport { os }\n')).toEqual([])
    })
    it('resolves packages by their exports map, @types and untyped ones', async () => {
        expect(await diagnose('src/lib/a.ts', 'import { typed, more } from "typed"\nimport { sub } from "typed/sub"\nimport eq from "eq"\nimport u from "untyped"\nexport const s: string = typed(more) + eq() + eq.x + String(u) + sub\n')).toEqual([])
    })
    it('finds the dependencies of a linked package next to its real folder', async () => {
        expect(await diagnose('src/lib/a.ts', 'import { linked } from "linked"\nexport const n: 42 = linked\n')).toEqual([])
    })
    it('leaves a package that is not installed reported', async () => {
        expect((await diagnose('src/lib/a.ts', 'import x from "not-installed"\nexport { x }\n'))[0]).toContain('2307')
    })
    it('accepts assets and json', async () => {
        expect(await diagnose('src/lib/a.ts', 'import css, { cls } from "../style.css"\nimport url from "../style.css?raw"\nimport data from "../data.json"\nexport { css, cls, url, data }\n')).toEqual([])
    })
    it('brings the project\'s global declarations', async () => {
        expect(await diagnose('src/lib/a.ts', 'export const v: string = __APP_VERSION__ + import.meta.env.MODE\n')).toEqual([])
    })
    it('brings @types globals, with the tsconfig `types` deciding which', async () => {
        expect(await diagnose('electron/main.ts', 'import { sep } from "node:path"\nexport const s: string = sep + process.arch\n')).toEqual([])
        // The app config lists no `types`, so every @types package is in; node's `process` is found there too.
        expect(await diagnose('src/lib/a.ts', 'export const p: string = process.arch\n')).toEqual([])
    })
    it('reads sibling files only in full mode', async () => {
        const read = async (mode: 'standard' | 'full') => {
            const path = join(root, 'src/lib/a.ts')
            const project = new Project(ts, fs, await loadConfig(ts, fs, path, root))
            await project.add([{ path, text: 'export {}\n' }])
            if (mode === 'full')
                await project.loadAll()
            return project.own().map(f => f.slice(root.length + 1)).sort()
        }
        expect(await read('standard')).toEqual(['src/lib/a.ts'])
        expect(await read('full')).toEqual(['src/core/chrome/codicon-font.ts', 'src/core/keyos.ts', 'src/env.d.ts', 'src/lib/a.ts', 'src/lib/util.ts', 'src/ui/Box.tsx'])
    })
    it('knows who imports a file', async () => {
        const path = join(root, 'src/lib/util.ts')
        const project = new Project(ts, fs, await loadConfig(ts, fs, path, root))
        await project.loadAll()
        expect(project.importers(join(root, 'src/core/keyos.ts'))).toEqual([path])
    })
    it('takes a changed file and its new imports', async () => {
        const path = join(root, 'src/lib/util.ts')
        const project = new Project(ts, fs, await loadConfig(ts, fs, path, root))
        await project.add([{ path, text: 'export {}\n' }])
        expect(project.files.size).toBe(1)
        expect(await project.refresh(path)).toBe(true)
        expect(project.files.has(join(root, 'src/core/keyos.ts'))).toBe(true)
        expect(await project.refresh(path)).toBe(false)
    })
    it('stops at the file limit', async () => {
        const path = join(root, 'src/lib/util.ts')
        const project = new Project(ts, fs, await loadConfig(ts, fs, path, root), { files: 1, bytes: 1e6 })
        await project.add([{ path, text: 'import "../core/keyos"\n' }])
        expect(project.files.size).toBe(1)
    })
})
