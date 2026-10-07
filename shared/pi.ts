// Minimal structural mirrors of pi's wire types (docs/message-types.md, docs/json.md, docs/rpc-commands.md).
// Kept loose on purpose: extensions can add roles and fields, and the GUI must tolerate unknown shapes.

import type { AcpAgentCaps, AcpConfigOption } from './agents'

export interface TextContent { type: 'text', text: string }
export interface ImageContent { type: 'image', data: string, mimeType: string }
export interface ThinkingContent { type: 'thinking', thinking: string, redacted?: boolean }
export interface ToolCall { type: 'toolCall', id: string, name: string, arguments: Record<string, any> }

export interface Usage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** Reasoning tokens (already part of output), when the provider reports them. */
    reasoning?: number
    totalTokens: number
    cost: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number }
}

export interface UserMessage { role: 'user', content: string | (TextContent | ImageContent)[], timestamp: number }
export interface AssistantMessage {
    role: 'assistant'
    content: (TextContent | ThinkingContent | ToolCall)[]
    provider?: string
    model?: string
    /** pi thinking level the request ran with. */
    thinkingLevel?: string
    usage?: Usage
    stopReason?: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'
    errorMessage?: string
    timestamp: number
}
export interface ToolResultMessage {
    role: 'toolResult'
    toolCallId: string
    toolName: string
    content: (TextContent | ImageContent)[]
    details?: any
    isError: boolean
    timestamp: number
}
export interface BashExecutionMessage {
    role: 'bashExecution'
    command: string
    output: string
    exitCode: number | undefined
    cancelled: boolean
    truncated: boolean
    timestamp: number
}
/** Extension message; `details` is the extension's own data (review reports and feedback carry theirs). */
export interface CustomMessage { role: 'custom', customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: unknown, timestamp: number }
export interface BranchSummaryMessage { role: 'branchSummary', summary: string, timestamp: number }
export interface CompactionSummaryMessage { role: 'compactionSummary', summary: string, tokensBefore: number, timestamp: number }

export type AgentMessage =
    | UserMessage
    | AssistantMessage
    | ToolResultMessage
    | BashExecutionMessage
    | CustomMessage
    | BranchSummaryMessage
    | CompactionSummaryMessage

export interface PiModel {
    id: string
    name: string
    provider: string
    reasoning?: boolean
    input?: string[]
    contextWindow?: number
    maxTokens?: number
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface RpcSessionState {
    model?: PiModel
    thinkingLevel?: ThinkingLevel
    isStreaming: boolean
    isCompacting: boolean
    sessionFile?: string
    sessionId?: string
    sessionName?: string
    messageCount?: number
    pendingMessageCount?: number
    /** Not pi's: the ACP bridge reports the agent's session settings here. */
    configOptions?: AcpConfigOption[]
    /** Not pi's: what the ACP agent can do. */
    agentCaps?: AcpAgentCaps
}

export interface SessionStats {
    cost?: number
    tokens?: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number }
    contextUsage?: { tokens: number | null, contextWindow: number, percent: number | null }
}

export interface SlashCommand { name: string, description?: string, source: 'extension' | 'prompt' | 'skill' }

/** Any record pi writes to stdout that is not a command response. */
export interface PiEvent { type: string, [key: string]: any }

export interface RpcResponse<T = any> {
    id?: string
    type: 'response'
    command: string
    success: boolean
    data?: T
    error?: string
}
