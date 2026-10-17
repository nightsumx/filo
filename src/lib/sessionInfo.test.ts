import type { RpcSessionState, SessionStats } from '@shared/pi'
import { describe, expect, it } from 'vitest'
import { sessionInfoRows } from './sessionInfo'

const state: RpcSessionState = {
    isStreaming: false,
    isCompacting: false,
    sessionFile: '/home/me/.pi/agent/sessions/a.jsonl',
    sessionId: 'abc-123',
    model: { id: 'big', name: 'Big', provider: 'acme' },
}
const stats: SessionStats = {
    sessionFile: '/home/me/.pi/agent/sessions/a.jsonl',
    sessionId: 'abc-123',
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 4,
    totalMessages: 9,
    tokens: { input: 1200, output: 300, cacheRead: 40000, cacheWrite: 500, total: 42000 },
    cost: 0.0042,
    contextUsage: { tokens: 20000, contextWindow: 200000, percent: 10 },
}
const byId = (rows: ReturnType<typeof sessionInfoRows>) => Object.fromEntries(rows.map(r => [r.id, r]))

describe('sessionInfoRows', () => {
    it('lists everything pi reports', () => {
        const rows = byId(sessionInfoRows('pi', state, stats))
        expect(rows.path.file).toBe(stats.sessionFile)
        expect(rows.id.value).toBe('abc-123')
        expect(rows.messages.value).toContain('9')
        expect(rows.model.value).toBe('acme/big')
        expect([rows.input.value, rows.output.value, rows.cacheRead.value, rows.cacheWrite.value, rows.total.value]).toEqual(['1,200', '300', '40,000', '500', '42,000'])
        expect(rows.cost.value).toBe('$0.0042')
        expect(rows.context.value).toBe('20,000 / 200,000（10.0%）')
    })

    it('leaves out what an agent does not report instead of showing 0', () => {
        const rows = byId(sessionInfoRows('codex', { ...state, sessionFile: 'codex:thread-1' }, { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }))
        // The key an ACP agent puts in sessionFile is not a path.
        expect(Object.keys(rows).sort()).toEqual(['id', 'model'])
    })

    it('shows an agent\'s tokens once it reports some', () => {
        const rows = byId(sessionInfoRows('claude', state, { tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, total: 11 } }))
        expect(rows.total.value).toBe('11')
        expect(rows.path).toBeUndefined()
        expect(rows.cost).toBeUndefined()
        expect(rows.messages).toBeUndefined()
    })

    it('marks an unknown context size with ?', () => {
        const rows = byId(sessionInfoRows('pi', state, { contextUsage: { tokens: null, contextWindow: 1000, percent: null } }))
        expect(rows.context.value).toBe('? / 1,000')
    })
})
