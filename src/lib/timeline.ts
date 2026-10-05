import type {
    AgentMessage,
    AssistantMessage,
    BashExecutionMessage,
    ImageContent,
    TextContent,
    ToolCall,
    ToolResultMessage,
} from '@shared/pi'
import { readableError } from './utils'

/** One message in display order. Snapshot items carry their session entry id. */
export interface TimelineMessage {
    key: string
    message: AgentMessage
}

export interface ToolResultView {
    content: ToolResultMessage['content']
    details?: any
    isError: boolean
}

/** Live tool execution state from tool_execution_* events. */
export interface ToolExecState {
    running: boolean
    partial?: ToolResultView
    result?: ToolResultView
}

export type Step =
    | { kind: 'thinking', key: string, text: string, streaming: boolean, redacted: boolean }
    | { kind: 'text', key: string, text: string, streaming: boolean }
    | { kind: 'tool', key: string, call: ToolCall, result?: ToolResultView, running: boolean }
    | { kind: 'bash', key: string, message: BashExecutionMessage }
    /** title is set for custom notes only; compaction / branch titles come from the transcript wording. */
    | { kind: 'note', key: string, variant: 'compaction' | 'branch' | 'custom', title: string, text: string }
    /** text is empty when pi gave no message; the view then says "Aborted" / "Request failed". */
    | { kind: 'error', key: string, text: string, aborted: boolean }

export interface UserPrompt {
    text: string
    images: ImageContent[]
    timestamp: number
    pending: boolean
}

export interface Turn {
    key: string
    user?: UserPrompt
    steps: Step[]
    startedAt: number
    endedAt: number
    running: boolean
}

export function contentText(content: string | (TextContent | ImageContent)[] | undefined): string {
    if (typeof content === 'string')
        return content
    return (content ?? []).filter((c): c is TextContent => c.type === 'text').map(c => c.text).join('\n')
}

export function contentImages(content: string | (TextContent | ImageContent)[] | undefined): ImageContent[] {
    return typeof content === 'string' ? [] : (content ?? []).filter((c): c is ImageContent => c.type === 'image')
}

export interface BuildOptions {
    /** Assistant message currently streaming (stopReason "pending"). */
    streaming?: AssistantMessage | null
    tools?: ReadonlyMap<string, ToolExecState>
    /** Prompt sent but not yet echoed back by pi. */
    pendingPrompt?: { text: string, images: ImageContent[], timestamp: number } | null
    running?: boolean
}

export function buildTurns(messages: TimelineMessage[], options: BuildOptions = {}): Turn[] {
    const results = new Map<string, ToolResultView>()
    for (const { message } of messages) {
        if (message.role === 'toolResult')
            results.set(message.toolCallId, { content: message.content, details: message.details, isError: message.isError })
    }

    const all = options.streaming
        ? [...messages, { key: 'streaming', message: options.streaming }]
        : messages

    const turns: Turn[] = []
    let current: Turn | undefined
    const open = (key: string, user?: UserPrompt, timestamp = 0) => {
        current = { key, user, steps: [], startedAt: timestamp, endedAt: timestamp, running: false }
        turns.push(current)
        return current
    }
    const ensure = (key: string, timestamp: number) => current ?? open(key, undefined, timestamp)
    const touch = (turn: Turn, timestamp: number) => {
        if (timestamp > turn.endedAt)
            turn.endedAt = timestamp
    }

    for (const { key, message } of all) {
        switch (message.role) {
            case 'user': {
                open(key, {
                    text: contentText(message.content),
                    images: contentImages(message.content),
                    timestamp: message.timestamp,
                    pending: false,
                }, message.timestamp)
                break
            }
            case 'assistant': {
                const turn = ensure(key, message.timestamp)
                const streaming = message.stopReason === 'pending'
                message.content.forEach((block, i) => {
                    const blockKey = `${key}:${i}`
                    const last = streaming && i === message.content.length - 1
                    if (block.type === 'text') {
                        if (block.text || last)
                            turn.steps.push({ kind: 'text', key: blockKey, text: block.text, streaming: last })
                    }
                    else if (block.type === 'thinking') {
                        if (block.thinking || block.redacted || last)
                            turn.steps.push({ kind: 'thinking', key: blockKey, text: block.thinking, streaming: last, redacted: !!block.redacted })
                    }
                    else if (block.type === 'toolCall') {
                        const live = options.tools?.get(block.id)
                        const result = results.get(block.id) ?? live?.result ?? live?.partial
                        const running = !results.has(block.id) && !live?.result && (streaming || !!live?.running || !!options.running)
                        turn.steps.push({ kind: 'tool', key: blockKey, call: block, result, running })
                    }
                })
                if (message.stopReason === 'error' || message.stopReason === 'aborted') {
                    turn.steps.push({
                        kind: 'error',
                        key: `${key}:error`,
                        text: message.errorMessage ? readableError(message.errorMessage) : '',
                        aborted: message.stopReason === 'aborted',
                    })
                }
                touch(turn, message.timestamp)
                break
            }
            case 'toolResult': {
                if (current)
                    touch(current, message.timestamp)
                break
            }
            case 'bashExecution': {
                open(key, undefined, message.timestamp).steps.push({ kind: 'bash', key, message })
                current = undefined
                break
            }
            case 'compactionSummary': {
                open(key, undefined, message.timestamp).steps.push({ kind: 'note', key, variant: 'compaction', title: '', text: message.summary })
                current = undefined
                break
            }
            case 'branchSummary': {
                open(key, undefined, message.timestamp).steps.push({ kind: 'note', key, variant: 'branch', title: '', text: message.summary })
                current = undefined
                break
            }
            case 'custom': {
                if (message.display)
                    ensure(key, message.timestamp).steps.push({ kind: 'note', key, variant: 'custom', title: message.customType, text: contentText(message.content) })
                break
            }
            default:
                break
        }
    }

    if (options.pendingPrompt) {
        const { text, images, timestamp } = options.pendingPrompt
        open('pending', { text, images, timestamp, pending: true }, timestamp)
    }

    const last = turns[turns.length - 1]
    if (last && options.running)
        last.running = true
    return turns
}

/** Tools whose results carry their own diff stay on their own row, as in pi-cc-extensions. */
const NON_GROUPABLE = new Set(['edit', 'write', 'apply_patch'])

export type StepItem =
    | { kind: 'step', step: Step }
    | { kind: 'group', key: string, steps: Extract<Step, { kind: 'tool' }>[] }

/** Runs of two or more back-to-back groupable tool calls collapse into one "Bash: 3 done" card. */
export function groupSteps(steps: Step[]): StepItem[] {
    const items: StepItem[] = []
    let run: Extract<Step, { kind: 'tool' }>[] = []
    const flush = () => {
        if (run.length >= 2)
            items.push({ kind: 'group', key: `group:${run[0].key}`, steps: run })
        else
            run.forEach(step => items.push({ kind: 'step', step }))
        run = []
    }
    for (const step of steps) {
        if (step.kind === 'tool' && !NON_GROUPABLE.has(step.call.name)) {
            run.push(step)
            continue
        }
        flush()
        items.push({ kind: 'step', step })
    }
    flush()
    return items
}
