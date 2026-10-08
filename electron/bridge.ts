// A terminal pi joined over pi-cc-tui's bridge (packages/pi-cc-tui/extensions/cc-bridge.ts): the
// socket speaks pi's RPC protocol, so it stands where a spawned `pi --mode rpc` would. Stopping it
// only disconnects; the terminal's pi carries on. When the terminal pi quits (or switches session),
// the socket closes and the thread falls back to a pi of its own.
import type { AgentExitInfo } from '@shared/ipc'
import type { RpcResponse } from '@shared/pi'
import type { Socket } from 'node:net'
import type { AgentCallbacks, ManagedAgent } from './agents'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { BRIDGE_HELLO } from '@shared/capabilities'
import { tr } from './i18n'
import { JsonlSplitter } from './jsonl'

const CONNECT_TIMEOUT_MS = 3000

export class BridgeAgent implements ManagedAgent {
    readonly id = randomUUID()
    private pending = new Map<string, { resolve: (r: RpcResponse) => void, reject: (e: Error) => void }>()
    private nextRequest = 0
    private closed = false
    /**
     * The bridge sends the run so far as soon as a client connects, before the window has this
     * agent's id; it would drop those events. Its first request comes after it has it.
     */
    private held: unknown[] | null = []
    private forward: (event: unknown) => void = () => {}

    private constructor(private socket: Socket, readonly pid: number) {}

    /** Connects to the bridge socket (or pipe, with its token); rejects when nobody listens there. */
    static connect(socketPath: string, pid: number, callbacks: AgentCallbacks, token?: string): Promise<BridgeAgent> {
        return new Promise((resolve, reject) => {
            const socket = createConnection(socketPath)
            const timer = setTimeout(() => {
                socket.destroy()
                reject(new Error(`bridge ${socketPath}: no answer`))
            }, CONNECT_TIMEOUT_MS)
            socket.once('error', (error) => {
                clearTimeout(timer)
                reject(error)
            })
            socket.once('connect', () => {
                clearTimeout(timer)
                if (token)
                    socket.write(`${JSON.stringify({ type: BRIDGE_HELLO, token })}\n`)
                const agent = new BridgeAgent(socket, pid)
                agent.listen(callbacks)
                resolve(agent)
            })
        })
    }

    private listen(callbacks: AgentCallbacks) {
        const splitter = new JsonlSplitter((line) => {
            let record: any
            try {
                record = JSON.parse(line)
            }
            catch {
                return
            }
            if (record?.type === 'response' && typeof record.id === 'string' && this.pending.has(record.id)) {
                this.pending.get(record.id)!.resolve(record)
                this.pending.delete(record.id)
                return
            }
            if (this.held)
                this.held.push(record)
            else
                callbacks.onEvent(this.id, record)
        })
        this.forward = event => callbacks.onEvent(this.id, event as any)
        this.socket.on('data', chunk => splitter.push(chunk))
        this.socket.on('error', () => {})
        this.socket.on('close', () => {
            splitter.end()
            if (this.closed)
                return
            this.closed = true
            const error = new Error(tr('终端里的 pi 已断开', 'The terminal pi disconnected'))
            for (const p of this.pending.values())
                p.reject(error)
            this.pending.clear()
            const info: AgentExitInfo = { code: null, signal: null, stderr: '', detached: true }
            callbacks.onExit(this.id, info)
        })
    }

    request(command: Record<string, unknown>): Promise<RpcResponse> {
        if (this.closed)
            return Promise.reject(new Error(tr('终端里的 pi 已断开', 'The terminal pi disconnected')))
        if (this.held) {
            const held = this.held
            this.held = null
            for (const event of held)
                this.forward(event)
        }
        const id = `gui-${++this.nextRequest}`
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            this.write({ ...command, id })
        })
    }

    write(record: Record<string, unknown>) {
        if (!this.closed)
            this.socket.write(`${JSON.stringify(record)}\n`)
    }

    /** Leaves the terminal pi running. */
    stop(): Promise<void> {
        if (this.closed)
            return Promise.resolve()
        return new Promise((resolve) => {
            this.socket.once('close', () => resolve())
            this.socket.end()
            setTimeout(() => this.socket.destroy(), 1000)
        })
    }
}
