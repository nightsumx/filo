// An agent's own session list (session/list), read by a short-lived process. It brings in the
// sessions started outside the app (Codex / Claude Code / Grok in a terminal) next to the app's own.

import type { AcpAgentSpec } from '@shared/agents'
import type { AcpLaunch } from './agent'
import { spawn } from 'node:child_process'
import { ACP_PROTOCOL_VERSION } from './agent'
import { AcpConnection, methodNotFound } from './connection'

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

/** Null when the agent cannot list sessions. Pages stop at `maxPages`; the whole read at `timeoutMs`. */
export async function listAgentSessions(spec: AcpAgentSpec, launch: AcpLaunch, { maxPages = 8, timeoutMs = 20_000 } = {}): Promise<SessionList | null> {
    const child = spawn(launch.file, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'ignore'] })
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${spec.label}: session/list timed out`)), timeoutMs)
    })
    const read = async (): Promise<SessionList | null> => {
        const init = await connection.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'pi-gui', version: '0.1.0' },
        })
        if (!init?.agentCapabilities?.sessionCapabilities?.list)
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
    }
    exited.catch(() => {})
    try {
        return await Promise.race([read(), exited, timeout])
    }
    finally {
        clearTimeout(timer)
        connection.close(new Error('closed'))
        child.stdin.end()
        child.kill('SIGTERM')
    }
}
