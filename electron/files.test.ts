import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeText, FolderWatch, listDir, readText, writeText } from './files'

let dir: string
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'filo-files-'))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('listDir', () => {
    it('lists folders first in natural order, hides .git, marks what git ignores', async () => {
        execFileSync('git', ['init', '-q'], { cwd: dir })
        await writeFile(path.join(dir, '.gitignore'), 'dist/\n*.log\n')
        await mkdir(path.join(dir, 'src'))
        await mkdir(path.join(dir, 'dist'))
        for (const name of ['a10.ts', 'a2.ts', 'B.ts', 'debug.log', '.DS_Store'])
            await writeFile(path.join(dir, name), '')
        await symlink(path.join(dir, 'src'), path.join(dir, 'link'))
        const { entries, more } = await listDir(dir)
        expect(more).toBe(0)
        expect(entries.map(e => e.name)).toEqual(['dist', 'link', 'src', '.gitignore', 'a2.ts', 'a10.ts', 'B.ts', 'debug.log'])
        expect(entries.filter(e => e.ignored).map(e => e.name)).toEqual(['dist', 'debug.log'])
        expect(entries.find(e => e.name === 'link')).toMatchObject({ dir: true, link: true })
    })

    it('ignores nothing outside a repository', async () => {
        await writeFile(path.join(dir, 'x.log'), '')
        expect((await listDir(dir)).entries).toEqual([{ name: 'x.log', dir: false, ignored: false }])
    })
})

describe('reading', () => {
    it('tells text from binary and keeps the byte order mark aside', () => {
        expect(decodeText(new TextEncoder().encode('héllo'))).toEqual({ text: 'héllo', bom: false })
        expect(decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]))).toEqual({ text: 'a', bom: true })
        expect(decodeText(new Uint8Array([0x61, 0, 0x62]))).toBeNull()
        // Latin-1 é: not UTF-8.
        expect(decodeText(new Uint8Array([0x63, 0xE9]))).toBeNull()
    })

    it('reports missing files and folders as missing', async () => {
        expect(await readText(path.join(dir, 'nope'))).toEqual({ kind: 'missing' })
        expect(await readText(dir)).toEqual({ kind: 'missing' })
    })
})

describe('writeText', () => {
    it('saves over the text it read, refuses when the disk changed meanwhile', async () => {
        const file = path.join(dir, 'a.ts')
        await writeFile(file, 'one')
        expect(await writeText(file, 'two', { expected: 'one', bom: false })).toEqual({ ok: true })
        expect(await readFile(file, 'utf8')).toBe('two')
        // An agent wrote "agent" since the editor read "two".
        await writeFile(file, 'agent')
        expect(await writeText(file, 'mine', { expected: 'two', bom: false })).toEqual({ ok: false, disk: { kind: 'text', text: 'agent', bom: false, size: 5 } })
        expect(await readFile(file, 'utf8')).toBe('agent')
        expect(await writeText(file, 'mine', { expected: null, bom: true })).toEqual({ ok: true })
        expect(await readFile(file, 'utf8')).toBe('\uFEFFmine')
    })
})

describe('FolderWatch', () => {
    it('reports changed entries per folder, including files replaced by a rename', async () => {
        const batches: { dir: string, names: string[], listed: boolean }[][] = []
        const watch = new FolderWatch(changes => batches.push(changes), 30)
        await writeFile(path.join(dir, 'a.txt'), '1')
        watch.set([dir])
        expect(watch.size).toBe(1)
        await new Promise(r => setTimeout(r, 100))
        batches.length = 0
        await writeFile(path.join(dir, 'tmp'), '2')
        await rename(path.join(dir, 'tmp'), path.join(dir, 'a.txt'))
        await expect.poll(() => batches.flat().filter(c => c.dir === dir).flatMap(c => c.names), { timeout: 3000 }).toContain('a.txt')
        expect(batches.flat().some(c => c.dir === dir && c.listed)).toBe(true)
        watch.set([])
        expect(watch.size).toBe(0)
        watch.close()
    })
})
