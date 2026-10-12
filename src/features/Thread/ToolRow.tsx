// Tool calls rendered like pi's TUI with pi-cc-extensions:
//   ✓ Edit src/app.ts
//     ↳ diff +15 -35 split [━━━━━━━━]
//     <diff, first 24 rows>  … 117 more · click to expand
// Other tools show a one-line "↳ 12 lines returned" result and expand into Input / Output sections;
// bash keeps the last lines of its output under it, running or done, as pi's TUI does; a running call
// expands too, to read its whole output so far.
import type { ImageContent, TextContent, ToolCall } from '@shared/pi'
import type { DiffModel } from '@/lib/diffModel'
import type { Step, ToolResultView } from '@/lib/timeline'
import { ImageThumb } from '@/components/ImageView'
import { TermLines } from '@/components/TermLines'
import { TuiDiff } from '@/components/TuiDiff'
import { diffFromContent, diffFromEdits, diffFromPatch } from '@/lib/diffModel'
import { displayText, headCount, tailLines } from '@/lib/termOutput'
import { formatToolInput, tuiSummary, tuiTitle } from '@/lib/toolMeta'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import { useThread } from './ThreadContext'
import { useViewState } from './viewState'
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'

/** Thread cwd, so absolute paths in tool calls print relative like the TUI. */
export const CwdContext = createContext<string | undefined>(undefined)

const OUTPUT_LIMIT = 50_000
const EDIT_COLLAPSED_ROWS = 24
const INPUT_PREVIEW_LINES = 5
const OUTPUT_PREVIEW_LINES = 10
const SPLIT_MIN_WIDTH = 760
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type ToolStep = Extract<Step, { kind: 'tool' }>
type Status = 'running' | 'success' | 'error'

function resultText(result?: ToolResultView): string {
    // ANSI colors and \r stripped, as pi's TUI shows tool output.
    const text = displayText((result?.content ?? []).filter((c): c is TextContent => c.type === 'text').map(c => c.text).join('\n'))
    return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… ${text.length - OUTPUT_LIMIT} more chars truncated` : text
}

function resultImages(result?: ToolResultView): ImageContent[] {
    return (result?.content ?? []).filter((c): c is ImageContent => c.type === 'image')
}

function lineCount(text: string): number {
    const t = text.replace(/\n+$/, '')
    return t ? t.split('\n').length : 0
}

function statusOf(step: { result?: ToolResultView, running: boolean }): Status {
    if (step.result?.isError)
        return 'error'
    if (step.running)
        return 'running'
    return 'success'
}

/** Braille spinner the TUI uses for pending tools. */
export function Spinner({ className }: { className?: string }) {
    const t = useT()
    const [frame, setFrame] = useState(0)
    useEffect(() => {
        const timer = setInterval(() => setFrame(f => (f + 1) % BRAILLE.length), 80)
        return () => clearInterval(timer)
    }, [])
    return <span aria-label={t.running} className={className}>{BRAILLE[frame]}</span>
}

export function StatusMark({ status }: { status: Status }) {
    const t = useT()
    if (status === 'running')
        return <Spinner className="text-ide-accent" />
    return status === 'error'
        ? <span className="text-red-500" aria-label={t.failed}>✗</span>
        : <span className="text-ide-success" aria-label={t.done}>✓</span>
}

/** Fixed-width column on the left holding ●, ✓, ✗, ❯ … so content lines up like terminal output. */
export function Gutter({ mark, children, className, markClassName }: { mark?: React.ReactNode, children: React.ReactNode, className?: string, markClassName?: string }) {
    return (
        <div className={cn('flex gap-2', className)}>
            <div aria-hidden={typeof mark === 'string' || undefined} className={cn('flex h-6 w-3.5 shrink-0 select-none items-center justify-center font-mono text-[12.5px]', markClassName)}>{mark}</div>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    )
}

function useWidth<T extends HTMLElement>() {
    const ref = useRef<T>(null)
    const [width, setWidth] = useState(0)
    useLayoutEffect(() => {
        const el = ref.current
        if (!el)
            return
        setWidth(el.clientWidth)
        const ro = new ResizeObserver(() => setWidth(el.clientWidth))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])
    return [ref, width] as const
}

/** "[━━━━━━━━]" green/red proportion meter from the TUI's diff header. */
function StatBar({ added, removed }: { added: number, removed: number }) {
    const total = added + removed
    if (!total)
        return null
    const slots = 12
    let plus = Math.round((added / total) * slots)
    if (added > 0 && plus === 0)
        plus = 1
    if (removed > 0 && plus >= slots)
        plus = slots - 1
    return (
        <span className="font-mono text-gray-400">
            [
            <span className="text-emerald-500">{'━'.repeat(plus)}</span>
            <span className="text-red-500">{'━'.repeat(slots - plus)}</span>
            ]
        </span>
    )
}

function Delta({ added, removed }: { added: number, removed: number }) {
    return (
        <span className="font-mono">
            <span className="text-emerald-600">{`+${added}`}</span>
            {' '}
            <span className="text-red-500">{`-${removed}`}</span>
        </span>
    )
}

/** One Input / Output section of an expanded tool: tree branch, label, clipped mono body. */
function IoSection({ id, label, body, last, maxLines, error, fullPath }: { id: string, label: string, body: string, last: boolean, maxLines: number, error?: boolean, fullPath?: string }) {
    const t = useT()
    const cwd = useContext(CwdContext)
    const [full, setFull] = useViewState(id, false)
    const lines = body.replace(/\n+$/, '').split('\n')
    const head = headCount(lines, maxLines)
    const clipped = !full && lines.length > head
    const shown = clipped ? lines.slice(0, head) : lines
    return (
        <div>
            <div className="flex items-center gap-2 text-gray-500">
                <span className="text-gray-400">{last ? '└' : '├'}</span>
                <span className="font-medium text-gray-700">{label}</span>
                {lines.length > head && (
                    <button type="button" onClick={() => setFull(v => !v)} className="font-sans text-[12px] text-gray-400 hover:text-gray-900">
                        {full ? t.showLess : t.showAll(lines.length)}
                    </button>
                )}
                {/* pi kept only the end of a long output; the rest is in this file. */}
                {fullPath && cwd && (
                    <button type="button" onClick={() => appStore.openFile(fullPath, cwd)} className="font-sans text-[12px] text-gray-400 hover:text-gray-900">
                        {tr('打开完整输出', 'open full output')}
                    </button>
                )}
            </div>
            <div className={cn('flex', !last && 'border-l border-gray-300/70', 'ml-[3px]')}>
                <pre className={cn('min-w-0 flex-1 whitespace-pre-wrap break-all py-0.5 pl-3.5 select-text', full && 'max-h-[480px] overflow-y-auto', error ? 'text-red-600' : 'text-gray-700')}>
                    {shown.join('\n') ? <TermLines lines={shown} /> : <span className="font-sans text-gray-400">{t.empty}</span>}
                    {clipped && (
                        <button type="button" onClick={() => setFull(true)} className="block font-sans text-gray-400 hover:text-gray-900">
                            {`${t.moreLines(lines.length - head)} · ${t.expand}`}
                        </button>
                    )}
                </pre>
            </div>
        </div>
    )
}

function IoPanel({ call, output, error, fullPath }: { call: ToolCall, output: string, error: boolean, fullPath?: string }) {
    const input = formatToolInput(call.arguments)
    return (
        <div className="mt-1 flex flex-col gap-1 rounded-md bg-ide-block px-3 py-2 font-mono text-[12px]">
            {input && <IoSection id={`io:${call.id}:in`} label="Input" body={input} last={false} maxLines={INPUT_PREVIEW_LINES} />}
            <IoSection id={`io:${call.id}:out`} label="Output" body={output} last maxLines={OUTPUT_PREVIEW_LINES} error={error} fullPath={fullPath} />
        </div>
    )
}

function editDiff(call: ToolCall, result?: ToolResultView): DiffModel | null {
    const patch = result?.details?.patch
    if (typeof patch === 'string' && patch) {
        const model = diffFromPatch(patch)
        if (model)
            return model
    }
    const args = call.arguments ?? {}
    const edits = Array.isArray(args.edits)
        ? args.edits
        : args.oldText != null || args.newText != null ? [{ oldText: args.oldText, newText: args.newText }] : []
    return edits.length ? diffFromEdits(edits) : null
}

/** Re-renders every second while `active`; returns the current time. */
export function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        if (!active)
            return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [active])
    return now
}

/** " · 2.4s" after a tool's result line: execution time, ticking while it runs. */
function ToolTime({ running, startedAt, ms }: { running: boolean, startedAt?: number, ms?: number }) {
    const t = useT()
    const now = useNow(running && startedAt !== undefined)
    const value = running ? (startedAt !== undefined ? now - startedAt : undefined) : ms
    if (value === undefined || (running && value < 1000))
        return null
    return <span className="tabular-nums text-gray-400">{` · ${running ? t.duration(value) : t.elapsed(value)}`}</span>
}

/** "Running…", or that the call waits on an approval prompt (shown under the transcript). */
const PendingLabel = observer(({ toolCallId }: { toolCallId: string }) => {
    const t = useT()
    const thread = useThread()
    if (thread?.approvalFor(toolCallId))
        return <span className="text-amber-600 dark:text-amber-400">{tr('等你确认', 'awaiting approval')}</span>
    return <span className="text-gray-500">{t.pending}</span>
})

/**
 * Last lines of a command's output, so long builds are not a silent spinner. Kept once it finishes
 * (pi's TUI shows the same five lines): dropping them then made the transcript jump while it streamed.
 * A QR code the tail cuts into is shown whole (tailLines).
 */
function OutputTail({ text }: { text: string }) {
    const lines = tailLines(text)
    if (!lines.length)
        return null
    return <pre className="mt-0.5 whitespace-pre-wrap break-all pl-4 font-mono text-[12px] text-gray-400 select-text"><TermLines lines={lines} /></pre>
}

/** pi's "[Showing lines … Full output: <path>]" note under truncated output; the tail leaves it out, like pi's TUI. */
function withoutTruncationNote(text: string, result?: ToolResultView): string {
    const path = result?.details?.fullOutputPath
    const at = text.lastIndexOf('\n\n[')
    return typeof path === 'string' && at !== -1 && text.trimEnd().endsWith(']') && text.slice(at).includes(path) ? text.slice(0, at) : text
}

/**
 * `action`: a small control at the end of the result line; `label`: what the call line shows instead
 * of its arguments (terminal tools: the terminal's name, not its id).
 */
export const ToolRow = memo(({ call, result, running, startedAt, ms, action, label }: { call: ToolCall, result?: ToolResultView, running: boolean, startedAt?: number, ms?: number, action?: React.ReactNode, label?: string }) => {
    const cwd = useContext(CwdContext)
    const t = useT()
    const [expanded, setExpanded] = useViewState(`tool:${call.id}`, false)
    const [bodyRef, width] = useWidth<HTMLDivElement>()
    const status = statusOf({ result, running })
    const failed = status === 'error'
    const output = resultText(result)
    const images = resultImages(result)
    const summary = tuiSummary(call.name, call.arguments, cwd)
    const { main, detail } = label ? { main: label, detail: '' } : summary
    const name = call.name
    const path = String(call.arguments?.path ?? call.arguments?.file_path ?? '')

    const diff = useMemo(() => {
        if (status !== 'success')
            return null
        if (name === 'edit')
            return editDiff(call, result)
        if (name === 'write' && typeof call.arguments?.content === 'string')
            return diffFromContent(call.arguments.content.slice(0, OUTPUT_LIMIT))
        return null
    }, [status, name, call, result])
    const mode = diff && diff.added > 0 && diff.removed > 0 && width >= SPLIT_MIN_WIDTH ? 'split' : 'unified'

    const toggle = () => setExpanded(v => !v)
    const time = <ToolTime running={status === 'running'} startedAt={startedAt} ms={ms} />
    const hint = <span className="text-gray-400 group-hover/res:text-gray-800">{` · ${expanded ? t.collapse : t.expand}`}</span>

    let resultLine: React.ReactNode
    if (status === 'running') {
        resultLine = (
            <>
                <PendingLabel toolCallId={call.id} />
                {time}
                {(output || formatToolInput(call.arguments)) && hint}
            </>
        )
    }
    else if (failed) {
        const first = output.trim().split('\n')[0] || t.failed
        resultLine = (
            <>
                <span className="text-red-500">{first.length > 160 ? `${first.slice(0, 160)}…` : first}</span>
                {time}
                {hint}
            </>
        )
    }
    else if (diff && name === 'edit') {
        resultLine = (
            <>
                <span className="font-mono font-semibold text-gray-700">diff</span>
                {' '}
                <Delta added={diff.added} removed={diff.removed} />
                {' '}
                <span className="font-mono text-gray-500">{mode}</span>
                {' '}
                <StatBar added={diff.added} removed={diff.removed} />
                {time}
            </>
        )
    }
    else if (diff && name === 'write') {
        resultLine = (
            <>
                <span className="text-gray-500">{t.linesWritten(diff.added)}</span>
                {time}
                {hint}
            </>
        )
    }
    else {
        const n = lineCount(output)

        resultLine = (
            <>
                <span className="text-gray-500">{n ? (name === 'read' ? t.linesLoaded(n) : t.linesReturned(n)) : t.done}</span>
                {time}
                {(n > 0 || formatToolInput(call.arguments)) && hint}
            </>
        )
    }

    return (
        <Gutter mark={<StatusMark status={status} />}>
            <div ref={bodyRef} className="font-mono text-[12.5px]">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={expanded}
                    className="flex h-6 w-full min-w-0 items-center gap-1.5 text-left"
                >
                    <span className={cn('shrink-0 font-semibold', failed ? 'text-red-600' : 'text-gray-900')}>{tuiTitle(name)}</span>
                    <span className="min-w-0 truncate text-gray-700">
                        {main}
                        {detail && <span className="text-gray-400">{detail}</span>}
                    </span>
                    {diff && name === 'write' && (
                        <span className="shrink-0 text-gray-400">
                            (
                            <Delta added={diff.added} removed={0} />
                            )
                        </span>
                    )}
                </button>
                <div className="flex items-start gap-2">
                    <button type="button" onClick={toggle} className="group/res flex min-h-[22px] min-w-0 flex-1 items-start gap-1.5 text-left leading-[22px]">
                        <span className="shrink-0 select-none text-gray-400">↳</span>
                        {/* CJK labels read better in the UI font; numbers and meters stay mono. */}
                        <span className="min-w-0 font-sans text-[12.5px] [overflow-wrap:anywhere]">{resultLine}</span>
                    </button>
                    {action}
                </div>
                {name === 'bash' && !expanded && <OutputTail text={withoutTruncationNote(output, result)} />}
                {diff && name === 'edit' && (
                    <div className="mt-1">
                        <TuiDiff model={diff} path={path} mode={mode} limit={expanded ? undefined : EDIT_COLLAPSED_ROWS} onShowMore={() => setExpanded(true)} />
                    </div>
                )}
                {diff && name === 'write' && expanded && (
                    <div className="mt-1">
                        <TuiDiff model={diff} path={path} mode="unified" />
                    </div>
                )}
                {expanded && !diff && <IoPanel call={call} output={output} error={failed} fullPath={typeof result?.details?.fullOutputPath === 'string' ? result.details.fullOutputPath : undefined} />}
                {images.map((_, i) => (
                    <div key={i} className="mt-1">
                        <ImageThumb images={images} index={i} alt="" className="max-h-80 w-fit rounded-md" />
                    </div>
                ))}
            </div>
        </Gutter>
    )
})

/** "● Bash: 3 done · click to expand" card over a run of read-only tool calls. */
export const ToolGroup = memo(({ steps }: { steps: ToolStep[] }) => {
    const cwd = useContext(CwdContext)
    const t = useT()
    const [expanded, setExpanded] = useViewState(`group:${steps[0].call.id}`, false)
    const statuses = steps.map(statusOf)
    const counts = { running: 0, success: 0, error: 0 }
    statuses.forEach(s => counts[s]++)
    const overall: Status = counts.error ? 'error' : counts.running ? 'running' : 'success'
    const names = [...new Set(steps.map(s => s.call.name))]
    const label = names.length === 1 ? tuiTitle(names[0]) : t.multipleTools
    const nameList = names.length > 1
        ? names.map((n) => {
                const c = steps.filter(s => s.call.name === n).length
                return `${n}${c > 1 ? `×${c}` : ''}`
            }).join(', ')
        : ''
    const countParts = ([['running', t.running, 'text-ide-accent'], ['success', t.doneCount, 'text-ide-success'], ['error', t.failedCount, 'text-red-500']] as const)
        .filter(([k]) => counts[k] > 0)

    return (
        <Gutter mark={<span className={overall === 'error' ? 'text-red-500' : overall === 'running' ? 'text-ide-accent' : 'text-ide-success'}>●</span>}>
            <div className="font-mono text-[12.5px]">
                <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} className="group/res flex h-6 w-full min-w-0 items-center gap-1 text-left">
                    <span className="shrink-0 font-semibold text-gray-900">{`${label}:`}</span>
                    <span className="min-w-0 truncate font-sans text-[12.5px] text-gray-500">
                        {countParts.map(([k, text, color], i) => (
                            <span key={k}>
                                {i > 0 && <span className="text-gray-400"> · </span>}
                                <span className={color}>{counts[k]}</span>
                                {` ${text}`}
                            </span>
                        ))}
                        {nameList && <span className="font-mono text-gray-400">{` · ${nameList}`}</span>}
                        <span className="text-gray-400 group-hover/res:text-gray-800">{` · ${expanded ? t.collapse : t.expand}`}</span>
                    </span>
                </button>
                {expanded
                    ? (
                            <div className="mt-1 flex flex-col gap-1.5 rounded-md bg-ide-block py-2 pl-1 pr-3">
                                {steps.map(step => <ToolRow key={step.key} call={step.call} result={step.result} running={step.running} startedAt={step.startedAt} ms={step.ms} />)}
                            </div>
                        )
                    : (
                            <div className="flex flex-col">
                                {steps.map((step, i) => {
                                    const { main, detail } = tuiSummary(step.call.name, step.call.arguments, cwd)
                                    return (
                                        <button key={step.key} type="button" onClick={() => setExpanded(true)} className="flex h-[22px] min-w-0 items-center gap-1.5 text-left">
                                            <span className="shrink-0 select-none text-gray-400">{i === steps.length - 1 ? '└' : '├'}</span>
                                            <span className="w-3 shrink-0 text-center"><StatusMark status={statuses[i]} /></span>
                                            <span className="shrink-0 text-gray-800">{tuiTitle(step.call.name)}</span>
                                            <span className="min-w-0 truncate text-gray-500">
                                                {main}
                                                {detail}
                                            </span>
                                            <span className="shrink-0 font-sans text-[12px]">
                                                <ToolTime running={step.running} startedAt={step.startedAt} ms={step.ms} />
                                            </span>
                                        </button>
                                    )
                                })}
                            </div>
                        )}
            </div>
        </Gutter>
    )
})
