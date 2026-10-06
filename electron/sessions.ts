import type { SessionItem, SessionSnapshot, SessionSummary } from '@shared/ipc'
import type { AgentMessage } from '@shared/pi'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { tr } from './i18n'

const FULL_READ_LIMIT = 4 * 1024 * 1024
const PARTIAL_CHUNK = 512 * 1024

/** Same precedence pi uses for user-level config: env var, then settings.json, then the default. */
export async function sessionsDir(): Promise<string> {
    if (process.env.PI_CODING_AGENT_SESSION_DIR)
        return process.env.PI_CODING_AGENT_SESSION_DIR
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
    try {
        const settings = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'))
        if (typeof settings.sessionDir === 'string' && path.isAbsolute(settings.sessionDir))
            return settings.sessionDir
    }
    catch {}
    return path.join(agentDir, 'sessions')
}

export function parseLines(text: string): any[] {
    const entries: any[] = []
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue
        try {
            entries.push(JSON.parse(line))
        }
        catch {
            // Partial line at a chunk boundary or a corrupt record: skip it.
        }
    }
    return entries
}

export function messageText(content: unknown): string {
    if (typeof content === 'string')
        return content
    if (!Array.isArray(content))
        return ''
    return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
}

/** Summary for the sidebar. Works on a full file or on a head + tail excerpt of a large one. */
export function summarizeSession(text: string, filePath: string, updatedAt: number): SessionSummary | null {
    const entries = parseLines(text)
    const header = entries[0]
    if (header?.type !== 'session')
        return null
    let name: string | undefined
    let firstPrompt: string | undefined
    for (const entry of entries) {
        if (entry.type === 'session_info')
            name = typeof entry.name === 'string' && entry.name ? entry.name : undefined
        if (!firstPrompt && entry.type === 'message' && entry.message?.role === 'user') {
            const prompt = messageText(entry.message.content).trim()
            if (prompt)
                firstPrompt = prompt.slice(0, 200)
        }
    }
    return {
        path: filePath,
        id: header.id,
        cwd: header.cwd,
        name,
        firstPrompt,
        createdAt: Date.parse(header.timestamp) || updatedAt,
        updatedAt,
    }
}

/**
 * Rebuild the active branch: walk from the leaf (the last appended entry) to the root.
 * Abandoned branches stay in the file but are not displayed, matching what pi sends to the model.
 */
export function parseSession(text: string, filePath: string): SessionSnapshot {
    const entries = parseLines(text)
    const header = entries[0]?.type === 'session' ? entries[0] : undefined
    const byId = new Map<string, any>()
    let leaf: any
    let name: string | undefined
    for (const entry of entries) {
        if (typeof entry.id !== 'string' || entry.type === 'session')
            continue
        byId.set(entry.id, entry)
        leaf = entry
        if (entry.type === 'session_info')
            name = typeof entry.name === 'string' && entry.name ? entry.name : undefined
    }

    const branch: any[] = []
    const seen = new Set<string>()
    for (let node = leaf; node && !seen.has(node.id); node = node.parentId ? byId.get(node.parentId) : undefined) {
        seen.add(node.id)
        branch.push(node)
    }
    branch.reverse()

    const items: SessionItem[] = []
    for (const entry of branch) {
        const message = toMessage(entry)
        if (message)
            items.push({ entryId: entry.id, message, endedAt: Date.parse(entry.timestamp) || undefined })
    }
    return { path: filePath, id: header?.id ?? '', cwd: header?.cwd ?? '', name, items }
}

function toMessage(entry: any): AgentMessage | null {
    const timestamp = Date.parse(entry.timestamp) || 0
    switch (entry.type) {
        case 'message':
            return entry.message?.role === 'system' ? null : entry.message
        case 'compaction':
            return { role: 'compactionSummary', summary: entry.summary ?? '', tokensBefore: entry.tokensBefore ?? 0, timestamp }
        case 'branch_summary':
            return { role: 'branchSummary', summary: entry.summary ?? '', timestamp }
        case 'custom_message':
            return entry.display
                ? { role: 'custom', customType: entry.customType, content: entry.content, display: true, timestamp }
                : null
        default:
            return null
    }
}

async function readExcerpt(filePath: string, size: number): Promise<string> {
    if (size <= FULL_READ_LIMIT)
        return readFile(filePath, 'utf8')
    const handle = await open(filePath, 'r')
    try {
        const head = Buffer.alloc(PARTIAL_CHUNK)
        const tail = Buffer.alloc(PARTIAL_CHUNK)
        await handle.read(head, 0, PARTIAL_CHUNK, 0)
        await handle.read(tail, 0, PARTIAL_CHUNK, size - PARTIAL_CHUNK)
        // parseLines drops the partial lines at both cut points.
        return `${head.toString('utf8')}\n${tail.toString('utf8')}`
    }
    finally {
        await handle.close()
    }
}

const summaryCache = new Map<string, { key: string, summary: SessionSummary | null }>()

/** Every session file: pi keeps one folder per working directory under the sessions folder. */
export async function sessionFiles(): Promise<string[]> {
    const root = await sessionsDir()
    let dirs: string[]
    try {
        dirs = await readdir(root)
    }
    catch {
        return []
    }
    const files: string[] = []
    await Promise.all(dirs.map(async (dir) => {
        try {
            for (const name of await readdir(path.join(root, dir))) {
                if (name.endsWith('.jsonl'))
                    files.push(path.join(root, dir, name))
            }
        }
        catch {}
    }))
    return files
}

export async function listSessions(): Promise<SessionSummary[]> {
    const files = await sessionFiles()

    const results = await Promise.all(files.map(async (file) => {
        try {
            const info = await stat(file)
            const key = `${info.mtimeMs}:${info.size}`
            const hit = summaryCache.get(file)
            if (hit?.key === key)
                return hit.summary
            const summary = summarizeSession(await readExcerpt(file, info.size), file, info.mtimeMs)
            summaryCache.set(file, { key, summary })
            return summary
        }
        catch {
            return null
        }
    }))
    return results.filter((s): s is SessionSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readSession(filePath: string): Promise<SessionSnapshot> {
    await assertInSessionsDir(filePath)
    try {
        return parseSession(await readFile(filePath, 'utf8'), filePath)
    }
    catch (error: any) {
        // A brand-new session has a path before pi writes its first entry.
        if (error?.code === 'ENOENT')
            return { path: filePath, id: '', cwd: '', items: [] }
        throw error
    }
}

/** Renderer-supplied paths are only honored inside the sessions directory. */
export async function assertInSessionsDir(filePath: string) {
    const root = path.resolve(await sessionsDir())
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(root + path.sep) || !resolved.endsWith('.jsonl'))
        throw new Error(tr('拒绝访问会话目录之外的文件', 'Refusing to read files outside the sessions folder'))
}
