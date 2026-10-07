// ACP agents for the main process: finding their adapter commands, the index of sessions started
// from the app, and reading a session back (live transcript, or a session/load replay).

import type { AcpAgentId, AcpAgentSpec, AgentAvailability } from '@shared/agents'
import type { SessionSnapshot, SessionSummary } from '@shared/ipc'
import type { AcpAgentCallbacks, AcpLaunch } from './agent'
import { ACP_AGENTS, acpAgent, parseAcpSessionKey } from '@shared/agents'
import { constants, readFileSync } from 'node:fs'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { tr } from '../i18n'
import { loginShellPath } from '../pi-env'
import { AcpAgent } from './agent'

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
}

async function findOnPath(bin: string, searchPath: string): Promise<string | undefined> {
    for (const dir of searchPath.split(path.delimiter)) {
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

/** PI_GUI_ACP_CODEX='["node","/path/agent.mjs"]' replaces the adapter command (tests, local builds). */
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
    const override = overrideOf(spec)
    if (override)
        return { file: override[0], args: override.slice(1), env }
    const adapter = await findOnPath(spec.bin, searchPath)
    if (adapter)
        return { file: adapter, args: [], env }
    const npx = await findOnPath('npx', searchPath)
    if (npx)
        return { file: npx, args: ['-y', spec.npm], env }
    throw new Error(tr(
        `找不到 ${spec.bin}，也没有 npx 可以临时运行它。安装 Node.js，或者 npm install -g ${spec.npm.replace(/@[^@/]+$/, '')}。`,
        `${spec.bin} not found, and no npx to run it. Install Node.js, or npm install -g ${spec.npm.replace(/@[^@/]+$/, '')}.`,
    ))
}

export class AcpService {
    private records = new Map<string, AcpSessionRecord>()
    /** Agents holding a session, by session key: their transcript is the freshest read. */
    private live = new Map<string, AcpAgent>()
    private replays = new Map<string, { updatedAt: number, snapshot: Promise<SessionSnapshot> }>()
    private saving: Promise<void> = Promise.resolve()

    constructor(private file: () => string) {
        try {
            const saved = JSON.parse(readFileSync(file(), 'utf8'))
            for (const record of Array.isArray(saved?.sessions) ? saved.sessions : []) {
                if (typeof record?.key === 'string' && parseAcpSessionKey(record.key))
                    this.records.set(record.key, record)
            }
        }
        catch {}
    }

    async availability(): Promise<AgentAvailability[]> {
        return Promise.all(ACP_AGENTS.map(async (spec) => {
            try {
                const launch = await resolveLaunch(spec)
                return { id: spec.id, label: spec.label, available: true, command: [path.basename(launch.file), ...launch.args].join(' ') }
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
            onEvent: callbacks.onEvent,
            onExit: (id, info) => {
                if (this.live.get(instance.key) === instance)
                    this.live.delete(instance.key)
                callbacks.onExit(id, info)
            },
            onSession: (a, change) => {
                if (!a.key)
                    return
                this.live.set(a.key, a)
                this.replays.delete(a.key)
                this.note(a, change)
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

    listSessions(): SessionSummary[] {
        return [...this.records.values()].map(r => ({
            path: r.key,
            id: r.sessionId,
            cwd: r.cwd,
            name: r.name ?? r.title,
            firstPrompt: r.firstPrompt,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            agent: r.agent,
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
        const snapshot = this.replay(record).then(items => ({ ...header, items }))
        this.replays.set(key, { updatedAt: record.updatedAt, snapshot })
        snapshot.catch(() => this.replays.delete(key))
        return snapshot
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

    /** Forgets a session in the app; the agent's own history is left alone. */
    remove(key: string) {
        if (this.records.delete(key)) {
            this.replays.delete(key)
            this.save()
        }
    }

    private save() {
        const data = JSON.stringify({ sessions: [...this.records.values()] }, null, 2)
        const file = this.file()
        this.saving = this.saving.then(async () => {
            await mkdir(path.dirname(file), { recursive: true })
            const tmp = `${file}.tmp`
            await writeFile(tmp, data)
            await rename(tmp, file)
        }).catch(() => {})
    }
}
