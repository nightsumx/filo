// Terminal pi sessions, as reported by pi-cc-tui's presence extension: one JSON file per process
// (see PRESENCE_DIR in packages/capabilities/protocol.ts). Watched here, pushed to every window.
import type { Presence } from '@shared/capabilities'
import { BRIDGE_PIPE_SUFFIX, BRIDGE_SOCKET_SUFFIX, PRESENCE_DIR } from '@shared/capabilities'
import { watch } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/** pi's agent dir: where the extension writes (same rule as pi's getAgentDir). */
export function presenceDir(): string {
    const env = process.env.PI_CODING_AGENT_DIR
    const agentDir = env ? env.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), '.pi', 'agent')
    return path.join(agentDir, PRESENCE_DIR)
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    }
    catch (error: any) {
        // EPERM: the process exists, it just is not ours.
        return error?.code === 'EPERM'
    }
}

function parsePresence(text: string): Presence | null {
    try {
        const p = JSON.parse(text)
        if (!Number.isInteger(p?.pid) || typeof p.cwd !== 'string' || !['idle', 'running', 'waiting'].includes(p.state))
            return null
        return { pid: p.pid, cwd: p.cwd, session: typeof p.session === 'string' ? p.session : undefined, state: p.state, since: Number(p.since) || 0 }
    }
    catch {
        return null
    }
}

/** Live entries in `dir`; files of dead processes are removed. */
export async function readPresence(dir: string): Promise<Presence[]> {
    let names: string[]
    try {
        names = await readdir(dir)
    }
    catch {
        return []
    }
    const out: Presence[] = []
    const sockets = new Set(names.filter(n => n.endsWith(BRIDGE_SOCKET_SUFFIX)))
    for (const name of names) {
        const socket = name.match(/^(\d+)\.(sock|pipe)$/)
        // A killed pi leaves its bridge socket (or pipe file) behind too.
        if (socket && !alive(Number(socket[1])))
            await rm(path.join(dir, name), { force: true }).catch(() => {})
        if (!/^\d+\.json$/.test(name))
            continue
        const pid = Number.parseInt(name)
        const file = path.join(dir, name)
        // A garbled file of a live process may be mid-write: skip it this time, never delete it.
        if (!alive(pid)) {
            await rm(file, { force: true }).catch(() => {})
            continue
        }
        const p = parsePresence(await readFile(file, 'utf8').catch(() => ''))
        if (!p || p.pid !== pid)
            continue
        const bridge = path.join(dir, `${pid}${BRIDGE_SOCKET_SUFFIX}`)
        if (sockets.has(`${pid}${BRIDGE_SOCKET_SUFFIX}`) && (await stat(bridge).catch(() => null))?.isSocket())
            p.bridge = bridge
        // Windows: a named pipe, announced with the token it wants first.
        if (names.includes(`${pid}${BRIDGE_PIPE_SUFFIX}`)) {
            const pipe = await readFile(path.join(dir, `${pid}${BRIDGE_PIPE_SUFFIX}`), 'utf8').then(JSON.parse).catch(() => null)
            if (typeof pipe?.path === 'string' && typeof pipe.token === 'string') {
                p.bridge = pipe.path
                p.bridgeToken = pipe.token
            }
        }
        out.push(p)
    }
    return out.sort((a, b) => a.pid - b.pid)
}

/** Killed processes leave no event behind: re-check pids on this interval. */
export const SWEEP_MS = 5000
const DEBOUNCE_MS = 100

/** Watches the presence dir and calls `onChange` with the full list whenever it changes. */
export class PresenceWatcher {
    private list: Presence[] = []
    private json = '[]'
    private watcher: ReturnType<typeof watch> | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private sweep: ReturnType<typeof setInterval> | null = null

    constructor(private dir: string, private onChange: (list: Presence[]) => void) {}

    get current(): Presence[] {
        return this.list
    }

    async start() {
        await mkdir(this.dir, { recursive: true }).catch(() => {})
        try {
            this.watcher = watch(this.dir, () => this.schedule())
            this.watcher.on('error', () => {})
        }
        catch {}
        this.sweep = setInterval(() => this.schedule(), SWEEP_MS)
        await this.refresh()
    }

    stop() {
        this.watcher?.close()
        if (this.sweep)
            clearInterval(this.sweep)
        if (this.timer)
            clearTimeout(this.timer)
    }

    private schedule() {
        if (this.timer)
            return
        this.timer = setTimeout(() => {
            this.timer = null
            void this.refresh()
        }, DEBOUNCE_MS)
    }

    async refresh() {
        const list = await readPresence(this.dir)
        const json = JSON.stringify(list)
        if (json === this.json)
            return
        this.list = list
        this.json = json
        // Bridge tokens stay in main.
        this.onChange(list.map(({ bridgeToken: _, ...p }) => p))
    }
}
