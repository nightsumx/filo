// Claude Code's session file (~/.claude/projects/<slug>/<session>.jsonl) read as pi's transcript.
//
// The interactive `claude` writes one JSON record per line as the session goes: the user's prompts,
// the model's content blocks (one record per block, merged by message.id), tool results, and
// bookkeeping (titles, modes, file snapshots). Records link to their parent by uuid; a resubmitted
// prompt or a rewind starts a new branch from an older record, so what the session shows is the
// path from the last record back to the first, plus the results of parallel tool calls, each linked
// to its own call. A compaction restarts the chain (parentUuid null) and keeps the old one as its
// logicalParentUuid.
//
// The fold feeds those records to an AcpTranscript as ACP-shaped updates; tool calls carry the pi
// calls they stand for (`_meta.piCalls`), so the thread's tool views apply.

import type { AskAnswer, AskDetails } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { TranscriptOptions } from '../acp/transcript'
import { closeSync, openSync, readSync } from 'node:fs'
import { claudeTokens, pricedModel } from 'pi-capabilities/lib/prices.ts'
import { AcpTranscript, askQuestions } from '../acp/transcript'
import { priceList } from '../prices'

export interface ClaudeRecord {
    type: string
    uuid?: string
    parentUuid?: string | null
    logicalParentUuid?: string | null
    isSidechain?: boolean
    isMeta?: boolean
    isCompactSummary?: boolean
    subtype?: string
    message?: any
    toolUseResult?: any
    origin?: { kind?: string }
    compactMetadata?: { preTokens?: number }
    timestamp?: string
    [key: string]: unknown
}

/** What a session file says besides its messages. */
export interface ClaudeMeta {
    /** The user's name for it (/rename), else the one Claude Code made up. */
    customTitle?: string
    aiTitle?: string
    model?: string
    permissionMode?: string
    cwd?: string
    firstPrompt?: string
    /** Seconds its prompt cache lives: an hour once it wrote one-hour entries (a subscription does), else the model's. */
    cacheTtl?: number
}

const INTERRUPTED = '[Request interrupted by user'

/** Complete lines of `text` as records; `rest` is the unfinished last line, read again with more. */
export function parseLines(text: string): { records: ClaudeRecord[], rest: string } {
    const lines = text.split('\n')
    const rest = lines.pop() ?? ''
    const records: ClaudeRecord[] = []
    for (const line of lines) {
        if (!line.trim())
            continue
        try {
            const record = JSON.parse(line)
            if (record && typeof record === 'object' && typeof record.type === 'string')
                records.push(slim(record))
        }
        catch {}
    }
    return { records, rest }
}

const CHUNK = 4 * 1024 * 1024

/**
 * Reads the file from byte `offset` on, in chunks (a long session outgrows one string). Returns the
 * complete records and the offset after the last complete line: a line still being written is read
 * again next time.
 */
export function readRecords(file: string, offset = 0): { records: ClaudeRecord[], offset: number } {
    let fd: number
    try {
        fd = openSync(file, 'r')
    }
    catch {
        return { records: [], offset }
    }
    const records: ClaudeRecord[] = []
    let carry = Buffer.alloc(0)
    let position = offset
    let consumed = offset
    try {
        for (;;) {
            const chunk = Buffer.alloc(CHUNK)
            const n = readSync(fd, chunk, 0, CHUNK, position)
            if (n <= 0)
                break
            position += n
            const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n)
            // Lines end in a newline byte, which no UTF-8 sequence contains: cut there and decode.
            const end = data.lastIndexOf(0x0A) + 1
            if (end > 0)
                records.push(...parseLines(data.toString('utf8', 0, end)).records)
            carry = Buffer.from(data.subarray(end))
            consumed = position - carry.length
        }
    }
    finally {
        closeSync(fd)
    }
    return { records, offset: consumed }
}

/** The parts of toolUseResult the fold reads; the rest (whole files before an edit) can be large. */
const RESULT_KEYS = ['stdout', 'stderr', 'answers', 'type'] as const

/** A record with only what the fold reads: long sessions run to hundreds of megabytes. */
function slim(r: ClaudeRecord): ClaudeRecord {
    if (r.type === 'attachment' || r.type === 'file-history-snapshot' || r.type === 'file-history-delta') {
        const a = r.attachment as any
        // A prompt typed while a turn ran, handed to the model between its steps.
        const queued = a?.type === 'queued_command' && a.origin?.kind === 'human' && typeof a.prompt === 'string' ? { attachment: { type: a.type, prompt: a.prompt } } : {}
        return { type: r.type, uuid: r.uuid, parentUuid: r.parentUuid, isSidechain: r.isSidechain, ...queued }
    }
    const tur = r.toolUseResult
    if (tur && typeof tur === 'object') {
        const kept: Record<string, unknown> = {}
        for (const key of RESULT_KEYS) {
            if (tur[key] !== undefined)
                kept[key] = tur[key]
        }
        if (tur.type === 'text' && typeof tur.file?.content === 'string')
            kept.file = { content: tur.file.content }
        r.toolUseResult = kept
    }
    return r
}

/** Records that take part in the conversation's chain. */
const chained = (r: ClaudeRecord) => !!r.uuid && !r.isSidechain && (r.type === 'user' || r.type === 'assistant' || r.type === 'system' || r.type === 'attachment')

const blocksOf = (r: ClaudeRecord): any[] => (Array.isArray(r.message?.content) ? r.message.content : [])

/** The tool_use ids a user record answers. */
function resultIds(r: ClaudeRecord): string[] {
    return r.type === 'user' ? blocksOf(r).filter(b => b?.type === 'tool_result' && typeof b.tool_use_id === 'string').map(b => b.tool_use_id) : []
}

/**
 * The records the session shows, in file order: the path from the last chained record back to the
 * root, plus tool results answering a call on that path (parallel calls hang off their own call).
 */
export function activePath(records: readonly ClaudeRecord[]): ClaudeRecord[] {
    const byUuid = new Map<string, ClaudeRecord>()
    const position = new Map<string, number>()
    const chain: ClaudeRecord[] = []
    for (const r of records) {
        if (!chained(r))
            continue
        byUuid.set(r.uuid!, r)
        position.set(r.uuid!, chain.length)
        chain.push(r)
    }
    const onPath = new Set<string>()
    for (let r: ClaudeRecord | undefined = chain[chain.length - 1]; r && !onPath.has(r.uuid!);) {
        onPath.add(r.uuid!)
        let parent: string | undefined = r.parentUuid ?? undefined
        // A compaction's logicalParentUuid often names a record written after it; the conversation
        // it continues is the one that ended just before it in the file.
        if (!parent && r.subtype === 'compact_boundary') {
            const at: number = position.get(r.uuid!)!
            const logical: string = r.logicalParentUuid ?? ''
            parent = (position.get(logical) ?? at) < at ? logical : chain[at - 1]?.uuid
        }
        r = parent ? byUuid.get(parent) : undefined
    }
    const calls = new Set<string>()
    for (const r of records) {
        if (r.type === 'assistant' && r.uuid && onPath.has(r.uuid)) {
            for (const b of blocksOf(r)) {
                if (b?.type === 'tool_use' || b?.type === 'server_tool_use')
                    calls.add(b.id)
            }
        }
    }
    const seenResult = new Set<string>()
    return records.filter((r) => {
        if (!chained(r))
            return false
        const ids = resultIds(r)
        if (ids.length) {
            // A result shows once, wherever it hangs; results for calls off the path do not.
            const fresh = ids.filter(id => calls.has(id) && !seenResult.has(id))
            if (!fresh.length)
                return false
            fresh.forEach(id => seenResult.add(id))
            return true
        }
        return onPath.has(r.uuid!)
    })
}

// ---------------------------------------------------------------- tool calls

const call = (id: string, name: string, args: Record<string, any>): ToolCall => ({ type: 'toolCall', id, name, arguments: args })
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const textContent = (t: string) => [{ type: 'content', content: { type: 'text', text: t } }]

const TODO_STATUS: Record<string, string> = { completed: 'done', in_progress: 'in_progress' }

/** How a Claude Code tool call reads as pi calls. */
export function claudeCalls(id: string, name: string, input: any): ToolCall[] {
    const i = input && typeof input === 'object' ? input : {}
    switch (name) {
        case 'Bash':
            return [call(id, 'bash', { command: str(i.command), ...(i.description ? { description: i.description } : {}) })]
        case 'Read':
            return [call(id, 'read', { path: str(i.file_path), ...(i.offset != null ? { offset: i.offset } : {}), ...(i.limit != null ? { limit: i.limit } : {}) })]
        case 'Write':
            return [call(id, 'write', { path: str(i.file_path), content: str(i.content) })]
        case 'Edit':
            return [call(id, 'edit', { path: str(i.file_path), oldText: str(i.old_string), newText: str(i.new_string) })]
        case 'MultiEdit':
            return (Array.isArray(i.edits) ? i.edits : []).map((e: any, n: number) => call(n ? `${id}#${n}` : id, 'edit', { path: str(i.file_path), oldText: str(e?.old_string), newText: str(e?.new_string) }))
        case 'Grep':
            return [call(id, 'grep', { pattern: str(i.pattern), ...(i.path ? { path: i.path } : {}), ...(i.glob ? { glob: i.glob } : {}) })]
        case 'Glob':
            return [call(id, 'find', { pattern: str(i.pattern), ...(i.path ? { path: i.path } : {}) })]
        case 'TodoWrite':
            return [call(id, 'todo', { items: (Array.isArray(i.todos) ? i.todos : []).map((t: any) => ({ text: str(t?.content), status: TODO_STATUS[t?.status] ?? 'pending' })) })]
        case 'AskUserQuestion':
            return [call(id, 'ask', { questions: askQuestions(i.questions) })]
        case 'WebSearch':
            return [call(id, 'web_search', { query: str(i.query) })]
        case 'WebFetch':
            return [call(id, 'web_fetch', { url: str(i.url), ...(i.prompt ? { prompt: i.prompt } : {}) })]
        case 'Task':
        case 'Agent':
            return [call(id, 'agent', { description: str(i.description), ...(i.prompt ? { task: i.prompt } : {}) })]
        default:
            return [call(id, name, i)]
    }
}

/** A tool result's content as ACP content blocks (text and images). */
function resultContent(block: any, record: ClaudeRecord, name: string): any[] {
    const tur = record.toolUseResult
    if (name === 'Bash' && tur && typeof tur === 'object' && (typeof tur.stdout === 'string' || typeof tur.stderr === 'string')) {
        const out = [str(tur.stdout), str(tur.stderr)].filter(Boolean).join('\n')
        return out ? textContent(out) : []
    }
    if (name === 'Read' && tur?.type === 'text' && typeof tur.file?.content === 'string')
        return textContent(tur.file.content)
    const raw = block.content
    if (typeof raw === 'string')
        return raw ? textContent(raw) : []
    return (Array.isArray(raw) ? raw : []).flatMap((c: any): any[] => {
        if (c?.type === 'text' && typeof c.text === 'string')
            return textContent(c.text)
        if (c?.type === 'image' && typeof c.source?.data === 'string')
            return [{ type: 'content', content: { type: 'image', data: c.source.data, mimeType: str(c.source.media_type) || 'image/png' } }]
        return []
    })
}

/** An AskUserQuestion's result: the labels picked, by question. */
function askDetails(input: any, record: ClaudeRecord, isError: boolean): AskDetails {
    const questions = askQuestions(input?.questions)
    const raw = record.toolUseResult?.answers
    if (isError || !raw || typeof raw !== 'object')
        return { kind: 'ask', status: 'cancelled', questions }
    const answers: Record<string, AskAnswer> = {}
    for (const q of questions) {
        const value = raw[q.question]
        if (typeof value !== 'string' || !value)
            continue
        const picked = value.split(', ')
        const selected = picked.filter(p => q.options.includes(p))
        answers[q.id] = selected.length === picked.length ? { selected } : { selected: [], text: value }
    }
    return { kind: 'ask', status: 'answered', questions, answers }
}

// ---------------------------------------------------------------- the fold

/** The text a user record shows: a prompt, a slash command, a shell command; '' for none. */
function userText(r: ClaudeRecord): string {
    const content = r.message?.content
    const t = typeof content === 'string' ? content : blocksOf(r).filter(b => b?.type === 'text').map(b => str(b.text)).join('\n')
    const command = /<command-name>([^<]*)<\/command-name>/.exec(t)
    if (command) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
        return args ? `${command[1]} ${args}` : command[1]
    }
    const bash = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(t.trim())
    if (bash)
        return `!${bash[1]}`
    if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|local-command-caveat)>/.test(t.trim()))
        return ''
    return t
}

/** What a local slash command printed (`<local-command-stdout>`), without the colour codes; '' if r is not that. */
function commandOutput(r: ClaudeRecord): string {
    const content = r.message?.content ?? r.content
    const t = typeof content === 'string' ? content : blocksOf(r).filter(b => b?.type === 'text').map(b => str(b.text)).join('\n')
    const m = /^<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>$/.exec(t.trim())
    // eslint-disable-next-line no-control-regex
    const plain = m ? m[1].replace(/\u001B\[[0-9;]*[A-Za-z]/g, '') : ''
    // Claude Code lists the hooks that ran ("PreCompact [<url>] completed successfully"): ours are not the user's to see.
    return plain.split('\n').filter(line => !line.includes('/claude-hook/')).join('\n')
}

function imagesOf(r: ClaudeRecord) {
    return blocksOf(r)
        .filter(b => b?.type === 'image' && typeof b.source?.data === 'string')
        .map(b => ({ type: 'image' as const, data: b.source.data as string, mimeType: str(b.source.media_type) || 'image/png' }))
}


/** Records → transcript updates, one record at a time. */
export class ClaudeFold {
    readonly transcript: AcpTranscript
    readonly meta: ClaudeMeta = {}
    /** A prompt is being answered (no turn_duration or interrupt after it yet). */
    turnOpen = false
    /** Prompts folded so far (the adapter waits for the one it saw submitted). */
    prompts = 0
    /** Compaction summaries read so far: the adapter waits for the next one after PostCompact. */
    compactions = 0
    /** What local commands printed so far: a command that ends without a PostCompact ("Not enough messages to compact") is known by it. */
    outputs = 0
    /**
     * Prompts that went to the model (not a local /command or !shell): each was a UserPromptSubmit,
     * so the adapter can tell hooks that never come.
     */
    asked = 0
    private tools = new Map<string, { name: string, input: any }>()
    private compactTokens = 0
    /** Text already shown for the block being streamed (MessageDisplay), which its record then completes. */
    private preview = ''
    /** The streamed message (MessageDisplay's message_id), and those whose record landed already. */
    private streamKey = ''
    private streamed = new Set<string>()

    /** The time of the record being folded: messages carry the session's times, not the reader's. */
    private at = 0

    constructor(prefix: string, options: TranscriptOptions = {}) {
        this.transcript = new AcpTranscript(prefix, {
            ...options,
            inputIncludesCache: false,
            now: () => this.at || Date.now(),
            model: () => ({ provider: 'Claude Code', model: this.meta.model }),
            price: () => pricedModel(priceList(), 'claude', this.meta.model)?.cost,
        })
    }

    /** Bookkeeping records (titles, modes); they hold no messages. */
    note(r: ClaudeRecord) {
        if (r.type === 'custom-title' && typeof r.customTitle === 'string')
            this.meta.customTitle = r.customTitle
        else if (r.type === 'ai-title' && typeof r.aiTitle === 'string')
            this.meta.aiTitle = r.aiTitle
        else if (r.type === 'permission-mode' && typeof r.permissionMode === 'string')
            this.meta.permissionMode = r.permissionMode
        if (typeof r.cwd === 'string' && !this.meta.cwd)
            this.meta.cwd = r.cwd
    }

    /** Streamed text of the reply being written (MessageDisplay), before its record lands. */
    stream(delta: string, key = '') {
        // A late piece of a message whose record is in already would show twice.
        if (!delta || (key && this.streamed.has(key)))
            return
        this.streamKey = key
        this.preview += delta
        this.transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } })
    }

    /** One record of the active path. */
    add(r: ClaudeRecord) {
        const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
        if (Number.isFinite(at))
            this.at = at
        this.note(r)
        if (r.type === 'assistant')
            this.assistant(r)
        else if (r.type === 'user')
            this.user(r)
        else if (r.type === 'system')
            this.system(r)
        else if (r.type === 'attachment' && typeof (r.attachment as any)?.prompt === 'string') {
            this.endStream()
            const prompt: string = (r.attachment as any).prompt
            this.transcript.userPrompt(prompt)
            this.prompts++
            if (!prompt.startsWith('/') && !prompt.startsWith('!'))
                this.asked++
        }
    }

    /** Closes what a turn left open (the session is not running any more). */
    settle() {
        if (this.turnOpen || this.transcript.running) {
            this.transcript.finish('end_turn')
            this.turnOpen = false
        }
        this.endStream()
    }

    private endStream() {
        if (this.streamKey)
            this.streamed.add(this.streamKey)
        this.streamKey = ''
        this.preview = ''
    }

    private assistant(r: ClaudeRecord) {
        const message = r.message ?? {}
        if (typeof message.model === 'string' && message.model !== '<synthetic>')
            this.meta.model = message.model
        for (const b of blocksOf(r)) {
            if (b?.type === 'text' && typeof b.text === 'string') {
                // The streamed preview is the start of this text; only the rest is new.
                const t = this.preview && b.text.startsWith(this.preview) ? b.text.slice(this.preview.length) : b.text
                this.endStream()
                if (t)
                    this.transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
            }
            else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
                this.transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: b.thinking } })
            }
            else if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && typeof b.id === 'string') {
                this.endStream()
                this.tools.set(b.id, { name: String(b.name ?? ''), input: b.input })
                const calls = claudeCalls(b.id, String(b.name ?? 'tool'), b.input)
                this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: b.id, title: String(b.name ?? ''), rawInput: b.input, status: 'in_progress', _meta: { piCalls: calls } })
            }
            else if (b?.type === 'web_search_tool_result' && typeof b.tool_use_id === 'string') {
                const urls = (Array.isArray(b.content) ? b.content : []).map((c: any) => str(c?.url)).filter(Boolean).join('\n')
                this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: b.tool_use_id, status: 'completed', content: textContent(urls) })
            }
        }
        // A record per content block, each with the request's usage so far, on the reply its blocks went to.
        const tokens = claudeTokens(message.usage)
        if (tokens && typeof message.id === 'string') {
            this.transcript.requestUsage(message.id, { inputTokens: tokens.input, outputTokens: tokens.output, cachedReadTokens: tokens.cacheRead, cachedWriteTokens: tokens.cacheWrite, cachedWrite1hTokens: tokens.cacheWrite1h, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite })
            if (tokens.cacheWrite1h)
                this.meta.cacheTtl = 3600
        }
    }

    private user(r: ClaudeRecord) {
        const results = blocksOf(r).filter(b => b?.type === 'tool_result')
        if (results.length) {
            for (const b of results) {
                const tool = this.tools.get(b.tool_use_id)
                const isError = b.is_error === true
                const content = resultContent(b, r, tool?.name ?? '')
                const details = tool?.name === 'AskUserQuestion' ? { [b.tool_use_id]: askDetails(tool.input, r, isError) } : undefined
                this.transcript.update({
                    sessionUpdate: 'tool_call_update',
                    toolCallId: b.tool_use_id,
                    status: isError ? 'failed' : 'completed',
                    content,
                    ...(tool?.name === 'Bash' ? { rawOutput: { exitCode: isError ? 1 : 0 } } : {}),
                    ...(details ? { _meta: { piDetails: details } } : {}),
                })
            }
            return
        }
        if (r.isCompactSummary) {
            const content = r.message?.content
            const summary = typeof content === 'string' ? content : blocksOf(r).filter(b => b?.type === 'text').map(b => str(b.text)).join('\n')
            this.transcript.compaction(summary, this.compactTokens)
            this.compactTokens = 0
            this.compactions++
            return
        }
        if (r.isMeta || r.origin?.kind === 'task-notification')
            return
        const output = commandOutput(r)
        if (output) {
            this.outputs++
            this.transcript.commandOutput(output)
            return
        }
        const text = userText(r)
        if (text.startsWith(INTERRUPTED)) {
            this.endStream()
            this.transcript.finish('cancelled')
            this.turnOpen = false
            return
        }
        const images = imagesOf(r)
        if (!text && !images.length)
            return
        this.endStream()
        this.transcript.userPrompt(text, images)
        this.prompts++
        this.meta.firstPrompt ??= text
        // Slash commands that run locally end at once; the rest are answered like prompts.
        this.turnOpen = !text.startsWith('/') && !text.startsWith('!')
        if (this.turnOpen)
            this.asked++
    }

    private system(r: ClaudeRecord) {
        if (r.subtype === 'turn_duration') {
            this.endStream()
            this.transcript.finish('end_turn')
            this.turnOpen = false
        }
        else if (r.subtype === 'compact_boundary') {
            this.compactTokens = r.compactMetadata?.preTokens ?? 0
        }
        else if (r.subtype === 'local_command' && typeof r.content === 'string') {
            const output = commandOutput(r)
            const text = userText({ type: 'user', message: { content: r.content } })
            if (output) {
                this.outputs++
                this.transcript.commandOutput(output)
            }
            else if (text) {
                this.transcript.userPrompt(text)
                this.meta.firstPrompt ??= text
            }
        }
        else if (r.subtype === 'informational' && typeof r.content === 'string') {
            // A command Claude Code does not know leaves no prompt record, only this line.
            const unknown = /^Unknown command: (\/\S+)/.exec(r.content)
            if (unknown) {
                this.transcript.userPrompt(unknown[1])
                this.transcript.commandOutput(r.content)
            }
        }
    }
}

/**
 * The whole session file as a transcript that follows it as it grows: records land in batches, and
 * the fold takes the new ones when they extend what it shows, or starts over (silently) when the
 * session moved to another branch (a rewind, a resubmitted prompt).
 */
export class ClaudeLog {
    readonly records: ClaudeRecord[] = []
    fold: ClaudeFold
    private shown: string[] = []

    constructor(private prefix: string, private options: TranscriptOptions = {}) {
        this.fold = new ClaudeFold(prefix, options)
    }

    /** Takes new records; true when the transcript was rebuilt rather than extended. */
    add(records: readonly ClaudeRecord[]): boolean {
        if (!records.length)
            return false
        this.records.push(...records)
        for (const r of records) {
            if (!chained(r))
                this.fold.note(r)
        }
        const path = activePath(this.records)
        const extends_ = this.shown.length <= path.length && this.shown.every((uuid, i) => path[i].uuid === uuid)
        if (extends_) {
            for (const r of path.slice(this.shown.length))
                this.fold.add(r)
            this.shown = path.map(r => r.uuid!)
            return false
        }
        this.rebuild(path)
        return true
    }

    /** Folds the active path again from the start, with no events (the thread reloads it). */
    rebuild(path = activePath(this.records)) {
        const fold = new ClaudeFold(this.prefix, { ...this.options, emit: undefined })
        for (const r of this.records) {
            if (!chained(r))
                fold.note(r)
        }
        for (const r of path)
            fold.add(r)
        fold.transcript.setEmitter(this.options.emit ?? (() => {}))
        this.fold = fold
        this.shown = path.map(r => r.uuid!)
    }

    get transcript(): AcpTranscript {
        return this.fold.transcript
    }

    get meta(): ClaudeMeta {
        return this.fold.meta
    }
}
