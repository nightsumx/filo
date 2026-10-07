// JSON-RPC 2.0 over newline-delimited stdio, the ACP transport. Small on purpose: requests out,
// responses matched by id, notifications and agent → client requests handed to callbacks.

import type { Readable, Writable } from 'node:stream'
import { JsonlSplitter } from '../jsonl'

export class RpcError extends Error {
    constructor(message: string, readonly code?: number, readonly data?: unknown) {
        super(message)
    }
}

export interface ConnectionHandlers {
    onNotification: (method: string, params: any) => void
    /** An agent → client request; the returned value (or thrown RpcError) is the response. */
    onRequest: (method: string, params: any) => Promise<unknown>
}

interface Pending {
    resolve: (result: any) => void
    reject: (error: Error) => void
}

export class AcpConnection {
    private pending = new Map<number, Pending>()
    private nextId = 0
    private closed: Error | null = null

    constructor(private output: Writable, input: Readable, private handlers: ConnectionHandlers) {
        const splitter = new JsonlSplitter(line => this.receive(line))
        input.on('data', chunk => splitter.push(chunk))
        input.on('end', () => splitter.end())
        output.on('error', () => {})
    }

    request<T = any>(method: string, params: unknown): Promise<T> {
        if (this.closed)
            return Promise.reject(this.closed)
        const id = ++this.nextId
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            this.write({ jsonrpc: '2.0', id, method, params })
        })
    }

    notify(method: string, params: unknown) {
        this.write({ jsonrpc: '2.0', method, params })
    }

    /** Fails every request still waiting, e.g. when the process exits. */
    close(error: Error) {
        this.closed ??= error
        for (const p of this.pending.values())
            p.reject(error)
        this.pending.clear()
    }

    private write(message: unknown) {
        if (!this.closed)
            this.output.write(`${JSON.stringify(message)}\n`)
    }

    private receive(line: string) {
        let message: any
        try {
            message = JSON.parse(line)
        }
        catch {
            return
        }
        if (!message || typeof message !== 'object')
            return
        const hasId = message.id !== undefined && message.id !== null
        if (typeof message.method === 'string') {
            if (!hasId) {
                this.handlers.onNotification(message.method, message.params)
                return
            }
            this.handlers.onRequest(message.method, message.params).then(
                result => this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null }),
                (error: any) => this.write({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: error instanceof RpcError && error.code !== undefined ? error.code : -32603, message: String(error?.message ?? error) },
                }),
            )
            return
        }
        if (hasId) {
            const pending = this.pending.get(message.id)
            if (!pending)
                return
            this.pending.delete(message.id)
            if (message.error)
                pending.reject(new RpcError(String(message.error.message ?? 'ACP error'), message.error.code, message.error.data))
            else
                pending.resolve(message.result)
        }
    }
}

/** -32601: the client does not implement the method. */
export const methodNotFound = (method: string) => new RpcError(`Method not found: ${method}`, -32601)
