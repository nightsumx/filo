// What a thread is doing right now, in one short line for the project tree: "运行 npm test",
// "等你回答 · 用哪个数据库？", "出错 · 429 rate limited". Pure, so it is easy to test.
import type { TodoDetails } from '@shared/capabilities'
import type { Localized } from '@shared/i18n'
import type { Step } from './timeline'
import { tr } from './i18n'
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

const VERBS: Record<string, Localized> = {
    bash: { zh: '运行', en: 'Running' },
    read: { zh: '读取', en: 'Reading' },
    edit: { zh: '编辑', en: 'Editing' },
    write: { zh: '写入', en: 'Writing' },
    apply_patch: { zh: '修改文件', en: 'Patching files' },
    grep: { zh: '搜索', en: 'Searching' },
    find: { zh: '查找', en: 'Finding' },
    ls: { zh: '列出', en: 'Listing' },
    todo: { zh: '更新任务清单', en: 'Updating todos' },
}

const thinking = () => tr('思考中', 'Thinking')

function describeStep(step: Step | undefined, cwd?: string): string {
    if (!step)
        return thinking()
    if (step.kind === 'tool') {
        const { name, arguments: args } = step.call
        // The todo list and patches say enough without their arguments.
        if (name === 'todo' || name === 'apply_patch')
            return tr(VERBS[name])
        if (name === 'subagent')
            return `${tr('子 Agent', 'Subagent')} · ${String(args?.title ?? '').trim() || tr('运行中', 'running')}`
        if (name === 'propose_plan')
            return tr('写计划', 'Writing a plan')
        const { main } = tuiSummary(name, args, cwd)
        const verb = VERBS[name] ? tr(VERBS[name]) : tuiTitle(name)
        return main ? `${verb} ${main}` : verb
    }
    if (step.kind === 'text' && step.streaming)
        return tr('回复中', 'Responding')
    // Thinking, or a finished step while the next model call is in flight.
    return thinking()
}

export type WaitingKind = 'question' | 'approval' | 'plan' | 'cards'

const WAITING_LABEL: Record<WaitingKind, Localized> = {
    question: { zh: '等你回答', en: 'Waiting for your answer' },
    approval: { zh: '等你确认', en: 'Waiting for approval' },
    plan: { zh: '等你审阅计划', en: 'Waiting for plan review' },
    cards: { zh: '等你决定', en: 'Waiting for your decision' },
}

export const waitingLabel = (kind: WaitingKind = 'question') => tr(WAITING_LABEL[kind])

function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? ''
}

export function threadActivity(input: ActivityInput): ThreadActivity {
    const items = input.todo?.items ?? []
    const done = items.filter(i => i.status === 'done').length
    const progress = items.length && done < items.length ? { done, total: items.length } : undefined

    if (input.waitingFor !== undefined) {
        const label = waitingLabel(input.waitingKind)
        return { phase: 'waiting', text: input.waitingFor ? `${label} · ${firstLine(input.waitingFor)}` : label, progress }
    }
    if (input.running) {
        let text: string
        if (input.starting)
            text = tr('正在启动 pi', 'Starting pi')
        else if (input.compacting)
            text = tr('正在压缩上下文', 'Compacting context')
        else if (input.retry)
            text = `${tr('重试中', 'Retrying')} ${input.retry.attempt}/${input.retry.maxAttempts}`
        else
            text = describeStep(input.steps[input.steps.length - 1], input.cwd)
        return { phase: 'running', text, progress }
    }
    if (input.agentError)
        return { phase: 'error', text: firstLine(input.agentError) }
    // A run that ended on a request failure (not a user abort) stays flagged until the next prompt.
    const last = input.steps[input.steps.length - 1]
    if (last?.kind === 'error' && !last.aborted)
        return { phase: 'error', text: firstLine(last.text) || tr('请求失败', 'Request failed') }
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
