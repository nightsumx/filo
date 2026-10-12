import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { platform } from '../platform'
import { CursorChats, cursorPrompt, GeminiChats, geminiSession } from './cliSessions'

let shellPath = ''
vi.mock('../pi-env', () => ({ loginShellPath: async () => shellPath }))

const { AcpService } = await import('./service')

const jsonl = (...lines: unknown[]) => `${lines.map(l => JSON.stringify(l)).join('\n')}\n`

// As cursor-agent 2026.10.01 writes them (one `-p` chat that read a file).
async function cursorChat(home: string, id: string, cwd: string, prompt: string) {
    const chat = path.join(home, '.cursor', 'chats', 'd5271b8a09404bb4a90fce4b1ef126e0', id)
    await mkdir(chat, { recursive: true })
    await writeFile(path.join(chat, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: 1791560387513, hasConversation: true, updatedAtMs: 1791560400505, cwd }))
    const dir = path.join(home, '.cursor', 'projects', cwd.slice(1).replace(/\//g, '-'), 'agent-transcripts', id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${id}.jsonl`), jsonl(
        { role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Friday, Oct 9, 2026, 11:39 PM (UTC+8)</timestamp>\n<user_query>\n${prompt}\n</user_query>` }] } },
        { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: `${cwd}/package.json`, limit: 20 } }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'filo' }] } },
        { type: 'turn_ended', status: 'success' },
    ))
}

// As Gemini CLI 0.63.0 writes them: a header, the preamble, then messages and $set patches.
async function geminiChat(home: string, project: string, cwd: string, id: string, prompt?: string) {
    const dir = path.join(home, '.gemini', 'tmp', project)
    await mkdir(path.join(dir, 'chats'), { recursive: true })
    await writeFile(path.join(dir, '.project_root'), cwd)
    const preamble = { id: 'p', timestamp: '2026-10-09T15:35:05.772Z', type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.\n</session_context>' }] }
    await writeFile(path.join(dir, 'chats', `session-2026-10-09T15-35-${id.slice(0, 8)}.jsonl`), jsonl(
        { sessionId: id, projectHash: 'h', startTime: '2026-10-09T15:35:05.771Z', lastUpdated: '2026-10-09T15:35:05.771Z', kind: 'main' },
        { $set: { messages: [preamble] } },
        ...prompt
            ? [
                    { id: 'u', timestamp: '2026-10-09T15:36:27.045Z', type: 'user', content: [{ text: prompt }] },
                    { $set: { lastUpdated: '2026-10-09T15:36:27.046Z' } },
                    { id: 'g', timestamp: '2026-10-09T15:36:27.064Z', type: 'gemini', content: 'reply', thoughts: [], model: 'gemini-3.1-pro-preview' },
                    { $set: { lastUpdated: '2026-10-09T15:36:27.065Z' } },
                ]
            : [],
    ))
}

describe('terminal chats in the agents\' own files', () => {
    let home: string
    beforeEach(async () => {
        home = await mkdtemp(path.join(os.tmpdir(), 'pi-cli-sessions-'))
    })
    afterEach(async () => {
        await rm(home, { recursive: true, force: true })
    })

    it('unwraps Cursor\'s stored prompt', () => {
        expect(cursorPrompt('<timestamp>Friday</timestamp>\n<user_query>\nhi\nthere\n</user_query>')).toBe('hi\nthere')
        expect(cursorPrompt('<timestamp>Friday</timestamp>\nplain')).toBe('plain')
    })

    it('lists Cursor\'s terminal chats and reads one as the thread shows it', async () => {
        await cursorChat(home, '7e048bd9-a608-4010-9fcc-d9df4612368c', '/work/app', 'read package.json')
        // A chat that never got a message has no transcript.
        await mkdir(path.join(home, '.cursor', 'chats', 'x', 'empty'), { recursive: true })
        await writeFile(path.join(home, '.cursor', 'chats', 'x', 'empty', 'meta.json'), JSON.stringify({ hasConversation: false, cwd: '/work/app' }))
        const chats = new CursorChats(() => home)
        const { sessions, complete } = await chats.list()
        expect(complete).toBe(true)
        expect(sessions).toMatchObject([{ sessionId: '7e048bd9-a608-4010-9fcc-d9df4612368c', cwd: '/work/app', title: 'read package.json', updatedAt: 1791560400505, terminalOnly: true }])
        const items = (await chats.read('7e048bd9-a608-4010-9fcc-d9df4612368c'))!
        expect(items.map(i => i.message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
        expect(items[0].message).toMatchObject({ content: [{ type: 'text', text: 'read package.json' }] })
        expect((items[1].message as any).content).toMatchObject([{ type: 'toolCall', name: 'read', arguments: { path: '/work/app/package.json', limit: 20 } }])
        expect((items[3].message as any).content).toMatchObject([{ type: 'text', text: 'filo' }])
        expect(await chats.read('missing')).toBeUndefined()
    })

    it('lists Gemini\'s sessions by the project they belong to, without its preamble', async () => {
        await geminiChat(home, 'proj', '/work/app', '17ba4299-15eb-4c23-bfe4-b8e0578551d0', 'hello one')
        // Opened and left without a prompt: nothing to list.
        await geminiChat(home, 'proj', '/work/app', '7937a6ef-19fe-4b7f-b523-650f8922776c')
        const { sessions } = await new GeminiChats(() => home).list()
        expect(sessions).toEqual([{ sessionId: '17ba4299-15eb-4c23-bfe4-b8e0578551d0', cwd: '/work/app', title: 'hello one', updatedAt: Date.parse('2026-10-09T15:36:27.065Z') }])
    })

    it('reads Gemini\'s older one-object session files, and skips subagents\'', () => {
        const old = { sessionId: 's1', startTime: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-02T00:00:00Z', messages: [{ type: 'user', content: 'first' }] }
        expect(geminiSession(JSON.stringify(old), true)).toEqual({ sessionId: 's1', updatedAt: Date.parse('2026-01-02T00:00:00Z'), prompt: 'first' })
        expect(geminiSession(jsonl({ sessionId: 's2', kind: 'subagent' }, { type: 'user', content: [{ text: 'x' }] }), false)).toBeUndefined()
        expect(geminiSession('not json', true)).toBeUndefined()
    })

    describe('in the session index', () => {
        let dir: string
        beforeEach(async () => {
            dir = await mkdtemp(path.join(os.tmpdir(), 'pi-cli-index-'))
            await mkdir(path.join(dir, 'bin'))
            shellPath = path.join(dir, 'bin')
            // Agents that start and quit at once: their ACP list fails, the files still list.
            for (const name of ['cursor-agent', 'gemini']) {
                const file = path.join(dir, 'bin', platform.id === 'win32' ? `${name}.cmd` : name)
                await writeFile(file, platform.id === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
                await chmod(file, 0o755)
            }
        })
        afterEach(async () => {
            // The index may still be saving.
            await rm(dir, { recursive: true, force: true, maxRetries: 5 })
        })

        it('shows terminal chats read-only, and Gemini\'s as resumable', async () => {
            await cursorChat(home, 'c1', '/work/app', 'cursor prompt')
            await geminiChat(home, 'app', '/work/app', 'g1', 'gemini prompt')
            const service = new AcpService(() => path.join(dir, 'acp.json'), undefined, undefined, undefined, undefined, () => home)
            const list = await service.listSessions(new Set(['/work/app']))
            expect(list.filter(s => s.agent === 'cursor' || s.agent === 'gemini').map(s => [s.path, s.name])).toEqual(expect.arrayContaining([
                ['acp:cursor:c1', 'cursor prompt'],
                ['acp:gemini:g1', 'gemini prompt'],
            ]))
            const cursor = await service.readSession('acp:cursor:c1')
            expect(cursor.terminalOnly).toMatch(/cursor-agent"? --resume c1$/)
            expect(cursor.items.map(i => i.message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
            await expect(service.start('cursor', '/work/app', 'acp:cursor:c1', { onEvent: () => {}, onExit: () => {} } as any)).rejects.toThrow(/terminal|终端/)
            // The next pass, with the ACP list failing again: what it listed before stays.
            service.merge('cursor', [{ sessionId: 'acp1', cwd: '/work/app', updatedAt: 1 }, { sessionId: 'c1', cwd: '/work/app', updatedAt: 1, terminalOnly: true }], true)
            const later = Date.now() + 10 * 60_000
            vi.spyOn(Date, 'now').mockReturnValue(later)
            await service.importDue()
            vi.restoreAllMocks()
            expect(service.has('acp:cursor:acp1')).toBe(true)
            expect(service.has('acp:cursor:c1')).toBe(true)
            expect(service.has('acp:gemini:g1')).toBe(true)
        }, 20_000)
    })
})
