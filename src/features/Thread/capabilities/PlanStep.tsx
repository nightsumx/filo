// The plan capability's propose_plan call: the plan with approve / revise / dismiss while pi waits,
// then the plan as a record of what was agreed. Decisions go back through /gui-plan-decide.
import type { PlanDecision, PlanDetails } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { ToolResultView } from '@/lib/timeline'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { flatFieldClass } from '@/components/ui/form'
import { cn } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { useThread } from '../ThreadContext'
import { Gutter, StatusMark } from '../ToolRow'
import { useViewState } from '../viewState'

const STATUS_LABEL: Record<PlanDetails['status'], string> = {
    pending: '等你审阅',
    approved: '已批准，开始执行',
    revised: '已要求修改',
    cancelled: '已搁置',
}

function PlanBody({ plan, streaming }: { plan: string, streaming?: boolean }) {
    return (
        <div className="mt-1 rounded-md bg-ide-block px-3 py-2 text-[13px]">
            <Markdown content={plan} streaming={streaming} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
        </div>
    )
}

const Review = observer(({ toolCallId }: { toolCallId: string }) => {
    const thread = useThread()
    const [revising, setRevising] = useState(false)
    const [feedback, setFeedback] = useState('')
    const [sending, setSending] = useState(false)
    const decide = async (decision: PlanDecision) => {
        if (!thread || sending)
            return
        setSending(true)
        await thread.decidePlan(toolCallId, decision)
        setSending(false)
    }

    if (revising) {
        return (
            <form
                className="mt-2 mb-1 flex max-w-3xl flex-col gap-2"
                onSubmit={(e) => {
                    e.preventDefault()
                    if (feedback.trim())
                        void decide({ feedback })
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && feedback.trim()) {
                        e.preventDefault()
                        void decide({ feedback })
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault()
                        setRevising(false)
                    }
                }}
            >
                <textarea
                    autoFocus
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    rows={3}
                    aria-label="要怎么改这个计划"
                    placeholder="要怎么改？比如：先别动数据库，分两步做…"
                    className={cn(flatFieldClass, 'h-auto w-full py-2 leading-5')}
                />
                <div className="flex items-center gap-2">
                    <Button type="submit" variant="primary" disabled={sending || !feedback.trim()} className="min-w-[72px]">发送修改意见</Button>
                    <Button type="button" variant="ghost" onClick={() => setRevising(false)}>返回</Button>
                    <span className="ml-auto text-[12px] text-[var(--jb-comment)]">⌘ Enter 发送</span>
                </div>
            </form>
        )
    }
    return (
        <div className="mt-2 mb-1 flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={sending} onClick={() => void decide({ approve: true })}>批准并开始执行</Button>
            <Button disabled={sending} onClick={() => setRevising(true)}>修改…</Button>
            <Button variant="ghost" disabled={sending} onClick={() => void decide({ cancelled: true })}>先不做</Button>
            <span className="ml-auto text-[12px] text-[var(--jb-comment)]">批准后退出计划模式，pi 接着按计划改代码</span>
        </div>
    )
})

export const PlanStep = observer(({ call, result, running }: { call: ToolCall, result?: ToolResultView, running: boolean }) => {
    const details = result?.details as PlanDetails | undefined
    const status = details?.kind === 'plan' ? details.status : undefined
    const plan = details?.plan ?? (typeof call.arguments?.plan === 'string' ? call.arguments.plan : '')
    const live = running && status === 'pending'
    // What was agreed stays open; superseded or shelved plans fold away.
    const [open, setOpen] = useViewState(`plan:${call.id}`, status !== 'revised' && status !== 'cancelled')

    if (live) {
        return (
            <Gutter mark={<span className="text-amber-500">?</span>}>
                <div className="flex h-6 items-center gap-1.5 text-[12.5px]">
                    <span className="font-mono font-semibold text-gray-900">Plan</span>
                    <span className="text-amber-600 dark:text-amber-400">{STATUS_LABEL.pending}</span>
                </div>
                <PlanBody plan={plan} />
                <Review toolCallId={call.id} />
            </Gutter>
        )
    }

    const mark = running ? <StatusMark status="running" /> : status === 'approved' ? <StatusMark status="success" /> : <span className="text-gray-400">⎿</span>
    const label = status ? STATUS_LABEL[status] : running ? '正在写计划…' : '未完成'
    return (
        <Gutter mark={mark}>
            <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="group/res flex h-6 w-full min-w-0 items-center gap-1.5 text-left text-[12.5px]">
                <span className="shrink-0 font-mono font-semibold text-gray-900">Plan</span>
                <span className="min-w-0 truncate text-gray-500">
                    {label}
                    {plan && <span className="text-gray-400 group-hover/res:text-gray-800">{` · ${open ? '收起' : '展开'}`}</span>}
                </span>
            </button>
            {details?.status === 'revised' && (
                <div className="text-[12.5px] leading-5 text-gray-600 [overflow-wrap:anywhere]">{`→ ${details.feedback}`}</div>
            )}
            {open && plan && <PlanBody plan={plan} streaming={running && !status} />}
        </Gutter>
    )
})
