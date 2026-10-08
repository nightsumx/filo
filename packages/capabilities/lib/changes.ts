// The working tree as review and autopilot see it: the diff of the files a thread edited, or of every
// uncommitted change when it edited none, within a budget.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Changes } from './review'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DIFF_BUDGET } from './review'

/** Shown path: relative inside the project, absolute outside it. */
export const shown = (cwd: string, file: string) => {
    const rel = path.relative(cwd, file)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file
}

/** NUL-separated `git status --porcelain -z` paths (renames carry their old path after the new one). */
export function statusPaths(output: string): string[] {
    const parts = output.split('\0')
    const out: string[] = []
    for (let i = 0; i < parts.length; i++) {
        const record = parts[i]
        if (record.length < 4)
            continue
        out.push(record.slice(3))
        if (record[0] === 'R' || record[0] === 'C')
            i++
    }
    return out
}

/** The diff to start from: the thread's files, or every uncommitted change. */
export async function collectChanges(pi: ExtensionAPI, cwd: string, threadFiles: string[], budget = DIFF_BUDGET): Promise<Changes> {
    const git = (...args: string[]) => pi.exec('git', args, { cwd, timeout: 20_000 })
    const top = await git('rev-parse', '--show-toplevel')
    const root = top.code === 0 ? top.stdout.trim() : undefined
    let scope: Changes['scope'] = 'thread'
    let files = threadFiles
    if (!files.length) {
        scope = 'uncommitted'
        if (root) {
            const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all')
            files = status.code === 0 ? statusPaths(status.stdout).map(p => path.join(root, p)) : []
        }
    }
    const display = files.map(f => shown(cwd, f))
    if (!root || !files.length)
        return { scope, files: display, diff: '', unshown: display }

    const inRepo = (f: string) => !path.relative(root, f).startsWith('..')
    const listed = await git('ls-files', '-z', '--full-name', '--', ...files.filter(inRepo))
    const tracked = new Set(listed.code === 0 ? listed.stdout.split('\0').filter(Boolean).map(p => path.join(root, p)) : [])
    const hasHead = (await git('rev-parse', '--verify', '--quiet', 'HEAD')).code === 0
    const chunks: string[] = []
    const unshown: string[] = []
    let used = 0
    for (const file of files) {
        const name = shown(cwd, file)
        let chunk = ''
        if (!inRepo(file)) {
            unshown.push(name)
            continue
        }
        if (tracked.has(file)) {
            const diff = await git('diff', '--no-color', ...(hasHead ? ['HEAD'] : []), '--', file)
            chunk = diff.code === 0 ? diff.stdout.trimEnd() : ''
            if (!chunk && diff.code === 0)
                continue // committed since, or reverted: nothing left to show
        }
        else {
            const content = await readFile(file, 'utf8').catch(() => undefined)
            if (content === undefined)
                continue // created and removed again
            if (!content.includes('\0'))
                chunk = `--- /dev/null\n+++ b/${path.relative(root, file)}\n${content.split('\n').map(l => `+${l}`).join('\n')}`
        }
        if (!chunk || used + chunk.length > budget) {
            unshown.push(name)
            continue
        }
        chunks.push(chunk)
        used += chunk.length
    }
    return { scope, files: display, diff: chunks.join('\n'), unshown }
}
