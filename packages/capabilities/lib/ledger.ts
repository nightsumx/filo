// What sessions cost, by day, agent, project and model, over pi's sessions and, read-only, Claude
// Code's and Codex's own logs. A pi session is counted the way pi counts its own total (core/agent-session
// getSessionStats: replies, tool results that report usage, which are subagents, cache warming,
// compaction and branch summaries), over every branch. A Claude Code or Codex request is priced from
// pi's model list (prices.ts), subscription or not. Waste is what cache misses re-billed (promptCache's
// extraCost, over requests in file order), with the part a channel caused (re-billed tails, drops
// mid-run) and cache warming apart. pi-cc-tui's /cost and Filo's status line read this.
import type { CacheMessage } from './promptCache'
import type { PriceList } from './prices'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { CACHE_TTL_MS, CACHE_WARM, cacheMisses } from './promptCache'
import { claudeTokens, costOf, pricedModel } from './prices'

export interface SpendRow {
    key: string
    cost: number
    /** Re-billed by cache misses. */
    waste: number
}

export interface Ledger {
    since: number
    sessions: number
    cost: number
    waste: number
    /** Of waste: misses with nothing changed locally (channelFault's reasons). */
    channelWaste: number
    /** Of cost: pi's cache-warming requests. */
    warming: number
    /** Costliest first; days newest first, as YYYY-MM-DD in local time. */
    byDay: SpendRow[]
    /** pi, Claude Code, Codex. */
    byAgent: SpendRow[]
    byProject: SpendRow[]
    /** `provider/id` of pi's model list. */
    byModel: SpendRow[]
}

/** Where each agent keeps its sessions: pi's sessions folder, CLAUDE_CONFIG_DIR, CODEX_HOME. */
export interface LedgerRoots {
    pi: string
    claude?: string
    codex?: string
}

interface Spend {
    at: number
    model: string
    cost: number
    waste: number
    channel: number
    warm: number
}

interface Session {
    cwd: string
    spends: Spend[]
}

const spendAt = (at: number, model: string, cost = 0): Spend => ({ at, model, cost, waste: 0, channel: 0, warm: 0 })

/** Requests (and what resets the cache between them) in order, with what each cost: the costly ones and those that missed. */
function billed(messages: CacheMessage[], spends: Spend[], ttlMs: number): Spend[] {
    cacheMisses(messages, ttlMs).forEach((miss, i) => {
        if (!miss?.extraCost)
            return
        spends[i].waste = miss.extraCost
        if (miss.reason === 'partial' || miss.reason === 'provider')
            spends[i].channel = miss.extraCost
    })
    return spends.filter(s => s.cost || s.waste)
}

/**
 * Lines of a session log that matter, parsed: the first (the header) and those containing one of
 * `marks`. Parsing every tool result would read a long session several times over.
 */
async function* records(file: string, marks: string[]) {
    let first = true
    for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
        if (!first && !marks.some(m => line.includes(m)))
            continue
        first = false
        try {
            yield JSON.parse(line)
        }
        catch {}
    }
}

async function readPi(file: string): Promise<Session> {
    let cwd = ''
    const messages: CacheMessage[] = []
    const spends: Spend[] = []
    const extra: Spend[] = []
    let model = ''
    for await (const entry of records(file, ['"usage"', '"compaction"', '"branch_summary"'])) {
        if (entry?.type === 'session') {
            cwd = String(entry.cwd ?? '')
            continue
        }
        const time = Date.parse(entry?.timestamp ?? '') || 0
        const m = entry?.message
        const usage = entry?.type === 'message' && (m?.role === 'assistant' || m?.role === 'toolResult')
            ? m.usage
            : entry?.type === 'usage' || entry?.type === 'compaction' || entry?.type === 'branch_summary' ? entry.usage : undefined
        if (entry?.type === 'message' && m?.role === 'assistant' && m.provider)
            model = `${m.provider}/${m.model}`
        const spend = spendAt(m?.timestamp || time, entry?.type === 'usage' ? `${entry.provider}/${entry.model}` : model, Number(usage?.cost?.total) || 0)
        if (entry?.type === 'usage' && entry.kind === CACHE_WARM) {
            spend.warm = spend.cost
            messages.push({ role: 'custom', customType: CACHE_WARM, timestamp: spend.at })
        }
        else if (entry?.type === 'compaction' || entry?.type === 'branch_summary') {
            messages.push({ role: entry.type === 'compaction' ? 'compactionSummary' : 'branchSummary', timestamp: spend.at })
        }
        else if (entry?.type === 'message' && m?.role === 'assistant') {
            messages.push(m)
        }
        else {
            if (spend.cost)
                extra.push(spend)
            continue
        }
        spends.push(spend)
    }
    return { cwd, spends: [...billed(messages, spends, CACHE_TTL_MS), ...extra] }
}

/**
 * A Claude Code session (or a subagent's, under the session's subagents folder). A reply is a record
 * per content block, each with the request's usage so far: the last of a message id counts.
 */
async function readClaude(file: string, prices: PriceList): Promise<Session> {
    let cwd = ''
    // Per chain (the main one, each sidechain of older versions): message ids and compactions in order.
    const chains = new Map<string, (string | number)[]>()
    const replies = new Map<string, { at: number, model: string, usage: unknown }>()
    for await (const r of records(file, ['"assistant"', '"compact_boundary"'])) {
        cwd ||= typeof r?.cwd === 'string' ? r.cwd : ''
        const at = Date.parse(r?.timestamp ?? '') || 0
        const key = r?.isSidechain ? String(r.agentId ?? 'side') : ''
        const chain = chains.get(key) ?? []
        chains.set(key, chain)
        if (r?.type === 'system' && r.subtype === 'compact_boundary') {
            chain.push(at)
            continue
        }
        const m = r?.message
        if (r?.type !== 'assistant' || typeof m?.id !== 'string' || m.model === '<synthetic>' || !claudeTokens(m.usage))
            continue
        if (!replies.has(m.id))
            chain.push(m.id)
        replies.set(m.id, { at: replies.get(m.id)?.at ?? at, model: String(m.model ?? ''), usage: m.usage })
    }
    const spends: Spend[] = []
    for (const chain of chains.values()) {
        const messages: CacheMessage[] = []
        const at: Spend[] = []
        let ttl: number | undefined
        for (const item of chain) {
            const reply = typeof item === 'string' ? replies.get(item) : undefined
            if (!reply) {
                messages.push({ role: 'compactionSummary', timestamp: Number(item) })
                at.push(spendAt(Number(item), ''))
                continue
            }
            const tokens = claudeTokens(reply.usage)!
            const model = pricedModel(prices, 'claude', reply.model)
            const cost = costOf(model?.cost, tokens)
            ttl = tokens.cacheWrite1h ? 3600 : ttl ?? model?.promptCache?.short
            messages.push({ role: 'assistant', model: reply.model, timestamp: reply.at, usage: { ...tokens, cost } })
            at.push(spendAt(reply.at, model?.key ?? reply.model, cost.total))
        }
        spends.push(...billed(messages, at, ttl ? ttl * 1000 : CACHE_TTL_MS))
    }
    return { cwd, spends }
}

/** A Codex rollout: a token_count event after each request, with that request's usage (input including the cache). */
async function readCodex(file: string, prices: PriceList): Promise<Session> {
    let cwd = ''
    let model = ''
    let seen: unknown
    const messages: CacheMessage[] = []
    const at: Spend[] = []
    let ttl: number | undefined
    for await (const r of records(file, ['"token_count"', '"turn_context"', '"compacted"'])) {
        const p = r?.payload
        const time = Date.parse(r?.timestamp ?? '') || 0
        if (r?.type === 'session_meta')
            cwd = String(p?.cwd ?? '')
        else if (r?.type === 'turn_context')
            model = String(p?.model ?? model)
        else if (r?.type === 'compacted') {
            messages.push({ role: 'compactionSummary', timestamp: time })
            at.push(spendAt(time, ''))
        }
        else if (r?.type === 'event_msg' && p?.type === 'token_count') {
            const last = p.info?.last_token_usage
            const total = p.info?.total_token_usage?.total_tokens
            // Repeated with every rate-limit update; a resumed thread's first one carries only the size.
            if (!last || total === seen || !(last.input_tokens || last.output_tokens))
                continue
            seen = total
            const cacheRead = Number(last.cached_input_tokens) || 0
            const cacheWrite = Number(last.cache_write_input_tokens) || 0
            const tokens = { input: Math.max(0, (Number(last.input_tokens) || 0) - cacheRead - cacheWrite), output: Number(last.output_tokens) || 0, cacheRead, cacheWrite }
            const priced = pricedModel(prices, 'codex', model)
            const cost = costOf(priced?.cost, tokens)
            ttl ??= priced?.promptCache?.short
            messages.push({ role: 'assistant', model, timestamp: time, usage: { ...tokens, cost } })
            at.push(spendAt(time, priced?.key ?? model, cost.total))
        }
    }
    return { cwd, spends: billed(messages, at, ttl ? ttl * 1000 : CACHE_TTL_MS) }
}

/** Per file, kept while its size, mtime and the prices stay the same. */
const parsed = new Map<string, Session & { size: number, mtimeMs: number, prices: string }>()

/** Every session of pi, Claude Code and Codex with requests since `since` (ms). */
export async function readLedger(roots: LedgerRoots, since: number, prices: PriceList): Promise<Ledger> {
    const ledger: Ledger = { since, sessions: 0, cost: 0, waste: 0, channelWaste: 0, warming: 0, byDay: [], byAgent: [], byProject: [], byModel: [] }
    const groups = { byDay: new Map<string, SpendRow>(), byAgent: new Map<string, SpendRow>(), byProject: new Map<string, SpendRow>(), byModel: new Map<string, SpendRow>() }
    const add = (map: Map<string, SpendRow>, key: string, s: Spend) => {
        const row = map.get(key) ?? { key, cost: 0, waste: 0 }
        row.cost += s.cost
        row.waste += s.waste
        map.set(key, row)
    }
    const priceKey = JSON.stringify(prices)
    const claude = roots.claude ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
    const codex = roots.codex ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
    const sources = [
        { agent: 'pi', dir: roots.pi, read: readPi },
        { agent: 'Claude Code', dir: path.join(claude, 'projects'), read: (file: string) => readClaude(file, prices) },
        { agent: 'Codex', dir: path.join(codex, 'sessions'), read: (file: string) => readCodex(file, prices) },
        { agent: 'Codex', dir: path.join(codex, 'archived_sessions'), read: (file: string) => readCodex(file, prices) },
    ]
    for (const { agent, dir, read } of sources) {
        for (const name of await readdir(dir, { recursive: true }).catch(() => [])) {
            if (!name.endsWith('.jsonl'))
                continue
            const file = path.join(dir, name)
            const info = await stat(file).catch(() => undefined)
            if (!info || info.mtimeMs < since)
                continue
            let session = parsed.get(file)
            if (!session || session.size !== info.size || session.mtimeMs !== info.mtimeMs || session.prices !== priceKey) {
                session = { size: info.size, mtimeMs: info.mtimeMs, prices: priceKey, ...await read(file).catch(() => ({ cwd: '', spends: [] })) }
                parsed.set(file, session)
            }
            const spends = session.spends.filter(s => s.at >= since)
            if (!spends.length)
                continue
            // A Claude Code subagent's log is part of its session.
            if (!name.includes(`${path.sep}subagents${path.sep}`))
                ledger.sessions++
            for (const s of spends) {
                ledger.cost += s.cost
                ledger.waste += s.waste
                ledger.channelWaste += s.channel
                ledger.warming += s.warm
                const day = new Date(s.at)
                add(groups.byDay, `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`, s)
                add(groups.byAgent, agent, s)
                add(groups.byProject, session.cwd, s)
                add(groups.byModel, s.model || 'unknown', s)
            }
        }
    }
    ledger.byDay = [...groups.byDay.values()].sort((a, b) => b.key.localeCompare(a.key))
    ledger.byAgent = [...groups.byAgent.values()].sort((a, b) => b.cost - a.cost)
    ledger.byProject = [...groups.byProject.values()].sort((a, b) => b.cost - a.cost)
    ledger.byModel = [...groups.byModel.values()].sort((a, b) => b.cost - a.cost)
    return ledger
}
