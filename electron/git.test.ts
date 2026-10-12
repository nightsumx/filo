import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { platform } from './platform'
import { applyWorktree, createWorktree, gitCommit, gitDiscard, gitFileBytes, gitFileEntries, gitFileThumbs, gitStatus, MAX_PREVIEW_BYTES, parseNumstat, parsePorcelain, removeWorktree, threadTask, worktreeParent } from './git'

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
        // Git for Windows turns LF into CRLF on checkout by default; these tests compare bytes.
        run('config', 'core.autocrlf', 'false')
        // gitCommit runs plain git: the repository needs an author where git has none (CI).
        run('config', 'user.email', 'a@b')
        run('config', 'user.name', 't')
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
        await expect(gitFileThumbs(repo, '../x.docx', '??')).rejects.toThrow()
        await expect(gitFileEntries(repo, 'a.zip', ' M', '../x.zip')).rejects.toThrow()
    })

    it('lists both sides of an archive, the committed one from a temp copy', async () => {
        await writeFile(path.join(repo, 'one.txt'), '1')
        await writeFile(path.join(repo, 'two.txt'), '2')
        run('add', '-A')
        run('commit', '-qm', 'files')
        // Windows has no zip; its tar writes one.
        const zip = (...files: string[]) => platform.id === 'win32'
            ? execFileSync('tar', ['-a', '-cf', 'pack.zip', ...files], { cwd: repo })
            : execFileSync('zip', ['-q', 'pack.zip', ...files], { cwd: repo })
        zip('one.txt')
        run('add', 'pack.zip')
        run('commit', '-qm', 'zip')
        await rm(path.join(repo, 'pack.zip'))
        zip('one.txt', 'two.txt')
        expect(await gitFileEntries(repo, 'pack.zip', ' M')).toEqual({ old: ['one.txt'], new: ['one.txt', 'two.txt'], oldCount: 1, newCount: 2 })
        await writeFile(path.join(repo, 'broken.zip'), 'not an archive')
        await expect(gitFileEntries(repo, 'broken.zip', '??')).rejects.toThrow(/archive/)
    })

    it.runIf(!!platform.thumbnail)('makes QuickLook thumbnails of both sides', { timeout: 30_000 }, async () => {
        // An RTF document: QuickLook renders it, the browser cannot.
        const rtf = (word: string) => `{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0\\fs48 ${word}}`
        await writeFile(path.join(repo, 'doc.rtf'), rtf('before'))
        run('add', 'doc.rtf')
        run('commit', '-qm', 'doc')
        await writeFile(path.join(repo, 'doc.rtf'), rtf('after'))
        const thumbs = await gitFileThumbs(repo, 'doc.rtf', ' M')
        const isPng = (b: Uint8Array | null) => !!b && Buffer.from(b.subarray(0, 4)).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
        expect(isPng(thumbs.old) && isPng(thumbs.new)).toBe(true)
        expect(Buffer.from(thumbs.old!).equals(Buffer.from(thumbs.new!))).toBe(false)
    })
})

describe('worktrees', () => {
    let repo: string
    let dir: string
    const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd }).toString()
    beforeEach(async () => {
        repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-git-')))
        dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-wt-')))
        run(repo, 'init', '-q')
        run(repo, 'config', 'core.autocrlf', 'false')
        await writeFile(path.join(repo, 'a.ts'), 'a\n')
        await writeFile(path.join(repo, 'b.ts'), 'one\ntwo\nthree\n')
        run(repo, 'add', '-A')
        run(repo, 'commit', '-qm', 'init')
    })
    afterEach(async () => {
        await rm(repo, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    })
    const read = (file: string) => readFile(file, 'utf8')

    it('adds copies outside the repository and knows their main checkout', async () => {
        const one = await createWorktree(repo, dir)
        const two = await createWorktree(repo, dir)
        expect(path.dirname(one)).toBe(dir)
        expect(path.basename(one).startsWith(`${path.basename(repo)}-`)).toBe(true)
        expect(two).not.toBe(one)
        expect(await worktreeParent(one)).toBe(repo)
        expect(await worktreeParent(repo)).toBeNull()
        expect(await worktreeParent(dir)).toBeNull()
    })

    it('applies commits, edits and new files as uncommitted changes, around the main checkout\'s own', async () => {
        const wt = await createWorktree(repo, dir)
        await writeFile(path.join(wt, 'a.ts'), 'committed\n')
        run(wt, 'commit', '-qam', 'in the copy')
        await writeFile(path.join(wt, 'b.ts'), 'one\ntwo\nTHREE\n')
        await writeFile(path.join(wt, 'new.ts'), 'n\n')
        await writeFile(path.join(wt, 'img.bin'), Buffer.from([0, 1, 2, 255]))
        // The main checkout moved on and edited an untouched line meanwhile.
        await writeFile(path.join(repo, 'c.ts'), 'c\n')
        run(repo, 'add', 'c.ts')
        run(repo, 'commit', '-qm', 'main')
        await writeFile(path.join(repo, 'b.ts'), 'ONE\ntwo\nthree\n')
        expect(await applyWorktree(wt)).toEqual({ files: 4, conflicts: [] })
        expect(await read(path.join(repo, 'a.ts'))).toBe('committed\n')
        expect(await read(path.join(repo, 'b.ts'))).toBe('ONE\ntwo\nTHREE\n')
        expect(await read(path.join(repo, 'new.ts'))).toBe('n\n')
        expect([...await readFile(path.join(repo, 'img.bin'))]).toEqual([0, 1, 2, 255])
        expect(run(repo, 'log', '--format=%s')).toBe('main\ninit\n')
        // Unstaged: the main checkout's index is untouched.
        expect(run(repo, 'diff', '--cached', '--name-only')).toBe('')
        // The copy's own index is untouched.
        expect(run(wt, 'status', '--porcelain')).toContain('?? new.ts')
    })

    it('leaves conflict markers when both sides changed the same lines', async () => {
        const wt = await createWorktree(repo, dir)
        await writeFile(path.join(wt, 'b.ts'), 'one\nTWO\nthree\n')
        await writeFile(path.join(repo, 'b.ts'), 'one\n2\nthree\n')
        run(repo, 'commit', '-qam', 'main')
        expect(await applyWorktree(wt)).toEqual({ files: 1, conflicts: ['b.ts'] })
        expect(await read(path.join(repo, 'b.ts'))).toContain('<<<<<<<')
    })

    it('sees an edit of the same size made in the second the copy\'s index was written', async () => {
        const wt = await createWorktree(repo, dir)
        await writeFile(path.join(wt, 'b.ts'), 'one\nTWO\nthree\n')
        await new Promise(r => setTimeout(r, 1100))
        expect(await applyWorktree(wt)).toEqual({ files: 1, conflicts: [] })
    })

    it('has nothing to apply from an untouched copy, and removes it with its changes', async () => {
        const wt = await createWorktree(repo, dir)
        expect(await applyWorktree(wt)).toEqual({ files: 0, conflicts: [] })
        await writeFile(path.join(wt, 'a.ts'), 'lost\n')
        await removeWorktree(wt)
        expect(run(repo, 'worktree', 'list')).not.toContain(wt)
        await expect(readFile(path.join(wt, 'a.ts'))).rejects.toThrow()
    })
})

describe('threadTask', () => {
    let repo: string
    beforeEach(async () => {
        repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-git-')))
        const run = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: repo })
        run('init', '-q')
        await writeFile(path.join(repo, 'a.ts'), 'a\n')
        await writeFile(path.join(repo, 'b.ts'), 'b\n')
        run('add', '-A')
        run('commit', '-qm', 'init')
    })
    afterEach(() => rm(repo, { recursive: true, force: true }))

    const messages = [
        { role: 'user', content: 'Fix a.ts' },
        { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }, { type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'a.ts', oldText: 'a', newText: 'changed' } }] },
        { role: 'toolResult', toolCallId: 'c1', toolName: 'edit', content: [], isError: false },
        { role: 'assistant', content: [{ type: 'text', text: 'Done: a.ts is fixed.' }] },
    ]

    it('tells another agent what pi\'s reviewer is told, with the thread\'s files to diff and a reply as the report', async () => {
        await writeFile(path.join(repo, 'a.ts'), 'changed\n')
        await writeFile(path.join(repo, 'b.ts'), 'not this thread\n')
        const task = await threadTask(repo, messages, 'review', 'Codex')
        expect(task).toContain('> Fix a.ts')
        expect(task).toContain('> Done: a.ts is fixed.')
        expect(task).toContain('Run git diff on these (new files: read them):\n- a.ts')
        expect(task).not.toContain('b.ts')
        expect(task).not.toContain('```diff')
        expect(task).not.toContain('submit_review')
        expect(task).toContain('Finish with the report as your reply')
    })

    it('hands the task over with the same facts and the files to check', async () => {
        await writeFile(path.join(repo, 'a.ts'), 'changed\n')
        const task = await threadTask(repo, messages, 'handoff', 'Claude Code')
        expect(task).toContain('another agent (Claude Code)')
        expect(task).toContain('> Fix a.ts')
        expect(task).toContain('Run git diff on these (new files: read them):\n- a.ts')
        expect(task).toContain('finish what is left')
    })
})
