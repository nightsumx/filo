import type { SubagentRun } from '@/lib/subagents'
import type { Step, Turn, UserPrompt } from '@/lib/timeline'
import type { TranscriptRow } from '@/lib/transcriptRows'
import type { Thread } from '@/store/thread'
import { ActionBtn } from '@/components/ActionBtn'
import { ImageThumb } from '@/components/ImageView'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { USER_BUBBLE_MAX_HEIGHT } from '@/lib/rowEstimate'
import { useT, verbFor } from '@/lib/transcriptText'
import { cn, formatCost, formatCount } from '@/lib/utils'
import { tr } from '@/lib/i18n'
import copyText from 'copy-to-clipboard'
import { appStore } from '@/store/app'
import { Check, ChevronRight, Copy, GitFork, PencilLine, Plane } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { turnStats } from '@/lib/turnSummary'
import { createContext, Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ReviewControl } from './capabilities/ReviewStep'
import { ExtensionRequest } from './ExtensionRequest'
import { StepView } from './StepView'
import { Gutter, ToolGroup } from './ToolRow'

function CopyAction({ text }: { text: string }) {
    const t = useT()
    const [copied, setCopied] = useState(false)
    return (
        <ActionBtn
            icon={copied ? Check : Copy}
            size="small"
            title={copied ? t.copied : t.copy}
            onClick={() => copyText(text, {
                format: 'text/plain',
                onCopy: () => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                },
            })}
        />
    )
}

/** Saved prompts (keyed by their session entry id) can be forked; live and pending ones not yet. */
const forkable = (entryId: string | undefined) => !!entryId && !entryId.startsWith('live-') && entryId !== 'pending'

/** Review feedback the user sent back: the picked items and the note, no fork or edit. */
const ReviewFeedbackBubble = observer(function ReviewFeedbackBubble({ user, review }: { user: UserPrompt, review: NonNullable<UserPrompt['review']> }) {
    const t = useT()
    const n = review.items.length
    const head = n ? tr(`交回 ${n} 条审查意见`, `Sent back ${n} review item${n === 1 ? '' : 's'}`) : tr('交回审查补充说明', 'Sent a review note')
    return (
        <div className="flex flex-col items-end pl-[15%]" title={user.timestamp ? t.dateTime(user.timestamp) : undefined}>
            <div className="min-w-0 max-w-full rounded-xl bg-ide-prompt px-3 py-1.5 text-[12.5px] leading-5 text-gray-900">
                <div className="text-gray-500">{review.round && review.round > 1 ? `${head} · Review ${review.round}` : head}</div>
                {review.items.map(item => (
                    <div key={item.id} className="flex min-w-0 gap-1.5">
                        <span className="shrink-0 font-mono text-gray-500">{item.id}</span>
                        <span className="min-w-0 truncate">{item.title}</span>
                    </div>
                ))}
                {user.text && <div className="mt-0.5 whitespace-pre-wrap break-words select-text">{user.text}</div>}
            </div>
        </div>
    )
})

/** A prompt autopilot sent in the user's place, or a card answer it relayed; labelled by its source. */
const AutopilotBubble = observer(function AutopilotBubble({ user, autopilot }: { user: UserPrompt, autopilot: NonNullable<UserPrompt['autopilot']> }) {
    const t = useT()
    return (
        <div className="flex flex-col items-end pl-[15%]" title={user.timestamp ? t.dateTime(user.timestamp) : undefined}>
            <div style={{ maxHeight: USER_BUBBLE_MAX_HEIGHT }} className="min-w-0 max-w-full overflow-y-auto rounded-xl bg-ide-prompt px-3 py-1.5 text-gray-900">
                <div className="flex h-5 items-center gap-1.5 text-[12px] text-gray-500">
                    <Plane size={11} className="shrink-0" />
                    <span>{t.apFrom[autopilot.from] ?? t.apFrom.supervisor}</span>
                    {autopilot.rules?.length ? <span className="font-mono text-[11.5px]">{autopilot.rules.join(' ')}</span> : null}
                </div>
                <div className="whitespace-pre-wrap break-words text-[length:var(--app-font-size)] leading-relaxed select-text">{user.text}</div>
            </div>
        </div>
    )
})

// User prompt: a right-aligned chat bubble; copy, fork and edit sit to its left on hover.
const UserBubble = observer(({ user, thread, entryId }: { user: UserPrompt, thread?: Thread, entryId?: string }) => {
    if (user.review)
        return <ReviewFeedbackBubble user={user} review={user.review} />
    if (user.autopilot)
        return <AutopilotBubble user={user} autopilot={user.autopilot} />
    return <PromptBubble user={user} thread={thread} entryId={entryId} />
})

const PromptBubble = observer(({ user, thread, entryId }: { user: UserPrompt, thread?: Thread, entryId?: string }) => {
    const t = useT()
    const bubbleRef = useRef<HTMLDivElement>(null)
    const [overflowing, setOverflowing] = useState(false)
    useLayoutEffect(() => {
        const el = bubbleRef.current
        setOverflowing(!!el && el.scrollHeight > el.clientHeight + 1)
    }, [user.text])
    return (
        <div className="group flex flex-col items-end gap-1.5 pl-[15%]" title={user.timestamp ? t.dateTime(user.timestamp) : undefined}>
            {user.images.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                    {user.images.map((_, i) => (
                        <ImageThumb key={i} images={user.images} index={i} alt="attached image" className="h-20 rounded-lg border border-gray-200 object-cover" />
                    ))}
                </div>
            )}
            {user.text && (
                <div className="flex max-w-full items-start gap-1">
                    <div className="flex shrink-0 gap-0.5 pt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {thread && thread.features.fork && forkable(entryId) && thread.sessionPath && (
                            <>
                                <ActionBtn icon={GitFork} size="small" title={t.forkHere} onClick={() => void appStore.forkThread(thread, entryId!, false)} />
                                {!thread.running && <ActionBtn icon={PencilLine} size="small" title={t.askAgain} onClick={() => void appStore.forkThread(thread, entryId!, true)} />}
                            </>
                        )}
                        <CopyAction text={user.text} />
                    </div>
                    {/* Long prompts (pasted logs, specs) scroll inside; focusable then, so the keyboard can scroll them too. */}
                    <div
                        ref={bubbleRef}
                        tabIndex={overflowing ? 0 : undefined}
                        style={{ maxHeight: USER_BUBBLE_MAX_HEIGHT }}
                        className={cn('min-w-0 overflow-y-auto rounded-xl bg-ide-prompt px-3 py-1.5 text-[length:var(--app-font-size)] leading-relaxed text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50', user.pending && 'opacity-60')}
                    >
                        <span className="whitespace-pre-wrap break-words select-text">{user.text}</span>
                    </div>
                </div>
            )}
        </div>
    )
})

/** Toggles a finished turn's fold; MessageList owns the open set because it changes the row list. */
export const TurnFoldContext = createContext<(turnKey: string) => void>(() => {})

/**
 * Codex-style fold over a finished turn's process: "› Ran 3 commands, edited 2 files +12 -3".
 * Also rendered pinned over the transcript while its open process scrolls by (MessageList).
 */
export function FoldRow({ row, onToggle }: { row: Extract<TranscriptRow, { kind: 'fold' }>, onToggle?: () => void }) {
    const t = useT()
    const toggleTurn = useContext(TurnFoldContext)
    const toggle = onToggle ?? (() => toggleTurn(row.turn.key))
    const s = useMemo(() => turnStats(row.steps), [row.steps])
    const parts: { key: string, text: string, extra?: React.ReactNode, className?: string }[] = []
    if (s.commands)
        parts.push({ key: 'commands', text: t.foldCommands(s.commands) })
    if (s.reads)
        parts.push({ key: 'reads', text: t.foldReads(s.reads) })
    if (s.searches)
        parts.push({ key: 'searches', text: t.foldSearches(s.searches) })
    if (s.other)
        parts.push({ key: 'other', text: t.foldOther(s.other) })
    if (s.edited) {
        parts.push({
            key: 'edited',
            text: t.foldEdited(s.edited),
            extra: (s.added > 0 || s.removed > 0) && (
                <span className="font-mono text-[12px]">
                    {' '}
                    <span className="text-emerald-600">{`+${s.added}`}</span>
                    {' '}
                    <span className="text-red-500">{`-${s.removed}`}</span>
                </span>
            ),
        })
    }
    const tools = parts.length > 0
    if (s.thinking)
        parts.push({ key: 'thought', text: s.thinkingMs !== undefined ? t.foldThoughtFor(t.elapsed(s.thinkingMs)) : t.foldThought })
    if (s.failed)
        parts.push({ key: 'failed', text: t.foldFailed(s.failed), className: 'text-red-500' })
    if (!parts.length)
        parts.push({ key: 'thought', text: t.foldThought })
    // Wall time of the folded process, from the prompt to its last step (thinking alone already says it).
    const span = tools && s.endedAt !== undefined && row.turn.startedAt ? s.endedAt - row.turn.startedAt : undefined
    return (
        <button
            type="button"
            onClick={toggle}
            aria-expanded={row.open}
            className="group/fold flex w-full min-w-0 gap-2 text-left"
        >
            <span aria-hidden className="flex h-6 w-3.5 shrink-0 items-center justify-center text-gray-400 group-hover/fold:text-gray-800">
                <ChevronRight size={12} strokeWidth={2.25} className={cn('transition-transform duration-150', row.open && 'rotate-90')} />
            </span>
            <span className="flex h-6 min-w-0 items-center text-[12.5px] text-gray-500 group-hover/fold:text-gray-800">
                <span className="truncate">
                    {parts.map((p, i) => (
                        <Fragment key={p.key}>
                            {i > 0 && t.foldSep}
                            <span className={p.className}>
                                {i === 0 ? t.foldCase(p.text) : p.text}
                                {p.extra}
                            </span>
                        </Fragment>
                    ))}
                    {span !== undefined && span > 0 && <span className="tabular-nums text-gray-400">{` · ${t.elapsed(span)}`}</span>}
                </span>
            </span>
        </button>
    )
}

const SPARKS = ['·', '✢', '✳', '✶', '✻', '✽']
const SPARK_FRAMES = [...SPARKS, ...SPARKS.slice(1, -1).reverse()]

/** Rough output size of a turn in tokens (chars / 4), like cc-tui's "↓ 1.2k tokens". */
function estimateTokens(steps: Step[]): number {
    let chars = 0
    for (const s of steps) {
        if (s.kind === 'text' || s.kind === 'thinking')
            chars += s.text.length
        else if (s.kind === 'tool')
            chars += JSON.stringify(s.call.arguments ?? {}).length
    }
    return Math.round(chars / 4)
}


/** One coloured slice of a token total: legend dot, label, count and share. */
interface Slice { key: string, label: string, value: number, dot: string, bar: string, accent?: string }

/** "Input 356,600" heading, a stacked bar and a legend row per slice. */
function TokenBreakdown({ label, total, slices }: { label: string, total: number, slices: Slice[] }) {
    const shown = slices.filter(s => s.value > 0)
    return (
        <section className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-4">
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</span>
                <span className="font-medium text-gray-900">{total.toLocaleString()}</span>
            </div>
            {total > 0 && shown.length > 1 && (
                <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-gray-100" aria-hidden>
                    {shown.map(s => <span key={s.key} className={s.bar} style={{ width: `${(s.value / total) * 100}%` }} />)}
                </div>
            )}
            <div className="grid grid-cols-[auto_1fr_auto_2.75rem] items-center gap-x-2 gap-y-0.5">
                {shown.map(s => (
                    <Fragment key={s.key}>
                        <span aria-hidden className={cn('size-2 rounded-full', s.dot)} />
                        <span className="text-gray-600">{s.label}</span>
                        <span className="text-right text-gray-800">{s.value.toLocaleString()}</span>
                        <span className={cn('text-right', s.accent ?? 'text-gray-400')}>{`${Math.round((s.value / total) * 100)}%`}</span>
                    </Fragment>
                ))}
            </div>
        </section>
    )
}

/** Hover card under a turn's footer: timing, cost, colour-coded token breakdown and models. */
function TurnDetails({ turn }: { turn: Turn }) {
    const t = useT()
    const usage = turn.usage
    const ms = turn.endedAt - turn.startedAt
    const input = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0
    const cachedPct = input && usage ? Math.round((usage.cacheRead / input) * 100) : 0
    const levels = usage?.thinkingLevels.filter(l => l !== 'off') ?? []
    return (
        <div className="flex flex-col gap-3 tabular-nums">
            <header className="flex flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[13px] font-medium text-gray-900">
                        {ms > 1000 ? t.workedFor(verbFor(t, turn.key)[1], t.duration(ms)) : t.done}
                    </span>
                    {usage && usage.cost > 0 && <span className="text-[13px] font-semibold text-gray-900">{formatCost(usage.cost)}</span>}
                </div>
                <span className="text-gray-500">
                    {t.dateTime(turn.endedAt)}
                    {usage?.requests ? ` · ${t.requests(usage.requests)}` : ''}
                </span>
            </header>
            {usage?.requests ? (
                <>
                    <TokenBreakdown
                        label={t.statInput}
                        total={input}
                        slices={[
                            { key: 'read', label: t.statCacheRead, value: usage.cacheRead, dot: 'bg-emerald-500', bar: 'bg-emerald-500', accent: 'font-medium text-emerald-600' },
                            { key: 'fresh', label: t.statFresh, value: usage.input, dot: 'bg-blue-500', bar: 'bg-blue-500' },
                            { key: 'write', label: t.statCacheWrite, value: usage.cacheWrite, dot: 'bg-amber-500', bar: 'bg-amber-500' },
                        ]}
                    />
                    <TokenBreakdown
                        label={t.statOutput}
                        total={usage.output}
                        slices={usage.reasoning
                            ? [
                                    { key: 'text', label: t.statText, value: Math.max(0, usage.output - usage.reasoning), dot: 'bg-gray-400', bar: 'bg-gray-400' },
                                    { key: 'thinking', label: t.statThinking, value: usage.reasoning, dot: 'bg-orange-400', bar: 'bg-orange-400' },
                                ]
                            : []}
                    />
                    {cachedPct > 0 && (
                        <div className="flex items-center gap-1.5 self-start rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11.5px] font-medium text-emerald-600">
                            <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                            {t.statCacheHit(cachedPct)}
                        </div>
                    )}
                </>
            ) : null}
            {usage && usage.models.length > 0 && (
                <footer className="flex flex-col gap-0.5 border-t border-gray-200 pt-2">
                    {usage.models.map(m => <span key={m} className="break-all font-mono text-[11.5px] text-gray-700">{m}</span>)}
                    {levels.length > 0 && (
                        <span className="self-start rounded bg-gray-100 px-1.5 font-mono text-[11px] text-gray-600">{levels.join(', ')}</span>
                    )}
                </footer>
            )}
        </div>
    )
}

/** Live "✶ Churning… (12s · ↓ 1.2k tokens)" line, cc-tui's working indicator. */
const RunningLine = observer(({ thread, turn }: { thread: Thread, turn: Turn }) => {
    const t = useT()
    const [frame, setFrame] = useState(0)
    useEffect(() => {
        const timer = setInterval(() => setFrame(f => f + 1), 120)
        return () => clearInterval(timer)
    }, [])
    const label = thread.compacting
        ? t.compacting
        : thread.retry
            ? t.retrying(thread.retry.attempt, thread.retry.maxAttempts)
            : thread.agentStatus === 'starting'
                ? t.starting
                : verbFor(t, turn.key)[0]
    const tokens = estimateTokens(turn.steps) + estimateTokens(thread.streamingSteps)
    const elapsed = t.duration(Date.now() - (thread.runStartedAt || Date.now()))
    // pi is blocked on the user: an ask form shows in its step, an extension request takes this slot.
    if (thread.waitingForUser)
        return <ExtensionRequest thread={thread} />
    return (
        <Gutter mark={SPARK_FRAMES[frame % SPARK_FRAMES.length]} markClassName="text-[#d7875f]">
            <div className="flex h-6 min-w-0 items-center gap-1.5 text-[13px]">
                <span className="shrink-0 text-[#e8956b]">{`${label}…`}</span>
                <span className="truncate text-gray-500 tabular-nums">
                    {`(${elapsed}${tokens ? ` · ↓ ${formatCount(tokens)} tokens` : ''}${turn.usage?.cost ? ` · ${formatCost(turn.usage.cost)}` : ''})`}
                    {thread.retry?.errorMessage && ` ${thread.retry.errorMessage}`}
                </span>
            </div>
        </Gutter>
    )
})

/** The spark animation frame, advancing every 120ms while mounted. */
function useSpark(): string {
    const [frame, setFrame] = useState(0)
    useEffect(() => {
        const timer = setInterval(() => setFrame(f => f + 1), 120)
        return () => clearInterval(timer)
    }, [])
    return SPARK_FRAMES[frame % SPARK_FRAMES.length]
}

/**
 * A subagent's working line, with the child's own numbers: time since it started and the tokens and
 * cost it reported. An approval one of its calls waits on takes the slot, as in the thread.
 */
const SubagentRunningLine = observer(({ thread, run, turn }: { thread: Thread, run: SubagentRun, turn: Turn }) => {
    const t = useT()
    const spark = useSpark()
    if (thread.subagentWaiting(run))
        return <ExtensionRequest thread={thread} />
    const d = run.details
    const elapsed = t.duration(Date.now() - (d?.startedAt ?? Date.now()))
    const label = d ? verbFor(t, turn.key)[0] : tr('启动中', 'Starting')
    return (
        <Gutter mark={spark} markClassName="text-[#d7875f]">
            <div className="flex h-6 min-w-0 items-center gap-1.5 text-[13px]">
                <span className="shrink-0 text-[#e8956b]">{`${label}…`}</span>
                <span className="truncate text-gray-500 tabular-nums">
                    {`(${elapsed}${d?.usage.output ? ` · ↓ ${formatCount(d.usage.output)} tokens` : ''}${d?.usage.cost ? ` · ${formatCost(d.usage.cost)}` : ''})`}
                </span>
            </div>
        </Gutter>
    )
})

/** Steps of the message currently streaming; observes only thread.streaming. */
const StreamingSteps = observer(({ thread }: { thread: Thread }) => (
    <>
        {thread.streamingSteps.map(step => <StepView key={step.key} step={step} />)}
    </>
))

/** One virtualized transcript row; spacing reproduces the old per-turn layout (gap 12px, 24px between turns). */
/** `subagent`: the row is from that child's transcript (no fork actions; its own working line). */
export const TranscriptRowView = memo(({ row, thread, subagent, top }: { row: TranscriptRow, thread: Thread, subagent?: SubagentRun, top: boolean }) => {
    const t = useT()
    const pad = row.first && !top ? 'pt-6' : 'pt-3'
    switch (row.kind) {
        case 'user':
            return <div className={pad}><UserBubble user={row.user} thread={subagent ? undefined : thread} entryId={row.turn.key} /></div>
        case 'fold':
            return <div className={pad}><FoldRow row={row} /></div>
        case 'item':
            return (
                <div className={pad}>
                    {row.item.kind === 'group' ? <ToolGroup steps={row.item.steps} /> : <StepView step={row.item.step} />}
                </div>
            )
        case 'live':
            // A child's streaming message is already among its turns' steps.
            if (subagent)
                return <div className={pad}><SubagentRunningLine thread={thread} run={subagent} turn={row.turn} /></div>
            return (
                <div className={cn(pad, 'flex flex-col gap-3')}>
                    <StreamingSteps thread={thread} />
                    <RunningLine thread={thread} turn={row.turn} />
                </div>
            )
        case 'footer': {
            // cc-tui's closing entry, trimmed to "✻ Worked for 3m 12s · $0.12"; the rest lives in a hover card.
            const { turn } = row
            const ms = turn.endedAt - turn.startedAt
            const cost = turn.usage?.cost ?? 0
            return (
                <div className={cn(pad, 'group/turn')}>
                    <Gutter mark="✻" markClassName="text-gray-400">
                        <div className="flex min-h-6 flex-wrap items-center gap-x-1 text-[12.5px] leading-6 text-gray-500 tabular-nums">
                            <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span tabIndex={0} className="cursor-default rounded-sm outline-none hover:text-gray-800 focus-visible:ring-1 focus-visible:ring-gray-400">
                                            {ms > 1000 ? t.workedFor(verbFor(t, turn.key)[1], t.duration(ms)) : t.doneAt(t.clock(turn.endedAt))}
                                            {cost > 0 && <span>{` · ${formatCost(cost)}`}</span>}
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" align="start" className="w-[300px] rounded-lg p-3">
                                        <TurnDetails turn={turn} />
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                            <ReviewControl thread={thread} turnKey={turn.key} />
                            {row.finalText && (
                                <span className="flex h-6 items-center opacity-0 transition-opacity group-hover/turn:opacity-100">
                                    <CopyAction text={row.finalText} />
                                </span>
                            )}
                        </div>
                    </Gutter>
                </div>
            )
        }
    }
})
