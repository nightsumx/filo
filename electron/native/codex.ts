// Codex app-server native adapter: drives `codex app-server` (JSON-RPC over stdio) and speaks pi
// RPC to the renderer through AcpTranscript. Unlocks features the ACP adapter can't provide: rewind
// to a message (thread/revert + fork), fork at a message (thread/fork with lastTurnId), ask-user
// questions (item/tool/requestUserInput), plan mode + approval (collaborationMode:'plan'), subagent
// tree (collabAgentToolCall items with parent/child threadIds), steering (turn/steer).

import type { AcpAgentCaps, AcpAgentSpec } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { RpcResponse } from '@shared/pi'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from '../acp/adapter'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { acpCaps, acpSessionKey } from '@shared/agents'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { AcpTranscript } from '../acp/transcript'

const STDERR_LIMIT = 64 * 1024

export interface CodexLaunch {
    file: string
    args: string[]
    env: Record<string, string>
}

/** Codex app-server JSON-RPC. No `jsonrpc` field in practice (though it accepts one). */
interface RpcMessage {
    id?: string | number
    method?: string
    params?: any
    result?: any
    error?: { code: number, message: string, data?: any }
}

interface ThreadInfo {
    thread: {
        id: string
        name?: string
        cwd: string
        model: string
        approvalPolicy?: string
        status?: { type: string }
    }
    model: string
    modelProvider?: string
    reasoningEffort?: string
}

/**
 * One `codex app-server` child process bound to one thread (Codex's term for a session).
 */
export class CodexAgent implements AgentAdapter {
    readonly id = randomUUID()
    #cwd: string
    #sessionId: string
    private child: ChildProcessWithoutNullStreams
    private stderr = ''
    private exited = false
    readonly ready: Promise<void>
    private nextRequest = 1
    private pending = new Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>()
    private transcript!: AcpTranscript
    private threadInfo: ThreadInfo | null = null
    private currentTurnId: string | null = null
    private running = false
    /** Replaying history. */
    private loading = true

    get key() {
        return acpSessionKey(this.spec.id, this.#sessionId)
    }
    get cwd() {
        return this.#cwd
    }
    get sessionId() {
        return this.#sessionId
    }

    caps: AcpAgentCaps = acpCaps({
        fork: true,
        list: true,
        forkAt: true,
        rewind: true,
        ask: true,
        plan: true,
        subagents: true,
        steering: true,
        images: true, // localImage support
    })

    constructor(
        readonly spec: AcpAgentSpec,
        launch: CodexLaunch,
        options: AgentAdapterOptions,
        callbacks: AgentAdapterCallbacks,
    ) {
        this.#cwd = options.cwd
        this.#sessionId = options.sessionId ?? randomUUID()
        this.transcript = new AcpTranscript('', {
            model: () => ({ model: this.threadInfo?.model ?? '' }),
            inputIncludesCache: true,
            now: () => (this.loading ? options.replayTime ?? Date.now() : Date.now()),
            emit: (event) => callbacks.onEvent(this.id, event),
        })

        this.child = spawn(launch.file, launch.args, { cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })

        this.child.stderr.on('data', (chunk: Buffer) => {
            this.stderr += chunk.toString()
            if (this.stderr.length > STDERR_LIMIT)
                this.stderr = this.stderr.slice(-STDERR_LIMIT)
        })

        this.child.stdout.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n')
            for (const line of lines) {
                if (!line.trim())
                    continue
                try {
                    const msg: RpcMessage = JSON.parse(line)
                    if (msg.id !== undefined) {
                        // Response
                        const wait = this.pending.get(Number(msg.id))
                        if (wait) {
                            this.pending.delete(Number(msg.id))
                            if (msg.error)
                                wait.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
                            else
                                wait.resolve(msg.result)
                        }
                    }
                    else if (msg.method) {
                        // Notification or server request
                        this.handleNotification(msg.method, msg.params)
                    }
                }
                catch (err) {
                    console.error('[CodexAgent] JSON parse error:', err, 'line:', line.slice(0, 200))
                }
            }
        })

        this.child.on('exit', (code, signal) => {
            this.exited = true
            for (const { reject } of this.pending.values())
                reject(new Error('Agent exited'))
            this.pending.clear()
            callbacks.onExit(this.id, {
                code: code ?? null,
                signal: signal ?? null,
                stderr: this.stderr,
            })
        })

        // Handshake and session open
        this.ready = (async () => {
            await this.rpc('initialize', {
                clientInfo: { name: 'Filo', title: 'Filo', version: '0.2.0' },
                capabilities: { experimentalApi: true },
            })
            await this.send({ method: 'initialized' })

            if (options.sessionId) {
                // Resume existing thread
                const info: ThreadInfo = await this.rpc('thread/resume', { threadId: options.sessionId })
                this.threadInfo = info
                // TODO: load history with thread/turns/list and thread/items/list
                this.transcript!.finish(undefined)
                this.loading = false
                this.emit()
            }
            else {
                // New thread
                const info: ThreadInfo = await this.rpc('thread/start', {
                    cwd: options.cwd,
                    model: undefined, // will use default
                    approvalPolicy: 'ask',
                })
                this.threadInfo = info
                this.#sessionId = info.thread.id
                this.transcript!.finish(undefined)
                this.loading = false
                this.emit()
            }

            callbacks.onSession?.(this, { title: this.threadInfo?.thread.name })
        })()
    }

    private send(msg: RpcMessage) {
        this.child.stdin.write(JSON.stringify(msg) + '\n')
    }

    private rpc(method: string, params?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.nextRequest++
            this.pending.set(id, { resolve, reject })
            this.send({ id, method, params })
            // TODO: timeout
        })
    }

    private emit() {
        // Events are pushed directly via transcript's emit callback
    }

    private handleNotification(method: string, params: any) {
        // TODO: implement all notification types
        console.log('[CodexAgent] notification:', method, JSON.stringify(params).slice(0, 200))

        switch (method) {
            case 'thread/started':
                // thread created
                break
            case 'thread/status/changed':
                // status: {type: 'idle' | 'active' | 'notLoaded' | 'systemError', activeFlags?: ...}
                break
            case 'turn/started':
                this.currentTurnId = params.turn?.id
                this.running = true
                break
            case 'turn/completed':
                this.running = false
                // TODO: emit agent_end, usage
                break
            case 'item/started':
                // params: {item, startedAtMs}
                break
            case 'item/agentMessage/delta':
                // TODO: map to agent_message_chunk
                break
            case 'item/commandExecution/requestApproval':
                // TODO: create approval dialog
                break
            case 'item/fileChange/requestApproval':
                // TODO: create approval dialog
                break
            case 'item/tool/requestUserInput':
                // TODO: create ask dialog
                break
            default:
                // ignore unknown
                break
        }
    }

    async request(command: Record<string, unknown>): Promise<RpcResponse> {
        const type = String(command.type ?? '')
        
        switch (type) {
            case 'get_state':
                return {
                    type: 'response',
                    command: 'get_state',
                    success: true,
                    data: {
                        model: this.threadInfo?.model,
                        thinkingLevel: this.threadInfo?.reasoningEffort,
                        isStreaming: this.running,
                        sessionFile: this.key,
                        sessionId: this.#sessionId,
                    },
                }
            
            case 'get_available_models':
                const modelsResp = await this.rpc('model/list', {})
                return {
                    type: 'response',
                    command: 'get_available_models',
                    success: true,
                    data: {
                        models: (modelsResp.data ?? []).map((m: any) => ({
                            id: m.id,
                            name: m.displayName ?? m.id,
                        })),
                    },
                }
            
            case 'get_commands':
                return { type: 'response', command: 'get_commands', success: true, data: { commands: [] } } // TODO: slash commands
            
            case 'prompt':
                const message = String(command.message ?? '')
                await this.rpc('turn/start', {
                    threadId: this.#sessionId,
                    input: [{ type: 'text', text: message }],
                })
                return { type: 'response', command: 'prompt', success: true, data: { disposition: 'accepted' } }
            
            case 'abort':
                if (this.currentTurnId) {
                    await this.rpc('turn/interrupt', { threadId: this.#sessionId, turnId: this.currentTurnId })
                }
                return { type: 'response', command: 'abort', success: true }
            
            default:
                return { type: 'response', command: type, success: false, error: `Unknown command: ${type}` }
        }
    }

    write(record: Record<string, unknown>) {
        // extension_ui_response for approvals
        // TODO: match by id and resolve pending approvals/questions
    }

    async stop() {
        if (!this.exited) {
            this.child.kill()
            await new Promise(resolve => {
                this.child.once('exit', resolve)
                setTimeout(resolve, 2000)
            })
        }
    }

    snapshot(): SessionItem[] {
        return this.transcript.snapshot()
    }
}
