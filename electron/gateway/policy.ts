// Gateway policy: what a failed answer means, how long a member rests after it, and the order a
// request tries a group's members in. Pure apart from the clock, which callers pass in.
//
// Failure kinds stay apart (shared/routes FailureKind): a key that is rejected rests the whole
// provider for long, a rate limit rests one member for as long as the provider asks, and a request
// the provider refuses for its content is the agent's to see, with nothing rested.

import type { FailureKind, MemberHealth, RouteGroup, RouteMember, RouteStatus } from '@shared/routes'
import { memberKey } from '@shared/routes'

const SECOND = 1000
const MINUTE = 60 * SECOND

export interface Verdict {
    kind: FailureKind
    /** Try the next member. */
    next: boolean
    /** What rests: the provider (all its models), this member, or nothing. */
    rest: 'provider' | 'member' | 'none'
}

const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded your|usage limit|limit reached|payment|余额|额度|欠费|充值/i
const MODEL_WORDS = /model[^.]{0,60}(not found|not exist|does not exist|unsupported|not supported|not available|invalid|unknown|no access|not allowed)|no such model|model_not_found|unknown model|invalid model|模型[^。]{0,12}(不存在|不支持|无效|未开通)/i
const CONTEXT_WORDS = /context[^.]{0,30}(length|window|limit)|prompt is too long|too many tokens|maximum[^.]{0,30}tokens|token[^.]{0,30}exceed|input is too long|超出[^。]{0,10}(长度|上下文)/i

/** Classifies a failed answer from its status and body (error text up to a few KB). */
export function classify(status: number, body: string): Verdict {
    if (status === 0)
        return { kind: 'network', next: true, rest: 'member' }
    if (status === 402)
        return { kind: 'credit', next: true, rest: 'provider' }
    if (status === 401 || status === 403) {
        // Some providers answer an exhausted plan with 403.
        if (QUOTA_WORDS.test(body))
            return { kind: 'quota', next: true, rest: 'provider' }
        return { kind: 'auth', next: true, rest: 'provider' }
    }
    if (status === 429)
        return QUOTA_WORDS.test(body) && !/rate/i.test(body) ? { kind: 'quota', next: true, rest: 'provider' } : { kind: 'rate', next: true, rest: 'member' }
    if (status === 404)
        return { kind: 'model', next: true, rest: 'member' }
    if (status === 408 || status >= 500)
        return { kind: 'server', next: true, rest: 'member' }
    if (status === 413 || CONTEXT_WORDS.test(body))
        return { kind: 'context', next: true, rest: 'none' }
    if (status === 400 || status === 422) {
        if (MODEL_WORDS.test(body))
            return { kind: 'model', next: true, rest: 'member' }
        if (QUOTA_WORDS.test(body))
            return { kind: 'quota', next: true, rest: 'provider' }
    }
    return { kind: 'request', next: false, rest: 'none' }
}

/** Anthropic stream `error` events name a type instead of a status. */
export function anthropicErrorStatus(type: string): number {
    switch (type) {
        case 'authentication_error': return 401
        case 'permission_error': return 403
        case 'billing_error': return 402
        case 'not_found_error': return 404
        case 'request_too_large': return 413
        case 'rate_limit_error': return 429
        case 'overloaded_error': return 529
        case 'invalid_request_error': return 400
        default: return 500
    }
}

/** Retry-After (seconds or an HTTP date) in ms; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
    if (!value)
        return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * SECOND
    const at = Date.parse(value)
    return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/**
 * How long a failure rests what it covers. `streak` counts this member's failures in a row (1 for
 * the first), doubling the rest of kinds without a provider-given time.
 */
export function restMs(kind: FailureKind, streak: number, retryAfter?: number): number {
    const doubling = (base: number, cap: number) => Math.min(cap, base * 2 ** Math.max(0, streak - 1))
    switch (kind) {
        case 'auth': return 10 * MINUTE
        case 'credit': return 30 * MINUTE
        case 'quota': return retryAfter !== undefined ? Math.min(8 * 24 * 60 * MINUTE, Math.max(MINUTE, retryAfter)) : 15 * MINUTE
        case 'rate': return retryAfter !== undefined ? Math.min(60 * MINUTE, Math.max(5 * SECOND, retryAfter)) : doubling(MINUTE, 30 * MINUTE)
        case 'model': return 30 * MINUTE
        case 'network':
        case 'server':
        case 'empty': return doubling(30 * SECOND, 10 * MINUTE)
        default: return 0
    }
}

export interface Failure {
    kind: FailureKind
    status: number
    message: string
    retryAfter?: number
}

/** Rest and outcome counts per member and provider, kept in memory for the app session. */
export class Health {
    private members = new Map<string, MemberHealth & { streak: number }>()
    private providers = new Map<string, { restUntil: number, reason: FailureKind }>()

    constructor(private now: () => number = Date.now) {}

    private member(key: string) {
        let state = this.members.get(key)
        if (!state) {
            state = { key, served: 0, failed: 0, streak: 0 }
            this.members.set(key, state)
        }
        return state
    }

    /** When the member may be tried first again (0: now). */
    restUntil(m: RouteMember): number {
        const now = this.now()
        const own = this.members.get(memberKey(m))?.restUntil ?? 0
        const provider = this.providers.get(m.provider)?.restUntil ?? 0
        const until = Math.max(own, provider)
        return until > now ? until : 0
    }

    fail(m: RouteMember, failure: Failure, verdict: Verdict) {
        const now = this.now()
        const state = this.member(memberKey(m))
        state.failed++
        state.lastError = { kind: failure.kind, status: failure.status, message: failure.message.slice(0, 300), at: now }
        if (verdict.rest === 'none')
            return
        state.streak++
        const until = now + restMs(failure.kind, state.streak, failure.retryAfter)
        if (verdict.rest === 'provider') {
            const current = this.providers.get(m.provider)
            if (!current || current.restUntil < until)
                this.providers.set(m.provider, { restUntil: until, reason: failure.kind })
        }
        else if ((state.restUntil ?? 0) < until) {
            state.restUntil = until
            state.reason = failure.kind
        }
    }

    ok(m: RouteMember) {
        const state = this.member(memberKey(m))
        state.served++
        state.lastOk = this.now()
        state.streak = 0
        state.restUntil = undefined
        state.reason = undefined
        // A provider-wide rest ends with any of its members answering.
        this.providers.delete(m.provider)
    }

    /** The user said a provider's key changed: its rests no longer apply. */
    forgetProvider(provider: string) {
        this.providers.delete(provider)
        for (const state of this.members.values()) {
            if (state.key.startsWith(`${provider}/`)) {
                state.restUntil = undefined
                state.reason = undefined
                state.streak = 0
            }
        }
    }

    snapshot(): Pick<RouteStatus, 'members' | 'providers'> {
        const now = this.now()
        const members: Record<string, MemberHealth> = {}
        for (const { streak: _streak, ...state } of this.members.values())
            members[state.key] = { ...state, restUntil: state.restUntil && state.restUntil > now ? state.restUntil : undefined }
        const providers: RouteStatus['providers'] = {}
        for (const [id, rest] of this.providers) {
            if (rest.restUntil > now)
                providers[id] = rest
        }
        return { members, providers }
    }
}

/** A session keeps the member that answered it while the prompt cache is warm. */
export const STICKY_MS = 5 * MINUTE

/**
 * The members a request tries, in order. A pin (or a manual group) sends to one member only. Else
 * the group's order, with the member that answered this session last moved first while its cache is
 * warm (switching providers mid-turn loses the cache and can break thinking signatures). Resting
 * members go last, soonest back first; they are still tried when nothing else answers.
 */
export function plan(group: RouteGroup, options: { pin?: string, sticky?: { member: string, at: number }, health: Health, now: number }): RouteMember[] {
    const on = group.members.filter(m => !m.off)
    const pinned = options.pin ? on.find(m => memberKey(m) === options.pin) : undefined
    if (pinned)
        return [pinned]
    if (group.mode === 'manual') {
        const picked = on.find(m => memberKey(m) === group.pick) ?? on[0]
        return picked ? [picked] : []
    }
    let order = on
    const sticky = options.sticky && options.now - options.sticky.at < STICKY_MS ? on.find(m => memberKey(m) === options.sticky!.member) : undefined
    if (sticky)
        order = [sticky, ...on.filter(m => m !== sticky)]
    const ready = order.filter(m => !options.health.restUntil(m))
    const resting = order.filter(m => options.health.restUntil(m)).sort((a, b) => options.health.restUntil(a) - options.health.restUntil(b))
    return [...ready, ...resting]
}
