// What a thread is doing right now, in one short line for the project tree: "运行 npm test",
// "等你回答 · 用哪个数据库？", "出错 · 429 rate limited". Pure, so it is easy to test.
import type { TodoDetails } from '@shared/capabilities'
import type { Step } from './timeline'
import { tuiSummary, tuiTitle } from './toolMeta'

export type ThreadPhase = 'waiting' | 'running' | 'error' | 'idle'

export interface ThreadActivity {
    phase: ThreadPhase
    /** Current action, the question waiting for an answer, or the error. Empty when idle. */
    text: string
    /** Todo progress while the list still has open items. */
    progress?: { done: number, total: number }
}

export interface ActivityInput {
    running: boolean
    starting: boolean
    compacting: boolean
    retry: { attempt: number, maxAttempts: number } | null
    /** Question or dialog title pi is blocked on; undefined when not waiting. */
    waitingFor?: string
    waitingKind?: WaitingKind
    /** Process failure (start error, crash). */
    agentError: string
    /** Steps of the last turn followed by the streaming message's steps. */
    steps: Step[]
    todo: TodoDetails | null
    cwd?: string
}

const VERBS: Record<string, string> = {
    bash: '运行',
    read: '读取',
    edit: '编辑',
    write: '写入',
    apply_patch: '修改文件',
    grep: '搜索',
    find: '查找',
    ls: '列出',
    todo: '更新任务清单',
}

function describeStep(step: Step | undefined, cwd?: string): string {
    if (!step)
        return '思考中'
    if (step.kind === 'tool') {
        const { name, arguments: args } = step.call
        // The todo list and patches say enough without their arguments.
        if (name === 'todo' || name === 'apply_patch')
            return VERBS[name]
        if (name === 'subagent')
            return `子 Agent · ${String(args?.title ?? '').trim() || '运行中'}`
        if (name === 'propose_plan')
            return '写计划'
        const { main } = tuiSummary(name, args, cwd)
        const verb = VERBS[name] ?? tuiTitle(name)
        return main ? `${verb} ${main}` : verb
    }
    if (step.kind === 'text' && step.streaming)
        return '回复中'
    // Thinking, or a finished step while the next model call is in flight.
    return '思考中'
}

export type WaitingKind = 'question' | 'approval' | 'plan'

export const WAITING_LABEL: Record<WaitingKind, string> = {
    question: '等你回答',
    approval: '等你确认',
    plan: '等你审阅计划',
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? ''
}

export function threadActivity(input: ActivityInput): ThreadActivity {
    const items = input.todo?.items ?? []
    const done = items.filter(i => i.status === 'done').length
    const progress = items.length && done < items.length ? { done, total: items.length } : undefined

    if (input.waitingFor !== undefined) {
        const label = WAITING_LABEL[input.waitingKind ?? 'question']
        return { phase: 'waiting', text: input.waitingFor ? `${label} · ${firstLine(input.waitingFor)}` : label, progress }
    }
    if (input.running) {
        let text: string
        if (input.starting)
            text = '正在启动 pi'
        else if (input.compacting)
            text = '正在压缩上下文'
        else if (input.retry)
            text = `重试中 ${input.retry.attempt}/${input.retry.maxAttempts}`
        else
            text = describeStep(input.steps[input.steps.length - 1], input.cwd)
        return { phase: 'running', text, progress }
    }
    if (input.agentError)
        return { phase: 'error', text: firstLine(input.agentError) }
    // A run that ended on a request failure (not a user abort) stays flagged until the next prompt.
    const last = input.steps[input.steps.length - 1]
    if (last?.kind === 'error' && !last.aborted)
        return { phase: 'error', text: firstLine(last.text) || '请求失败' }
    return { phase: 'idle', text: '' }
}

/** Run time as a clock: 0:42, 3:07, 1:02:03. */
export function formatElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
