// A subagent call seen from the parent thread: its status, the child's transcript as turns, and
// one line of what it is doing. Pure, so the project tree, the inline card and the full view
// (opened from either) all read the same thing.
import type { SubagentDetails } from '@shared/capabilities'
import type { Step, TimelineMessage, ToolExecState, ToolResultView, Turn } from './timeline'
import { tr } from './i18n'
import { describeStep } from './threadActivity'
import { buildTurns } from './timeline'

type ToolStep = Extract<Step, { kind: 'tool' }>

/** `starting`: launched, no child event yet. `interrupted`: the parent stopped (app quit) mid-run. */
export type SubagentStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface SubagentRun {
    /** The parent's tool call id; steer and cancel address the child by it. */
    id: string
    title: string
    task: string
    status: SubagentStatus
    details?: SubagentDetails
}

export function subagentRun(step: ToolStep): SubagentRun {
    const details = step.result?.details?.kind === 'subagent' ? step.result.details as SubagentDetails : undefined
    const args = step.call.arguments ?? {}
    const status: SubagentStatus = details
        ? step.running ? details.status : details.status === 'running' ? 'interrupted' : details.status
        : step.running ? 'starting' : 'interrupted'
    return {
        id: step.call.id,
        title: details?.title ?? (String(args.title ?? '').trim() || tr('子 Agent', 'Subagent')),
        task: details?.task ?? (typeof args.task === 'string' ? args.task : ''),
        status,
        details,
    }
}

/** Subagent calls among steps, in call order. */
export function subagentsIn(steps: Step[]): SubagentRun[] {
    return steps.filter((s): s is ToolStep => s.kind === 'tool' && s.call.name === 'subagent').map(subagentRun)
}

export const subagentLive = (run: SubagentRun) => run.status === 'starting' || run.status === 'running'

/** The child's transcript as parent-style turns: the task is the first prompt, steers the later ones. */
export function childTurns(details: SubagentDetails, running: boolean): Turn[] {
    const messages: TimelineMessage[] = details.messages.map((message, i) => ({ key: `sub:${i}`, message }))
    // The child echoes the task back as its first message; until then (or if it never did), the task.
    if (details.messages[0]?.role !== 'user')
        messages.unshift({ key: 'sub:task', message: taskMessage(details.task, details.startedAt) })
    const tools = new Map<string, ToolExecState>(Object.entries(details.tools ?? {}).map(([id, s]) => [id, { running: true, startedAt: s.startedAt, partial: s.partial as ToolResultView | undefined }]))
    if (details.streaming)
        messages.push({ key: 'sub:streaming', message: { ...details.streaming, stopReason: 'pending' } })
    return buildTurns(messages, { tools, running })
}

const taskMessage = (task: string, timestamp: number) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: task }], timestamp })

/** A run's turns, also before the child reported anything (only the task then). */
export function runTurns(run: SubagentRun): Turn[] {
    const live = subagentLive(run)
    if (run.details)
        return childTurns(run.details, live)
    return buildTurns([{ key: 'sub:task', message: taskMessage(run.task, Date.now()) }], { running: live })
}

/** Ids of every tool call the child made, the streaming message's included. */
export function childToolCallIds(details: SubagentDetails): Set<string> {
    const ids = new Set<string>()
    for (const m of [...details.messages, details.streaming] as any[]) {
        if (m?.role === 'assistant') {
            for (const c of m.content ?? []) {
                if (c?.type === 'toolCall' && typeof c.id === 'string')
                    ids.add(c.id)
            }
        }
    }
    return ids
}

export const childToolCount = (details: SubagentDetails | undefined) => details?.messages.filter(m => m.role === 'toolResult').length ?? 0

/** What a running child is doing, for the tree: "运行 npm test", "思考中". */
export function subagentActivity(run: SubagentRun, cwd?: string): string {
    if (!run.details)
        return tr('启动中', 'Starting')
    const turns = childTurns(run.details, true)
    const steps = turns[turns.length - 1]?.steps ?? []
    return describeStep(steps[steps.length - 1], cwd)
}
