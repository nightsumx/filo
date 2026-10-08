import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitCommit, gitDiscard, gitFileBytes, gitStatus, MAX_PREVIEW_BYTES, parseNumstat, parsePorcelain } from './git'

describe('parsePorcelain', () => {
    it('parses modified, untracked and renamed entries', () => {
        const out = [' M src/a.ts', '?? new file.txt', 'R  b-new.ts', 'b-old.ts', ''].join('\0')
        expect(parsePorcelain(out)).toEqual([
            { path: 'src/a.ts', status: ' M' },
            { path: 'new file.txt', status: '??' },
            { path: 'b-new.ts', status: 'R ', origPath: 'b-old.ts' },
        ])
    })
})

describe('parseNumstat', () => {
    it('reads counts, binary files and renames', () => {
        const out = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0')
        const stats = parseNumstat(out)
        expect(stats.get('src/a.ts')).toEqual({ additions: 3, deletions: 1, binary: false })
        expect(stats.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true })
        expect(stats.get('new.ts')).toEqual({ additions: 2, deletions: 0, binary: false })
    })
})

describe('gitDiscard / gitCommit', () => {
    let repo: string
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: repo }).toString()
    beforeEach(async () => {
        repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-git-')))
        run('init', '-q')
        await writeFile(path.join(repo, 'a.ts'), 'a\n')
        await writeFile(path.join(repo, 'b.ts'), 'b\n')
        await writeFile(path.join(repo, 'old.ts'), 'o\n')
        run('add', '-A')
        run('commit', '-qm', 'init')
    })
    afterEach(() => rm(repo, { recursive: true, force: true }))

    const status = async () => (await gitStatus(repo) as Extract<Awaited<ReturnType<typeof gitStatus>>, { isRepo: true }>).files

    it('rolls tracked files back to HEAD and trashes files HEAD does not have', async () => {
        await writeFile(path.join(repo, 'a.ts'), 'changed\n')
        await rm(path.join(repo, 'b.ts'))
        await writeFile(path.join(repo, 'new.ts'), 'n\n')
        await writeFile(path.join(repo, 'staged.ts'), 's\n')
        run('add', 'staged.ts')
        run('mv', 'old.ts', 'renamed.ts')
        const trashed: string[] = []
        await gitDiscard(repo, await status(), async (file) => {
            trashed.push(path.relative(repo, file))
            await rm(file)
        })
        expect(await status()).toEqual([])
        expect(await readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('a\n')
        expect(await readFile(path.join(repo, 'old.ts'), 'utf8')).toBe('o\n')
        expect(trashed.sort()).toEqual(['new.ts', 'renamed.ts', 'staged.ts'])
    })

    it('refuses paths outside the repository', async () => {
        await expect(gitDiscard(repo, [{ path: '../x', status: ' M' }], async () => {})).rejects.toThrow()
        await expect(gitCommit(repo, 'm', ['../x'])).rejects.toThrow()
    })

    it('commits only the chosen files, new ones included, and leaves the rest', async () => {
        await writeFile(path.join(repo, 'a.ts'), 'a2\n')
        await writeFile(path.join(repo, 'b.ts'), 'b2\n')
        await writeFile(path.join(repo, 'new.ts'), 'n\n')
        const hash = await gitCommit(repo, '  -leading dash is fine\n\nbody  ', ['a.ts', 'new.ts'])
        expect(run('rev-parse', '--short', 'HEAD').trim()).toBe(hash)
        expect(run('log', '-1', '--format=%B').trim()).toBe('-leading dash is fine\n\nbody')
        expect(run('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.ts', 'new.ts'])
        expect((await status()).map(f => f.path)).toEqual(['b.ts'])
    })

    it('reports a failing hook with its output', async () => {
        await writeFile(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\necho "lint failed: a.ts"\nexit 1\n', { mode: 0o755 })
        await writeFile(path.join(repo, 'a.ts'), 'a2\n')
        await expect(gitCommit(repo, 'm', ['a.ts'])).rejects.toThrow('lint failed: a.ts')
    })
})

describe('gitFileBytes', () => {
    let repo: string
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: repo }).toString()
    // A PNG signature plus NUL bytes: binary, so a utf8 round trip would corrupt it.
    const png = (n: number) => Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, n, 0xFF])
    beforeEach(async () => {
        repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-git-')))
        run('init', '-q')
        await writeFile(path.join(repo, 'a.png'), png(1))
        await writeFile(path.join(repo, 'gone.png'), png(2))
        await writeFile(path.join(repo, 'old.png'), png(3))
        await writeFile(path.join(repo, 'empty.png'), '')
        run('add', '-A')
        run('commit', '-qm', 'init')
    })
    afterEach(() => rm(repo, { recursive: true, force: true }))

    it('returns HEAD and working-copy bytes unchanged', async () => {
        await writeFile(path.join(repo, 'a.png'), png(9))
        const bytes = await gitFileBytes(repo, 'a.png', ' M')
        expect(Buffer.from(bytes.old!)).toEqual(png(1))
        expect(Buffer.from(bytes.new!)).toEqual(png(9))
        expect(bytes).toMatchObject({ oldSize: 11, newSize: 11, tooLarge: false })
    })

    it('has no old side for new files, no new side for deleted ones, and follows renames', async () => {
        await writeFile(path.join(repo, 'new.png'), png(4))
        await rm(path.join(repo, 'gone.png'))
        run('mv', 'old.png', 'moved.png')
        expect(await gitFileBytes(repo, 'new.png', '??')).toMatchObject({ old: null, newSize: 11 })
        const gone = await gitFileBytes(repo, 'gone.png', ' D')
        expect(gone.new).toBeNull()
        expect(Buffer.from(gone.old!)).toEqual(png(2))
        const moved = await gitFileBytes(repo, 'moved.png', 'R ', 'old.png')
        expect(Buffer.from(moved.old!)).toEqual(png(3))
        expect(Buffer.from(moved.new!)).toEqual(png(3))
    })

    it('keeps an empty committed file distinct from a missing one', async () => {
        await writeFile(path.join(repo, 'empty.png'), png(5))
        const bytes = await gitFileBytes(repo, 'empty.png', ' M')
        expect(bytes.old).not.toBeNull()
        expect(bytes.old!.length).toBe(0)
    })

    it('skips files over the preview cap without reading them', async () => {
        await writeFile(path.join(repo, 'big.bin'), Buffer.alloc(MAX_PREVIEW_BYTES + 1))
        expect(await gitFileBytes(repo, 'big.bin', '??')).toMatchObject({ new: null, newSize: MAX_PREVIEW_BYTES + 1, tooLarge: true })
    })

    it('refuses paths outside the repository', async () => {
        await expect(gitFileBytes(repo, '../etc/passwd', '??')).rejects.toThrow()
        await expect(gitFileBytes(repo, 'a.png', ' M', '../x')).rejects.toThrow()
    })
})
