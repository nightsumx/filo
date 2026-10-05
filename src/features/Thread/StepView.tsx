import type { Step } from '@/lib/timeline'
import { Markdown } from '@/components/Markdown'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { Archive, GitBranch, Puzzle } from 'lucide-react'
import { memo, useState } from 'react'
import { Gutter, ToolRow } from './ToolRow'

// Thinking is printed inline in dim italics, the way pi's TUI shows it, rather than behind a toggle.
const ThinkingBlock = memo(({ text, streaming, redacted }: { text: string, streaming: boolean, redacted: boolean }) => {
    const t = useT()
    if (redacted || !text) {
        return (
            <Gutter>
                <div className={cn('flex h-6 items-center text-[13px] italic text-gray-500', streaming && 'text-shimmer')}>
                    {redacted ? t.thinkingRedacted : t.thinking}
                </div>
            </Gutter>
        )
    }
    return (
        <Gutter>
            <Markdown content={text} streaming={streaming} className="italic !text-gray-500 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:not-italic" />
        </Gutter>
    )
})

/** User-run `!command`: `$ command` then its output, clipped like a tool result. */
function BashExecution({ message }: { message: Extract<Step, { kind: 'bash' }>['message'] }) {
    const t = useT()
    const [full, setFull] = useState(false)
    const lines = (message.output ?? '').replace(/\n+$/, '').split('\n')
    const clipped = !full && lines.length > 10
    const failed = message.exitCode != null && message.exitCode !== 0
    return (
        <Gutter mark="$" markClassName="text-ide-accent">
            <div className="font-mono text-[12.5px]">
                <div className="flex min-h-6 items-center gap-2 py-0.5">
                    <span className="min-w-0 whitespace-pre-wrap break-all font-semibold text-gray-900 select-text">{message.command}</span>
                    {failed && <span className="shrink-0 text-red-500">{t.exitCode(message.exitCode!)}</span>}
                </div>
                {message.output && (
                    <div className="mt-0.5 rounded-md bg-[var(--bg-side)] px-3 py-2 text-[12px] dark:border dark:border-gray-100">
                        <pre className={cn('whitespace-pre-wrap break-all text-gray-700 select-text', full && 'max-h-[480px] overflow-y-auto')}>
                            {clipped ? lines.slice(0, 10).join('\n') : lines.join('\n')}
                        </pre>
                        {lines.length > 10 && (
                            <button type="button" onClick={() => setFull(v => !v)} className="mt-1 font-sans text-gray-400 hover:text-gray-900">
                                {full ? t.showLess : `${t.moreLines(lines.length - 10)} · ${t.expand}`}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </Gutter>
    )
}

function NoteBlock({ variant, title: customTitle, text }: { variant: 'compaction' | 'branch' | 'custom', title: string, text: string }) {
    const t = useT()
    const title = variant === 'compaction' ? t.compacted : variant === 'branch' ? t.branchSummary : customTitle
    const [open, setOpen] = useState(false)
    const Icon = variant === 'compaction' ? Archive : variant === 'branch' ? GitBranch : Puzzle
    return (
        <div className="my-1">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 text-[12px] text-gray-500 hover:text-gray-800"
            >
                <span className="h-px flex-1 bg-ide-line" />
                <Icon size={12} />
                <span>{title}</span>
                <span className="h-px flex-1 bg-ide-line" />
            </button>
            {open && text && (
                <div className="mt-2 rounded-md bg-[var(--bg-side)] px-3 py-2 text-[13px] text-gray-700">
                    <Markdown content={text} />
                </div>
            )}
        </div>
    )
}

export const StepView = memo(({ step }: { step: Step }) => {
    const t = useT()
    switch (step.kind) {
        case 'thinking':
            return <ThinkingBlock text={step.text} streaming={step.streaming} redacted={step.redacted} />
        case 'text':
            // Assistant prose hangs off a ● like the TUI's ⏺ bullet.
            return (
                <Gutter mark="●" markClassName="h-5 text-[10px] text-gray-900">
                    <Markdown content={step.text} streaming={step.streaming} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                </Gutter>
            )
        case 'tool':
            return <ToolRow call={step.call} result={step.result} running={step.running} />
        case 'bash':
            return <BashExecution message={step.message} />
        case 'note':
            return <NoteBlock variant={step.variant} title={step.title} text={step.text} />
        case 'error':
            return (
                <Gutter mark={step.aborted ? '⎿' : '✗'} markClassName={step.aborted ? 'text-gray-400' : 'text-red-500'}>
                    <div className={cn('min-h-6 whitespace-pre-wrap break-words py-[3px] text-[13px] leading-[18px] select-text', step.aborted ? 'text-gray-500' : 'text-red-600')}>
                        {step.text || (step.aborted ? t.aborted : t.requestFailed)}
                    </div>
                </Gutter>
            )
    }
})
