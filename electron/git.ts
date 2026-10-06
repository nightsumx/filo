import type { GitFileChange, GitFileDiff, GitStatus } from '@shared/ipc'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { tr } from './i18n'

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

/** Repository root (as git reports it: symlinks resolved), or null outside a repo. */
export async function gitRoot(cwd: string): Promise<string | null> {
    return git(cwd, ['rev-parse', '--show-toplevel']).then(s => s.trim() || null, () => null)
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
        root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
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
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
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
    return path.relative(root, absolute)
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
