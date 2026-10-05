import type { GitFileChange, GitFileDiff, GitStatus } from '@shared/ipc'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024

// execFile with argument arrays: paths and refs never pass through a shell.
async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 20_000 })
    return stdout
}

/** Parse `git status --porcelain=v1 -z`. Renames carry the original path as an extra NUL field. */
export function parsePorcelain(output: string): { path: string, status: string }[] {
    const fields = output.split('\0')
    const files: { path: string, status: string }[] = []
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        if (field.length < 4)
            continue
        const status = field.slice(0, 2)
        files.push({ path: field.slice(3), status })
        if (status[0] === 'R' || status[0] === 'C')
            i++
    }
    return files
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
    const porcelain = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
    const numstat = hasHead ? parseNumstat(await git(root, ['diff', 'HEAD', '--numstat', '-z'])) : new Map()

    const files: GitFileChange[] = await Promise.all(parsePorcelain(porcelain).map(async ({ path: file, status }) => {
        const stats = numstat.get(file)
        if (stats)
            return { path: file, status, ...stats }
        // Untracked (or no HEAD yet): count lines of the working copy.
        let additions = 0
        let binary = false
        try {
            const buffer = await readFile(path.join(root, file))
            binary = buffer.subarray(0, 8000).includes(0)
            additions = binary || buffer.length > MAX_FILE_BYTES ? 0 : countLines(buffer.toString('utf8'))
        }
        catch {}
        return { path: file, status, additions, deletions: 0, binary }
    }))
    return { isRepo: true, branch, files }
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
        throw new Error('路径不在仓库内')
    const untracked = status === '??' || status[0] === 'A'
    const oldText = untracked
        ? ''
        : await git(root, ['show', `HEAD:${file}`]).catch(() => '')
    const newText = status.includes('D')
        ? ''
        : await readFile(absolute, 'utf8').catch(() => '')
    return { oldText: oldText.slice(0, MAX_FILE_BYTES), newText: newText.slice(0, MAX_FILE_BYTES) }
}
