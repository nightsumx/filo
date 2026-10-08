import { describe, expect, it } from 'vitest'
import { parseSession, summarizeSession } from './sessions'

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
