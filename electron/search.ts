// Full-text search over every pi session (this app's threads and terminal pi alike). Prompts and
// replies are indexed, tool output is not: it is most of each file and rarely what one looks for.
// The index lives in memory and is brought up to date (changed files only) on every query. It runs
// in a worker thread (searchWorker.ts): a cold start reads every session file, hundreds of MB.
import type { SearchHit, SearchResult } from '@shared/ipc'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { messageText, sessionFiles } from './sessions'

interface IndexedEntry {
    id: string
    role: 'user' | 'assistant'
    text: string
    at: number
}



export interface IndexedSession {
    cwd: string
    name?: string
    firstPrompt?: string
    entries: IndexedEntry[]
}

const MAX_SESSIONS = 50
const HITS_PER_SESSION = 3
const SNIPPET = 160

/** Tool results are skipped by a check on the line's first bytes, without decoding the (often huge) line. */
const TOOL_RESULT = '"role":"toolResult"'
const PREFIX_BYTES = 240
/** Longer messages are indexed by their start only. */
const MAX_TEXT = 20_000
/** Lines this long are tool calls carrying whole files; parsing them costs more than they are worth. */
const MAX_LINE = 2 * 1024 * 1024

/** The lines worth parsing: not empty, not a tool result, not a giant tool call. */
function* candidateLines(file: Buffer): Generator<string> {
    for (let start = 0; start < file.length;) {
        let end = file.indexOf(10, start)
        if (end === -1)
            end = file.length
        const length = end - start
        if (length > 0 && length <= MAX_LINE && !file.toString('latin1', start, Math.min(end, start + PREFIX_BYTES)).includes(TOOL_RESULT))
            yield file.toString('utf8', start, end)
        start = end + 1
    }
}

export function indexSession(file: Buffer): IndexedSession | null {
    let header: any
    const session: IndexedSession = { cwd: '', entries: [] }
    for (const line of candidateLines(file)) {
        let entry: any
        try {
            entry = JSON.parse(line)
        }
        catch {
            continue
        }
        if (!header) {
            if (entry?.type !== 'session')
                return null
            header = entry
            session.cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
            continue
        }
        if (entry.type === 'session_info')
            session.name = typeof entry.name === 'string' && entry.name ? entry.name : undefined
        const role = entry.message?.role
        if (entry.type !== 'message' || (role !== 'user' && role !== 'assistant') || typeof entry.id !== 'string')
            continue
        const body = messageText(entry.message.content).trim()
        if (!body)
            continue
        if (role === 'user' && !session.firstPrompt)
            session.firstPrompt = body.split('\n')[0].slice(0, 200)
        session.entries.push({ id: entry.id, role, text: body.slice(0, MAX_TEXT), at: Date.parse(entry.timestamp) || 0 })
    }
    return header ? session : null
}

/** Lowercased words; every one must appear in a message for it to match. */
export function terms(query: string): string[] {
    return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

/** Text around the first match, whitespace collapsed. `lower` is text.toLowerCase(). */
export function snippet(text: string, lower: string, words: string[]): string {
    const first = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0))
    const start = Math.max(0, first - 50)
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    return `${start > 0 ? '…' : ''}${flat(text.slice(start, start + SNIPPET)).trim()}${start + SNIPPET < text.length ? '…' : ''}`
}

export function searchIndex(sessions: Iterable<{ path: string, updatedAt: number, session: IndexedSession, lower?: string[] }>, query: string): SearchResult[] {
    const words = terms(query)
    if (!words.length)
        return []
    const results: SearchResult[] = []
    for (const { path, updatedAt, session, lower: lowered } of sessions) {
        const title = session.name ?? session.firstPrompt ?? ''
        const titleMatch = words.every(w => title.toLowerCase().includes(w))
        const hits: SearchHit[] = []
        let total = 0
        for (let i = 0; i < session.entries.length; i++) {
            const entry = session.entries[i]
            const lower = lowered?.[i] ?? entry.text.toLowerCase()
            if (!words.every(w => lower.includes(w)))
                continue
            total++
            if (hits.length < HITS_PER_SESSION)
                hits.push({ entryId: entry.id, role: entry.role, at: entry.at, snippet: snippet(entry.text, lower, words) })
        }
        if (total || titleMatch)
            results.push({ session: path, cwd: session.cwd, title, updatedAt, hits, total })
    }
    // Most recently active first: what one searches for is usually recent.
    return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
}

interface Indexed {
    key: string
    updatedAt: number
    session: IndexedSession | null
    /** entries[i].text lowercased; not saved. */
    lower?: string[]
}

const INDEX_VERSION = 1

/**
 * The index, kept up to date per file (mtime + size). With `cacheFile` it is saved after each
 * change, so a restart only reads the sessions written since.
 */
export class SessionSearch {
    private index = new Map<string, Indexed>()
    private updating: Promise<void> | null = null
    private loaded: Promise<void> | null = null

    /** `extraFiles`: more pi-format session files to index (the ACP copies, acp/mirror.ts). */
    constructor(private cacheFile?: string, private extraFiles?: () => Promise<string[]>) {}

    /** Re-reads changed and new session files; concurrent callers share one pass. */
    update(): Promise<void> {
        this.updating ??= this.refresh().finally(() => {
            this.updating = null
        })
        return this.updating
    }

    private async load() {
        if (!this.cacheFile)
            return
        try {
            const saved = JSON.parse(await readFile(this.cacheFile, 'utf8'))
            if (saved?.version === INDEX_VERSION && saved.files && typeof saved.files === 'object') {
                for (const [file, value] of Object.entries<any>(saved.files))
                    this.index.set(file, { key: value.key, updatedAt: value.updatedAt, session: value.session })
            }
        }
        catch {}
    }

    private async save() {
        if (!this.cacheFile)
            return
        const files = Object.fromEntries([...this.index].map(([file, v]) => [file, { key: v.key, updatedAt: v.updatedAt, session: v.session }]))
        await mkdir(path.dirname(this.cacheFile), { recursive: true })
        await writeFile(`${this.cacheFile}.tmp`, JSON.stringify({ version: INDEX_VERSION, files }))
        await rename(`${this.cacheFile}.tmp`, this.cacheFile)
    }

    private async refresh() {
        await (this.loaded ??= this.load())
        const [own, extra] = await Promise.all([sessionFiles(), this.extraFiles?.() ?? []])
        const files = [...own, ...extra]
        const present = new Set(files)
        let changed = false
        for (const file of this.index.keys()) {
            if (!present.has(file)) {
                this.index.delete(file)
                changed = true
            }
        }
        // One file at a time: a cold start reads hundreds of MB, and reading in parallel only spikes memory.
        for (const file of files) {
            try {
                const info = await stat(file)
                const key = `${info.mtimeMs}:${info.size}`
                if (this.index.get(file)?.key === key)
                    continue
                this.index.set(file, { key, updatedAt: info.mtimeMs, session: indexSession(await readFile(file)) })
                changed = true
            }
            catch {
                this.index.delete(file)
            }
        }
        if (changed)
            await this.save().catch(() => {})
    }

    async search(query: string): Promise<SearchResult[]> {
        await this.update()
        const sessions = []
        for (const [file, v] of this.index) {
            if (!v.session)
                continue
            v.lower ??= v.session.entries.map(e => e.text.toLowerCase())
            sessions.push({ path: file, updatedAt: v.updatedAt, session: v.session, lower: v.lower })
        }
        return searchIndex(sessions, query)
    }
}
