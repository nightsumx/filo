import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexSession, SessionSearch, snippet } from './search'

const lines = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n')
const header = { type: 'session', version: 3, id: 's', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo' }
const msg = (id: string, role: string, text: string, extra: object = {}) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 0, ...extra },
})

describe('indexSession', () => {
    it('indexes prompts and replies, not tool output', () => {
        const session = indexSession(Buffer.from(lines(
            header,
            msg('u1', 'user', 'Why does the Build fail?'),
            msg('r1', 'toolResult', 'build failed: secret tool output', { toolCallId: 'c', toolName: 'bash' }),
            msg('a1', 'assistant', 'The build fails because of a typo.'),
            { type: 'session_info', id: 'i', parentId: null, timestamp: header.timestamp, name: 'Build' },
        )))
        expect(session?.name).toBe('Build')
        expect(session?.firstPrompt).toBe('Why does the Build fail?')
        expect(session?.entries.map(e => [e.id, e.role])).toEqual([['u1', 'user'], ['a1', 'assistant']])
    })

    it('needs a session header', () => {
        expect(indexSession(Buffer.from(lines(msg('u1', 'user', 'x'))))).toBeNull()
    })
})

describe('snippet', () => {
    it('starts a little before the first match', () => {
        const text = `${'a'.repeat(100)} needle ${'b'.repeat(300)}`
        const s = snippet(text, text.toLowerCase(), ['needle'])
        expect(s.startsWith('…')).toBe(true)
        expect(s).toContain('needle')
        expect(s.endsWith('…')).toBe(true)
    })
})

describe('SessionSearch', () => {
    let dir: string
    const env = { ...process.env }
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-search-'))
        process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions')
        await mkdir(path.join(dir, 'sessions', 'p'), { recursive: true })
    })
    afterEach(async () => {
        process.env = { ...env }
        await rm(dir, { recursive: true, force: true })
    })

    it('matches messages holding every word, case-insensitively, and picks up new files', async () => {
        const one = path.join(dir, 'sessions', 'p', 'one.jsonl')
        await writeFile(one, lines(header, msg('u1', 'user', 'Merge the Windows'), msg('a1', 'assistant', 'windows merged'), msg('a2', 'assistant', 'only merge')))
        const cache = path.join(dir, 'index.json')
        const search = new SessionSearch(cache)
        const results = await search.search('windows MERGE')
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ session: one, cwd: '/repo', title: 'Merge the Windows', total: 2 })
        expect(results[0].hits.map(h => h.entryId)).toEqual(['u1', 'a1'])

        const two = path.join(dir, 'sessions', 'p', 'two.jsonl')
        await writeFile(two, lines(header, msg('u1', 'user', 'merge windows again')))
        expect((await search.search('windows merge')).map(r => r.session).sort()).toEqual([one, two].sort())

        // A fresh instance reads the saved index (and still sees both).
        expect((await new SessionSearch(cache).search('again')).map(r => r.session)).toEqual([two])
    })
})
