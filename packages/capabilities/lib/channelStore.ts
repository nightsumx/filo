// What both hosts keep of channel tests (channelTest.ts), in pi's agent dir so the terminal and Filo
// see the same: the last result per model in <agent dir>/channel-tests.json. And the cache record of
// past sessions, per model, for the same page: read from pi's session files.
import type { ChannelResult } from './channelTest'
import type { CacheMessage, MissReason } from './promptCache'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { cacheMisses, EXPECTED_MISSES } from './promptCache'

export const RESULTS_FILE = 'channel-tests.json'

export const modelKey = (provider: string, model: string) => `${provider}/${model}`

/** Last result per "provider/model"; a missing or broken file is none. */
export async function readChannelResults(agentDir: string): Promise<Record<string, ChannelResult>> {
    try {
        const data = JSON.parse(await readFile(path.join(agentDir, RESULTS_FILE), 'utf8'))
        const results = data?.results
        if (!results || typeof results !== 'object')
            return {}
        return Object.fromEntries(Object.entries(results).filter(([, r]: [string, any]) => r?.version === 1 && Array.isArray(r.steps))) as Record<string, ChannelResult>
    }
    catch {
        return {}
    }
}

/** Replaces the model's last result. Written through a temp file, so a reader never sees half of it. */
export async function saveChannelResult(agentDir: string, result: ChannelResult): Promise<void> {
    const results = await readChannelResults(agentDir)
    results[modelKey(result.provider, result.model)] = result
    await mkdir(agentDir, { recursive: true })
    const file = path.join(agentDir, RESULTS_FILE)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify({ version: 1, results }, null, 2)}\n`)
    await rename(tmp, file)
}

// ---------------------------------------------------------------- history

/** One model's requests in past sessions. */
export interface ModelHistory {
    provider: string
    model: string
    requests: number
    /** Requests in sessions that reported any caching. */
    cachedRequests: number
    prompt: number
    read: number
    /** Misses the user did not cause (EXPECTED_MISSES aside): lost at a prompt, dropped mid-run, tail re-billed. */
    misses: number
    missedTokens: number
    extraCost: number
    /** Misses after a model or thinking change, or idle: normal, listed apart. */
    expectedMisses: number
}

interface RequestRecord {
    key: string
    at: number
    prompt: number
    read: number
    cached: boolean
    miss?: { reason: MissReason, missed: number, extraCost: number }
}

interface Node {
    parent: string | null
    kind: 'user' | 'request' | 'reset' | 'other'
    message?: CacheMessage
}

const ID_RE = /"id":"([^"]+)","parentId":(?:null|"([^"]+)")/
const HEAD = 300

/**
 * A session file's requests, each judged against the request before it on its own branch: a file
 * holds every branch, and a request after going back in the tree only shares the earlier prefix.
 * Only assistant lines are parsed whole; the rest only for their place in the tree.
 */
async function readSession(file: string): Promise<RequestRecord[]> {
    const nodes = new Map<string, Node>()
    const order: string[] = []
    const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
        const head = line.slice(0, HEAD)
        // Message lines carry their ids first; others (custom entries) are small, so search all of them.
        const isMessage = head.startsWith('{"type":"message"')
        const ids = ID_RE.exec(isMessage ? head : line)
        if (!ids)
            continue
        const [, id, parent = null] = ids
        let node: Node = { parent, kind: 'other' }
        if (head.startsWith('{"type":"compaction"') || head.startsWith('{"type":"branch_summary"')) {
            node = { parent, kind: 'reset' }
        }
        else if (isMessage && head.includes('"message":{"role":"user"')) {
            node = { parent, kind: 'user' }
        }
        else if (isMessage && head.includes('"message":{"role":"assistant"') && line.includes('"usage"')) {
            try {
                const m = JSON.parse(line).message
                const u = m?.usage
                if (u && m.stopReason !== 'pending' && (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) > 0) {
                    node = {
                        parent,
                        kind: 'request',
                        message: {
                            role: 'assistant',
                            provider: m.provider,
                            model: m.model,
                            thinkingLevel: m.thinkingLevel,
                            stopReason: m.stopReason,
                            timestamp: m.timestamp,
                            usage: { input: u.input || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, cost: u.cost },
                        },
                    }
                }
            }
            catch {}
        }
        nodes.set(id, node)
        if (node.kind === 'request')
            order.push(id)
    }

    // A session that never reported caching on a model has nothing to miss (cacheMisses does the same).
    // What a cached token costs, per model: a pair where neither side read has no price of its own.
    const reported = new Set<string>()
    const readPrice = new Map<string, number>()
    for (const id of order) {
        const m = nodes.get(id)!.message!
        const key = modelKey(m.provider ?? '', m.model ?? '')
        if (m.usage!.cacheRead + m.usage!.cacheWrite > 0)
            reported.add(key)
        if (m.usage!.cacheRead > 0 && m.usage!.cost?.cacheRead && !readPrice.has(key))
            readPrice.set(key, m.usage!.cost.cacheRead / m.usage!.cacheRead)
    }

    return order.map((id) => {
        const m = nodes.get(id)!.message!
        const key = modelKey(m.provider ?? '', m.model ?? '')
        const record: RequestRecord = { key, at: m.timestamp, prompt: m.usage!.input + m.usage!.cacheRead + m.usage!.cacheWrite, read: m.usage!.cacheRead, cached: reported.has(key) }
        // The previous request up the branch, and whether a user message came in between.
        let userBetween = false
        let previous: CacheMessage | undefined
        for (let at = nodes.get(id)!.parent, guard = 0; at && guard < 100_000; guard++) {
            const n = nodes.get(at)
            if (!n || n.kind === 'reset')
                break
            if (n.kind === 'user')
                userBetween = true
            if (n.kind === 'request') {
                previous = n.message
                break
            }
            at = n.parent
        }
        if (previous) {
            // On a model that reports caching, a pair that reported nothing is still a miss: cacheMisses
            // learns that from earlier requests, so mark the previous one as reporting (one token moved
            // from input to write keeps its prompt the same).
            const u = previous.usage!
            const prev = record.cached && u.cacheRead + u.cacheWrite === 0 && u.input > 0
                ? { ...previous, usage: { ...u, input: u.input - 1, cacheWrite: 1 } }
                : previous
            const pair: CacheMessage[] = [prev, ...(userBetween ? [{ role: 'user', timestamp: m.timestamp }] : []), m]
            const miss = record.cached ? cacheMisses(pair).at(-1) : null
            if (miss) {
                let extraCost = miss.extraCost
                const read = readPrice.get(key)
                const mu = m.usage!
                const paidTokens = mu.input + mu.cacheWrite
                if (extraCost === null && read !== undefined && paidTokens > 0 && mu.cost)
                    extraCost = miss.missed * Math.max(0, ((mu.cost.input || 0) + (mu.cost.cacheWrite || 0)) / paidTokens - read)
                record.miss = { reason: miss.reason, missed: miss.missed, extraCost: extraCost ?? 0 }
            }
        }
        return record
    })
}

/** Parsed files by path, kept while their size and mtime stay the same. */
export type HistoryCache = Map<string, { size: number, mtimeMs: number, records: RequestRecord[] }>

export const HISTORY_DAYS = 7

/** pi's sessions root, the way Filo finds it (electron/sessions.ts): env var, settings.json sessionDir, then the default. */
export async function sessionsRoot(agentDir: string): Promise<string> {
    if (process.env.PI_CODING_AGENT_SESSION_DIR)
        return process.env.PI_CODING_AGENT_SESSION_DIR
    try {
        const settings = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'))
        if (typeof settings.sessionDir === 'string' && path.isAbsolute(settings.sessionDir))
            return settings.sessionDir
    }
    catch {}
    return path.join(agentDir, 'sessions')
}

/**
 * Per "provider/model", the requests of sessions under `sessionsRoot` (pi's sessions dir, one folder
 * per project) since `since`. Files untouched since then are skipped without being read.
 */
export async function channelHistory(sessionsRoot: string, options: { since?: number, cache?: HistoryCache, signal?: AbortSignal } = {}): Promise<Record<string, ModelHistory>> {
    const since = options.since ?? Date.now() - HISTORY_DAYS * 86_400_000
    const cache = options.cache
    const files: string[] = []
    const dirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
        if (!dir.isDirectory())
            continue
        const entries = await readdir(path.join(sessionsRoot, dir.name)).catch(() => [])
        for (const name of entries) {
            if (name.endsWith('.jsonl'))
                files.push(path.join(sessionsRoot, dir.name, name))
        }
    }
    const out: Record<string, ModelHistory> = {}
    for (const file of files) {
        if (options.signal?.aborted)
            break
        const info = await stat(file).catch(() => undefined)
        if (!info || info.mtimeMs < since)
            continue
        let hit = cache?.get(file)
        if (!hit || hit.size !== info.size || hit.mtimeMs !== info.mtimeMs) {
            const records = await readSession(file).catch(() => [])
            hit = { size: info.size, mtimeMs: info.mtimeMs, records }
            cache?.set(file, hit)
        }
        for (const r of hit.records) {
            if (r.at < since)
                continue
            const slash = r.key.indexOf('/')
            const h = out[r.key] ??= { provider: r.key.slice(0, slash), model: r.key.slice(slash + 1), requests: 0, cachedRequests: 0, prompt: 0, read: 0, misses: 0, missedTokens: 0, extraCost: 0, expectedMisses: 0 }
            h.requests++
            h.prompt += r.prompt
            h.read += r.read
            if (r.cached)
                h.cachedRequests++
            if (r.miss && EXPECTED_MISSES.has(r.miss.reason)) {
                h.expectedMisses++
            }
            else if (r.miss) {
                h.misses++
                h.missedTokens += r.miss.missed
                h.extraCost += r.miss.extraCost
            }
        }
    }
    return out
}
