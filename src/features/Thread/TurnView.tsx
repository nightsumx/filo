import type { Step, Turn, UserPrompt } from '@/lib/timeline'
import type { Thread } from '@/store/thread'
import { ActionBtn } from '@/components/ActionBtn'
import { groupSteps } from '@/lib/timeline'
import { useT, verbFor } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import copyText from 'copy-to-clipboard'
import { Check, Copy } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { memo, useEffect, useState } from 'react'
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

// User prompt: a full-width block, like the highlighted prompt line in a JetBrains terminal / AI chat.
function UserBubble({ user }: { user: UserPrompt }) {
    return (
        <div className="group relative flex flex-col gap-2 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-100">
            {user.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {user.images.map((img, i) => (
                        <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="attached image" className="h-20 rounded-md border border-gray-200 object-cover" />
                    ))}
                </div>
            )}
            {user.text && (
                <div className={cn('flex gap-2 text-[length:var(--app-font-size)] leading-relaxed', user.pending && 'opacity-60')}>
                    <span aria-hidden className="shrink-0 select-none font-mono font-semibold text-ide-accent">❯</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-gray-900 select-text">{user.text}</span>
                </div>
            )}
            <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100">
                <CopyAction text={user.text} />
            </div>
        </div>
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
    // pi is blocked on the user (ask form, dialog); the waiting step says so, a spinner would not.
    if (thread.waitingForUser)
        return null
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

export const TurnView = memo(({ turn, thread, isLast }: { turn: Turn, thread: Thread, isLast: boolean }) => {
    const t = useT()
    const items = groupSteps(turn.steps)
    const finalText = turn.steps.filter(s => s.kind === 'text').map(s => (s as { text: string }).text).slice(-1).join('')
    const ms = turn.endedAt - turn.startedAt
    const hasWork = turn.steps.some(s => s.kind === 'tool' || s.kind === 'text' || s.kind === 'thinking')

    return (
        <div className="group/turn flex flex-col gap-3 py-3">
            {turn.user && <UserBubble user={turn.user} />}
            {items.map(item => item.kind === 'group'
                ? <ToolGroup key={item.key} steps={item.steps} />
                : <StepView key={item.step.key} step={item.step} />)}
            {isLast && turn.running && (
                <>
                    <StreamingSteps thread={thread} />
                    <RunningLine thread={thread} turn={turn} />
                </>
            )}
            {!turn.running && turn.user && hasWork && (
                // cc-tui's closing entry: "✻ Worked for 3m 12s · done 4:12 PM".
                <Gutter mark="✻" markClassName="text-gray-400">
                    <div className="flex h-6 items-center gap-2 text-[12.5px] text-gray-500">
                        <span>{ms > 1000 ? t.workedFor(verbFor(t, turn.key)[1], t.duration(ms), t.clock(turn.endedAt)) : t.doneAt(t.clock(turn.endedAt))}</span>
                        {finalText && (
                            <span className="opacity-0 transition-opacity group-hover/turn:opacity-100">
                                <CopyAction text={finalText} />
                            </span>
                        )}
                    </div>
                </Gutter>
            )}
        </div>
    )
})
