import type { Step, Turn, UserPrompt } from '@/lib/timeline'
import type { TranscriptRow } from '@/lib/transcriptRows'
import type { Thread } from '@/store/thread'
import { ActionBtn } from '@/components/ActionBtn'
import { useT, verbFor } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
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
    return (
        <div className="group flex flex-col items-end gap-1.5 pl-[15%]">
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
    if (s.failed)
        parts.push({ key: 'failed', text: t.foldFailed(s.failed), className: 'text-red-500' })
    if (!parts.length)
        parts.push({ key: 'thought', text: t.foldThought })
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

function formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
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
                    {`(${elapsed}${tokens ? ` · ↓ ${formatTokens(tokens)} tokens` : ''})`}
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
                        <div className="flex h-6 items-center gap-2 text-[12.5px] text-gray-500">
                            <span>{ms > 1000 ? t.workedFor(verbFor(t, turn.key)[1], t.duration(ms), t.clock(turn.endedAt)) : t.doneAt(t.clock(turn.endedAt))}</span>
                            {row.finalText && (
                                <span className="opacity-0 transition-opacity group-hover/turn:opacity-100">
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
