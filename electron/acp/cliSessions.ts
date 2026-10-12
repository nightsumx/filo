// Sessions an agent's terminal CLI keeps where its ACP session/list does not look, read from the
// agent's own files. The formats are the agents' own and undocumented: anything unexpected is
// skipped, so a format change costs a missing entry, never a broken list.
//
// Cursor: `cursor-agent` in a terminal keeps chats in ~/.cursor/chats/<md5(cwd)>/<id>/meta.json and
// the transcript in ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl; its ACP lists and
// loads only ~/.cursor/acp-sessions. So these chats are read here and cannot be continued in the app
// (session/load refuses them): the thread shows them and points at `cursor-agent --resume`.
//
// Gemini CLI: no session/list at all, but session/load opens any session in
// ~/.gemini/tmp/<slug>/chats/session-*.jsonl (the folder's .project_root names the project). So
// only the list is read here; opening one goes through the agent as usual.

import type { SessionItem } from '@shared/ipc'
import type { ToolCall } from '@shared/pi'
import type { ListedSession, SessionList } from './list'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { AcpTranscript } from './transcript'

/** Long prompts are cut for the list; the transcript has them whole. */
const PROMPT_CHARS = 200

const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

async function dirs(dir: string): Promise<string[]> {
    try {
        return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
    }
    catch {
        return []
    }
}

function jsonLines(text: string): any[] {
    const out: any[] = []
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue
        try {
            const value = JSON.parse(line)
            if (value && typeof value === 'object')
                out.push(value)
        }
        catch {}
    }
    return out
}

/** Re-reads a file only when it changed: the list is read every couple of minutes. */
class FileCache<T> {
    private entries = new Map<string, { mtime: number, size: number, value: T | undefined }>()

    async get(file: string, read: (text: string) => T | undefined): Promise<T | undefined> {
        let info
        try {
            info = await stat(file)
        }
        catch {
            this.entries.delete(file)
            return undefined
        }
        const cached = this.entries.get(file)
        if (cached && cached.mtime === info.mtimeMs && cached.size === info.size)
            return cached.value
        const value = read(await readFile(file, 'utf8').catch(() => ''))
        this.entries.set(file, { mtime: info.mtimeMs, size: info.size, value })
        return value
    }
}

// ---------------------------------------------------------------- Cursor

/** What the user typed: Cursor stores the prompt wrapped in a timestamp and `<user_query>`. */
export function cursorPrompt(raw: string): string {
    const query = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(raw)
    if (query)
        return query[1].trim()
    return raw.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, '').trim()
}

/** A Cursor tool call as the pi call the thread's tool views know. */
function cursorCall(id: string, name: string, input: any): ToolCall {
    const args = input && typeof input === 'object' ? input : {}
    const call = (piName: string, piArgs: Record<string, any>): ToolCall => ({ type: 'toolCall', id, name: piName, arguments: piArgs })
    switch (name) {
        case 'Read':
            return call('read', { path: String(args.path ?? args.target_file ?? ''), ...(typeof args.offset === 'number' ? { offset: args.offset } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) })
        case 'Shell':
            return call('bash', { command: String(args.command ?? '') })
        case 'Write':
            return call('write', { path: String(args.path ?? ''), content: String(args.contents ?? args.content ?? '') })
        case 'StrReplace':
            return call('edit', { path: String(args.path ?? ''), oldText: String(args.old_string ?? ''), newText: String(args.new_string ?? '') })
        default:
            return call(name, args)
    }
}

/** A Cursor transcript as the thread's items. Cursor keeps no per-message times or tool results. */
export function cursorTranscript(lines: any[], at: number, prefix = 'cursor:'): SessionItem[] {
    const transcript = new AcpTranscript(prefix, { now: () => at })
    let calls = 0
    for (const line of lines) {
        const blocks = Array.isArray(line?.message?.content) ? line.message.content : []
        if (line.role === 'user') {
            const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => cursorPrompt(b.text)).join('\n\n')
            if (text)
                transcript.userPrompt(text)
        }
        else if (line.role === 'assistant') {
            for (const b of blocks) {
                if (b?.type === 'text' && typeof b.text === 'string')
                    transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: b.text } })
                else if (b?.type === 'thinking' && typeof b.thinking === 'string')
                    transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: b.thinking } })
                else if (b?.type === 'tool_use' && typeof b.name === 'string') {
                    const id = str(b.id) ?? `cursor-tool-${calls++}`
                    transcript.update({ sessionUpdate: 'tool_call', toolCallId: id, title: b.name, status: 'completed', rawInput: b.input, _meta: { piCalls: [cursorCall(id, b.name, b.input)] } })
                }
            }
        }
        else if (line.type === 'turn_ended') {
            transcript.finish('end_turn')
        }
    }
    transcript.finish('end_turn')
    return transcript.snapshot()
}

interface CursorChat extends ListedSession {
    transcript: string
}

export class CursorChats {
    private metas = new FileCache<{ cwd: string, createdAt: number, updatedAt: number }>()
    private prompts = new FileCache<string>()

    constructor(private home: () => string) {}

    private get root() {
        return path.join(this.home(), '.cursor')
    }

    /** Transcript files by chat id, across every project. */
    private async transcripts(): Promise<Map<string, string>> {
        const found = new Map<string, string>()
        const projects = path.join(this.root, 'projects')
        for (const project of await dirs(projects)) {
            const base = path.join(projects, project, 'agent-transcripts')
            for (const id of await dirs(base))
                found.set(id, path.join(base, id, `${id}.jsonl`))
        }
        return found
    }

    async list(): Promise<{ sessions: CursorChat[], complete: boolean }> {
        const transcripts = await this.transcripts()
        const chats = path.join(this.root, 'chats')
        const sessions: CursorChat[] = []
        for (const group of await dirs(chats)) {
            for (const id of await dirs(path.join(chats, group))) {
                const transcript = transcripts.get(id)
                if (!transcript)
                    continue
                const meta = await this.metas.get(path.join(chats, group, id, 'meta.json'), (text) => {
                    try {
                        const m = JSON.parse(text)
                        if (!m?.hasConversation || !str(m.cwd))
                            return undefined
                        const createdAt = typeof m.createdAtMs === 'number' ? m.createdAtMs : 0
                        return { cwd: m.cwd, createdAt, updatedAt: typeof m.updatedAtMs === 'number' ? m.updatedAtMs : createdAt }
                    }
                    catch {
                        return undefined
                    }
                })
                const prompt = meta && await this.prompts.get(transcript, (text) => {
                    const first = jsonLines(text).find(l => l.role === 'user')
                    const block = (first?.message?.content ?? []).find((b: any) => b?.type === 'text' && typeof b.text === 'string')
                    return block ? cursorPrompt(block.text).slice(0, PROMPT_CHARS) || undefined : undefined
                })
                if (meta && prompt)
                    sessions.push({ sessionId: id, cwd: meta.cwd, title: prompt, updatedAt: meta.updatedAt, terminalOnly: true, transcript })
            }
        }
        return { sessions, complete: true }
    }

    /** A chat's transcript; undefined when it is gone. */
    async read(id: string): Promise<SessionItem[] | undefined> {
        const chat = (await this.list()).sessions.find(s => s.sessionId === id)
        if (!chat)
            return undefined
        const text = await readFile(chat.transcript, 'utf8').catch(() => undefined)
        return text === undefined ? undefined : cursorTranscript(jsonLines(text), chat.updatedAt)
    }
}

// ---------------------------------------------------------------- Gemini CLI

/** Gemini's own context preamble opens every session as a user message; it is not the user's. */
export const isGeminiPreamble = (text: string) => text.trimStart().startsWith('<session_context>')

function geminiText(content: unknown): string {
    if (typeof content === 'string')
        return content
    if (Array.isArray(content))
        return content.map(p => typeof p?.text === 'string' ? p.text : '').join('')
    return ''
}

/**
 * A session file's header, last change and first prompt. The .jsonl form is a header line, then
 * messages and `$set` patches; the older .json form is one object with `messages`.
 */
export function geminiSession(text: string, json: boolean): { sessionId: string, updatedAt: number, prompt: string } | undefined {
    let header: any
    let messages: any[] = []
    let updated: string | undefined
    if (json) {
        try {
            header = JSON.parse(text)
        }
        catch {
            return undefined
        }
        messages = Array.isArray(header?.messages) ? header.messages : []
        updated = str(header?.lastUpdated)
    }
    else {
        const lines = jsonLines(text)
        header = lines[0]
        for (const line of lines.slice(1)) {
            const set = line.$set
            if (set && typeof set === 'object') {
                if (Array.isArray(set.messages))
                    messages = [...set.messages]
                updated = str(set.lastUpdated) ?? updated
            }
            else if (str(line.type)) {
                messages.push(line)
            }
        }
        updated ??= str(header?.lastUpdated)
    }
    const sessionId = str(header?.sessionId)
    // Subagents keep sessions of their own beside the main one.
    if (!sessionId || (header.kind !== undefined && header.kind !== 'main'))
        return undefined
    const prompt = messages.filter(m => m?.type === 'user').map(m => geminiText(m.content)).find(t => t.trim() && !isGeminiPreamble(t))
    if (!prompt)
        return undefined
    return { sessionId, updatedAt: Date.parse(updated ?? str(header.startTime) ?? '') || 0, prompt: prompt.trim().slice(0, PROMPT_CHARS) }
}

export class GeminiChats {
    private files = new FileCache<ReturnType<typeof geminiSession>>()

    constructor(private home: () => string) {}

    async list(): Promise<SessionList> {
        const tmp = path.join(this.home(), '.gemini', 'tmp')
        const sessions: ListedSession[] = []
        for (const project of await dirs(tmp)) {
            const cwd = (await readFile(path.join(tmp, project, '.project_root'), 'utf8').catch(() => '')).trim()
            if (!path.isAbsolute(cwd))
                continue
            const chats = path.join(tmp, project, 'chats')
            const names = await readdir(chats).catch(() => [] as string[])
            for (const name of names) {
                const json = name.endsWith('.json')
                if (!name.startsWith('session-') || (!json && !name.endsWith('.jsonl')))
                    continue
                const session = await this.files.get(path.join(chats, name), text => geminiSession(text, json))
                if (session)
                    sessions.push({ sessionId: session.sessionId, cwd, title: session.prompt, updatedAt: session.updatedAt })
            }
        }
        return { sessions, complete: true }
    }
}
