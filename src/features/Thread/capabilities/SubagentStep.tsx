// The subagent capability inline: one row for the delegated task, and under it the child's own
// transcript drawn with the parent's components. While it runs, a steer field and a cancel button
// talk to the child through /gui-subagent-steer and /gui-subagent-cancel.
import type { SubagentDetails } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { TimelineMessage, ToolExecState, ToolResultView } from '@/lib/timeline'
import { Markdown } from '@/components/Markdown'
import { flatFieldClass } from '@/components/ui/form'
import { buildTurns, groupSteps } from '@/lib/timeline'
import { useT } from '@/lib/transcriptText'
import { cn, formatCost, formatCount } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StepView } from '../StepView'
import { useThread } from '../ThreadContext'
import { Gutter, StatusMark, ToolGroup, useNow } from '../ToolRow'
import { useViewState } from '../viewState'

/** The child's transcript as parent-style turns; the first prompt is the task, shown separately. */
function useChildTurns(details: SubagentDetails, running: boolean) {
    return useMemo(() => {
        const messages: TimelineMessage[] = details.messages.map((message, i) => ({ key: `sub:${i}`, message }))
        const tools = new Map<string, ToolExecState>(Object.entries(details.tools ?? {}).map(([id, s]) => [id, { running: true, startedAt: s.startedAt, partial: s.partial as ToolResultView | undefined }]))
        if (details.streaming)
            messages.push({ key: 'sub:streaming', message: { ...details.streaming, stopReason: 'pending' } })
        return buildTurns(messages, { tools, running })
    }, [details, running])
}

function Transcript({ details, running }: { details: SubagentDetails, running: boolean }) {
    const turns = useChildTurns(details, running)
    const scrollRef = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    // Follow the child's output like the main transcript, unless the user scrolled up.
    useLayoutEffect(() => {
        const el = scrollRef.current
        if (el && running && stick.current)
            el.scrollTop = el.scrollHeight
    })
    return (
        <div
            ref={scrollRef}
            onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
            className="max-h-[420px] overflow-y-auto pr-1"
        >
            {turns.map((turn, ti) => (
                <div key={turn.key}>
                    {ti > 0 && turn.user && (
                        <div className="my-1 text-[12.5px] leading-5 text-gray-600 [overflow-wrap:anywhere]">
                            <span className="text-ide-accent">↳ 你的引导：</span>
                            {turn.user.text}
                        </div>
                    )}
                    {groupSteps(turn.steps).map(item => (
                        <div key={item.kind === 'group' ? item.key : item.step.key} className="mt-0.5">
                            {item.kind === 'group' ? <ToolGroup steps={item.steps} /> : <StepView step={item.step} />}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    )
}

const Controls = observer(({ toolCallId, steering }: { toolCallId: string, steering: string[] }) => {
    const thread = useThread()
    const [text, setText] = useState('')
    const [sending, setSending] = useState(false)
    const steer = async () => {
        const message = text.trim()
        if (!thread || !message || sending)
            return
        setSending(true)
        if (await thread.steerSubagent(toolCallId, message))
            setText('')
        setSending(false)
    }
    return (
        <div className="mt-1.5 mb-1 flex flex-col gap-1">
            {steering.map((s, i) => (
                <div key={i} className="flex min-w-0 items-center gap-2 text-[12px] text-gray-600">
                    <span className="shrink-0 rounded-[4px] bg-ide-sel px-1.5 text-gray-800">排队中</span>
                    <span className="truncate">{s}</span>
                </div>
            ))}
            <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                    e.preventDefault()
                    void steer()
                }}
            >
                <input
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder="引导这个子 Agent，当前工具跑完后送达…"
                    aria-label="引导子 Agent"
                    className={cn(flatFieldClass, 'h-7 min-w-0 flex-1 text-[12.5px]')}
                />
                <button
                    type="button"
                    onClick={() => void thread?.cancelSubagent(toolCallId)}
                    className="h-7 shrink-0 rounded-[4px] px-2.5 text-[12.5px] text-red-600 hover:bg-red-500/10 dark:text-red-400"
                >
                    取消子 Agent
                </button>
            </form>
        </div>
    )
})

const STATUS: Record<SubagentDetails['status'], string> = {
    running: '运行中',
    done: '完成',
    failed: '失败',
    cancelled: '已取消',
}

export const SubagentStep = observer(({ call, result, running }: { call: ToolCall, result?: ToolResultView, running: boolean }) => {
    const t = useT()
    const details = result?.details as SubagentDetails | undefined
    const live = running && details?.kind === 'subagent' && details.status === 'running'
    const title = details?.title ?? (typeof call.arguments?.title === 'string' ? call.arguments.title : '')
    const task = details?.task ?? (typeof call.arguments?.task === 'string' ? call.arguments.task : '')
    // Running subagents are open so their progress shows; finished ones fold to their row.
    const [open, setOpen] = useViewState(`subagent:${call.id}`, running)
    const [taskOpen, setTaskOpen] = useViewState(`subagent-task:${call.id}`, false)
    const now = useNow(live)

    const tools = details?.messages.filter(m => m.role === 'toolResult').length ?? 0
    const elapsed = details ? (details.endedAt ?? now) - details.startedAt : 0
    const usage = details?.usage
    // No result and not running: the process ended mid-run (app quit), so nothing was recorded.
    const interrupted = !running && !result
    const meta = [
        interrupted ? t.aborted : details ? STATUS[details.status] : '启动中…',
        details && elapsed > 0 ? t.elapsed(elapsed) : '',
        tools ? `${tools} 次工具调用` : '',
        usage && (usage.input || usage.output) ? `↑ ${formatCount(usage.input + usage.cacheRead + usage.cacheWrite)} ↓ ${formatCount(usage.output)}` : '',
        usage?.cost ? formatCost(usage.cost) : '',
    ].filter(Boolean).join(' · ')
    const status = details?.status === 'failed' || result?.isError ? 'error' : running ? 'running' : 'success'

    return (
        <Gutter mark={interrupted || details?.status === 'cancelled' ? <span className="text-gray-400">⎿</span> : <StatusMark status={status} />}>
            <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="group/res flex h-6 w-full min-w-0 items-center gap-1.5 text-left text-[12.5px]">
                <span className="shrink-0 font-mono font-semibold text-gray-900">Subagent</span>
                <span className="min-w-0 truncate text-gray-900">{title}</span>
                <span className="shrink-0 tabular-nums text-gray-500">{meta}</span>
                <span className="shrink-0 text-gray-400 group-hover/res:text-gray-800">{open ? t.collapse : t.expand}</span>
            </button>
            {details?.error && <div className="text-[12.5px] leading-5 text-red-600 [overflow-wrap:anywhere]">{details.error}</div>}
            {open && (
                <div className="mt-0.5 mb-1 border-l-2 border-ide-line pl-3">
                    <button type="button" onClick={() => setTaskOpen(v => !v)} aria-expanded={taskOpen} className="flex min-h-6 w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] text-gray-500 hover:text-gray-800">
                        <span className="shrink-0">任务</span>
                        {!taskOpen && <span className="min-w-0 truncate text-gray-700">{task.split('\n')[0]}</span>}
                    </button>
                    {taskOpen && (
                        <div className="mb-1 rounded-md bg-ide-block px-3 py-2 text-[12.5px]">
                            <Markdown content={task} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                        </div>
                    )}
                    {details && <Transcript details={details} running={live} />}
                    {live && <Controls toolCallId={call.id} steering={details!.steering} />}
                </div>
            )}
        </Gutter>
    )
})
