// Claude Code native adapter: drives `claude` CLI (stream-json protocol over stdio) and speaks pi
// RPC to the renderer through AcpTranscript. Features: rewind to message, fork at message, ask-user
// questions, plan mode approval, subagent tree, steering, images.

import type { AcpAgentCaps, AcpAgentSpec } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { RpcResponse } from '@shared/pi'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from '../acp/adapter'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AskDetails, AskQuestion, PlanDetails, SubagentDetails, SubagentUsage, SubagentToolState } from '@shared/capabilities'
import type { AssistantMessage } from '@shared/pi'
import { acpCaps, acpSessionKey } from '@shared/agents'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { AcpTranscript } from '../acp/transcript'

const STDERR_LIMIT = 64 * 1024

export interface ClaudeLaunch {
    file: string
    args: string[]
    env: Record<string, string>
}

interface ControlResponse {
    type: 'control_response'
    subtype: 'success' | 'error'
    request_id: string
    response?: any
    error?: any
}

/** Output message types from CLI. */
interface OutputMessage {
    type: 'system' | 'assistant' | 'user' | 'stream_event' | 'result' | 'status' | 'tool_progress' | 'permission_denied' | 'thinking_tokens' | 'auth_status' | 'task_notification'
    subtype?: string
    session_id?: string
    parent_tool_use_id?: string | null
    user_message_uuid?: string
    [key: string]: any
}

interface PendingRequest {
    resolve: (result: any) => void
    reject: (error: Error) => void
}

interface PendingApproval {
    resolve: (response: any) => void
    reject: (error: Error) => void
    toolName: string
    input: any
}

/**
 * One `claude` child process bound to one session.
 */
export class ClaudeAgent implements AgentAdapter {
    readonly id = randomUUID()
    #cwd: string
    #sessionId: string
    private child: ChildProcessWithoutNullStreams
    private stderr = ''
    private exited = false
    readonly ready: Promise<void>
    private nextRequestId = 1
    private pendingRequests = new Map<string, PendingRequest>()
    private pendingApproval: PendingApproval | null = null
    private transcript!: AcpTranscript
    private currentModel = ''
    private running = false
    private loading = true
    private callbacks: AgentAdapterCallbacks
    /** Tool calls by their parent_tool_use_id (subagent tree). */
    private subagents = new Map<string, {
        title: string
        task: string
        messages: AssistantMessage[]
        tools: Record<string, SubagentToolState>
        steering: string[]
        usage: SubagentUsage
        startedAt: number
    }>()

    get key() {
        return acpSessionKey('claude' as any, this.#sessionId)
    }
    get cwd() {
        return this.#cwd
    }
    get sessionId() {
        return this.#sessionId
    }

    caps: AcpAgentCaps = acpCaps({
        fork: true,
        list: false,
        forkAt: true,
        rewind: true,
        ask: true,
        plan: true,
        subagents: true,
        steering: true,
        images: true,
    })

    constructor(
        readonly spec: AcpAgentSpec,
        launch: ClaudeLaunch,
        options: AgentAdapterOptions,
        callbacks: AgentAdapterCallbacks,
    ) {
        this.#cwd = options.cwd
        this.#sessionId = options.sessionId ?? randomUUID()
        this.callbacks = callbacks

        this.transcript = new AcpTranscript('', {
            model: () => ({ model: this.currentModel }),
            inputIncludesCache: true,
            now: () => (this.loading ? options.replayTime ?? Date.now() : Date.now()),
            emit: (event) => callbacks.onEvent(this.id, event),
        })

        // Map internal tool names to pi names
        this.transcript.overrideToolName = {
            'AskUserQuestion': 'ask',
            'ExitPlanMode': 'propose_plan',
            'Task': 'subagent',
        }

        // Build command line
        const args = [
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--permission-prompt-tool', 'stdio',
            '--include-partial-messages',
            ...launch.args,
        ]

        if (options.sessionId) {
            args.push('--resume', options.sessionId)
        }

        this.child = spawn(launch.file, args, { cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })

        this.child.stderr.on('data', (chunk: Buffer) => {
            this.stderr += chunk.toString()
            if (this.stderr.length > STDERR_LIMIT)
                this.stderr = this.stderr.slice(-STDERR_LIMIT)
        })

        let buffer = ''
        this.child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim())
                    continue
                try {
                    const msg = JSON.parse(line)
                    this.handleMessage(msg)
                }
                catch (err) {
                    console.error('[ClaudeAgent] JSON parse error:', err, 'line:', line.slice(0, 200))
                }
            }
        })

        this.child.on('exit', (code, signal) => {
            this.exited = true
            for (const { reject } of this.pendingRequests.values())
                reject(new Error('Agent exited'))
            this.pendingRequests.clear()
            if (this.pendingApproval) {
                this.pendingApproval.reject(new Error('Agent exited'))
                this.pendingApproval = null
            }
            callbacks.onExit(this.id, {
                code: code ?? null,
                signal: signal ?? null,
                stderr: this.stderr,
            })
        })

        // Handshake and session open
        this.ready = (async () => {
            const initResp = await this.controlRequest('initialize', {
                capabilities: ['stream_json_v1'],
            })

            // Extract model list and account info
            if (initResp.models && Array.isArray(initResp.models)) {
                this.currentModel = initResp.models[0] || 'claude-sonnet-4'
            }

            if (options.sessionId) {
                // Resume: load history if needed
                // TODO: implement getSessionMessages equivalent
                this.transcript.finish(undefined)
                this.loading = false
            }
            else {
                // New session: send initial user message if one was provided
                this.transcript.finish(undefined)
                this.loading = false
            }

            callbacks.onSession?.(this, {})
        })()
    }

    private send(msg: any) {
        this.child.stdin.write(JSON.stringify(msg) + '\n')
    }

    private controlRequest(subtype: string, params: Record<string, any> = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const request_id = `req-${this.nextRequestId++}`
            this.pendingRequests.set(request_id, { resolve, reject })
            this.send({
                type: 'control_request',
                subtype,
                request_id,
                ...params,
            })
        })
    }

    private handleMessage(msg: any) {
        if (msg.type === 'control_response') {
            this.handleControlResponse(msg as ControlResponse)
        }
        else if (msg.type === 'control_request' && msg.subtype === 'can_use_tool') {
            this.handleCanUseTool(msg)
        }
        else {
            this.handleOutputMessage(msg as OutputMessage)
        }
    }

    private handleControlResponse(msg: ControlResponse) {
        const pending = this.pendingRequests.get(msg.request_id)
        if (pending) {
            this.pendingRequests.delete(msg.request_id)
            if (msg.subtype === 'success') {
                pending.resolve(msg.response)
            }
            else {
                pending.reject(new Error(JSON.stringify(msg.error)))
            }
        }
    }

    private async handleCanUseTool(msg: any) {
        const toolName = msg.tool_name

        if (toolName === 'AskUserQuestion') {
            await this.handleAskUserQuestion(msg)
        }
        else if (toolName === 'ExitPlanMode') {
            await this.handleExitPlanMode(msg)
        }
        else {
            await this.handleToolApproval(msg)
        }
    }

    private async handleAskUserQuestion(msg: any) {
        const input = msg.input || {}
        const questions: AskQuestion[] = (input.questions || []).map((q: any) => ({
            id: q.name,
            question: q.prompt,
            type: q.type || 'text',
            options: q.options,
            required: q.required,
        }))

        const requestId = randomUUID()
        this.pendingApproval = {
            resolve: (response) => {
                this.send({
                    type: 'control_response',
                    subtype: 'success',
                    request_id: msg.request_id,
                    response: {
                        behavior: 'allow',
                        updatedInput: {
                            questions: input.questions,
                            answers: response.answers,
                        },
                    },
                })
            },
            reject: (error) => {
                this.send({
                    type: 'control_response',
                    subtype: 'success',
                    request_id: msg.request_id,
                    response: { behavior: 'deny' },
                })
            },
            toolName: 'AskUserQuestion',
            input,
        }

        // Show ask details in transcript
        const details: AskDetails = {
            kind: 'ask',
            status: 'pending',
            questions,
        }
        this.transcript.setDetails(msg.tool_use_id, details)

        // Emit UI request
        this.callbacks.onEvent(this.id, {
            type: 'extension_ui_request',
            id: requestId,
            method: 'ask',
            questions,
        })
    }

    private async handleExitPlanMode(msg: any) {
        const input = msg.input || {}
        const plan = input.plan || ''

        const requestId = randomUUID()
        this.pendingApproval = {
            resolve: (response) => {
                this.send({
                    type: 'control_response',
                    subtype: 'success',
                    request_id: msg.request_id,
                    response: {
                        behavior: response.approved ? 'allow' : 'deny',
                        message: response.feedback,
                        interrupt: !response.approved,
                    },
                })
            },
            reject: (error) => {
                this.send({
                    type: 'control_response',
                    subtype: 'success',
                    request_id: msg.request_id,
                    response: { behavior: 'deny', interrupt: true },
                })
            },
            toolName: 'ExitPlanMode',
            input,
        }

        // Show plan details in transcript
        const details: PlanDetails = {
            kind: 'plan',
            status: 'pending',
            plan,
        }
        this.transcript.setDetails(msg.tool_use_id, details)

        // Emit UI request
        this.callbacks.onEvent(this.id, {
            type: 'extension_ui_request',
            id: requestId,
            method: 'plan',
            plan,
        })
    }

    private async handleToolApproval(msg: any) {
        const toolName = msg.tool_name

        const requestId = randomUUID()
        this.pendingApproval = {
            resolve: (response) => {
                const controlResp: any = {
                    behavior: response.allow ? 'allow' : 'deny',
                }
                if (response.always && response.allow) {
                    controlResp.updatedPermissions = [{
                        type: 'addRules',
                        behavior: 'allow',
                        destination: 'session',
                        rules: [{ toolName }],
                    }]
                }
                this.send({
                    type: 'control_response',
                    subtype: 'success',
                    request_id: msg.request_id,
                    response: controlResp,
                })
            },
            reject: (error) => {
                this.send({
                    type: 'control_response',
                    subtype: 'success',
                    request_id: msg.request_id,
                    response: { behavior: 'deny' },
                })
            },
            toolName,
            input: msg.input || {},
        }

        // Emit UI request
        this.callbacks.onEvent(this.id, {
            type: 'extension_ui_request',
            id: requestId,
            method: 'select',
            title: `Allow ${toolName}?`,
            options: [
                { label: 'Allow', value: 'allow' },
                { label: 'Deny', value: 'deny' },
                { label: 'Always allow', value: 'always' },
            ],
        })
    }

    private handleOutputMessage(msg: OutputMessage) {
        // Track session ID
        if (msg.session_id) {
            this.#sessionId = msg.session_id
        }

        switch (msg.type) {
            case 'system':
                this.handleSystemMessage(msg)
                break
            case 'assistant':
                this.handleAssistantMessage(msg)
                break
            case 'user':
                // Echo of user message
                break
            case 'stream_event':
                this.handleStreamEvent(msg)
                break
            case 'result':
                this.handleResult(msg)
                break
            case 'status':
            case 'tool_progress':
                this.handleToolProgress(msg)
                break
            case 'task_notification':
                // Background task status (subagents)
                break
        }
    }

    private handleSystemMessage(msg: OutputMessage) {
        if (msg.subtype === 'init') {
            if (msg.model) {
                this.currentModel = msg.model
            }
        }
        else if (msg.subtype === 'session_state_changed') {
            this.running = msg.state === 'working' || msg.state === 'requires_action'
        }
    }

    private handleAssistantMessage(msg: OutputMessage) {
        const parentToolUseId = msg.parent_tool_use_id

        if (parentToolUseId) {
            // Subagent message
            this.trackSubagentMessage(parentToolUseId, msg)
        }
        else {
            // Main thread message
            const content = msg.message?.content || []
            for (const block of content) {
                if (block.type === 'text') {
                    this.transcript.update({
                        sessionUpdate: 'agent_message_chunk',
                        content: block.text,
                    })
                }
                else if (block.type === 'thinking') {
                    this.transcript.update({
                        sessionUpdate: 'agent_thought_chunk',
                        content: block.thinking,
                    })
                }
                else if (block.type === 'tool_use') {
                    this.transcript.update({
                        sessionUpdate: 'tool_call',
                        toolCallId: block.id,
                        title: block.name,
                        name: block.name,
                        rawInput: block.input,
                    })
                }
            }
        }
    }

    private handleStreamEvent(msg: OutputMessage) {
        const delta = msg.delta
        if (!delta) return

        const parentToolUseId = msg.parent_tool_use_id

        if (parentToolUseId) {
            // Subagent stream event
            return
        }

        if (delta.type === 'text_delta') {
            this.transcript.update({
                sessionUpdate: 'agent_message_chunk',
                content: delta.text,
            })
        }
        else if (delta.type === 'thinking_delta') {
            this.transcript.update({
                sessionUpdate: 'agent_thought_chunk',
                content: delta.thinking,
            })
        }
        else if (delta.type === 'tool_use') {
            // Tool call start (from partial messages)
            this.transcript.update({
                sessionUpdate: 'tool_call',
                toolCallId: delta.id,
                title: delta.name,
                name: delta.name,
                rawInput: delta.input || {},
            })
        }
    }

    private handleResult(msg: OutputMessage) {
        const usage = msg.usage
        const cost = msg.cost

        const promptUsage: any = {}
        if (usage) {
            promptUsage.inputTokens = usage.input_tokens
            promptUsage.outputTokens = usage.output_tokens
            promptUsage.cachedReadTokens = usage.cache_read_input_tokens
            promptUsage.cachedWriteTokens = usage.cache_creation_input_tokens
        }
        if (cost?.usd) {
            promptUsage.cost = cost.usd
        }

        this.transcript.finish(promptUsage)
        this.running = false
    }

    private handleToolProgress(msg: OutputMessage) {
        const toolUseId = msg.tool_use_id
        if (!toolUseId) return

        const output = msg.output || ''

        if (output) {
            this.transcript.update({
                sessionUpdate: 'tool_call_update',
                toolCallId: toolUseId,
                _meta: { terminal_output_delta: output },
            })
        }

        if (msg.type === 'tool_progress' && msg.done) {
            this.transcript.update({
                sessionUpdate: 'tool_call_update',
                toolCallId: toolUseId,
                status: 'complete',
                rawOutput: msg.result || '',
            })
        }
    }

    private trackSubagentMessage(parentToolUseId: string, msg: OutputMessage) {
        let sub = this.subagents.get(parentToolUseId)
        if (!sub) {
            sub = {
                title: 'Subagent',
                task: '',
                messages: [],
                tools: {},
                steering: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
                startedAt: Date.now(),
            }
            this.subagents.set(parentToolUseId, sub)
        }

        // Build assistant message from content
        const message = msg.message
        if (message?.role === 'assistant') {
            const blocks: any[] = []
            for (const block of message.content || []) {
                if (block.type === 'text') {
                    blocks.push({ type: 'text', text: block.text })
                }
                else if (block.type === 'thinking') {
                    blocks.push({ type: 'thinking', thinking: block.thinking })
                }
                else if (block.type === 'tool_use') {
                    blocks.push({
                        type: 'toolCall',
                        id: block.id,
                        name: block.name,
                        arguments: block.input,
                    })
                }
            }

            const assistantMsg: AssistantMessage = {
                role: 'assistant',
                content: blocks,
                timestamp: Date.now(),
            }

            sub.messages.push(assistantMsg)

            // Update subagent details
            const details: SubagentDetails = {
                kind: 'subagent',
                status: 'running',
                title: sub.title,
                task: sub.task,
                messages: sub.messages,
                tools: sub.tools,
                steering: sub.steering,
                usage: sub.usage,
                startedAt: sub.startedAt,
            }

            this.transcript.setDetails(parentToolUseId, details)
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
                        model: this.currentModel,
                        isStreaming: this.running,
                        sessionFile: this.key,
                        sessionId: this.#sessionId,
                    },
                }

            case 'get_available_models':
                return {
                    type: 'response',
                    command: 'get_available_models',
                    success: true,
                    data: { models: [] }, // TODO: extract from initialize response
                }

            case 'get_commands':
                return {
                    type: 'response',
                    command: 'get_commands',
                    success: true,
                    data: { commands: [] },
                }

            case 'prompt': {
                const message = String(command.message ?? '')
                const images = (command.images as any[]) || []

                // Send user message
                const content: any[] = []
                if (message) {
                    content.push({ type: 'text', text: message })
                }
                for (const img of images) {
                    content.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: img.mimeType || 'image/png',
                            data: img.data,
                        },
                    })
                }

                this.send({
                    type: 'user',
                    message: { role: 'user', content },
                    parent_tool_use_id: null,
                    uuid: randomUUID(),
                })

                this.transcript.userPrompt(message, images)

                return {
                    type: 'response',
                    command: 'prompt',
                    success: true,
                    data: { disposition: 'accepted' },
                }
            }

            case 'abort':
                try {
                    await this.controlRequest('interrupt', { cancel_queued: false })
                    return { type: 'response', command: 'abort', success: true }
                }
                catch (error) {
                    return { type: 'response', command: 'abort', success: false, error: String(error) }
                }

            case 'set_model':
                try {
                    const model = command.model ? String(command.model) : null
                    await this.controlRequest('set_model', { model })
                    if (model) this.currentModel = model
                    return { type: 'response', command: 'set_model', success: true }
                }
                catch (error) {
                    return { type: 'response', command: 'set_model', success: false, error: String(error) }
                }

            case '/gui-rewind': {
                const entryId = String(command.entryId ?? '')
                const match = /^(\d+)$/.exec(entryId)
                if (!match) {
                    return { type: 'response', command: '/gui-rewind', success: false, error: 'Invalid entry ID' }
                }

                const position = parseInt(match[1], 10)
                const snapshot = this.transcript.snapshot()
                if (position < 0 || position >= snapshot.length) {
                    return { type: 'response', command: '/gui-rewind', success: false, error: 'Entry not found' }
                }

                const entry = snapshot[position]
                const userMessageId = entry.message.role === 'user' ? (entry.message as any).uuid : undefined

                if (!userMessageId) {
                    return { type: 'response', command: '/gui-rewind', success: false, error: 'Not a user message' }
                }

                try {
                    await this.controlRequest('rewind_files', { user_message_id: userMessageId })
                    this.transcript.truncate(position + 1)
                    return { type: 'response', command: '/gui-rewind', success: true }
                }
                catch (error) {
                    return { type: 'response', command: '/gui-rewind', success: false, error: String(error) }
                }
            }

            default:
                return {
                    type: 'response',
                    command: type,
                    success: false,
                    error: `Unknown command: ${type}`,
                }
        }
    }

    write(record: Record<string, unknown>) {
        const type = String(record.type ?? '')

        if (type === 'extension_ui_response' && this.pendingApproval) {
            const approval = this.pendingApproval
            this.pendingApproval = null

            if (approval.toolName === 'AskUserQuestion') {
                const answers = (record.answers as Record<string, any>) || {}
                approval.resolve({ answers })
            }
            else if (approval.toolName === 'ExitPlanMode') {
                const approved = record.approved === true
                const feedback = String(record.feedback || '')
                approval.resolve({ approved, feedback })
            }
            else {
                // Tool approval
                const response = String(record.response || '')
                const allow = response === 'allow' || response === 'always'
                const always = response === 'always'
                approval.resolve({ allow, always })
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
}
