import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readLedger } from 'pi-capabilities/lib/ledger.ts'
import { describe, expect, it } from 'vitest'

const at = (n: number) => new Date(Date.UTC(2026, 9, 10, 12, n)).toISOString()
const usage = (input: number, cacheRead: number, cacheWrite: number, total: number) => ({ input, output: 10, cacheRead, cacheWrite, cost: { input: input * 3e-6, output: 0, cacheRead: cacheRead * 0.3e-6, cacheWrite: cacheWrite * 3.75e-6, total } })
const reply = (n: number, u: object) => ({ type: 'message', timestamp: at(n), message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'toolUse', timestamp: Date.parse(at(n)), usage: u } })

describe('readLedger', () => {
    it('totals what pi counts in a session (replies, subagents, warming) and what misses re-billed', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'ledger-'))
        await mkdir(path.join(root, '--p--'))
        const lines = [
            { type: 'session', cwd: '/work/p', timestamp: at(0) },
            reply(0, usage(10, 0, 20_000, 1)),
            { type: 'message', timestamp: at(1), message: { role: 'toolResult', toolName: 'subagent', timestamp: Date.parse(at(1)), usage: usage(0, 0, 0, 2) } },
            reply(2, usage(10, 20_000, 100, 0.5)),
            { type: 'usage', kind: 'cache_warm', provider: 'p', model: 'm', timestamp: at(6), usage: usage(0, 20_000, 0, 0.25) },
            reply(10, usage(10, 0, 21_000, 3)),
        ]
        await writeFile(path.join(root, '--p--', 's.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'))
        try {
            const ledger = await readLedger({ pi: root, claude: path.join(root, 'none'), codex: path.join(root, 'none') }, 0, {})
            expect(ledger).toMatchObject({ sessions: 1, cost: 6.75, warming: 0.25 })
            // Warmed 4 minutes before: not idle, a drop with nothing changed, so the channel's.
            expect(ledger.waste).toBeGreaterThan(0)
            expect(ledger.channelWaste).toBe(ledger.waste)
            expect(ledger.byProject).toEqual([{ key: '/work/p', cost: 6.75, waste: ledger.waste }])
            expect(ledger.byModel.map(r => r.key)).toEqual(['p/m'])
            expect(ledger.byDay).toHaveLength(1)
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('prices Claude Code and Codex logs at pi\'s list, once per request', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'ledger-'))
        const claude = path.join(root, 'claude', 'projects', '-work-c')
        const codex = path.join(root, 'codex', 'sessions', '2026', '10', '10')
        await mkdir(path.join(claude, 's', 'subagents'), { recursive: true })
        await mkdir(codex, { recursive: true })
        const record = (n: number, id: string, usage: object) => ({ type: 'assistant', cwd: '/work/c', timestamp: at(n), message: { id, model: 'claude-x', usage } })
        await writeFile(path.join(claude, 's.jsonl'), [
            // One reply, a record per content block: the last one's usage counts.
            record(0, 'a', { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }),
            record(0, 'a', { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 }),
            { type: 'user', cwd: '/work/c', timestamp: at(1), message: { content: 'next' } },
        ].map(l => JSON.stringify(l)).join('\n'))
        await writeFile(path.join(claude, 's', 'subagents', 'agent-1.jsonl'), JSON.stringify(record(2, 'b', { input_tokens: 1000, output_tokens: 0 })))
        const tokens = (input: number, cached: number, total: number) => ({ type: 'event_msg', timestamp: at(3), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 0, total_tokens: input } } } })
        await writeFile(path.join(codex, 'rollout-1.jsonl'), [
            { type: 'session_meta', timestamp: at(3), payload: { cwd: '/work/x' } },
            { type: 'turn_context', timestamp: at(3), payload: { model: 'gpt-x' } },
            tokens(2000, 1000, 2000),
            // The same count again, with a rate-limit update.
            tokens(2000, 1000, 2000),
        ].map(l => JSON.stringify(l)).join('\n'))
        const prices = {
            'anthropic/claude-x': { cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 } },
            'openai/gpt-x': { cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } },
        }
        try {
            const ledger = await readLedger({ pi: path.join(root, 'pi'), claude: path.join(root, 'claude'), codex: path.join(root, 'codex') }, 0, prices)
            // Claude: 1000 in + 1000 out, the subagent 1000 in; Codex: 1000 in + 1000 cached.
            expect(ledger.byAgent).toEqual([{ key: 'Claude Code', cost: 0.012, waste: 0 }, { key: 'Codex', cost: 0.0025, waste: 0 }])
            expect(ledger.sessions).toBe(2)
            expect(ledger.byModel.map(r => r.key)).toEqual(['anthropic/claude-x', 'openai/gpt-x'])
            expect(ledger.byProject.map(r => r.key)).toEqual(['/work/c', '/work/x'])
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
