import type { ProbeReply, ProbeRequest, ProbeSend } from 'pi-capabilities/lib/channelTest.ts'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { channelHistory, readChannelResults, saveChannelResult } from 'pi-capabilities/lib/channelStore.ts'
import { estimateCost, runChannelTest, stepKinds } from 'pi-capabilities/lib/channelTest.ts'
import { describe, expect, it } from 'vitest'

const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const model = { provider: 'p', id: 'm', cost: COST }

/** The request as the provider would tokenise it: about four characters a token. */
const flat = (r: ProbeRequest) => [r.system, ...r.turns.map(t => (t.role === 'user' ? t.text : (t.message as { text: string }).text))].join('\n\u0000\n')
const tokens = (chars: number) => Math.ceil(chars / 4)

type Cache = 'anthropic' | 'openai' | 'ratio' | 'writes-only' | 'none' | 'lossy'

/** A provider with the given cache behaviour, replying with the lines it was asked to copy. */
function provider(kind: Cache, options: { failAt?: number } = {}): ProbeSend & { requests: ProbeRequest[] } {
    const seen: string[] = []
    const requests: ProbeRequest[] = []
    const send = async (request: ProbeRequest): Promise<ProbeReply> => {
        requests.push(request)
        if (options.failAt === requests.length)
            return { message: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ttftMs: null, durationMs: 5, error: '529 overloaded' }
        const text = flat(request)
        const prompt = tokens(text.length)
        let common = 0
        for (const s of seen) {
            let i = 0
            while (i < s.length && i < text.length && s[i] === text[i])
                i++
            // Only whole cached prompts are reusable (a breakpoint at the end of each request).
            if (i === s.length)
                common = Math.max(common, i)
        }
        seen.push(text)
        let read = tokens(common)
        let write = 0
        if (kind === 'anthropic')
            write = prompt - read
        else if (kind === 'openai')
            read = read >= 1024 ? Math.floor(read / 128) * 128 : 0
        else if (kind === 'ratio')
            read = Math.round(prompt * 0.9)
        else if (kind === 'writes-only') {
            read = 0
            write = prompt
        }
        else if (kind === 'lossy') {
            read = requests.length % 2 ? 0 : read
            write = prompt - read
        }
        else {
            read = 0
        }
        const lines = request.turns.at(-1)!.role === 'user' ? (request.turns.at(-1) as { text: string }).text.split('\n').filter(l => /^\d+\.\d+ /.test(l)).join('\n') : ''
        return {
            message: { text: lines },
            usage: { input: prompt - read - write, output: tokens(lines.length), cacheRead: read, cacheWrite: write },
            ttftMs: 400,
            durationMs: 1400,
        }
    }
    return Object.assign(send, { requests })
}

const run = (kind: Cache, options: { failAt?: number, idleMs?: number } = {}) => {
    const send = provider(kind, options)
    return runChannelTest({ model, send, nonce: 'fixed', idleMs: options.idleMs, sleep: async () => {} }).then(result => ({ result, send }))
}

describe('channel test', () => {
    it('passes a provider that caches each prompt and reads it back', async () => {
        const { result, send } = await run('anthropic')
        expect(result.verdict).toBe('healthy')
        expect(result.steps.map(s => s.status)).toEqual(['fresh', 'hit', 'hit', 'hit', 'hit', 'hit', 'hit'])
        expect(send.requests).toHaveLength(stepKinds().length)
        // Each append reads the previous prompt and writes the new part.
        const [, , third] = result.steps
        expect(third.cacheRead).toBe(result.steps[1].prompt)
        expect(third.cacheWrite).toBeGreaterThan(1000)
        expect(result.extraCost).toBe(0)
        expect(result.ttftMs).toBe(400)
        expect(result.outputTps).toBeGreaterThan(0)
    })

    it('sends a growing conversation with the replies, the same request on repeat, and one session id', async () => {
        const { send } = await run('anthropic')
        const [first, repeat, append] = send.requests
        expect(repeat).toEqual(first)
        expect(append.turns.slice(0, 1)).toEqual(first.turns)
        expect(append.turns[1]).toEqual({ role: 'assistant', message: expect.objectContaining({ text: expect.stringContaining('1.1 ') }) })
        expect(new Set(send.requests.map(r => r.sessionId)).size).toBe(1)
        expect(first.system).toContain('fixed')
        // ~11k tokens of system prompt: above every provider's minimum cacheable prefix.
        expect(tokens(first.system.length)).toBeGreaterThan(9000)
    })

    it('allows OpenAI\'s 128-token steps and its missing write figure', async () => {
        const { result } = await run('openai')
        expect(result.verdict).toBe('healthy')
        expect(result.steps.every(s => s.cacheWrite === 0)).toBe(true)
    })

    it('calls out reads on a prompt never sent before, the mark of a relay billing by ratio', async () => {
        const { result } = await run('ratio')
        expect(result.verdict).toBe('fabricated')
        expect(result.steps[0].status).toBe('excess')
        // An append reading more than was ever sent is impossible too.
        expect(result.steps[2].status).toBe('excess')
    })

    it('tells writes that are never read from no cache figures at all', async () => {
        expect((await run('writes-only')).result.verdict).toBe('none')
        expect((await run('none')).result.verdict).toBe('unreported')
    })

    it('marks a cache that is lost every other request as partial and prices the re-billed tokens', async () => {
        const { result } = await run('lossy')
        expect(result.verdict).toBe('partial')
        const lost = result.steps.filter(s => s.status === 'miss')
        expect(lost.length).toBeGreaterThan(0)
        // Unread tokens were written again: 3.75 − 0.3 per million.
        const unread = lost.reduce((n, s) => n + s.unread, 0)
        expect(result.extraCost).toBeCloseTo(unread * (3.75 - 0.3) / 1e6, 6)
    })

    it('stops at the first error and keeps what ran', async () => {
        const { result, send } = await run('anthropic', { failAt: 3 })
        expect(result.verdict).toBe('failed')
        expect(result.error).toBe('529 overloaded')
        expect(result.steps).toHaveLength(2)
        expect(send.requests).toHaveLength(3)
    })

    it('waits before the idle step and sends the last request again', async () => {
        const waits: number[] = []
        const send = provider('anthropic')
        const progress: { kind: string, waitUntil?: number }[] = []
        const result = await runChannelTest({ model, send, nonce: 'n', idleMs: 240_000, sleep: async ms => void waits.push(ms), onProgress: p => progress.push({ kind: p.kind, waitUntil: p.waitUntil }) })
        expect(waits).toEqual([240_000])
        expect(send.requests.at(-1)).toEqual(send.requests.at(-2))
        expect(result.steps.at(-1)).toMatchObject({ kind: 'idle', status: 'hit' })
        expect(result.idleMs).toBe(240_000)
        expect(progress.filter(p => p.waitUntil)).toHaveLength(1)
    })

    it('can be cancelled', async () => {
        const controller = new AbortController()
        const send = provider('anthropic')
        const wrapped: ProbeSend = async (r, s) => {
            if (send.requests.length === 1)
                controller.abort()
            return send(r, s)
        }
        await expect(runChannelTest({ model, send: wrapped, nonce: 'n', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
        expect(send.requests).toHaveLength(2)
    })

    it('estimates the cost both ways, and nothing without prices', () => {
        const e = estimateCost(model)
        expect(e.requests).toBe(7)
        expect(e.healthy!).toBeGreaterThan(0.05)
        expect(e.healthy!).toBeLessThan(0.3)
        expect(e.worst!).toBeGreaterThan(e.healthy! * 2)
        expect(estimateCost({ provider: 'p', id: 'm' }).healthy).toBeNull()
        expect(estimateCost(model, { idleMs: 1 }).requests).toBe(8)
    })
})

describe('channel store', () => {
    it('keeps the last result per model', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'channel-store-'))
        try {
            expect(await readChannelResults(dir)).toEqual({})
            const { result } = await run('anthropic')
            await saveChannelResult(dir, result)
            await saveChannelResult(dir, { ...result, model: 'other' })
            await saveChannelResult(dir, { ...result, verdict: 'partial' })
            const saved = await readChannelResults(dir)
            expect(Object.keys(saved).sort()).toEqual(['p/m', 'p/other'])
            expect(saved['p/m'].verdict).toBe('partial')
        }
        finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('counts past requests per model, judging each against the one before it on its branch', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'channel-history-'))
        try {
            await mkdir(path.join(root, 'proj'))
            const now = Date.now()
            const at = (i: number) => new Date(now - 60_000 + i * 1000).toISOString()
            let n = 0
            const line = (parent: string | null, body: Record<string, unknown>) => {
                const id = `e${++n}`
                return { id, text: JSON.stringify({ type: 'message', id, parentId: parent, timestamp: at(n), ...body }) }
            }
            const user = (parent: string | null) => line(parent, { message: { role: 'user', content: 'hi', timestamp: now } })
            const reply = (parent: string, input: number, cacheRead: number, cacheWrite: number) => line(parent, { message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', timestamp: now + n * 1000, usage: { input, output: 10, cacheRead, cacheWrite, cost: { input: input * 3e-6, output: 0, cacheRead: cacheRead * 0.3e-6, cacheWrite: cacheWrite * 3.75e-6, total: 0 } } } })
            const u1 = user(null)
            const r1 = reply(u1.id, 10, 0, 50_000)
            const u2 = user(r1.id)
            const r2 = reply(u2.id, 10, 50_000, 5_000)
            // Back to r1 and a new branch: it only shares r1's prompt, which it reads.
            const u3 = user(r1.id)
            const r3 = reply(u3.id, 10, 50_000, 1_000)
            // Then a request that lost everything.
            const u4 = user(r3.id)
            const r4 = reply(u4.id, 10, 0, 60_000)
            const custom = JSON.stringify({ type: 'custom', customType: 'x', data: {}, id: 'c1', parentId: r4.id, timestamp: at(99) })
            await writeFile(path.join(root, 'proj', 's.jsonl'), `${[u1, r1, u2, r2, u3, r3, u4, r4].map(l => l.text).join('\n')}\n${custom}\n`)
            const cache = new Map()
            const history = await channelHistory(root, { cache })
            expect(history['p/m']).toMatchObject({ requests: 4, cachedRequests: 4, misses: 1, missedTokens: 51_010 })
            expect(history['p/m'].extraCost).toBeCloseTo(51_010 * (3.75 - 0.3) / 1e6, 4)
            expect(cache.size).toBe(1)
            expect(await channelHistory(root, { since: now + 3_600_000 })).toEqual({})
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
