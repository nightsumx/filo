// Who changed what: edit / write tool calls read back from pi's session files. The desktop app's
// threads and terminal pi write the same files, so one scan covers both. Used to filter the changes
// panel to one thread and to flag files two sessions changed since the last commit.
import type { FileEditor, RepoEdits } from '@shared/ipc'
import { readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gitDirty, gitHeadTime, gitRoot } from './git'
import { messageText, parseLines, sessionFiles } from './sessions'

const EDIT_TOOLS = new Set(['edit', 'write'])

export interface SessionEdits {
    cwd: string
    title: string
    /** Successful edits in file order; `path` as the tool got it, resolved against cwd. */
    edits: { path: string, at: number }[]
}

/** Edit / write calls whose result was not an error. Calls still running count (pi writes the call first). */
export function parseEdits(text: string): SessionEdits | null {
    const entries = parseLines(text)
    const header = entries[0]
    if (header?.type !== 'session' || typeof header.cwd !== 'string')
        return null
    let name: string | undefined
    let firstPrompt: string | undefined
    const calls = new Map<string, { path: string, at: number }>()
    const failed = new Set<string>()
    for (const entry of entries) {
        if (entry.type === 'session_info')
            name = typeof entry.name === 'string' && entry.name ? entry.name : undefined
        if (entry.type !== 'message')
            continue
        const message = entry.message
        if (message?.role === 'user' && !firstPrompt)
            firstPrompt = messageText(message.content).trim().split('\n')[0]?.slice(0, 80) || undefined
        if (message?.role === 'assistant' && Array.isArray(message.content)) {
            const at = Date.parse(entry.timestamp) || 0
            for (const block of message.content) {
                const file = block?.arguments?.path
                if (block?.type === 'toolCall' && EDIT_TOOLS.has(block.name) && typeof file === 'string' && file && typeof block.id === 'string')
                    calls.set(block.id, { path: resolveToolPath(header.cwd, file), at })
            }
        }
        if (message?.role === 'toolResult' && message.isError && typeof message.toolCallId === 'string')
            failed.add(message.toolCallId)
    }
    return {
        cwd: header.cwd,
        title: name ?? firstPrompt ?? '',
        edits: [...calls].filter(([id]) => !failed.has(id)).map(([, edit]) => edit),
    }
}

/** pi's tools take paths relative to the session cwd, absolute, or with ~ / a leading @. */
export function resolveToolPath(cwd: string, file: string): string {
    const clean = file.startsWith('@') ? file.slice(1) : file
    if (clean === '~' || clean.startsWith('~/'))
        return path.join(os.homedir(), clean.slice(1))
    return path.resolve(cwd, clean)
}

const cache = new Map<string, { key: string, edits: SessionEdits | null }>()

async function sessionEdits(file: string, size: number, mtime: number): Promise<SessionEdits | null> {
    const key = `${mtime}:${size}`
    const hit = cache.get(file)
    if (hit?.key === key)
        return hit.edits
    const edits = parseEdits(await readFile(file, 'utf8'))
    // git reports the root with symlinks resolved (/private/tmp); tool paths may not be.
    if (edits) {
        const dirs = new Map<string, Promise<string>>()
        // A folder that is gone (or not made yet) resolves through its nearest existing parent.
        const real = (dir: string): Promise<string> => {
            let p = dirs.get(dir)
            if (!p) {
                p = realpath(dir).catch(() => (path.dirname(dir) === dir ? dir : real(path.dirname(dir)).then(r => path.join(r, path.basename(dir)))))
                dirs.set(dir, p)
            }
            return p
        }
        edits.edits = await Promise.all(edits.edits.map(async e => ({ ...e, path: path.join(await real(path.dirname(e.path)), path.basename(e.path)) })))
    }
    cache.set(file, { key, edits })
    return edits
}

/**
 * For each uncommitted file in the repository holding `cwd`, the sessions that edited it after
 * the last commit (latest edit per session).
 */
export async function repoEdits(cwd: string): Promise<RepoEdits> {
    const root = await gitRoot(cwd)
    if (!root)
        return { files: {} }
    const [since, dirty, files] = await Promise.all([gitHeadTime(root), gitDirty(root), sessionFiles()])
    const wanted = new Set(dirty.map(f => f.path))
    const result: Record<string, FileEditor[]> = {}
    if (!wanted.size)
        return { files: result }
    await Promise.all(files.map(async (file) => {
        try {
            const info = await stat(file)
            if (info.mtimeMs < since)
                return
            const session = await sessionEdits(file, info.size, info.mtimeMs)
            if (!session)
                return
            const latest = new Map<string, number>()
            for (const edit of session.edits) {
                if (edit.at < since)
                    continue
                const rel = path.relative(root, edit.path)
                if (rel.startsWith('..') || path.isAbsolute(rel) || !wanted.has(rel))
                    continue
                latest.set(rel, Math.max(latest.get(rel) ?? 0, edit.at))
            }
            for (const [rel, at] of latest)
                (result[rel] ??= []).push({ session: file, title: session.title, at })
        }
        catch {}
    }))
    for (const editors of Object.values(result))
        editors.sort((a, b) => b.at - a.at)
    return { files: result }
}
