import type { RouteGroup } from '@shared/routes'
import { describe, expect, it } from 'vitest'
import { classify, Health, plan, restMs, retryAfterMs, STICKY_MS } from './policy'

describe('classify', () => {
    it('rests the whole provider for key, credit and quota failures', () => {
        expect(classify(401, 'invalid x-api-key')).toEqual({ kind: 'auth', next: true, rest: 'provider' })
        expect(classify(403, 'forbidden')).toMatchObject({ kind: 'auth', rest: 'provider' })
        expect(classify(403, 'You exceeded your current quota')).toMatchObject({ kind: 'quota', rest: 'provider' })
        expect(classify(402, '')).toMatchObject({ kind: 'credit', rest: 'provider' })
        expect(classify(429, 'insufficient balance')).toMatchObject({ kind: 'quota', rest: 'provider' })
    })

    it('rests one member for rate limits, server errors and missing models', () => {
        expect(classify(429, 'rate limit reached, quota resets soon')).toMatchObject({ kind: 'rate', rest: 'member' })
        expect(classify(529, 'Overloaded')).toMatchObject({ kind: 'server', rest: 'member', next: true })
        expect(classify(503, '')).toMatchObject({ kind: 'server' })
        expect(classify(0, 'ECONNREFUSED')).toMatchObject({ kind: 'network', rest: 'member' })
        expect(classify(404, '')).toMatchObject({ kind: 'model', rest: 'member' })
        expect(classify(400, 'The model `x` does not exist')).toMatchObject({ kind: 'model', rest: 'member' })
    })

    it('moves on without resting when the request is too long for the model', () => {
        expect(classify(400, 'prompt is too long: 250000 tokens > 200000 maximum')).toEqual({ kind: 'context', next: true, rest: 'none' })
        expect(classify(413, '')).toMatchObject({ kind: 'context', rest: 'none' })
    })

    it('gives other bad requests back to the agent', () => {
        expect(classify(400, 'messages.1.content: field required')).toEqual({ kind: 'request', next: false, rest: 'none' })
        expect(classify(422, 'bad tool schema')).toMatchObject({ next: false })
    })
})

describe('rests', () => {
    it('reads Retry-After as seconds or a date', () => {
        expect(retryAfterMs('30', 0)).toBe(30_000)
        expect(retryAfterMs(new Date(90_000).toUTCString(), 0)).toBe(90_000)
        expect(retryAfterMs('soon', 0)).toBeUndefined()
        expect(retryAfterMs(null, 0)).toBeUndefined()
    })

    it('follows Retry-After for rate limits, within bounds, and doubles without it', () => {
        expect(restMs('rate', 1, 20_000)).toBe(20_000)
        expect(restMs('rate', 1, 100)).toBe(5_000)
        expect(restMs('rate', 1, 10 * 3600_000)).toBe(3600_000)
        expect(restMs('rate', 1)).toBe(60_000)
        expect(restMs('rate', 3)).toBe(240_000)
        expect(restMs('server', 1)).toBe(30_000)
        expect(restMs('server', 20)).toBe(600_000)
        expect(restMs('context', 1)).toBe(0)
    })
})

const group = (members: string[], extra: Partial<RouteGroup> = {}): RouteGroup => ({
    id: 'g',
    name: 'G',
    api: 'anthropic-messages',
    mode: 'order',
    members: members.map((k) => {
        const [provider, model] = k.split('/')
        return { provider, model }
    }),
    ...extra,
})
const keys = (members: { provider: string, model: string }[]) => members.map(m => `${m.provider}/${m.model}`)

describe('plan', () => {
    it('keeps the group order and puts resting members last, soonest back first', () => {
        let now = 1000
        const health = new Health(() => now)
        const g = group(['a/1', 'b/1', 'c/1', 'd/1'])
        expect(keys(plan(g, { health, now }))).toEqual(['a/1', 'b/1', 'c/1', 'd/1'])
        health.fail(g.members[0], { kind: 'server', status: 500, message: '' }, classify(500, ''))
        health.fail(g.members[1], { kind: 'rate', status: 429, message: '', retryAfter: 10_000 }, classify(429, 'rate'))
        expect(keys(plan(g, { health, now }))).toEqual(['c/1', 'd/1', 'b/1', 'a/1'])
        now += 31_000
        expect(keys(plan(g, { health, now }))).toEqual(['a/1', 'b/1', 'c/1', 'd/1'])
    })

    it('rests every model of a provider whose key was rejected, until one answers', () => {
        const health = new Health(() => 0)
        const g = group(['a/1', 'a/2', 'b/1'])
        health.fail(g.members[0], { kind: 'auth', status: 401, message: '' }, classify(401, ''))
        expect(keys(plan(g, { health, now: 0 }))).toEqual(['b/1', 'a/1', 'a/2'])
        health.ok(g.members[1])
        expect(keys(plan(g, { health, now: 0 }))).toEqual(['a/1', 'a/2', 'b/1'])
    })

    it('keeps a session on the member that answered it while the cache is warm', () => {
        const health = new Health(() => 0)
        const g = group(['a/1', 'b/1', 'c/1'])
        expect(keys(plan(g, { health, now: 100, sticky: { member: 'b/1', at: 0 } }))).toEqual(['b/1', 'a/1', 'c/1'])
        expect(keys(plan(g, { health, now: STICKY_MS + 1, sticky: { member: 'b/1', at: 0 } }))).toEqual(['a/1', 'b/1', 'c/1'])
    })

    it('skips paused members and sends manual groups and pins to one member', () => {
        const health = new Health(() => 0)
        const g = group(['a/1', 'b/1', 'c/1'])
        g.members[0].off = true
        expect(keys(plan(g, { health, now: 0 }))).toEqual(['b/1', 'c/1'])
        expect(keys(plan({ ...g, mode: 'manual', pick: 'c/1' }, { health, now: 0 }))).toEqual(['c/1'])
        expect(keys(plan({ ...g, mode: 'manual', pick: 'a/1' }, { health, now: 0 }))).toEqual(['b/1'])
        expect(keys(plan(g, { health, now: 0, pin: 'c/1' }))).toEqual(['c/1'])
        // A pin that is no longer in the group is ignored.
        expect(keys(plan(g, { health, now: 0, pin: 'z/1' }))).toEqual(['b/1', 'c/1'])
    })
})
