// Short-lived agent processes for work outside a thread: an agent's own session list (session/list,
// which brings in sessions started in a terminal) and deleting a session from the agent's history.

import type { AcpAgentCaps, AcpAgentSpec } from '@shared/agents'
import type { AcpLaunch } from './agent'
import { acpCaps } from '@shared/agents'
import { spawn } from 'node:child_process'
import { ACP_PROTOCOL_VERSION } from './agent'
import { AcpConnection, methodNotFound } from './connection'
import { CODEX_CAPS, deleteCodexThread, listCodexThreads } from '../native/codex'

export interface ListedSession {
    sessionId: string
    cwd: string
    title?: string
    /** ms; 0 when the agent gave none. */
    updatedAt: number
}

export interface SessionList {
    sessions: ListedSession[]
    /** Every page was read: a session missing from it is gone from the agent. */
    complete: boolean
}

/** Starts the agent, initializes, runs `work`, and ends the process; the whole of it within `timeoutMs`. */
export async function withAgent<T>(spec: AcpAgentSpec, launch: AcpLaunch, work: (connection: AcpConnection, caps: AcpAgentCaps) => Promise<T>, timeoutMs = 20_000): Promise<{ caps: AcpAgentCaps, result: T }> {
    const child = spawn(launch.file, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'ignore'], windowsVerbatimArguments: launch.windowsVerbatimArguments })
    const connection = new AcpConnection(child.stdin, child.stdout, {
        onNotification: () => {},
        onRequest: async (method) => {
            throw methodNotFound(method)
        },
    })
    const exited = new Promise<never>((_resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => reject(new Error(`${spec.label} exited (${code})`)))
    })
    exited.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${spec.label}: timed out`)), timeoutMs)
    })
    const run = async () => {
        const init = await connection.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'pi-gui', version: '0.1.0' },
        })
        const caps = acpCaps(init)
        return { caps, result: await work(connection, caps) }
    }
    try {
        return await Promise.race([run(), exited, timeout])
    }
    finally {
        clearTimeout(timer)
        connection.close(new Error('closed'))
        child.stdin.end()
        child.kill('SIGTERM')
    }
}

/** Null when the agent cannot list sessions. Pages stop at `maxPages`. */
export async function listAgentSessions(spec: AcpAgentSpec, launch: AcpLaunch, { maxPages = 8 } = {}): Promise<{ caps: AcpAgentCaps, list: SessionList | null }> {
    if (spec.protocol === 'codex-app-server')
        return { caps: CODEX_CAPS, list: await listCodexThreads(launch, maxPages) }
    const { caps, result } = await withAgent(spec, launch, async (connection, caps) => {
        if (!caps.list)
            return null
        const sessions: ListedSession[] = []
        let cursor: string | undefined
        for (let page = 0; page < maxPages; page++) {
            const result = await connection.request('session/list', cursor ? { cursor } : {})
            for (const s of Array.isArray(result?.sessions) ? result.sessions : []) {
                if (typeof s?.sessionId !== 'string' || !s.sessionId || typeof s.cwd !== 'string' || !s.cwd)
                    continue
                sessions.push({
                    sessionId: s.sessionId,
                    cwd: s.cwd,
                    title: typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 200) : undefined,
                    updatedAt: (typeof s.updatedAt === 'string' && Date.parse(s.updatedAt)) || 0,
                })
            }
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
            if (!cursor)
                return { sessions, complete: true }
        }
        return { sessions, complete: false }
    })
    return { caps, list: result }
}

/** Deletes a session from the agent's own history (session/delete; Grok Build's x.ai/session/delete). */
export async function deleteAgentSession(spec: AcpAgentSpec, launch: AcpLaunch, sessionId: string): Promise<void> {
    if (spec.protocol === 'codex-app-server')
        return deleteCodexThread(launch, sessionId)
    await withAgent(spec, launch, async (connection, caps) => {
        if (!caps.delete)
            throw new Error(`${spec.label} cannot delete sessions`)
        // No cwd: Grok then finds the session among all of them, whatever path the app knows it by.
        await connection.request(caps.xai ? '_x.ai/session/delete' : 'session/delete', { sessionId })
    })
}
