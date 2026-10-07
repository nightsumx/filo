// The review capability in the transcript: a report card (verdict, rechecks of earlier items,
// issues with their runtime evidence, follow-up suggestions) where the user picks what goes back
// to the agent, plus the footer control that starts a review and shows it running.
// Talks to pi through /gui-review, /gui-review-cancel and /gui-review-apply.
import type { ReviewDetails, ReviewIssue, ReviewRecheck, ReviewSeverity } from '@shared/capabilities'
import type { Thread } from '@/store/thread'
import type { Localized } from '@shared/i18n'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { flatFieldClass } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { useT } from '@/lib/transcriptText'
import { cn, formatCost } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { useThread } from '../ThreadContext'
import { Gutter, Spinner, StatusMark, useNow } from '../ToolRow'
import { useViewState } from '../viewState'
import { Transcript } from './SubagentStep'

const SEVERITY: Record<ReviewSeverity, { label: Localized, className: string }> = {
    high: { label: { zh: '高', en: 'high' }, className: 'text-red-600 dark:text-red-400' },
    medium: { label: { zh: '中', en: 'medium' }, className: 'text-amber-600 dark:text-amber-400' },
    low: { label: { zh: '低', en: 'low' }, className: 'text-gray-500' },
}

const RECHECK: Record<ReviewRecheck['outcome'], { label: Localized, className: string }> = {
    fixed: { label: { zh: '已修复', en: 'fixed' }, className: 'text-ide-success' },
    not_fixed: { label: { zh: '未修复', en: 'not fixed' }, className: 'text-red-600 dark:text-red-400' },
    rebuttal_accepted: { label: { zh: '反驳成立', en: 'rebuttal holds' }, className: 'text-gray-600' },
    rebuttal_rejected: { label: { zh: '反驳不成立', en: 'rebuttal rejected' }, className: 'text-amber-600 dark:text-amber-400' },
}

const where = (issue: ReviewIssue) => issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : ''

function Evidence({ issue }: { issue: ReviewIssue }) {
    const t = useT()
    const evidence = issue.evidence!
    return (
        <div className="mt-1 rounded-md bg-ide-block px-3 py-2 font-mono text-[12px]">
            <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 whitespace-pre-wrap break-all font-semibold text-gray-900 select-text">{`$ ${evidence.command}`}</span>
                <span className={cn('shrink-0 font-sans', evidence.exitCode ? 'text-red-500' : 'text-gray-500')}>
                    {evidence.exitCode === undefined ? tr('未结束', 'unfinished') : t.exitCode(evidence.exitCode)}
                </span>
            </div>
            {evidence.output && <pre className="mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-all text-gray-700 select-text">{evidence.output}</pre>}
        </div>
    )
}

/** One pickable item: check box, id, tags and title; the body opens under it. */
function Item({ id, checked, onToggle, applied, tags, title, location, children }: {
    id: string
    checked: boolean
    onToggle: () => void
    applied: boolean
    tags: React.ReactNode
    title: string
    location?: string
    children: React.ReactNode
}) {
    const [open, setOpen] = useState(false)
    return (
        <li className="flex flex-col">
            <div className="flex min-h-6 min-w-0 items-center gap-2 text-[12.5px]">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={onToggle}
                    aria-label={tr(`选中 ${id}`, `Pick ${id}`)}
                    className="size-3.5 shrink-0 cursor-pointer accent-[var(--ide-accent)]"
                />
                <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="group/item flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <span className="shrink-0 font-mono text-gray-500">{id}</span>
                    {tags}
                    <span className="min-w-0 truncate text-gray-900">{title}</span>
                    {location && <span className="shrink-0 truncate font-mono text-[11.5px] text-gray-500">{location}</span>}
                    {applied && <span className="shrink-0 rounded-[4px] bg-ide-sel px-1.5 text-[11.5px] text-gray-700">{tr('已交回', 'sent')}</span>}
                    <ChevronRight size={12} className={cn('shrink-0 text-gray-400 transition-transform group-hover/item:text-gray-800', open && 'rotate-90')} />
                </button>
            </div>
            {open && <div className="mb-1 ml-[22px] flex flex-col gap-1 text-[12.5px] leading-5 text-gray-700">{children}</div>}
        </li>
    )
}

const Prose = ({ text }: { text: string }) => <Markdown content={text} className="text-[12.5px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />

export const ReviewStep = observer(({ id, report, applied }: { id: string, report: ReviewDetails, applied: string[] }) => {
    const t = useT()
    const thread = useThread()
    const sent = new Set(applied)
    // Picks start at the issues not sent back yet; suggestions are opt-in.
    const [picked, setPicked] = useViewState<string[]>(`review-picked:${report.id}`, report.issues.filter(i => !sent.has(i.id)).map(i => i.id))
    const [note, setNote] = useViewState(`review-note:${report.id}`, '')
    const [process, setProcess] = useViewState(`review-run:${id}`, false)
    const [sending, setSending] = useState(false)
    const toggle = (itemId: string) => setPicked(p => p.includes(itemId) ? p.filter(x => x !== itemId) : [...p, itemId])

    const elapsed = report.endedAt - report.startedAt
    const cost = report.run.usage.cost
    const tools = report.run.messages.filter(m => m.role === 'toolResult').length
    const done = report.status === 'done'
    const pass = done && report.verdict === 'pass'
    const meta = [
        done ? (pass ? tr('通过', 'pass') : tr('需要修改', 'needs work')) : report.status === 'cancelled' ? tr('已取消', 'cancelled') : tr('失败', 'failed'),
        done && report.issues.length ? tr(`${report.issues.length} 个问题`, `${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}`) : '',
        done && report.suggestions.length ? tr(`${report.suggestions.length} 条建议`, `${report.suggestions.length} suggestion${report.suggestions.length === 1 ? '' : 's'}`) : '',
        elapsed > 0 ? t.elapsed(elapsed) : '',
        tools ? tr(`${tools} 次工具调用`, `${tools} tool ${tools === 1 ? 'call' : 'calls'}`) : '',
        cost ? formatCost(cost) : '',
    ].filter(Boolean).join(' · ')
    const scope = report.scope === 'thread'
        ? tr(`本线程改过的 ${report.files.length} 个文件`, `${report.files.length} file${report.files.length === 1 ? '' : 's'} this thread changed`)
        : report.files.length ? tr(`全部未提交改动（${report.files.length} 个文件）`, `every uncommitted change (${report.files.length} files)`) : tr('没有文件改动', 'no file changes')

    const pickedItems = picked.filter(p => report.issues.some(i => i.id === p) || report.suggestions.some(s => s.id === p))
    const canSend = !!thread && !sending && (pickedItems.length > 0 || !!note.trim())
    const send = async () => {
        if (!canSend)
            return
        setSending(true)
        if (await thread!.applyReview(report.id, { items: pickedItems, ...(note.trim() ? { note: note.trim() } : {}) })) {
            setPicked([])
            setNote('')
        }
        setSending(false)
    }

    return (
        <Gutter mark={done ? <StatusMark status={pass ? 'success' : 'error'} /> : <span className="text-gray-400">⎿</span>}>
            <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-[12.5px]">
                <span className="shrink-0 font-mono font-semibold text-gray-900">{report.round > 1 ? `Review ${report.round}` : 'Review'}</span>
                <span className="min-w-0 truncate tabular-nums text-gray-500">{meta}</span>
            </div>
            {report.error && <div className="text-[12.5px] leading-5 text-red-600 [overflow-wrap:anywhere] dark:text-red-400">{report.error}</div>}
            {done && (
                <div className="mt-0.5 flex flex-col gap-1.5">
                    <div className="text-gray-700">
                        <Prose text={report.summary} />
                        <div className="text-[11.5px] text-gray-500">{tr(`审查范围：${scope}`, `Scope: ${scope}`)}</div>
                    </div>
                    {report.rechecks.length > 0 && (
                        <ul className="m-0 flex list-none flex-col p-0">
                            {report.rechecks.map(r => (
                                <li key={r.id} className="flex min-h-6 min-w-0 items-baseline gap-1.5 text-[12.5px] leading-5">
                                    <span className="shrink-0 font-mono text-gray-500">{r.id}</span>
                                    <span className={cn('shrink-0', RECHECK[r.outcome].className)}>{tr(RECHECK[r.outcome].label)}</span>
                                    <span className="min-w-0 text-gray-900 [overflow-wrap:anywhere]">{r.title}</span>
                                    {r.note && <span className="min-w-0 text-gray-500 [overflow-wrap:anywhere]">{`· ${r.note}`}</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                    {(report.issues.length > 0 || report.suggestions.length > 0) && (
                        <ul className="m-0 flex list-none flex-col p-0">
                            {report.issues.map(issue => (
                                <Item
                                    key={issue.id}
                                    id={issue.id}
                                    checked={picked.includes(issue.id)}
                                    onToggle={() => toggle(issue.id)}
                                    applied={sent.has(issue.id)}
                                    title={issue.title}
                                    location={where(issue)}
                                    tags={(
                                        <>
                                            <span className={cn('shrink-0', SEVERITY[issue.severity].className)}>{tr(SEVERITY[issue.severity].label)}</span>
                                            <span className={cn('shrink-0', issue.status === 'confirmed' ? 'text-ide-accent' : 'text-gray-500')}>
                                                {issue.status === 'confirmed' ? tr('已复现', 'reproduced') : tr('推测', 'suspected')}
                                            </span>
                                        </>
                                    )}
                                >
                                    <Prose text={issue.detail} />
                                    {issue.fix && (
                                        <div className="flex min-w-0 gap-1.5">
                                            <span className="shrink-0 text-gray-500">{tr('修复建议', 'Fix')}</span>
                                            <div className="min-w-0 flex-1"><Prose text={issue.fix} /></div>
                                        </div>
                                    )}
                                    {issue.evidence && <Evidence issue={issue} />}
                                </Item>
                            ))}
                            {report.suggestions.map(s => (
                                <Item
                                    key={s.id}
                                    id={s.id}
                                    checked={picked.includes(s.id)}
                                    onToggle={() => toggle(s.id)}
                                    applied={sent.has(s.id)}
                                    title={s.title}
                                    tags={<span className="shrink-0 text-gray-500">{tr('建议', 'suggestion')}</span>}
                                >
                                    <Prose text={s.detail} />
                                </Item>
                            ))}
                        </ul>
                    )}
                    {(report.issues.length > 0 || report.suggestions.length > 0) && (
                        <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => {
                                e.preventDefault()
                                void send()
                            }}
                        >
                            <input
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                placeholder={tr('补充说明（可选），和选中的条目一起交给 Agent…', 'Add a note (optional), sent with the picked items…')}
                                aria-label={tr('补充说明', 'Note')}
                                className={cn(flatFieldClass, 'h-7 min-w-0 flex-1 text-[12.5px]')}
                            />
                            <Button type="submit" variant="primary" size="sm" disabled={!canSend}>
                                {pickedItems.length ? tr(`交给 Agent（${pickedItems.length}）`, `Send to agent (${pickedItems.length})`) : tr('交给 Agent', 'Send to agent')}
                            </Button>
                        </form>
                    )}
                </div>
            )}
            <button type="button" onClick={() => setProcess(v => !v)} aria-expanded={process} className="mt-0.5 flex h-6 items-center gap-1 text-[12px] text-gray-500 hover:text-gray-800">
                <ChevronRight size={12} className={cn('transition-transform', process && 'rotate-90')} />
                {tr('审查过程', 'How it reviewed')}
            </button>
            {process && (
                <div className="mb-1 border-l-2 border-ide-line pl-3">
                    <Transcript details={report.run} running={false} />
                </div>
            )}
        </Gutter>
    )
})

/** Review in a finished turn's footer; while one runs, its progress and Stop instead. */
export const ReviewControl = observer(({ thread, turnKey }: { thread: Thread, turnKey: string }) => {
    const progress = thread.reviewProgress
    const now = useNow(!!progress)
    if (!thread.reviewAvailable || thread.reviewTurnKey !== turnKey)
        return null
    if (progress) {
        return (
            <span className="flex h-6 min-w-0 items-center gap-1.5">
                <span className="text-gray-400">·</span>
                <Spinner className="text-ide-accent" />
                <span className="min-w-0 truncate">
                    {tr('审查中', 'Reviewing')}
                    {` · ${Math.max(0, Math.round((now - progress.startedAt) / 1000))}s`}
                    {progress.tools ? tr(` · ${progress.tools} 次工具调用`, ` · ${progress.tools} tool ${progress.tools === 1 ? 'call' : 'calls'}`) : ''}
                    {progress.last && <span className="font-mono text-[11.5px]">{` · ${progress.last}`}</span>}
                </span>
                <button type="button" onClick={() => void thread.cancelReview()} className="shrink-0 rounded-[4px] px-1.5 text-gray-500 hover:bg-black/[0.04] hover:text-gray-800">
                    {tr('停止', 'Stop')}
                </button>
            </span>
        )
    }
    if (thread.running)
        return null
    return (
        <span className="flex h-6 items-center gap-1">
            <span className="text-gray-400">·</span>
            <button
                type="button"
                onClick={() => void thread.startReview()}
                title={tr('让一个独立的 pi 进程只读审查这些改动，跑命令取证', 'Have a separate pi process audit these changes read-only, running commands for evidence')}
                className="rounded-[4px] px-1.5 text-gray-500 hover:bg-black/[0.04] hover:text-gray-800"
            >
                Review
            </button>
        </span>
    )
})
