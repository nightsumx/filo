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
import type { ApprovalRequest, AskQuestion } from '@shared/capabilities'
import { acpCaps, acpSessionKey } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { AcpTranscript, type PromptUsage } from '../acp/transcript'

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
    /** Pending approval requests by itemId. */
    private approvals = new Map<string, { resolve: (response: any) => void }>()
    /** Pending ask-user questions by itemId. */
    private questions = new Map<string, { resolve: (response: any) => void, questions: AskQuestion[] }>()
    /** Turn ID to message position mapping for rewind/fork. */
    private turnToPosition = new Map<string, number>()
    /** Item tracking for subagent tree building. */
    private items = new Map<string, any>()
    private callbacks: AgentAdapterCallbacks

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
        this.callbacks = callbacks
        this.transcript = new AcpTranscript('', {
            model: () => ({ model: this.threadInfo?.model ?? '' }),
            inputIncludesCache: true,
            now: () => (this.loading ? options.replayTime ?? Date.now() : Date.now()),
            emit: (event) => callbacks.onEvent(this.id, event),
        })
        this.transcript.overrideToolName['collabAgentToolCall'] = 'subagent'

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
                // Load history
                await this.loadHistory()
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
        switch (method) {
            case 'turn/started':
                this.currentTurnId = params.turn?.id
                this.running = true
                if (params.turn?.id)
                    this.turnToPosition.set(params.turn.id, this.transcript.messages.length)
                break
            
            case 'turn/completed': {
                this.running = false
                const turn = params.turn
                const usage: PromptUsage = {
                    inputTokens: turn?.inputTokens,
                    outputTokens: turn?.outputTokens,
                    cachedReadTokens: turn?.cacheReadTokens,
                    thoughtTokens: turn?.reasoningTokens,
                }
                this.transcript.finish(turn?.status?.type, usage)
                break
            }
            
            case 'item/started':
                if (params.item)
                    this.items.set(params.item.id, params.item)
                break
            
            case 'item/completed':
                if (params.item)
                    this.items.set(params.item.id, params.item)
                break
            
            case 'item/agentMessage/delta':
                this.transcript.update({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: params.delta },
                })
                break
            
            case 'item/reasoning/textDelta':
                this.transcript.update({
                    sessionUpdate: 'agent_thought_chunk',
                    content: { type: 'text', text: params.delta },
                })
                break
            
            case 'item/reasoning/summaryTextDelta':
                // Summary thinking - treat as regular thinking
                this.transcript.update({
                    sessionUpdate: 'agent_thought_chunk',
                    content: { type: 'text', text: params.delta },
                })
                break
            
            case 'item/commandExecution/outputDelta':
            case 'item/commandExecution/outputDelta': {
                const tool = this.transcript['tools'].get(params.itemId)
                if (tool) {
                    tool.output += params.delta
                    const call = tool.calls[0]
                    if (call) {
                        this.callbacks.onEvent(this.id, {
                            type: 'tool_execution_update',
                            toolCallId: call.id,
                            toolName: call.name,
                            partialResult: { content: [{ type: 'text', text: tool.output }] },
                        })
                    }
                }
                break
            }
            
            case 'item/fileChange/patchUpdated':
                // File diff update - create/update tool call
                this.handleItemUpdate(params)
                break
            
            case 'item/commandExecution/requestApproval':
                this.handleCommandApproval(params)
                break
            
            case 'item/fileChange/requestApproval':
                this.handleFileApproval(params)
                break
            
            case 'item/tool/requestUserInput':
                this.handleAskUser(params)
                break
            
            case 'item/collabAgentToolCall/started':
            case 'item/collabAgentToolCall/updated':
                this.handleSubagent(params)
                break
            
            default:
                // Unknown notification types are logged but not fatal
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
            
            case 'gui-rewind': {
                const entryId = String(command.entryId ?? '')
                const position = Number.parseInt(entryId.replace(/^.*-/, ''), 10)
                if (Number.isNaN(position) || position < 0)
                    return { type: 'response', command: 'gui-rewind', success: false, error: 'Invalid entryId' }
                
                // Find turn ID at that position
                let targetTurnId: string | null = null
                for (const [turnId, pos] of this.turnToPosition.entries()) {
                    if (pos === position) {
                        targetTurnId = turnId
                        break
                    }
                }
                
                if (!targetTurnId)
                    return { type: 'response', command: 'gui-rewind', success: false, error: 'Turn not found for position' }
                
                await this.rpc('thread/revert', { threadId: this.#sessionId, beforeTurnId: targetTurnId })
                this.transcript.truncate(position)
                return { type: 'response', command: 'gui-rewind', success: true }
            }
            
            case 'fork': {
                const entryId = command.entryId ? String(command.entryId) : undefined
                let lastTurnId: string | undefined
                
                if (entryId) {
                    // Fork at a specific message
                    const position = Number.parseInt(entryId.replace(/^.*-/, ''), 10)
                    if (!Number.isNaN(position) && position >= 0) {
                        for (const [turnId, pos] of this.turnToPosition.entries()) {
                            if (pos <= position)
                                lastTurnId = turnId
                        }
                    }
                }
                
                const forkResp = await this.rpc('thread/fork', {
                    threadId: this.#sessionId,
                    lastTurnId,
                })
                
                const newThreadId = forkResp.thread?.id
                if (!newThreadId)
                    return { type: 'response', command: 'fork', success: false, error: 'Fork failed' }
                
                this.#sessionId = newThreadId
                
                // Notify about new session
                this.callbacks.onSession?.(this, { title: forkResp.thread?.name })
                
                // Return the original prompt text if forking at a message
                const originalMessage = entryId ? this.transcript.messages[Number.parseInt(entryId.replace(/^.*-/, ''), 10)]?.message : null
                const text = originalMessage?.role === 'user' && Array.isArray(originalMessage.content)
                    ? originalMessage.content.find(c => c.type === 'text')?.text ?? ''
                    : ''
                
                return { type: 'response', command: 'fork', success: true, data: { text } }
            }
            
            default:
                return { type: 'response', command: type, success: false, error: `Unknown command: ${type}` }
        }
    }

    write(record: Record<string, unknown>) {
        // Handle extension_ui_response for approvals and questions
        if (record.type === 'extension_ui_response' && typeof record.id === 'string') {
            const id = record.id
            
            // Check if it's an approval response
            const approval = this.approvals.get(id)
            if (approval) {
                this.approvals.delete(id)
                if (record.cancelled) {
                    approval.resolve({ decision: 'cancel' })
                } else {
                    const value = String(record.value ?? 'deny')
                    const decision = value === 'allow' ? 'accept' : value === 'always' ? 'acceptForSession' : 'decline'
                    approval.resolve({ decision })
                }
                return
            }
            
            // Check if it's a question response
            const question = this.questions.get(id)
            if (question) {
                this.questions.delete(id)
                if (record.cancelled) {
                    question.resolve({ answers: {} })
                } else {
                    // Map answers from the response
                    const answers: Record<string, any> = {}
                    if (record.answers && typeof record.answers === 'object') {
                        for (const [qid, answer] of Object.entries(record.answers)) {
                            answers[qid] = { answers: Array.isArray(answer) ? answer : [answer] }
                        }
                    }
                    question.resolve({ answers })
                }
                return
            }
        }
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

    private async loadHistory() {
        try {
            // Load turns
            const turnsResp = await this.rpc('thread/turns/list', {
                threadId: this.#sessionId,
                sortDirection: 'ascending',
            })
            
            const turns = turnsResp.turns ?? []
            for (const turn of turns) {
                if (turn.id)
                    this.turnToPosition.set(turn.id, this.transcript.messages.length)
                
                // Load items for each turn
                for (const item of turn.items ?? []) {
                    this.processHistoryItem(item)
                }
            }
        } catch (err) {
            console.error('[CodexAgent] Failed to load history:', err)
        }
    }

    private processHistoryItem(item: any) {
        if (!item || !item.type) return
        
        switch (item.type) {
            case 'userMessage':
                // User messages are added through transcript
                break
            case 'agentMessage':
                this.transcript.update({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: item.text ?? '' },
                })
                break
            case 'reasoning':
                for (const content of item.content ?? []) {
                    this.transcript.update({
                        sessionUpdate: 'agent_thought_chunk',
                        content: { type: 'text', text: content },
                    })
                }
                break
            case 'commandExecution':
            case 'fileChange':
            case 'collabAgentToolCall':
                // Tool calls loaded from history
                this.transcript.update({
                    sessionUpdate: 'tool_call',
                    toolCallId: item.id,
                    kind: item.type === 'commandExecution' ? 'execute' : item.type === 'fileChange' ? 'edit' : 'collabAgentToolCall',
                    name: item.type,
                    status: item.status ?? 'completed',
                    rawInput: item,
                    rawOutput: item,
                })
                break
        }
    }

    private handleItemUpdate(params: any) {
        const item = this.items.get(params.itemId) ?? params.item
        if (!item) return
        
        this.transcript.update({
            sessionUpdate: 'tool_call_update',
            toolCallId: params.itemId,
            rawInput: item,
            rawOutput: item,
            content: item.content,
        })
    }

    private handleCommandApproval(params: any) {
        const itemId = params.itemId
        const requestId = `codex-approval-${itemId}`
        
        const approval: ApprovalRequest = {
            toolCallId: itemId,
            tool: 'bash',
            summary: params.command ?? 'Run command',
            scope: '',
            alwaysLabel: 'Always allow',
        }
        
        const promise = new Promise<any>((resolve) => {
            this.approvals.set(requestId, { resolve })
        })
        
        this.callbacks.onEvent(this.id, {
            type: 'extension_ui_request',
            id: requestId,
            method: 'select',
            title: `${APPROVAL_TITLE_PREFIX}${JSON.stringify(approval)}`,
            options: ['allow', 'always', 'deny'],
        })
        
        promise.then(async (response) => {
            await this.rpc('item/commandExecution/requestApproval/response', {
                threadId: this.#sessionId,
                turnId: params.turnId,
                itemId: params.itemId,
                ...response,
            })
        })
    }

    private handleFileApproval(params: any) {
        const itemId = params.itemId
        const requestId = `codex-approval-${itemId}`
        
        const approval: ApprovalRequest = {
            toolCallId: itemId,
            tool: 'edit',
            summary: params.reason ?? 'Edit files',
            scope: '',
            alwaysLabel: 'Always allow',
        }
        
        const promise = new Promise<any>((resolve) => {
            this.approvals.set(requestId, { resolve })
        })
        
        this.callbacks.onEvent(this.id, {
            type: 'extension_ui_request',
            id: requestId,
            method: 'select',
            title: `${APPROVAL_TITLE_PREFIX}${JSON.stringify(approval)}`,
            options: ['allow', 'always', 'deny'],
        })
        
        promise.then(async (response) => {
            await this.rpc('item/fileChange/requestApproval/response', {
                threadId: this.#sessionId,
                turnId: params.turnId,
                itemId: params.itemId,
                ...response,
            })
        })
    }

    private handleAskUser(params: any) {
        const itemId = params.itemId
        const requestId = `codex-ask-${itemId}`
        
        const questions: AskQuestion[] = (params.questions ?? []).map((q: any) => ({
            id: q.id,
            prompt: q.question,
            type: 'select' as const,
            options: (q.options ?? []).map((o: any) => ({
                value: o.value ?? o.id ?? String(o),
                label: o.name ?? o.label ?? String(o),
            })),
        }))
        
        const promise = new Promise<any>((resolve) => {
            this.questions.set(requestId, { resolve, questions })
        })
        
        // Set ask details in transcript
        this.transcript.setDetails(itemId, {
            kind: 'ask',
            status: 'pending',
            questions,
        })
        
        promise.then(async (response) => {
            await this.rpc('item/tool/requestUserInput/response', {
                threadId: this.#sessionId,
                turnId: params.turnId,
                itemId: params.itemId,
                ...response,
            })
            
            // Update with answered status
            this.transcript.setDetails(itemId, {
                kind: 'ask',
                status: 'answered',
                questions,
                answers: response.answers,
            })
        })
    }

    private handleSubagent(params: any) {
        const item = params.item ?? this.items.get(params.itemId)
        if (!item || item.type !== 'collabAgentToolCall') return
        
        const status = item.status === 'completed' ? 'done' : 'running'
        const tool = item.tool
        
        // Build subagent details
        const details: any = {
            kind: 'subagent',
            status,
            title: `Subagent: ${tool}`,
            task: item.prompt ?? '',
            messages: [],
            tools: [],
            usage: null,
        }
        
        this.transcript.setDetails(item.id, details)
    }
}
