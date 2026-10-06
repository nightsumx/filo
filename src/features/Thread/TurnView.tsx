import type { Step, Turn, UserPrompt } from '@/lib/timeline'
import type { TranscriptRow } from '@/lib/transcriptRows'
import type { Thread } from '@/store/thread'
import { ActionBtn } from '@/components/ActionBtn'
import { useT, verbFor } from '@/lib/transcriptText'
import { cn, formatCost, formatCount } from '@/lib/utils'
import copyText from 'copy-to-clipboard'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { turnStats } from '@/lib/turnSummary'
import { createContext, Fragment, memo, useContext, useEffect, useMemo, useState } from 'react'
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

// User prompt: a right-aligned chat bubble; the copy action sits to its left on hover.
function UserBubble({ user }: { user: UserPrompt }) {
    const t = useT()
    return (
        <div className="group flex flex-col items-end gap-1.5 pl-[15%]" title={user.timestamp ? t.dateTime(user.timestamp) : undefined}>
            {user.images.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                    {user.images.map((img, i) => (
                        <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="attached image" className="h-20 rounded-lg border border-gray-200 object-cover" />
                    ))}
                </div>
            )}
            {user.text && (
                <div className="flex max-w-full items-start gap-1">
                    <div className="shrink-0 pt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <CopyAction text={user.text} />
                    </div>
                    <div className={cn('min-w-0 rounded-xl bg-ide-prompt px-3 py-1.5 text-[length:var(--app-font-size)] leading-relaxed text-gray-900', user.pending && 'opacity-60')}>
                        <span className="whitespace-pre-wrap break-words select-text">{user.text}</span>
                    </div>
                </div>
            )}
        </div>
    )
}

/** Toggles a finished turn's fold; MessageList owns the open set because it changes the row list. */
export const TurnFoldContext = createContext<(turnKey: string) => void>(() => {})

/** Codex-style fold over a finished turn's process: "› Ran 3 commands, edited 2 files +12 -3". */
function FoldRow({ row }: { row: Extract<TranscriptRow, { kind: 'fold' }> }) {
    const t = useT()
    const toggle = useContext(TurnFoldContext)
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
            onClick={() => toggle(row.turn.key)}
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


/** "6 requests · ↑ 52.1k ↓ 3.2k · 89% cached · $0.12 · claude-opus-5-5 (high)" for a turn's footer. */
function UsageParts({ usage }: { usage: NonNullable<Turn['usage']> }) {
    const t = useT()
    if (!usage.requests)
        return null
    const input = usage.input + usage.cacheRead + usage.cacheWrite
    const cachedPct = input ? Math.round((usage.cacheRead / input) * 100) : 0
    const parts: { key: string, node: React.ReactNode, title?: string }[] = [
        { key: 'requests', node: t.requests(usage.requests) },
        {
            key: 'tokens',
            node: `↑ ${formatCount(input)} ↓ ${formatCount(usage.output)}${usage.reasoning ? ` (${t.reasoningTokens(formatCount(usage.reasoning))})` : ''}`,
            title: `${t.tokensIn}: ${input.toLocaleString()} (input ${usage.input.toLocaleString()}, cache read ${usage.cacheRead.toLocaleString()}, cache write ${usage.cacheWrite.toLocaleString()})\n${t.tokensOut}: ${usage.output.toLocaleString()}`,
        },
    ]
    if (cachedPct)
        parts.push({ key: 'cache', node: t.cached(cachedPct) })
    if (usage.cost > 0)
        parts.push({ key: 'cost', node: formatCost(usage.cost) })
    if (usage.models.length) {
        const levels = usage.thinkingLevels.filter(l => l !== 'off')
        parts.push({
            key: 'model',
            node: `${usage.models.map(m => m.split('/').pop()).join(', ')}${levels.length ? ` (${levels.join(', ')})` : ''}`,
            title: usage.models.join('\n'),
        })
    }
    return (
        <>
            {parts.map(p => (
                <span key={p.key} title={p.title} className="whitespace-nowrap">
                    <span className="text-gray-400">· </span>
                    {p.node}
                </span>
            ))}
        </>
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

/** Steps of the message currently streaming; observes only thread.streaming. */
const StreamingSteps = observer(({ thread }: { thread: Thread }) => (
    <>
        {thread.streamingSteps.map(step => <StepView key={step.key} step={step} />)}
    </>
))

/** One virtualized transcript row; spacing reproduces the old per-turn layout (gap 12px, 24px between turns). */
export const TranscriptRowView = memo(({ row, thread, top }: { row: TranscriptRow, thread: Thread, top: boolean }) => {
    const t = useT()
    const pad = row.first && !top ? 'pt-6' : 'pt-3'
    switch (row.kind) {
        case 'user':
            return <div className={pad}><UserBubble user={row.user} /></div>
        case 'fold':
            return <div className={pad}><FoldRow row={row} /></div>
        case 'item':
            return (
                <div className={pad}>
                    {row.item.kind === 'group' ? <ToolGroup steps={row.item.steps} /> : <StepView step={row.item.step} />}
                </div>
            )
        case 'live':
            return (
                <div className={cn(pad, 'flex flex-col gap-3')}>
                    <StreamingSteps thread={thread} />
                    <RunningLine thread={thread} turn={row.turn} />
                </div>
            )
        case 'footer': {
            // cc-tui's closing entry: "✻ Worked for 3m 12s · done 4:12 PM".
            const { turn } = row
            const ms = turn.endedAt - turn.startedAt
            return (
                <div className={cn(pad, 'group/turn')}>
                    <Gutter mark="✻" markClassName="text-gray-400">
                        <div className="flex min-h-6 flex-wrap items-center gap-x-1 text-[12.5px] leading-6 text-gray-500 tabular-nums">
                            <span title={t.dateTime(turn.endedAt)}>{ms > 1000 ? t.workedFor(verbFor(t, turn.key)[1], t.duration(ms), t.clock(turn.endedAt)) : t.doneAt(t.clock(turn.endedAt))}</span>
                            {turn.usage && <UsageParts usage={turn.usage} />}
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
