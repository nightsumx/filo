import type { AcpAgentId } from '@shared/agents'
import type { AgentExitInfo, AgentStartOptions, PiEnv } from '@shared/ipc'
import type { PiEvent, RpcResponse } from '@shared/pi'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AcpService } from './acp/service'
import { BridgeAgent } from './bridge'
import { ENV } from '@shared/capabilities'
import { capabilityArgs, hostExtensionArgs } from './capabilities'
import { tr } from './i18n'
import { JsonlSplitter } from './jsonl'
import { piCommand, piSpawnEnv } from './pi-env'

const STDERR_LIMIT = 64 * 1024

interface Pending {
    resolve: (response: RpcResponse) => void
    reject: (error: Error) => void
}

export interface AgentCallbacks {
    onEvent: (agentId: string, event: PiEvent) => void
    onExit: (agentId: string, info: AgentExitInfo) => void
}

/**
 * What the renderer drives: pi's RPC commands in, pi's events out. PiAgent is pi itself; AcpAgent
 * (acp/agent.ts) speaks it on behalf of an ACP agent.
 */
export interface ManagedAgent {
    readonly id: string
    request: (command: Record<string, unknown>) => Promise<RpcResponse>
    /** A record that gets no response (extension_ui_response). */
    write: (record: Record<string, unknown>) => void
    stop: () => Promise<void>
}

/** One `pi --mode rpc` child process bound to one working directory and session. */
class PiAgent implements ManagedAgent {
    readonly id = randomUUID()
    private child: ChildProcessWithoutNullStreams
    private pending = new Map<string, Pending>()
    private nextRequest = 0
    private stderr = ''
    private exited = false

    constructor(env: PiEnv, options: AgentStartOptions, extensionsDir: string, callbacks: AgentCallbacks) {
        const args = ['--mode', 'rpc', ...hostExtensionArgs(extensionsDir), ...capabilityArgs(options.capabilities, extensionsDir, { approvalMode: options.approvalMode })]
        if (options.sessionPath)
            args.push('--session', options.sessionPath)
        const command = piCommand(env, args)
        this.child = spawn(command.file, command.args, {
            cwd: options.cwd,
            // The app loads its capabilities with -e; pi-cc-tui, if installed, leaves its copies off.
            env: { ...piSpawnEnv(env), [ENV.host]: 'gui' },
            stdio: ['pipe', 'pipe', 'pipe'],
        })

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
            callbacks.onEvent(this.id, record)
        })
        this.child.stdout.on('data', chunk => splitter.push(chunk))
        this.child.stdout.on('end', () => splitter.end())
        this.child.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
        })
        // A broken pipe on stdin surfaces as an error event; the exit handler reports it.
        this.child.stdin.on('error', () => {})

        const finish = (code: number | null, signal: string | null) => {
            if (this.exited)
                return
            this.exited = true
            const error = new Error(this.stderr.trim().split('\n').slice(-5).join('\n') || `pi exited (${code ?? signal})`)
            for (const p of this.pending.values())
                p.reject(error)
            this.pending.clear()
            callbacks.onExit(this.id, { code, signal, stderr: this.stderr })
        }
        this.child.on('exit', finish)
        this.child.on('error', (error) => {
            this.stderr += `\n${error.message}`
            finish(null, null)
        })
    }

    request(command: Record<string, unknown>): Promise<RpcResponse> {
        if (this.exited)
            return Promise.reject(new Error(tr('pi 进程已退出', 'pi process has exited')))
        const id = `gui-${++this.nextRequest}`
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            this.write({ ...command, id })
        })
    }

    write(record: Record<string, unknown>) {
        if (!this.exited)
            this.child.stdin.write(`${JSON.stringify(record)}\n`)
    }

    /** Closing stdin asks pi for an orderly shutdown; escalate if it does not exit. */
    stop(): Promise<void> {
        if (this.exited)
            return Promise.resolve()
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.child.kill('SIGTERM'), 3000)
            this.child.once('exit', () => {
                clearTimeout(timer)
                resolve()
            })
            this.child.stdin.end()
        })
    }
}

export class AgentManager {
    private agents = new Map<string, ManagedAgent>()

    /** extensionsDir holds the capability extensions (packages/capabilities/extensions, or Resources/capabilities when packaged). */
    constructor(private callbacks: AgentCallbacks, private extensionsDir: string) {}

    start(env: PiEnv, options: AgentStartOptions): string {
        const agent = new PiAgent(env, options, this.extensionsDir, {
            onEvent: this.callbacks.onEvent,
            onExit: (id, info) => {
                this.agents.delete(id)
                this.callbacks.onExit(id, info)
            },
        })
        this.agents.set(agent.id, agent)
        return agent.id
    }

    /** An ACP agent for a thread; resolves once its process is spawned (the session opens after). */
    async startAcp(service: AcpService, agent: AcpAgentId, options: AgentStartOptions): Promise<string> {
        const instance = await service.start(agent, options.cwd, options.sessionPath, {
            onEvent: this.callbacks.onEvent,
            onExit: (id, info) => {
                this.agents.delete(id)
                this.callbacks.onExit(id, info)
            },
        })
        this.agents.set(instance.id, instance)
        return instance.id
    }

    /** Joins a terminal pi over its bridge socket instead of starting one; rejects if it does not answer. */
    async attach(socketPath: string, pid: number): Promise<string> {
        const agent = await BridgeAgent.connect(socketPath, pid, {
            onEvent: this.callbacks.onEvent,
            onExit: (id, info) => {
                this.agents.delete(id)
                this.callbacks.onExit(id, info)
            },
        })
        this.agents.set(agent.id, agent)
        return agent.id
    }

    async request(agentId: string, command: Record<string, unknown>): Promise<RpcResponse> {
        const agent = this.agents.get(agentId)
        if (!agent)
            throw new Error(tr('pi 进程不存在或已退出', 'pi process is gone or has exited'))
        return agent.request(command)
    }

    send(agentId: string, record: Record<string, unknown>) {
        this.agents.get(agentId)?.write(record)
    }

    async stop(agentId: string) {
        await this.agents.get(agentId)?.stop()
    }

    async stopAll() {
        await Promise.all([...this.agents.values()].map(a => a.stop()))
    }
}
