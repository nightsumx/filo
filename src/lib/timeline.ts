import type {
    AgentMessage,
    AssistantMessage,
    BashExecutionMessage,
    ImageContent,
    TextContent,
    ToolCall,
    ToolResultMessage,
} from '@shared/pi'
import type { ReviewDetails, ReviewFeedbackDetails } from '@shared/capabilities'
import { CAPABILITY_TOOLS, REVIEW_TYPES } from '@shared/capabilities'
import { readableError } from './utils'

/** One message in display order. Snapshot items carry their session entry id. */
export interface TimelineMessage {
    key: string
    message: AgentMessage
    /** When the message was finished (session entry time, or message_end for live ones). */
    endedAt?: number
}

/** Exact start / end of one content block, recorded from the stream's *_start / *_end events. */
export interface BlockTime {
    start: number
    end?: number
}

/** Key of a block in BuildOptions.blockTimes: the assistant message's start timestamp + content index. */
export const blockTimeKey = (messageTimestamp: number, index: number) => `${messageTimestamp}:${index}`

export interface ToolResultView {
    content: ToolResultMessage['content']
    details?: any
    isError: boolean
    /** When the tool finished (the toolResult message timestamp). */
    endedAt?: number
}

/** Live tool execution state from tool_execution_* events. */
export interface ToolExecState {
    running: boolean
    startedAt?: number
    endedAt?: number
    partial?: ToolResultView
    result?: ToolResultView
}

/**
 * Timing on steps is best effort. `ms` is how long the step took (thinking: generating the block;
 * tool: executing it), `endedAt` when it finished. Recorded live from stream events when available,
 * otherwise estimated from message start / end times (see blockSpans).
 */
export type Step =
    | { kind: 'thinking', key: string, text: string, streaming: boolean, redacted: boolean, ms?: number, endedAt?: number }
    | { kind: 'text', key: string, text: string, streaming: boolean, endedAt?: number }
    | { kind: 'tool', key: string, call: ToolCall, result?: ToolResultView, running: boolean, startedAt?: number, ms?: number, endedAt?: number }
    | { kind: 'bash', key: string, message: BashExecutionMessage }
    /** title is set for custom notes only; compaction / branch titles come from the transcript wording. */
    | { kind: 'note', key: string, variant: 'compaction' | 'branch' | 'custom', title: string, text: string }
    /** text is empty when pi gave no message; the view then says "Aborted" / "Request failed". */
    | { kind: 'error', key: string, text: string, aborted: boolean }
    /** A review report; `applied` lists its item ids already sent back to the agent. */
    | { kind: 'review', key: string, report: ReviewDetails, applied: string[] }

export interface UserPrompt {
    text: string
    images: ImageContent[]
    timestamp: number
    pending: boolean
    /** Set when this prompt is review feedback: the items sent back; `text` is the user's note. */
    review?: { reviewId: string, round?: number, items: { id: string, title: string }[] }
}

/** Token usage and cost summed over a turn's model requests. */
export interface TurnUsage {
    requests: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** Reasoning tokens (part of output), when the provider reports them. */
    reasoning?: number
    cost: number
    /** "provider/model" of each distinct model that answered, in order. */
    models: string[]
    /** Thinking levels the requests ran with, in order. */
    thinkingLevels: string[]
}

export interface Turn {
    key: string
    user?: UserPrompt
    steps: Step[]
    startedAt: number
    endedAt: number
    running: boolean
    usage?: TurnUsage
}

const emptyUsage = (): TurnUsage => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: [], thinkingLevels: [] })

function addUsage(usage: TurnUsage, message: AssistantMessage) {
    const u = message.usage
    if (!u)
        return
    usage.requests++
    usage.input += u.input || 0
    usage.output += u.output || 0
    usage.cacheRead += u.cacheRead || 0
    usage.cacheWrite += u.cacheWrite || 0
    usage.cost += u.cost?.total || 0
    if (typeof u.reasoning === 'number')
        usage.reasoning = (usage.reasoning ?? 0) + u.reasoning
    const model = message.provider && message.model ? `${message.provider}/${message.model}` : message.model
    if (model && !usage.models.includes(model))
        usage.models.push(model)
    if (message.thinkingLevel && !usage.thinkingLevels.includes(message.thinkingLevel))
        usage.thinkingLevels.push(message.thinkingLevel)
}

/** Output size of a block in characters, used to share a message's duration between its blocks. */
function blockWeight(block: AssistantMessage['content'][number]): number {
    if (block.type === 'text')
        return block.text.length
    if (block.type === 'thinking')
        return block.thinking.length
    return JSON.stringify(block.arguments ?? {}).length
}

/**
 * Start / end of each block of a finished assistant message. Recorded times win; otherwise the
 * message's duration (start → endedAt) is shared out by output size, blocks being generated in order.
 */
export function blockSpans(message: AssistantMessage, endedAt: number | undefined, times?: ReadonlyMap<string, BlockTime>): ({ start: number, end: number } | undefined)[] {
    const weights = message.content.map(blockWeight)
    const total = weights.reduce((a, b) => a + b, 0)
    const duration = endedAt && message.timestamp && endedAt >= message.timestamp ? endedAt - message.timestamp : undefined
    let offset = 0
    return message.content.map((_, i) => {
        const recorded = times?.get(blockTimeKey(message.timestamp, i))
        const share = duration !== undefined && total > 0 ? (duration * weights[i]) / total : undefined
        const estimate = share !== undefined ? { start: message.timestamp + offset, end: message.timestamp + offset + share } : undefined
        offset += share ?? 0
        if (recorded?.end !== undefined)
            return { start: recorded.start, end: recorded.end }
        return estimate
    })
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
    /** Exact block times recorded while streaming (see blockTimeKey). */
    blockTimes?: ReadonlyMap<string, BlockTime>
}

export function buildTurns(messages: TimelineMessage[], options: BuildOptions = {}): Turn[] {
    const results = new Map<string, ToolResultView>()
    for (const { message } of messages) {
        if (message.role === 'toolResult')
            results.set(message.toolCallId, { content: message.content, details: message.details, isError: message.isError, endedAt: message.timestamp })
    }

    const all = options.streaming
        ? [...messages, { key: 'streaming', message: options.streaming }]
        : messages

    // Reviews: reports by id, and what feedback already sent back from each.
    const reports = new Map<string, ReviewDetails>()
    const applied = new Map<string, Set<string>>()
    for (const { message } of messages) {
        if (message.role !== 'custom')
            continue
        if (message.customType === REVIEW_TYPES.report && (message.details as ReviewDetails | undefined)?.kind === 'review')
            reports.set((message.details as ReviewDetails).id, message.details as ReviewDetails)
        const feedback = message.customType === REVIEW_TYPES.feedback ? message.details as ReviewFeedbackDetails | undefined : undefined
        if (feedback?.reviewId) {
            const set = applied.get(feedback.reviewId) ?? new Set()
            feedback.items.forEach(id => set.add(id))
            applied.set(feedback.reviewId, set)
        }
    }

    const turns: Turn[] = []
    let current: Turn | undefined
    const start = (key: string, user?: UserPrompt, timestamp = 0) => {
        current = { key, user, steps: [], startedAt: timestamp, endedAt: timestamp, running: false, usage: emptyUsage() }
        turns.push(current)
        return current
    }
    // A report can land mid-run; it waits for the run's turn to end and then stands on its own, so
    // it never splits the run.
    let reviews: { step: Step, timestamp: number }[] = []
    const flushReviews = () => {
        for (const { step, timestamp } of reviews) {
            start(step.key, undefined, timestamp).steps.push(step)
            current = undefined
        }
        reviews = []
    }
    const open = (key: string, user?: UserPrompt, timestamp = 0) => {
        flushReviews()
        return start(key, user, timestamp)
    }
    const ensure = (key: string, timestamp: number) => current ?? open(key, undefined, timestamp)
    const touch = (turn: Turn, timestamp: number) => {
        if (timestamp > turn.endedAt)
            turn.endedAt = timestamp
    }

    for (const { key, message, endedAt } of all) {
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
                const spans = streaming ? [] : blockSpans(message, endedAt, options.blockTimes)
                if (!streaming && turn.usage)
                    addUsage(turn.usage, message)
                message.content.forEach((block, i) => {
                    const blockKey = `${key}:${i}`
                    const last = streaming && i === message.content.length - 1
                    const span = spans[i]
                    if (block.type === 'text') {
                        if (block.text || last)
                            turn.steps.push({ kind: 'text', key: blockKey, text: block.text, streaming: last, endedAt: span?.end })
                    }
                    else if (block.type === 'thinking') {
                        if (block.thinking || block.redacted || last) {
                            const ms = span ? Math.round(span.end - span.start) : undefined
                            turn.steps.push({ kind: 'thinking', key: blockKey, text: block.thinking, streaming: last, redacted: !!block.redacted, ms, endedAt: span?.end })
                        }
                    }
                    else if (block.type === 'toolCall') {
                        const live = options.tools?.get(block.id)
                        const result = results.get(block.id) ?? live?.result ?? live?.partial
                        const running = !results.has(block.id) && !live?.result && (streaming || !!live?.running || !!options.running)
                        // Tools start once their message is complete and end with their toolResult.
                        const startedAt = live?.startedAt ?? endedAt
                        const finishedAt = running ? undefined : results.get(block.id)?.endedAt ?? live?.endedAt
                        const ms = startedAt && finishedAt && finishedAt >= startedAt ? finishedAt - startedAt : undefined
                        turn.steps.push({ kind: 'tool', key: blockKey, call: block, result, running, startedAt, ms, endedAt: finishedAt })
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
                touch(turn, endedAt ?? message.timestamp)
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
                const details = message.details as any
                if (message.customType === REVIEW_TYPES.report && details?.kind === 'review') {
                    reviews.push({ step: { kind: 'review', key, report: details, applied: [...(applied.get(details.id) ?? [])] }, timestamp: message.timestamp })
                }
                else if (message.customType === REVIEW_TYPES.feedback && details?.reviewId) {
                    const feedback = details as ReviewFeedbackDetails
                    const report = reports.get(feedback.reviewId)
                    const title = (id: string) => report?.issues.find(i => i.id === id)?.title ?? report?.suggestions.find(s => s.id === id)?.title ?? ''
                    open(key, {
                        text: feedback.note ?? '',
                        images: [],
                        timestamp: message.timestamp,
                        pending: false,
                        review: { reviewId: feedback.reviewId, round: report?.round, items: feedback.items.map(id => ({ id, title: title(id) })) },
                    }, message.timestamp)
                }
                else if (message.display) {
                    ensure(key, message.timestamp).steps.push({ kind: 'note', key, variant: 'custom', title: message.customType, text: contentText(message.content) })
                }
                break
            }
            default:
                break
        }
    }
    // Still running: the report shows in the run's turn until it ends.
    if (reviews.length && options.running && current) {
        current.steps.push(...reviews.map(r => r.step))
        reviews = []
    }
    flushReviews()

    if (options.pendingPrompt) {
        const { text, images, timestamp } = options.pendingPrompt
        open('pending', { text, images, timestamp, pending: true }, timestamp)
    }

    const last = turns[turns.length - 1]
    if (last && options.running)
        last.running = true
    return turns
}

/**
 * Tools whose results carry their own diff stay on their own row, as in pi-cc-extensions; so do
 * capability tools, which have dedicated views.
 */
const NON_GROUPABLE = new Set(['edit', 'write', 'apply_patch', ...CAPABILITY_TOOLS.keys()])

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
