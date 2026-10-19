import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path/posix'
import { clearTSServiceCache, setTsLibLoader } from 'lite-monaco'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TsCheckClient } from './tsCheckClient'

beforeAll(() => {
    const libs = join(process.cwd(), 'node_modules/typescript/lib')
    setTsLibLoader(async () => new Map(readdirSync(libs).filter(f => /^lib\..*\.d\.ts$/.test(f)).map(f => [f, readFileSync(join(libs, f), 'utf8')] as const)))
})
afterEach(() => clearTSServiceCache())

const req = (fileName: string, text: string) => ({ fileName, text, mode: 'full' as const, wantTags: false, options: {} })

// Without a Worker (node) the client runs the checker in-process: the same code the worker runs.
describe('TsCheckClient', () => {
    it('sends only what changed', async () => {
        const client = new TsCheckClient(false)
        const seen: { set: string[], del: string[] }[] = []
        const api = (client as unknown as { api: { files: (...a: any[]) => void } }).api
        const files = api.files.bind(api)
        api.files = (family, set, del) => {
            seen.push({ set: Object.keys(set), del })
            files(family, set, del)
        }
        client.setFiles('typescript', { '/a.ts': 'export const a = 1', '/b.ts': 'export const b = 2' })
        client.setFiles('typescript', { '/a.ts': 'export const a = 1', '/b.ts': 'export const b = 3' })
        client.setFiles('typescript', { '/b.ts': 'export const b = 3' })
        client.setFiles('typescript', { '/b.ts': 'export const b = 3' })
        expect(seen).toEqual([{ set: ['/a.ts', '/b.ts'], del: [] }, { set: ['/b.ts'], del: [] }, { set: [], del: ['/a.ts'] }])
    })

    it('checks an open file against the files it was given', async () => {
        const client = new TsCheckClient(false)
        client.setFiles('typescript', { '/a.ts': 'export const a: number = 1\n' })
        const ok = await client.check('typescript', req('/main.ts', 'import { a } from "./a"\nexport const x: number = a\n'), {})
        expect(ok?.diagnostics).toEqual([])
        const bad = await client.check('typescript', req('/main.ts', 'import { a } from "./a"\nexport const x: string = a\n'), {})
        expect(bad?.diagnostics).toHaveLength(1)
        // the file changed: the next check sees it
        client.setFiles('typescript', { '/a.ts': 'export const a: string = ""\n' })
        const after = await client.check('typescript', req('/main.ts', 'import { a } from "./a"\nexport const x: string = a\n'), {})
        expect(after?.diagnostics).toEqual([])
    })

    it('counts the errors of files the project holds', async () => {
        const client = new TsCheckClient(false)
        client.setFiles('typescript', { '/ok.ts': 'export const a = 1\n', '/bad.ts': 'export const b: number = "x"\nexport const c: string = 1\n' })
        expect(await client.count('typescript', ['/ok.ts', '/bad.ts'], {})).toEqual({ '/bad.ts': 2 })
    })

    it('a file whose editor is gone is read from the files again', async () => {
        const client = new TsCheckClient(false)
        client.setFiles('typescript', { '/a.ts': 'export const a = 1\n' })
        await client.check('typescript', req('/a.ts', 'export const a: number = "typed in the editor"\n'), {})
        client.forget('typescript', '/a.ts')
        expect(await client.count('typescript', ['/a.ts'], {})).toEqual({})
    })

    it('each request is checked under the options it brings', async () => {
        const client = new TsCheckClient(false)
        const text = 'export function f(a) { return a }\n'
        expect((await client.check('typescript', req('/x.ts', text), { strict: false }))?.diagnostics).toEqual([])
        expect((await client.check('typescript', req('/x.ts', text), { strict: true }))?.diagnostics.length).toBeGreaterThan(0)
        // an option that is not asked for any more is the service's own again (strict by default)
        expect((await client.check('typescript', req('/x.ts', text), { skipLibCheck: true }))?.diagnostics.length).toBeGreaterThan(0)
    })
})
