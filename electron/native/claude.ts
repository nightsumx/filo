// Claude Code native adapter stub (not implemented yet).

import type { AcpAgentCaps, AcpAgentSpec } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { RpcResponse } from '@shared/pi'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from '../acp/adapter'
import { randomUUID } from 'node:crypto'
import { acpSessionKey } from '@shared/agents'

export class ClaudeAgent implements AgentAdapter {
    readonly id = randomUUID()
    #cwd: string
    #sessionId: string
    readonly ready = Promise.reject(new Error('Claude adapter not implemented yet'))
    caps: AcpAgentCaps = { images: false, steering: false, fork: false, delete: false, list: false, xai: false }

    get key() { return acpSessionKey('claude' as any, this.#sessionId) }
    get cwd() { return this.#cwd }
    get sessionId() { return this.#sessionId }

    constructor(readonly spec: AcpAgentSpec, _launch: any, options: AgentAdapterOptions, _callbacks: AgentAdapterCallbacks) {
        this.#cwd = options.cwd
        this.#sessionId = options.sessionId ?? randomUUID()
    }

    async request(_command: Record<string, unknown>): Promise<RpcResponse> {
        throw new Error('Claude adapter not implemented yet')
    }

    write(_record: Record<string, unknown>) {
        throw new Error('Claude adapter not implemented yet')
    }

    async stop() {}

    snapshot(): SessionItem[] {
        return []
    }
}
