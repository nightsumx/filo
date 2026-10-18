import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importSession, parseSession, sessionDirFor, summarizeSession } from './sessions'

const lines = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n')

const header = { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo' }
const user = (id: string, parentId: string | null, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
})
const assistant = (id: string, parentId: string, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 2 },
})

describe('summarizeSession', () => {
    it('uses the first user prompt and the latest session name', () => {
        const text = lines(
            header,
            { type: 'model_change', id: 'm', parentId: null, timestamp: header.timestamp, provider: 'p', modelId: 'x' },
            user('u1', 'm', '  fix the build  '),
            { type: 'session_info', id: 'i1', parentId: 'u1', timestamp: header.timestamp, name: 'Old' },
            { type: 'session_info', id: 'i2', parentId: 'i1', timestamp: header.timestamp, name: 'Build fix' },
        )
        expect(summarizeSession(text, '/s/a.jsonl', 99)).toEqual({
            path: '/s/a.jsonl',
            id: 'sess-1',
            cwd: '/repo',
            name: 'Build fix',
            firstPrompt: 'fix the build',
            createdAt: Date.parse(header.timestamp),
            updatedAt: 99,
        })
    })

    it('rejects files without a session header', () => {
        expect(summarizeSession(lines(user('u1', null, 'x')), '/s/a.jsonl', 1)).toBeNull()
    })

    it('tolerates a partial line from a head/tail excerpt', () => {
        const text = `${lines(header, user('u1', null, 'hi'))}\n{"type":"mess`
        expect(summarizeSession(text, '/s/a.jsonl', 1)?.firstPrompt).toBe('hi')
    })
})

describe('parseSession', () => {
    it('follows the active branch from the last entry and skips system messages', () => {
        const text = lines(
            header,
            { type: 'message', id: 's', parentId: null, timestamp: header.timestamp, message: { role: 'system', content: '', timestamp: 0 } },
            user('u1', 's', 'first'),
            assistant('a1', 'u1', 'abandoned'),
            assistant('a2', 'u1', 'kept'),
            { type: 'custom', id: 'c', parentId: 'a2', timestamp: header.timestamp, customType: 'x', data: {} },
        )
        const snapshot = parseSession(text, '/s/a.jsonl')
        expect(snapshot.items.map(i => i.entryId)).toEqual(['u1', 'a2'])
        expect(snapshot.cwd).toBe('/repo')
    })

    it('turns compaction and displayed custom messages into display messages', () => {
        const text = lines(
            header,
            user('u1', null, 'q'),
            { type: 'compaction', id: 'k', parentId: 'u1', timestamp: header.timestamp, summary: 'sum', tokensBefore: 10, firstKeptEntryId: 'u1' },
            { type: 'custom_message', id: 'cm', parentId: 'k', timestamp: header.timestamp, customType: 'ext', content: 'note', display: true },
            { type: 'custom_message', id: 'hidden', parentId: 'cm', timestamp: header.timestamp, customType: 'ext', content: 'x', display: false },
        )
        const roles = parseSession(text, '/s/a.jsonl').items.map(i => i.message.role)
        expect(roles).toEqual(['user', 'compactionSummary', 'custom'])
    })

    it('shows review reports (entries outside the context) and keeps custom message details', () => {
        const report = { kind: 'review', id: 'rv-1', round: 1, status: 'done', summary: 's', issues: [], suggestions: [], rechecks: [] }
        const text = lines(
            header,
            user('u1', null, 'q'),
            { type: 'custom', id: 'r', parentId: 'u1', timestamp: header.timestamp, customType: 'pi-kit-review', data: report },
            { type: 'custom', id: 'other', parentId: 'r', timestamp: header.timestamp, customType: 'pi-kit-review', data: { kind: 'nope' } },
            { type: 'custom_message', id: 'f', parentId: 'other', timestamp: header.timestamp, customType: 'pi-kit-review-feedback', content: 'fix R1', display: true, details: { reviewId: 'rv-1', items: ['R1'] } },
        )
        const items = parseSession(text, '/s/a.jsonl').items
        expect(items.map(i => i.entryId)).toEqual(['u1', 'r', 'f'])
        expect(items[1].message).toMatchObject({ role: 'custom', customType: 'pi-kit-review', display: true, details: report })
        expect(items[2].message).toMatchObject({ role: 'custom', details: { reviewId: 'rv-1', items: ['R1'] } })
    })

    it('shows autopilot decisions, cards and answers, but not its on/off switch', () => {
        const card = { kind: 'autopilot-card', id: 'card-1', category: 'taste', title: 't', question: 'q', options: [], createdAt: 0 }
        const text = lines(
            header,
            user('u1', null, 'q'),
            { type: 'custom', id: 'mode', parentId: 'u1', timestamp: header.timestamp, customType: 'pi-kit-autopilot-mode', data: { on: true } },
            { type: 'custom', id: 'c', parentId: 'mode', timestamp: header.timestamp, customType: 'pi-kit-autopilot-card', data: card },
            { type: 'custom', id: 'd', parentId: 'c', timestamp: header.timestamp, customType: 'pi-kit-autopilot', data: { kind: 'autopilot', id: 'ap-1', next: 'wait', cards: ['card-1'] } },
            { type: 'custom', id: 'a', parentId: 'd', timestamp: header.timestamp, customType: 'pi-kit-autopilot-answer', data: { cardId: 'card-1', choice: 'A' } },
        )
        const items = parseSession(text, '/s/a.jsonl').items
        expect(items.map(i => i.entryId)).toEqual(['u1', 'c', 'd', 'a'])
        expect(items[1].message).toMatchObject({ role: 'custom', customType: 'pi-kit-autopilot-card', details: card })
    })

    it('stops on a parent cycle instead of looping', () => {
        const text = lines(header, { ...user('a', 'b', 'x') }, { ...user('b', 'a', 'y') })
        expect(parseSession(text, '/s/a.jsonl').items.length).toBe(2)
    })
})

describe('importSession (pi\'s /import)', () => {
    let dir: string
    let previous: string | undefined
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'import-session-'))
        previous = process.env.PI_CODING_AGENT_SESSION_DIR
        process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions')
    })
    afterEach(async () => {
        if (previous === undefined)
            delete process.env.PI_CODING_AGENT_SESSION_DIR
        else
            process.env.PI_CODING_AGENT_SESSION_DIR = previous
        await rm(dir, { recursive: true, force: true })
    })
    const write = async (name: string, ...records: object[]) => {
        const file = path.join(dir, name)
        await writeFile(file, `${lines(...records)}\n`)
        return file
    }

    // pi resolves '/Users/me/proj' against the current drive on Windows ('--D--Users-me-proj--'); these two use POSIX paths.
    it.skipIf(path.sep === '\\')('names the folder as pi does: the cwd without its leading slash, separators as dashes', async () => {
        expect(await sessionDirFor('/Users/me/proj')).toBe(path.join(dir, 'sessions', '--Users-me-proj--'))
    })

    it.skipIf(path.sep === '\\')('copies the file into its own project\'s folder and keeps the original', async () => {
        const file = await write('a.jsonl', header, user('u1', null, 'hello'))
        const { summary, movedTo } = await importSession(file, '/other', ['/repo', '/other'])
        expect(movedTo).toBeUndefined()
        expect(summary.cwd).toBe('/repo')
        expect(summary.path).toBe(path.join(dir, 'sessions', '--repo--', 'a.jsonl'))
        expect(summary.firstPrompt).toBe('hello')
        expect(await readFile(summary.path, 'utf8')).toBe(await readFile(file, 'utf8'))
    })

    it('adds -1, -2 when the name is taken, like pi', async () => {
        const file = await write('a.jsonl', header, user('u1', null, 'hello'))
        const first = await importSession(file, '/repo', ['/repo'])
        const second = await importSession(file, '/repo', ['/repo'])
        expect(path.basename(first.summary.path)).toBe('a.jsonl')
        expect(path.basename(second.summary.path)).toBe('a-1.jsonl')
    })

    it('files a session of an unknown directory under the project it was imported into, changing only the header\'s cwd', async () => {
        const file = await write('b.jsonl', { ...header, cwd: '/gone' }, user('u1', null, 'hi'))
        const { summary, movedTo } = await importSession(file, '/repo', ['/repo'])
        expect(movedTo).toBe('/repo')
        expect(summary.cwd).toBe('/repo')
        const copy = (await readFile(summary.path, 'utf8')).split('\n')
        expect(JSON.parse(copy[0])).toEqual({ ...header, cwd: '/repo' })
        expect(copy[1]).toBe(JSON.stringify(user('u1', null, 'hi')))
        expect(JSON.parse((await readFile(file, 'utf8')).split('\n')[0]).cwd).toBe('/gone')
    })

    it('leaves a file that is already in the sessions folder where it is', async () => {
        const inside = path.join(dir, 'sessions', '--repo--')
        await mkdir(inside, { recursive: true })
        const file = path.join(inside, 'c.jsonl')
        await writeFile(file, `${lines(header, user('u1', null, 'x'))}\n`)
        const { summary } = await importSession(file, '/repo', ['/repo'])
        expect(summary.path).toBe(file)
    })

    it('refuses what is not a pi session', async () => {
        const text = path.join(dir, 'x.jsonl')
        await writeFile(text, 'not json\n')
        await expect(importSession(text, '/repo', ['/repo'])).rejects.toThrow()
        const otherType = await write('y.jsonl', { type: 'message', id: 'a' })
        await expect(importSession(otherType, '/repo', ['/repo'])).rejects.toThrow()
        await expect(importSession(path.join(dir, 'missing.jsonl'), '/repo', ['/repo'])).rejects.toThrow()
        await expect(importSession('relative.jsonl', '/repo', [])).rejects.toThrow()
    })
})
