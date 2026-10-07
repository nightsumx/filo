// ACP agents for the main process: finding their adapter commands, the index of their sessions
// (started from the app, or listed by the agent itself), reading a session back (live transcript, or
// a session/load replay), and the pi-format copies that search and the edit log read (mirror.ts).

import type { AcpAgentCaps, AcpAgentId, AcpAgentSpec, AgentAvailability } from '@shared/agents'
import type { SessionItem, SessionSnapshot, SessionSummary } from '@shared/ipc'
import type { AcpAgentCallbacks, AcpLaunch } from './agent'
import { ACP_AGENTS, acpAgent, acpSessionKey, parseAcpSessionKey } from '@shared/agents'
import { constants, readFileSync } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { tr } from '../i18n'
import { loginShellPath } from '../pi-env'
import { agentDir } from '../piSettings'
import { AcpAgent } from './agent'
import { deleteAgentSession, listAgentSessions } from './list'
import { mirrorFile, mirrorFiles, mirrorKey, mirrorText } from './mirror'

/** What the app remembers of an ACP session (the agent keeps the conversation itself). */
export interface AcpSessionRecord {
    key: string
    agent: AcpAgentId
    sessionId: string
    cwd: string
    /** Set by the user (rename). */
    name?: string
    /** Set by the agent (session_info_update). */
    title?: string
    firstPrompt?: string
    createdAt: number
    updatedAt: number
    /** Found in the agent's own list (session/list), not started from the app. */
    imported?: boolean
}

/** An agent's own list is read again after this long (sessions from a terminal show up then). */
const IMPORT_EVERY_MS = 2 * 60_000
/** The first list (nothing imported yet) is waited for this long before the sidebar shows. */
const FIRST_IMPORT_WAIT_MS = 6000
const MIRROR_DELAY_MS = 200

async function findIn(bin: string, dirs: string[]): Promise<string | undefined> {
    for (const dir of dirs) {
        if (!dir)
            continue
        const file = path.join(dir, bin)
        try {
            await access(file, constants.X_OK)
            return file
        }
        catch {}
    }
    return undefined
}

const findOnPath = (bin: string, searchPath: string) => findIn(bin, searchPath.split(path.delimiter))

/** PI_GUI_ACP_<ID>='["node","/path/agent.mjs"]' replaces the adapter command (tests, local builds). */
function overrideOf(spec: AcpAgentSpec): string[] | undefined {
    const raw = process.env[`PI_GUI_ACP_${spec.id.toUpperCase()}`]
    if (!raw)
        return undefined
    try {
        const argv = JSON.parse(raw)
        if (Array.isArray(argv) && argv.length && argv.every(a => typeof a === 'string'))
            return argv
    }
    catch {}
    return [raw]
}

/** A literal API key saved in pi's auth.json for this provider (not an env name or a !command). */
async function piApiKey(provider: string): Promise<string | undefined> {
    try {
        const auth = JSON.parse(await readFile(path.join(agentDir(), 'auth.json'), 'utf8'))
        const entry = auth?.[provider]
        const key = entry?.type === 'api_key' && typeof entry.key === 'string' ? entry.key.trim() : ''
        return key && !key.startsWith('!') && !/^[A-Z][A-Z0-9_]*$/.test(key) ? key : undefined
    }
    catch {
        return undefined
    }
}

export async function resolveLaunch(spec: AcpAgentSpec): Promise<AcpLaunch> {
    const searchPath = await loginShellPath()
    const env: Record<string, string> = { ...process.env as Record<string, string>, PATH: searchPath }
    delete env.ELECTRON_RUN_AS_NODE
    // The user's own CLI: same version and sign-in as in their terminal.
    if (spec.cli && !env[spec.cli.env]) {
        const cli = await findOnPath(spec.cli.bin, searchPath)
        if (cli)
            env[spec.cli.env] = cli
    }
    if (spec.apiKey && !env[spec.apiKey.env]) {
        const key = await piApiKey(spec.apiKey.provider)
        if (key)
            env[spec.apiKey.env] = key
    }
    const override = overrideOf(spec)
    if (override)
        return { file: override[0], args: override.slice(1), env, via: 'override' }
    const dirs = [...searchPath.split(path.delimiter), ...(spec.dirs ?? []).map(d => d.replace(/^~(?=\/)/, os.homedir()))]
    const adapter = await findIn(spec.bin, dirs)
    if (adapter)
        return { file: adapter, args: spec.args ?? [], env, via: 'path' }
    if (!spec.npm) {
        throw new Error(tr(
            `找不到 ${spec.bin}。安装：${spec.install ?? spec.bin}`,
            `${spec.bin} not found. Install it: ${spec.install ?? spec.bin}`,
        ))
    }
    const npx = await findOnPath('npx', searchPath)
    if (npx)
        return { file: npx, args: ['-y', spec.npm, ...(spec.npmArgs ?? spec.args ?? [])], env, via: 'npx' }
    const pkg = spec.npm.replace(/@[^@/]+$/, '')
    throw new Error(tr(
        `找不到 ${spec.bin}，也没有 npx 可以临时运行它。安装 Node.js，或者 npm install -g ${pkg}。`,
        `${spec.bin} not found, and no npx to run it. Install Node.js, or npm install -g ${pkg}.`,
    ))
}

export class AcpService {
    private records = new Map<string, AcpSessionRecord>()
    /** Agents holding a session, by session key: their transcript is the freshest read. */
    private live = new Map<string, AcpAgent>()
    private replays = new Map<string, { updatedAt: number, snapshot: Promise<SessionSnapshot> }>()
    private saving: Promise<void> = Promise.resolve()
    /** Sessions the user removed from the app; the agent still lists them. */
    private hidden = new Set<string>()
    /** When each agent's list was last read (attempted). */
    private importedAt: Partial<Record<AcpAgentId, number>> = {}
    private importing: Promise<void> | null = null
    private mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** What each agent said it can do, the last time one started. */
    private caps: Partial<Record<AcpAgentId, AcpAgentCaps>> = {}

    /** `mirrorDir`: where the pi-format copies go; none, no copies. */
    constructor(private file: () => string, private mirrorDir?: () => string) {
        try {
            const saved = JSON.parse(readFileSync(file(), 'utf8'))
            for (const record of Array.isArray(saved?.sessions) ? saved.sessions : []) {
                if (typeof record?.key === 'string' && parseAcpSessionKey(record.key))
                    this.records.set(record.key, record)
            }
            for (const key of Array.isArray(saved?.hidden) ? saved.hidden : []) {
                if (typeof key === 'string')
                    this.hidden.add(key)
            }
            if (saved?.importedAt && typeof saved.importedAt === 'object')
                this.importedAt = saved.importedAt
            if (saved?.caps && typeof saved.caps === 'object')
                this.caps = saved.caps
        }
        catch {}
    }

    async availability(): Promise<AgentAvailability[]> {
        return Promise.all(ACP_AGENTS.map(async (spec) => {
            try {
                const launch = await resolveLaunch(spec)
                return { id: spec.id, label: spec.label, available: true, via: launch.via, command: [path.basename(launch.file), ...launch.args].join(' ') }
            }
            catch (error: any) {
                return { id: spec.id, label: spec.label, available: false, error: String(error?.message ?? error) }
            }
        }))
    }

    /** Starts an agent process for a thread; `sessionKey` resumes that session. */
    async start(agent: AcpAgentId, cwd: string, sessionKey: string | undefined, callbacks: AcpAgentCallbacks): Promise<AcpAgent> {
        const spec = acpAgent(agent)
        if (!spec)
            throw new Error(`Unknown agent: ${agent}`)
        const resume = parseAcpSessionKey(sessionKey)
        const record = sessionKey ? this.records.get(sessionKey) : undefined
        const launch = await resolveLaunch(spec)
        const instance = new AcpAgent(spec, launch, { cwd, sessionId: resume?.sessionId, replayTime: record?.updatedAt }, {
            onEvent: (id, event) => {
                callbacks.onEvent(id, event)
                if (event.type === 'message_end')
                    this.mirrorSoon(instance.key, () => instance.snapshot())
            },
            onExit: (id, info) => {
                if (this.live.get(instance.key) === instance)
                    this.live.delete(instance.key)
                callbacks.onExit(id, info)
            },
            onFork: (a, sessionId) => this.noteFork(a, sessionId),
            onSession: (a, change) => {
                if (!a.key)
                    return
                this.noteCaps(spec.id, a.caps)
                this.live.set(a.key, a)
                this.replays.delete(a.key)
                this.note(a, change)
                this.mirrorSoon(a.key, () => a.snapshot())
                if (change.title && !this.records.get(a.key)?.name)
                    callbacks.onEvent(a.id, { type: 'session_info_changed', name: change.title })
            },
        })
        return instance
    }

    private note(agent: AcpAgent, change: { prompt?: string, title?: string, name?: string }) {
        const now = Date.now()
        const existing = this.records.get(agent.key)
        // A session that never got a prompt is not worth listing (pi writes no file for it either).
        if (!existing && !change.prompt)
            return
        const record: AcpSessionRecord = existing ?? { key: agent.key, agent: agent.spec.id, sessionId: agent.sessionId, cwd: agent.cwd, createdAt: now, updatedAt: now }
        if (change.prompt && !record.firstPrompt)
            record.firstPrompt = change.prompt.trim().slice(0, 200)
        if (change.title)
            record.title = change.title
        if (change.name !== undefined)
            record.name = change.name || undefined
        record.updatedAt = now
        this.records.set(record.key, record)
        this.save()
    }

    /**
     * The index, after bringing in each agent's own list when it is due. The first time (nothing
     * imported yet) waits a little for it; later the last import shows and the next lands behind.
     *
     * Every session cwd is a project in the sidebar, so imported sessions only show for `projects`
     * (folders the app knows already): a Codex history spans every scratch folder it ever ran in.
     */
    async listSessions(projects: ReadonlySet<string>): Promise<SessionSummary[]> {
        const pass = this.importDue()
        if (!Object.keys(this.importedAt).length)
            await Promise.race([pass, new Promise(resolve => setTimeout(resolve, FIRST_IMPORT_WAIT_MS))])
        return this.summaries(projects)
    }

    private summaries(projects: ReadonlySet<string>): SessionSummary[] {
        return [...this.records.values()].filter(r => !r.imported || projects.has(r.cwd)).map(r => ({
            path: r.key,
            id: r.sessionId,
            cwd: r.cwd,
            name: r.name ?? r.title,
            firstPrompt: r.firstPrompt,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            agent: r.agent,
            agentCaps: this.caps[r.agent],
        }))
    }

    has(key: string): boolean {
        return this.records.has(key)
    }

    async readSession(key: string): Promise<SessionSnapshot> {
        const parsed = parseAcpSessionKey(key)
        if (!parsed)
            throw new Error(`Not an ACP session: ${key}`)
        const record = this.records.get(key)
        const live = this.live.get(key)
        const header = { path: key, id: parsed.sessionId, cwd: record?.cwd ?? live?.cwd ?? '', name: record?.name ?? record?.title }
        if (live)
            return { ...header, items: live.snapshot() }
        if (!record)
            return { ...header, items: [] }
        const cached = this.replays.get(key)
        if (cached?.updatedAt === record.updatedAt)
            return cached.snapshot
        const snapshot = this.replay(record).then((items) => {
            void this.writeMirror(key, items)
            return { ...header, items }
        })
        this.replays.set(key, { updatedAt: record.updatedAt, snapshot })
        snapshot.catch(() => this.replays.delete(key))
        return snapshot
    }

    /** Reads the lists of the agents that are due, one pass at a time. */
    importDue(): Promise<void> {
        this.importing ??= this.importAll().finally(() => {
            this.importing = null
        })
        return this.importing
    }

    private async importAll() {
        const now = Date.now()
        await Promise.all(ACP_AGENTS.map(async (spec) => {
            if (now - (this.importedAt[spec.id] ?? 0) < IMPORT_EVERY_MS)
                return
            let launch: AcpLaunch
            try {
                launch = await resolveLaunch(spec)
            }
            catch {
                return
            }
            // npx would download the adapter (hundreds of MB) just to list: only once the user ran it.
            if (launch.via === 'npx' && ![...this.records.values()].some(r => r.agent === spec.id && !r.imported))
                return
            this.importedAt[spec.id] = now
            try {
                const { caps, list } = await listAgentSessions(spec, launch)
                this.noteCaps(spec.id, caps)
                if (list)
                    this.merge(spec.id, list.sessions, list.complete)
            }
            catch {}
        }))
        this.save()
    }

    /** Folds an agent's list into the index; with the whole list, imported sessions it no longer has go. */
    merge(agent: AcpAgentId, listed: { sessionId: string, cwd: string, title?: string, updatedAt: number }[], complete: boolean) {
        const seen = new Set<string>()
        for (const s of listed) {
            const key = acpSessionKey(agent, s.sessionId)
            seen.add(key)
            if (this.hidden.has(key))
                continue
            const existing = this.records.get(key)
            if (existing) {
                existing.title ??= s.title
                if (s.updatedAt > existing.updatedAt)
                    existing.updatedAt = s.updatedAt
                continue
            }
            const at = s.updatedAt || Date.now()
            this.records.set(key, { key, agent, sessionId: s.sessionId, cwd: s.cwd, title: s.title, createdAt: at, updatedAt: at, imported: true })
        }
        if (complete) {
            for (const record of [...this.records.values()]) {
                if (record.agent === agent && record.imported && !seen.has(record.key) && !this.live.has(record.key)) {
                    this.records.delete(record.key)
                    this.dropMirror(record.key)
                }
            }
        }
        this.save()
    }

    // ---------------------------------------------------------------- pi-format copies

    /** Every copy, for search and the edit log. */
    mirrors(): Promise<string[]> {
        return this.mirrorDir ? mirrorFiles(this.mirrorDir()) : Promise.resolve([])
    }

    /** The session key a copy stands for. */
    keyOfMirror(file: string): string | undefined {
        return this.mirrorDir ? mirrorKey(this.mirrorDir(), file) : undefined
    }

    /** Rewrites a session's copy soon; bursts of messages collapse into one write. */
    private mirrorSoon(key: string, items: () => SessionItem[]) {
        if (!this.mirrorDir || !key)
            return
        clearTimeout(this.mirrorTimers.get(key))
        this.mirrorTimers.set(key, setTimeout(() => {
            this.mirrorTimers.delete(key)
            void this.writeMirror(key, items())
        }, MIRROR_DELAY_MS))
    }

    private async writeMirror(key: string, items: SessionItem[]) {
        const record = this.records.get(key)
        const file = this.mirrorDir && mirrorFile(this.mirrorDir(), key)
        // Only listed sessions: one that never got a prompt is not in the index either.
        if (!record || !file || !items.length)
            return
        const text = mirrorText({ sessionId: record.sessionId, cwd: record.cwd, createdAt: record.createdAt, name: record.name ?? record.title }, items)
        try {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(`${file}.tmp`, text)
            await rename(`${file}.tmp`, file)
        }
        catch {}
    }

    private dropMirror(key: string) {
        clearTimeout(this.mirrorTimers.get(key))
        this.mirrorTimers.delete(key)
        const file = this.mirrorDir && mirrorFile(this.mirrorDir(), key)
        if (file)
            void rm(file, { force: true }).catch(() => {})
    }

    /** Opens the session in a throwaway process; session/load streams the history back. */
    private async replay(record: AcpSessionRecord) {
        const spec = acpAgent(record.agent)!
        const launch = await resolveLaunch(spec)
        let failure = ''
        const agent = new AcpAgent(spec, launch, { cwd: record.cwd, sessionId: record.sessionId, readOnly: true, replayTime: record.updatedAt }, {
            onEvent: () => {},
            onExit: (_id, info) => {
                failure = info.stderr.trim().split('\n').slice(-3).join('\n')
            },
        })
        try {
            await agent.ready
            return agent.snapshot()
        }
        catch (error: any) {
            throw new Error(String(error?.message ?? error) || failure)
        }
        finally {
            void agent.stop()
        }
    }

    private noteCaps(agent: AcpAgentId, caps: AcpAgentCaps) {
        if (JSON.stringify(this.caps[agent]) === JSON.stringify(caps))
            return
        this.caps[agent] = caps
        this.save()
    }

    /** A fork the agent just made: listed like the session it came from. */
    private noteFork(from: AcpAgent, sessionId: string): string {
        const key = acpSessionKey(from.spec.id, sessionId)
        const source = this.records.get(from.key)
        const now = Date.now()
        const title = source?.name ?? source?.title ?? source?.firstPrompt
        this.records.set(key, {
            key,
            agent: from.spec.id,
            sessionId,
            cwd: from.cwd,
            name: title ? tr(`${title}（分叉）`, `${title} (fork)`) : undefined,
            firstPrompt: source?.firstPrompt,
            createdAt: now,
            updatedAt: now,
        })
        this.save()
        // Its copy for search: the transcript so far, which the fork holds too.
        void this.writeMirror(key, from.snapshot())
        return key
    }

    /** Deletes the session in the agent's own history too (session/delete), then forgets it. */
    async deleteHistory(key: string) {
        const record = this.records.get(key)
        const spec = record && acpAgent(record.agent)
        if (!record || !spec)
            return
        const live = this.live.get(key)
        if (live)
            await live.stop()
        await deleteAgentSession(spec, await resolveLaunch(spec), record.sessionId)
        this.remove(key)
    }

    /** Forgets a session in the app; the agent's own history is left alone (and stays hidden here). */
    remove(key: string) {
        if (!this.records.delete(key))
            return
        // The agent's own list would bring it back.
        this.hidden.add(key)
        this.replays.delete(key)
        this.dropMirror(key)
        this.save()
    }

    private save() {
        const data = JSON.stringify({ sessions: [...this.records.values()], hidden: [...this.hidden], importedAt: this.importedAt, caps: this.caps }, null, 2)
        const file = this.file()
        this.saving = this.saving.then(async () => {
            await mkdir(path.dirname(file), { recursive: true })
            const tmp = `${file}.tmp`
            await writeFile(tmp, data)
            await rename(tmp, file)
        }).catch(() => {})
    }
}
