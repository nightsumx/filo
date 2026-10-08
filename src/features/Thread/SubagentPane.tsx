// A subagent opened like a thread of its own (from the project tree or its card): a header with the
// way back and the run's numbers, the child's transcript drawn by the thread's MessageList, and a
// composer that steers the child (delivered after its current tool) or stops it. The child lives in
// its parent's tool call, so once it ends the view is read-only.
import type { SubagentRun, SubagentStatus } from '@/lib/subagents'
import type { Thread } from '@/store/thread'
import type { Localized } from '@shared/i18n'
import { SubagentMark } from '@/components/StatusIcons'
import { childToolCount, subagentLive } from '@/lib/subagents'
import { tr } from '@/lib/i18n'
import { formatElapsed } from '@/lib/threadActivity'
import { cn, formatCost, formatCount } from '@/lib/utils'
import { appStore } from '@/store/app'
import { ArrowUp, ChevronLeft, Square } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNow } from './ToolRow'

const STATUS: Record<SubagentStatus, Localized> = {
    starting: { zh: '启动中', en: 'Starting' },
    running: { zh: '运行中', en: 'Running' },
    done: { zh: '完成', en: 'Done' },
    failed: { zh: '失败', en: 'Failed' },
    cancelled: { zh: '已取消', en: 'Cancelled' },
    interrupted: { zh: '已中断', en: 'Interrupted' },
}

export const SubagentHeader = observer(({ thread, run }: { thread: Thread, run: SubagentRun }) => {
    const live = subagentLive(run)
    const now = useNow(live)
    const d = run.details
    const waiting = live && thread.subagentWaiting(run)
    const tools = childToolCount(d)
    const tokens = d ? d.usage.input + d.usage.cacheRead + d.usage.cacheWrite : 0
    const meta = [
        waiting ? tr('等你确认', 'Waiting for approval') : tr(STATUS[run.status]),
        d ? formatElapsed((d.endedAt ?? (live ? now : d.startedAt)) - d.startedAt) : '',
        tools ? tr(`${tools} 次工具调用`, `${tools} tool ${tools === 1 ? 'call' : 'calls'}`) : '',
        d && (tokens || d.usage.output) ? `↑ ${formatCount(tokens)} ↓ ${formatCount(d.usage.output)}` : '',
        d?.usage.cost ? formatCost(d.usage.cost) : '',
        d?.model ?? '',
    ].filter(Boolean)
    return (
        <div className="shrink-0">
            <div className="mx-auto flex h-8 w-full max-w-5xl min-w-0 items-center gap-1.5 px-5 text-[12.5px]">
                <button
                    type="button"
                    onClick={() => thread.showSubagent(null)}
                    title={tr('回到主线程（Esc）', 'Back to the thread (Esc)')}
                    className="-ml-1.5 flex h-6 min-w-0 max-w-[40%] shrink-0 items-center gap-0.5 rounded-md pr-1.5 pl-0.5 text-gray-500 hover:bg-ide-hover hover:text-gray-800"
                >
                    <ChevronLeft size={14} className="shrink-0" />
                    <span className="truncate">{thread.title}</span>
                </button>
                <span className="shrink-0 text-gray-400">/</span>
                <SubagentMark status={run.status} waiting={waiting} />
                <span className="min-w-0 shrink truncate font-medium text-gray-900">{run.title}</span>
                <span className={cn('min-w-0 flex-1 truncate tabular-nums', waiting ? 'text-amber-600 dark:text-amber-400' : run.status === 'failed' ? 'text-red-500' : 'text-gray-500')}>
                    {meta.join(' · ')}
                </span>
            </div>
            {d?.error && <div className="mx-auto w-full max-w-5xl px-5 pb-1 text-[12.5px] leading-5 text-red-500 [overflow-wrap:anywhere]">{d.error}</div>}
        </div>
    )
})

/** Steers the running child; once it ended, says so and offers the way back. */
export const SubagentComposer = observer(({ thread, run }: { thread: Thread, run: SubagentRun }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const [text, setText] = useState('')
    const [sending, setSending] = useState(false)
    // Steering needs the child process, which exists once it reported its first event.
    const live = subagentLive(run)
    const steerable = run.status === 'running'
    const queued = run.details?.steering ?? []

    // Opening it from the tree focuses here, as a tab switch focuses the thread's composer.
    const focusRequest = appStore.composerFocus
    useEffect(() => {
        if (focusRequest.key === thread.key)
            textareaRef.current?.focus()
    }, [focusRequest.n, focusRequest.key, thread.key])

    useLayoutEffect(() => {
        const el = textareaRef.current
        if (!el)
            return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
    }, [text])

    const steer = async () => {
        const message = text.trim()
        if (!message || sending || !steerable)
            return
        setSending(true)
        if (await thread.steerSubagent(run.id, message))
            setText('')
        setSending(false)
    }

    if (!live) {
        const ended = run.status === 'done'
            ? tr('子 Agent 已完成，它的回复已交给主线程。', 'The subagent finished; its reply went to the thread.')
            : run.status === 'failed'
                ? tr('子 Agent 失败了，主线程已收到错误。', 'The subagent failed; the thread got the error.')
                : run.status === 'cancelled'
                    ? tr('子 Agent 已取消。', 'The subagent was cancelled.')
                    : tr('子 Agent 随主线程中断了。', 'The subagent stopped with the thread.')
        return (
            <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-5 pt-1 pb-4 text-[12.5px] text-gray-500">
                <span className="min-w-0 truncate">{ended}</span>
                <button type="button" onClick={() => thread.showSubagent(null)} className="shrink-0 rounded-md px-1.5 text-ide-accent hover:bg-ide-hover">
                    {tr('回到主线程', 'Back to the thread')}
                </button>
            </div>
        )
    }

    // Something else waits on the user (the thread's own call, another subagent's): only the thread shows it.
    const elsewhere = thread.waitingForUser && !thread.subagentWaiting(run)
    return (
        <div className="mx-auto w-full max-w-5xl px-4 pb-3">
            {elsewhere && (
                <div role="status" className="mb-1.5 flex items-center gap-2 px-1 text-[12.5px] text-amber-600 dark:text-amber-400">
                    <span className="min-w-0 truncate">{`${tr('主线程', 'The thread')} · ${thread.activity.text}`}</span>
                    <button type="button" onClick={() => thread.showSubagent(null)} className="shrink-0 rounded-md px-1.5 text-ide-accent hover:bg-ide-hover">
                        {tr('去处理', 'Go there')}
                    </button>
                </div>
            )}
            {queued.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                    {queued.map((q, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md bg-ide-sel px-2.5 py-1 text-[12px] text-gray-800">
                            <span className="shrink-0 font-medium">{tr('排队中', 'Queued')}</span>
                            <span className="truncate">{q}</span>
                        </div>
                    ))}
                </div>
            )}
            <div className="relative cursor-text rounded-lg bg-ide-input" onClick={e => e.target === e.currentTarget && textareaRef.current?.focus()}>
                <textarea
                    ref={textareaRef}
                    value={text}
                    rows={2}
                    disabled={!steerable}
                    aria-label={tr(`引导子 Agent「${run.title}」`, `Steer subagent “${run.title}”`)}
                    placeholder={steerable
                        ? tr('引导这个子 Agent，当前工具跑完后送达（Esc 回到主线程）', 'Steer this subagent; delivered after its current tool (Esc to go back)')
                        : tr('子 Agent 启动中…', 'Subagent starting…')}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing)
                            return
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void steer()
                        }
                        else if (e.key === 'Escape' && !text) {
                            e.preventDefault()
                            thread.showSubagent(null)
                        }
                    }}
                    className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[length:var(--app-font-size)] leading-relaxed text-gray-900 outline-none placeholder:text-gray-400 select-text disabled:cursor-default"
                />
                <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                    <span className="min-w-0 flex-1 truncate px-1.5 text-[11.5px] text-gray-400">
                        {tr(`子 Agent · ${run.title}`, `Subagent · ${run.title}`)}
                    </span>
                    {text.trim()
                        ? (
                                <button
                                    type="button"
                                    aria-label={tr('发送引导消息', 'Send steering message')}
                                    title={tr('发送（Enter）', 'Send (Enter)')}
                                    disabled={sending || !steerable}
                                    onClick={() => void steer()}
                                    className="ml-1 flex h-7 w-7 items-center justify-center rounded-md bg-ide-accent text-always-white hover:bg-ide-accent-hover disabled:bg-gray-100 disabled:text-gray-400"
                                >
                                    <ArrowUp size={15} />
                                </button>
                            )
                        : (
                                <button
                                    type="button"
                                    aria-label={tr('停止子 Agent', 'Stop subagent')}
                                    title={tr('停止这个子 Agent，主线程继续', 'Stop this subagent; the thread carries on')}
                                    disabled={!steerable}
                                    onClick={() => void thread.cancelSubagent(run.id)}
                                    className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 disabled:text-gray-300"
                                >
                                    <Square size={13} fill="currentColor" />
                                </button>
                            )}
                </div>
            </div>
        </div>
    )
})
