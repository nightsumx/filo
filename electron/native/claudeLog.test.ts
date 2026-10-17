import type { PiEvent } from '@shared/pi'
import type { ClaudeRecord } from './claudeLog'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { activePath, ClaudeLog, readRecords } from './claudeLog'

// Record shapes as claude 2.1.285 writes them (checked against a session driven through its TUI).
let n = 0
const at = () => new Date(Date.UTC(2026, 9, 9, 12, 0, n)).toISOString()
function rec(type: string, parent: string | null, extra: Partial<ClaudeRecord> = {}): ClaudeRecord {
    n++
    return { type, uuid: `u${n}`, parentUuid: parent, isSidechain: false, timestamp: at(), ...extra }
}
const prompt = (parent: string | null, text: string) => rec('user', parent, { message: { role: 'user', content: text }, origin: { kind: 'human' }, promptId: 'p' })
const reply = (parent: string, id: string, block: any) => rec('assistant', parent, { message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [block], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } })
const result = (parent: string, id: string, text: string, tur?: any, isError = false) => rec('user', parent, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] }, toolUseResult: tur })
const done = (parent: string) => rec('system', parent, { subtype: 'turn_duration', durationMs: 10 })

const roles = (log: ClaudeLog) => log.transcript.messages.map(m => m.message.role)

describe('claude session file', () => {
    it('shows a command Claude Code does not know, with its answer', () => {
        const a = rec('system', null, { subtype: 'informational', content: 'Unknown command: /zzz', level: 'warning' })
        const b = rec('system', a.uuid!, { subtype: 'informational', content: 'Auto mode lets Claude handle permission prompts', level: 'info' })
        const log = new ClaudeLog('k:')
        log.add([a, b])
        expect(log.transcript.messages.map(m => m.message)).toMatchObject([
            { role: 'user', content: [{ type: 'text', text: '/zzz' }] },
            { role: 'custom', customType: '/zzz', content: 'Unknown command: /zzz', display: true },
        ])
    })

    it('shows what a local slash command printed, under the command', () => {
        const a = rec('user', null, { message: { role: 'user', content: '<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>' } })
        const b = rec('user', a.uuid!, { message: { role: 'user', content: '<local-command-stdout>Total cost: \u001B[1m$0.42\u001B[0m</local-command-stdout>' } })
        const c = rec('user', b.uuid!, { message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } })
        const log = new ClaudeLog('k:')
        log.add([a, b, c])
        expect(log.transcript.messages.map(m => m.message)).toMatchObject([
            { role: 'user', content: [{ type: 'text', text: '/cost' }] },
            { role: 'custom', customType: '/cost', content: 'Total cost: $0.42', display: true },
        ])
    })

    it('folds a turn: prompt, text, a command with its output, the closing text', () => {
        const a = prompt(null, 'BASH1 now')
        const b = reply(a.uuid!, 'msg_1', { type: 'text', text: 'Running command 1.' })
        const c = reply(b.uuid!, 'msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'touch made1.txt', description: 'Make file 1' } })
        const d = result(c.uuid!, 'toolu_1', '(Bash completed with no output)', { stdout: 'made\n', stderr: '', interrupted: false })
        const e = reply(d.uuid!, 'msg_2', { type: 'text', text: 'All done.' })
        const log = new ClaudeLog('k:')
        log.add([a, rec('attachment', a.uuid!), b, c, d, e, done(e.uuid!), { type: 'ai-title', aiTitle: 'Make a file' }])
        expect(roles(log)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
        const [user, first, out, last] = log.transcript.messages.map(m => m.message) as any[]
        expect(user.content).toEqual([{ type: 'text', text: 'BASH1 now' }])
        expect(first.content).toEqual([{ type: 'text', text: 'Running command 1.' }, { type: 'toolCall', id: 'toolu_1', name: 'bash', arguments: { command: 'touch made1.txt', description: 'Make file 1' } }])
        expect(out.content).toEqual([{ type: 'text', text: 'made\n' }])
        expect(out.isError).toBe(false)
        expect(last.stopReason).toBe('stop')
        // Each request on its own reply, as in pi; msg_1's two records count once.
        expect(first.usage).toMatchObject({ input: 10, output: 5, cacheRead: 2 })
        expect(last.usage).toMatchObject({ input: 10, output: 5, cacheRead: 2 })
        expect(log.meta.aiTitle).toBe('Make a file')
        expect(log.fold.turnOpen).toBe(false)
        // Times are the session's.
        expect(log.transcript.messages[0].message.timestamp).toBe(Date.parse(a.timestamp!))
    })

    it('a turn without turn_duration is still open; an interrupt closes it as aborted', () => {
        const a = prompt(null, 'SLOW story')
        const b = reply(a.uuid!, 'msg_1', { type: 'text', text: 'Slow line 0.\nS' })
        const log = new ClaudeLog('k:')
        log.add([a, b])
        expect(log.fold.turnOpen).toBe(true)
        log.add([rec('user', b.uuid!, { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })])
        expect(log.fold.turnOpen).toBe(false)
        expect(roles(log)).toEqual(['user', 'assistant'])
        expect((log.transcript.messages[1].message as any).stopReason).toBe('aborted')
    })

    it('a resubmitted prompt shows its own branch, not the one it replaced', () => {
        const a = prompt(null, 'first')
        const b = reply(a.uuid!, 'msg_1', { type: 'text', text: 'one' })
        const c = done(b.uuid!)
        const abandoned = prompt(c.uuid!, 'typo')
        const replacement = prompt(c.uuid!, 'fixed')
        const d = reply(replacement.uuid!, 'msg_2', { type: 'text', text: 'two' })
        const texts = activePath([a, b, c, abandoned, replacement, d]).map(r => r.uuid)
        expect(texts).toEqual([a.uuid, b.uuid, c.uuid, replacement.uuid, d.uuid])

        // Live: the abandoned prompt showed first; the replacement rebuilds the transcript.
        const log = new ClaudeLog('k:')
        log.add([a, b, c, abandoned])
        expect(log.add([replacement, d])).toBe(true)
        log.fold.settle()
        expect(log.transcript.messages.map(m => (m.message as any).content[0].text)).toEqual(['first', 'one', 'fixed', 'two'])
    })

    it('parallel calls: each result hangs off its own call and still shows', () => {
        const a = prompt(null, 'two reads')
        const b = reply(a.uuid!, 'msg_1', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a' } })
        const c = reply(b.uuid!, 'msg_1', { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/b' } })
        const r1 = result(b.uuid!, 't1', 'A', { type: 'text', file: { content: 'A' } })
        const r2 = result(c.uuid!, 't2', 'B', { type: 'text', file: { content: 'B' } })
        const d = reply(r2.uuid!, 'msg_2', { type: 'text', text: 'read both' })
        const log = new ClaudeLog('k:')
        log.add([a, b, c, r1, r2, d, done(d.uuid!)])
        expect(roles(log)).toEqual(['user', 'assistant', 'toolResult', 'toolResult', 'assistant'])
        expect((log.transcript.messages[1].message as any).content.map((c: any) => c.arguments.path)).toEqual(['/w/a', '/w/b'])
    })

    it('a compaction keeps the conversation before it and notes the summary', () => {
        const a = prompt(null, 'before')
        const b = reply(a.uuid!, 'msg_1', { type: 'text', text: 'old' })
        const c = done(b.uuid!)
        // logicalParentUuid can name a record written after the boundary.
        const boundary = rec('system', null, { subtype: 'compact_boundary', logicalParentUuid: 'later', compactMetadata: { preTokens: 5000 } })
        const summary = rec('user', boundary.uuid!, { isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } })
        const after = prompt(summary.uuid!, 'after')
        const log = new ClaudeLog('k:')
        log.add([a, b, c, boundary, summary, after])
        expect(roles(log)).toEqual(['user', 'assistant', 'compactionSummary', 'user'])
        expect(log.transcript.messages[2].message).toMatchObject({ summary: 'This session is being continued…', tokensBefore: 5000 })
    })

    it('slash commands, shell commands and meta records', () => {
        const a = rec('user', null, { isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } })
        const b = rec('user', a.uuid!, { message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } })
        const c = rec('user', b.uuid!, { message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } })
        const d = rec('user', c.uuid!, { message: { role: 'user', content: '<bash-input>ls</bash-input>' } })
        const log = new ClaudeLog('k:')
        log.add([a, b, c, d])
        // The caveat is meta and dropped; what /model printed is a note under it.
        expect(log.transcript.messages.map(m => (m.message as any).content[0]?.text ?? (m.message as any).content)).toEqual(['/model opus', 'Set model', '!ls'])
        expect(log.fold.turnOpen).toBe(false)
    })

    it('a prompt typed during a turn shows where the model got it', () => {
        const a = prompt(null, 'SLOW story')
        const b = reply(a.uuid!, 'msg_1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 1' } })
        const r = result(b.uuid!, 't1', '', { stdout: '', stderr: '' })
        const q = rec('attachment', r.uuid!, { attachment: { type: 'queued_command', prompt: 'QUEUED one', origin: { kind: 'human' } } })
        const c = reply(q.uuid!, 'msg_2', { type: 'text', text: 'ok' })
        const log = new ClaudeLog('k:')
        const { records } = writeAndRead([a, b, r, q, c])
        log.add(records)
        log.fold.settle()
        expect(log.transcript.messages.map(m => m.message.role)).toEqual(['user', 'assistant', 'toolResult', 'user', 'assistant'])
        expect((log.transcript.messages[3].message as any).content[0].text).toBe('QUEUED one')
    })

    it('an AskUserQuestion result becomes the ask view\'s answers', () => {
        const questions = [{ question: 'Pick a colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }]
        const a = prompt(null, 'ASK me')
        const b = reply(a.uuid!, 'msg_1', { type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions } })
        const r = result(b.uuid!, 'ask1', 'User has answered…', { questions, answers: { 'Pick a colour?': 'Blue' } })
        const log = new ClaudeLog('k:')
        log.add([a, b, r])
        const out = log.transcript.messages[2].message as any
        expect(out.toolName).toBe('ask')
        expect(out.details).toEqual({ kind: 'ask', status: 'answered', questions: [{ id: 'Pick a colour?', question: 'Pick a colour?', options: ['Red', 'Blue'] }], answers: { 'Pick a colour?': { selected: ['Blue'] } } })
    })

    it('streamed text (MessageDisplay) is completed, not repeated, by its record', () => {
        const events: PiEvent[] = []
        const log = new ClaudeLog('k:', { emit: e => events.push(e) })
        const a = prompt(null, 'hi')
        log.add([a])
        log.fold.stream('Hello from the fake model.\n')
        expect(log.transcript.streaming?.content).toEqual([{ type: 'text', text: 'Hello from the fake model.\n' }])
        log.add([reply(a.uuid!, 'msg_1', { type: 'text', text: 'Hello from the fake model.\nLine two.' })])
        log.fold.settle()
        expect((log.transcript.messages[1].message as any).content).toEqual([{ type: 'text', text: 'Hello from the fake model.\nLine two.' }])
        const deltas = events.filter(e => e.type === 'message_update').map(e => (e as any).assistantMessageEvent.delta).filter(Boolean)
        expect(deltas.join('')).toBe('Hello from the fake model.\nLine two.')
    })

    it('reads a growing file from an offset, leaving a half-written line for later', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-log-'))
        try {
            const file = path.join(dir, 's.jsonl')
            const a = prompt(null, '多字节 ✓')
            const line = JSON.stringify(a)
            writeFileSync(file, `${line}\n${line.slice(0, 10)}`)
            const first = readRecords(file)
            expect(first.records.map(r => r.uuid)).toEqual([a.uuid])
            expect(first.offset).toBe(Buffer.byteLength(line) + 1)
            appendFileSync(file, `${line.slice(10)}\n`)
            const second = readRecords(file, first.offset)
            expect(second.records.map(r => (r.message as any).content)).toEqual(['多字节 ✓'])
        }
        finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

/** Round trip through a file, as the adapter reads them (slimmed). */
function writeAndRead(records: ClaudeRecord[]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-log-'))
    try {
        const file = path.join(dir, 's.jsonl')
        writeFileSync(file, records.map(r => `${JSON.stringify(r)}\n`).join(''))
        return readRecords(file)
    }
    finally {
        rmSync(dir, { recursive: true, force: true })
    }
}
