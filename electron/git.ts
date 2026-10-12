import type { GitFileBytes, GitFileChange, GitFileDiff, GitFileEntries, GitFileThumbs, GitStatus } from '@shared/ipc'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { collectChanges } from 'pi-capabilities/lib/changes.ts'
import { branchFacts, handoffTask, reviewerTask } from 'pi-capabilities/lib/review.ts'
import { tr } from './i18n'
import { platform } from './platform'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024

// execFile with argument arrays: paths and refs never pass through a shell.
async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 20_000 })
    return stdout
}

/** Parse `git status --porcelain=v1 -z`. Renames carry the original path as an extra NUL field. */
export function parsePorcelain(output: string): { path: string, status: string, origPath?: string }[] {
    const fields = output.split('\0')
    const files: { path: string, status: string, origPath?: string }[] = []
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        if (field.length < 4)
            continue
        const status = field.slice(0, 2)
        if (status[0] === 'R' || status[0] === 'C')
            files.push({ path: field.slice(3), status, origPath: fields[++i] })
        else
            files.push({ path: field.slice(3), status })
    }
    return files
}

/** git's root path in this OS's form: git for Windows prints C:/x/y. */
const toplevel = async (cwd: string) => path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())

/** Repository root (as git reports it: symlinks resolved), or null outside a repo. */
export async function gitRoot(cwd: string): Promise<string | null> {
    return toplevel(cwd).then(s => s || null, () => null)
}

/** Uncommitted paths, relative to the root. */
export async function gitDirty(root: string): Promise<{ path: string, status: string, origPath?: string }[]> {
    return parsePorcelain(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
}

/** Commit time of HEAD in ms; 0 before the first commit. */
export async function gitHeadTime(root: string): Promise<number> {
    const out = await git(root, ['log', '-1', '--format=%ct']).catch(() => '')
    return Number(out.trim()) * 1000 || 0
}

/** Parse `git diff --numstat -z`; binary files report "-" counts. */
export function parseNumstat(output: string): Map<string, { additions: number, deletions: number, binary: boolean }> {
    const stats = new Map<string, { additions: number, deletions: number, binary: boolean }>()
    const fields = output.split('\0')
    for (let i = 0; i < fields.length; i++) {
        const match = fields[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s)
        if (!match)
            continue
        let file = match[3]
        // Renames: "<add>\t<del>\t" followed by two NUL-separated paths.
        if (!file) {
            file = fields[i + 2] ?? ''
            i += 2
        }
        stats.set(file, {
            additions: match[1] === '-' ? 0 : Number(match[1]),
            deletions: match[2] === '-' ? 0 : Number(match[2]),
            binary: match[1] === '-',
        })
    }
    return stats
}

function countLines(text: string): number {
    if (!text)
        return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
    let root: string
    try {
        root = await toplevel(cwd)
    }
    catch {
        return { isRepo: false }
    }
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim()
    const dirty = await gitDirty(root)
    const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
    const numstat = hasHead ? parseNumstat(await git(root, ['diff', 'HEAD', '--numstat', '-z'])) : new Map()

    const files: GitFileChange[] = await Promise.all(dirty.map(async ({ path: file, status, origPath }) => {
        const stats = numstat.get(file)
        if (stats)
            return { path: file, status, ...stats, ...(origPath && { origPath }) }
        // Untracked (or no HEAD yet): count lines of the working copy.
        let additions = 0
        let binary = false
        try {
            const buffer = await readFile(path.join(root, file))
            binary = buffer.subarray(0, 8000).includes(0)
            additions = binary || buffer.length > MAX_FILE_BYTES ? 0 : countLines(buffer.toString('utf8'))
        }
        catch {}
        return { path: file, status, additions, deletions: 0, binary, ...(origPath && { origPath }) }
    }))
    return { isRepo: true, root, branch, files }
}

/** Branch name, short commit for a detached HEAD, or null outside a repo / missing folder. */
export async function gitBranch(cwd: string): Promise<string | null> {
    try {
        const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        if (branch !== 'HEAD')
            return branch
        return (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
    }
    catch {
        // Fresh repo without commits still has a branch name.
        return git(cwd, ['symbolic-ref', '--short', 'HEAD']).then(s => s.trim() || null, () => null)
    }
}

export async function gitFileDiff(cwd: string, file: string, status: string): Promise<GitFileDiff> {
    const root = await toplevel(cwd)
    const absolute = path.resolve(root, file)
    if (!absolute.startsWith(root + path.sep))
        throw new Error(tr('路径不在仓库内', 'Path is outside the repository'))
    const untracked = status === '??' || status[0] === 'A'
    const oldText = untracked
        ? ''
        : await git(root, ['show', `HEAD:${file}`]).catch(() => '')
    const newText = status.includes('D')
        ? ''
        : await readFile(absolute, 'utf8').catch(() => '')
    return { oldText: oldText.slice(0, MAX_FILE_BYTES), newText: newText.slice(0, MAX_FILE_BYTES) }
}

/** Previews load whole files into the renderer; past this they show a notice instead. */
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024

/** Bytes of `HEAD:<file>`, or null when HEAD lacks it. Size first, so a huge blob is never read. */
async function headBytes(root: string, file: string): Promise<{ bytes: Buffer | null, size: number }> {
    const out = (await git(root, ['cat-file', '-s', `HEAD:${file}`]).catch(() => '')).trim()
    if (!/^\d+$/.test(out))
        return { bytes: null, size: 0 }
    const size = Number(out)
    if (size > MAX_PREVIEW_BYTES)
        return { bytes: null, size }
    const { stdout } = await execFileAsync('git', ['cat-file', 'blob', `HEAD:${file}`], { cwd: root, encoding: 'buffer', maxBuffer: MAX_PREVIEW_BYTES + 1024, timeout: 20_000 })
    return { bytes: stdout, size }
}

async function workingBytes(absolute: string): Promise<{ bytes: Buffer | null, size: number }> {
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile())
        return { bytes: null, size: 0 }
    if (info.size > MAX_PREVIEW_BYTES)
        return { bytes: null, size: info.size }
    return { bytes: await readFile(absolute), size: info.size }
}

/** Both sides of a changed file as bytes, for image / PDF / media previews in the review panel. */
export async function gitFileBytes(cwd: string, file: string, status: string, origPath?: string): Promise<GitFileBytes> {
    const root = await gitRoot(cwd)
    if (!root)
        throw new Error(tr('不是 git 仓库', 'Not a git repository'))
    const rel = inRepo(root, file)
    const untracked = status === '??' || status[0] === 'A'
    const before = untracked ? { bytes: null, size: 0 } : await headBytes(root, origPath ? inRepo(root, origPath) : rel)
    const after = status.includes('D') ? { bytes: null, size: 0 } : await workingBytes(path.join(root, rel))
    return {
        old: before.bytes,
        new: after.bytes,
        oldSize: before.size,
        newSize: after.size,
        tooLarge: before.size > MAX_PREVIEW_BYTES || after.size > MAX_PREVIEW_BYTES,
    }
}

/**
 * Runs `fn` on each side of a changed file as a path on disk, for tools that read files (QuickLook,
 * tar): the working copy where it is, the committed copy written to a temp file of the same name,
 * since both go by the extension. `scratch` is an empty folder for the tool's output. A side that
 * does not exist, or a committed copy over the preview cap, is null.
 */
async function onSides<T>(cwd: string, file: string, status: string, origPath: string | undefined, fn: (absolute: string, scratch: string) => Promise<T>) {
    const root = await gitRoot(cwd)
    if (!root)
        throw new Error(tr('不是 git 仓库', 'Not a git repository'))
    const rel = inRepo(root, file)
    const head = origPath ? inRepo(root, origPath) : rel
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'filo-preview-'))
    const scratch = async (name: string) => {
        const dir = path.join(tmp, name)
        await mkdir(dir)
        return dir
    }
    try {
        let old: T | null = null
        let oldSize = 0
        if (status !== '??' && status[0] !== 'A') {
            const before = await headBytes(root, head)
            oldSize = before.size
            if (before.bytes) {
                const copy = path.join(await scratch('head'), path.basename(head))
                await writeFile(copy, before.bytes)
                old = await fn(copy, await scratch('head-out'))
            }
        }
        let neu: T | null = null
        let newSize = 0
        const absolute = path.join(root, rel)
        const info = status.includes('D') ? null : await stat(absolute).catch(() => null)
        if (info?.isFile()) {
            newSize = info.size
            neu = await fn(absolute, await scratch('work-out'))
        }
        return { old, new: neu, oldSize, newSize }
    }
    finally {
        await rm(tmp, { recursive: true, force: true })
    }
}

/**
 * QuickLook thumbnails (what Finder shows) of both sides, as PNG: Office and iWork documents, RTF,
 * HEIC, TIFF, PSD, camera RAW, USDZ... The renderer only asks for known types, and only where the OS
 * makes thumbnails (platform.thumbnail); elsewhere both sides are null.
 */
export async function gitFileThumbs(cwd: string, file: string, status: string, origPath?: string): Promise<GitFileThumbs> {
    // Without thumbnails (the renderer does not ask then) both sides are null; paths are still checked.
    return onSides(cwd, file, status, origPath, platform.thumbnail ?? (async () => null))
}

/** Archives list at most this many entries per side. */
export const MAX_ARCHIVE_ENTRIES = 5000

/** Entry names of both sides of an archive (zip, jar, tar, tgz, 7z, rar... whatever the OS's tar reads). */
export async function gitFileEntries(cwd: string, file: string, status: string, origPath?: string): Promise<GitFileEntries> {
    const sides = await onSides(cwd, file, status, origPath, async (absolute) => {
        try {
            return await platform.archiveEntries(absolute)
        }
        catch (error: any) {
            const why = String(error?.stderr || error?.message || error).trim().split('\n')[0]
            throw new Error(tr(`无法读取归档：${why}`, `Cannot read the archive: ${why}`))
        }
    })
    return {
        old: sides.old?.slice(0, MAX_ARCHIVE_ENTRIES) ?? null,
        new: sides.new?.slice(0, MAX_ARCHIVE_ENTRIES) ?? null,
        oldCount: sides.old?.length ?? 0,
        newCount: sides.new?.length ?? 0,
    }
}

/** git's own message for a failed command (hook output, "nothing to commit", ...), not node's wrapper. */
function gitError(error: any): Error {
    const text = String(error?.stderr || error?.stdout || error?.message || error).trim()
    return new Error(text.split('\n').filter(Boolean).slice(-12).join('\n') || 'git failed')
}

/** Paths from the renderer, relative to the root; anything escaping the repository is refused. */
function inRepo(root: string, file: unknown): string {
    if (typeof file !== 'string' || !file)
        throw new Error(tr('路径不在仓库内', 'Path is outside the repository'))
    const absolute = path.resolve(root, file)
    if (!absolute.startsWith(root + path.sep))
        throw new Error(tr('路径不在仓库内', 'Path is outside the repository'))
    // git's own form (HEAD:<path> wants forward slashes on Windows too).
    return path.relative(root, absolute).split(path.sep).join('/')
}

export interface DiscardFile { path: string, status: string, origPath?: string }

/**
 * Rollback, as in JetBrains: tracked files go back to HEAD (index and working copy). Files HEAD does
 * not have (untracked, newly added, a rename's new name) are moved to the Trash, so those can be
 * recovered; `trash` is shell.trashItem.
 */
export async function gitDiscard(cwd: string, files: DiscardFile[], trash: (absolute: string) => Promise<void>) {
    const root = await gitRoot(cwd)
    if (!root)
        throw new Error(tr('不是 git 仓库', 'Not a git repository'))
    const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
    const restore: string[] = []
    const unstage: string[] = []
    const remove: string[] = []
    for (const file of files) {
        const rel = inRepo(root, file.path)
        const status = String(file.status ?? '')
        if (status === '??') {
            remove.push(rel)
        }
        else if (!hasHead || status[0] === 'A') {
            unstage.push(rel)
            remove.push(rel)
        }
        else if (status[0] === 'R' || status[0] === 'C') {
            unstage.push(rel)
            remove.push(rel)
            if (status[0] === 'R' && file.origPath)
                restore.push(inRepo(root, file.origPath))
        }
        else {
            restore.push(rel)
        }
    }
    try {
        if (unstage.length)
            await git(root, ['rm', '--cached', '-q', '-f', '--', ...unstage])
        if (restore.length)
            await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore])
    }
    catch (error) {
        throw gitError(error)
    }
    for (const rel of remove)
        await trash(path.join(root, rel)).catch(() => {})
}

/**
 * Commits exactly these paths (their working-copy state, new files included), leaving anything else
 * staged as it was: `git add` then `git commit --only`. Hooks run. Returns the short hash.
 */
export async function gitCommit(cwd: string, message: string, files: string[]): Promise<string> {
    const root = await gitRoot(cwd)
    if (!root)
        throw new Error(tr('不是 git 仓库', 'Not a git repository'))
    if (!message.trim())
        throw new Error(tr('请填写提交说明', 'Enter a commit message'))
    const paths = [...new Set(files.map(f => inRepo(root, f)))]
    if (!paths.length)
        throw new Error(tr('没有选中文件', 'No files selected'))
    try {
        await git(root, ['add', '-A', '--', ...paths])
        // Hooks (lint, tests) can take a while.
        await execFileAsync('git', ['commit', '-q', `--message=${message.trim()}`, '--only', '--', ...paths], { cwd: root, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 })
    }
    catch (error) {
        throw gitError(error)
    }
    return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim()
}

/**
 * The main checkout a linked worktree belongs to, whoever added it (`git worktree add`, `claude
 * --worktree`, this app); null for a main checkout, a submodule, or outside a repository.
 */
export async function worktreeParent(cwd: string): Promise<string | null> {
    const out = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']).catch(() => '')).trim()
    if (!out)
        return null
    const [common, top] = out.split('\n').map(p => path.resolve(p))
    return path.basename(common) === '.git' && path.dirname(common) !== top ? path.dirname(common) : null
}

/**
 * A worktree of cwd's repository at its HEAD, detached, in `dir`. Outside the repository, so its test
 * runner and watchers do not see the copy. Uncommitted changes stay where they are. Names are never
 * reused: sessions keep a deleted copy's path as their cwd.
 */
export async function createWorktree(cwd: string, dir = path.join(os.homedir(), '.filo', 'worktrees')): Promise<string> {
    const root = await gitRoot(cwd)
    if (!root)
        throw new Error(tr('不是 git 仓库', 'Not a git repository'))
    if (!await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false))
        throw new Error(tr('仓库还没有提交，副本要从一个提交开始', 'The repository has no commits yet; a worktree starts from one'))
    await mkdir(dir, { recursive: true })
    const name = `${path.basename(root)}-${Date.now().toString(36)}`
    for (let n = 0; ; n++) {
        const target = path.join(dir, n ? `${name}-${n}` : name)
        if (await stat(target).then(() => true, () => false))
            continue
        try {
            await execFileAsync('git', ['worktree', 'add', '--detach', '--quiet', target, 'HEAD'], { cwd: root, timeout: 300_000 })
        }
        catch (error) {
            throw gitError(error)
        }
        return realpath(target)
    }
}

/**
 * The working copy (new files included) as a tree, through a copy of its index, which the real one
 * never sees. Leaves the copy at `index` for git commands run with it.
 */
async function snapshot(root: string, index: string): Promise<string> {
    // With the original's mtime: git trusts cached stats older than the index file, so a fresh mtime would
    // hide an edit made in the same second as the last index write.
    const source = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim())
    await copyFile(source, index).then(async () => {
        const { atime, mtime } = await stat(source)
        await utimes(index, atime, mtime)
    }).catch(() => {})
    const env = { ...process.env, GIT_INDEX_FILE: index }
    await execFileAsync('git', ['add', '-A'], { cwd: root, env, timeout: 120_000 })
    return (await execFileAsync('git', ['write-tree'], { cwd: root, env })).stdout.trim()
}

/**
 * Everything a worktree changed since it left its main checkout's history (its commits, edits and new
 * files) as unstaged changes in the main checkout, merged three ways with the main checkout's own
 * edits. Returns the number of files and the ones left with conflict markers.
 */
export async function applyWorktree(cwd: string): Promise<{ files: number, conflicts: string[] }> {
    const parent = await worktreeParent(cwd)
    if (!parent)
        throw new Error(tr('这个目录不是副本', 'This folder is not a worktree'))
    const root = await toplevel(cwd)
    const temp = await mkdtemp(path.join(os.tmpdir(), 'filo-apply-'))
    try {
        const tree = await snapshot(root, path.join(temp, 'source'))
        const base = (await git(root, ['merge-base', 'HEAD', (await git(parent, ['rev-parse', 'HEAD'])).trim()])).trim()
        const files = (await git(root, ['diff', '--name-only', '-z', base, tree])).split('\0').filter(Boolean).length
        if (!files)
            return { files, conflicts: [] }
        const patch = path.join(temp, 'patch')
        await writeFile(patch, await git(root, ['diff', '--binary', '--full-index', base, tree]))
        // --3way works on an index matching the files: the main checkout's state in a copy of its index.
        const index = path.join(temp, 'target')
        await snapshot(parent, index)
        const env = { ...process.env, GIT_INDEX_FILE: index }
        try {
            await execFileAsync('git', ['apply', '--3way', '--whitespace=nowarn', patch], { cwd: parent, env, timeout: 120_000 })
            return { files, conflicts: [] }
        }
        catch (error) {
            const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: parent, env })
            const conflicts = stdout.split('\0').filter(Boolean)
            if (!conflicts.length)
                throw gitError(error)
            return { files, conflicts }
        }
    }
    finally {
        await rm(temp, { recursive: true, force: true })
    }
}

/** Deletes a worktree folder and git's entry for it, uncommitted and unapplied changes included. */
export async function removeWorktree(cwd: string) {
    const parent = await worktreeParent(cwd)
    if (!parent)
        throw new Error(tr('这个目录不是副本', 'This folder is not a worktree'))
    try {
        await git(parent, ['worktree', 'remove', '--force', await toplevel(cwd)])
    }
    catch (error) {
        throw gitError(error)
    }
}

/**
 * What another agent's new thread is told about a thread (its messages, pi-format) to review it or take
 * it over: pi's review task or the handoff (lib/review.ts), listing the changed files to diff rather
 * than quoting the diff. `from`: the thread's agent.
 */
export async function threadTask(cwd: string, messages: unknown[], kind: 'review' | 'handoff', from: string): Promise<string> {
    const facts = branchFacts(messages.map(message => ({ type: 'message', message })), cwd)
    const exec = (command: string, args: string[], options: { cwd: string, timeout: number }) => execFileAsync(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
        .then(r => ({ code: 0, stdout: r.stdout }), (error: any) => ({ code: typeof error?.code === 'number' ? error.code : 1, stdout: String(error?.stdout ?? '') }))
    const changes = await collectChanges({ exec }, cwd, facts.files, 0)
    return kind === 'review' ? reviewerTask(facts, changes, undefined, false) : handoffTask(facts, changes, from)
}
