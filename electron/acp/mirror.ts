// ACP agents keep their conversations in their own stores, in their own formats. The app writes a
// copy of each one it shows as a pi session file (header, session_info, message entries), so session
// search and the edit log read ACP threads the same way they read pi's. The copy is only an index:
// opening a session still asks the agent (session/load), which has the latest history.
//
// Layout: <dir>/<agent>/<sessionId>.jsonl. No Electron imports: the search worker uses this too.

import type { AcpAgentId } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import { acpSessionKey, parseAcpSessionKey } from '@shared/agents'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

export interface MirrorHeader {
    sessionId: string
    cwd: string
    createdAt: number
    /** The user's name for the session, else the agent's title. */
    name?: string
}

/** The copy's path for a session key; undefined for keys that are not ACP sessions. */
export function mirrorFile(dir: string, key: string): string | undefined {
    const parsed = parseAcpSessionKey(key)
    return parsed ? path.join(dir, parsed.agent, `${encodeURIComponent(parsed.sessionId)}.jsonl`) : undefined
}

/** The session key a copy stands for; undefined for any other file. */
export function mirrorKey(dir: string, file: string): string | undefined {
    const rel = path.relative(dir, file)
    const parts = rel.split(path.sep)
    if (parts.length !== 2 || rel.startsWith('..') || !parts[1].endsWith('.jsonl'))
        return undefined
    const key = acpSessionKey(parts[0] as AcpAgentId, decodeURIComponent(parts[1].slice(0, -'.jsonl'.length)))
    return parseAcpSessionKey(key) ? key : undefined
}

/** A transcript as pi session JSONL: entry ids are the snapshot's, so search hits open at the message. */
export function mirrorText(header: MirrorHeader, items: SessionItem[]): string {
    const iso = (ms: number | undefined) => new Date(ms && Number.isFinite(ms) ? ms : header.createdAt).toISOString()
    const lines: unknown[] = [{ type: 'session', version: 3, id: header.sessionId, timestamp: iso(header.createdAt), cwd: header.cwd }]
    let parentId: string | null = null
    if (header.name) {
        lines.push({ type: 'session_info', id: 'name', parentId, timestamp: iso(header.createdAt), name: header.name })
        parentId = 'name'
    }
    for (const item of items) {
        const at = item.endedAt ?? (item.message as { timestamp?: number }).timestamp
        lines.push({ type: 'message', id: item.entryId, parentId, timestamp: iso(at), message: item.message })
        parentId = item.entryId
    }
    return `${lines.map(l => JSON.stringify(l)).join('\n')}\n`
}

/** Every copy under `dir`. */
export async function mirrorFiles(dir: string): Promise<string[]> {
    const files: string[] = []
    let agents: string[]
    try {
        agents = await readdir(dir)
    }
    catch {
        return files
    }
    await Promise.all(agents.map(async (agent) => {
        try {
            for (const name of await readdir(path.join(dir, agent))) {
                if (name.endsWith('.jsonl'))
                    files.push(path.join(dir, agent, name))
            }
        }
        catch {}
    }))
    return files
}
