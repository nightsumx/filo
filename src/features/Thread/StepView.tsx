import type { Step } from '@/lib/timeline'
import { Markdown } from '@/components/Markdown'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { Archive, GitBranch, Puzzle } from 'lucide-react'
import { memo } from 'react'
import { AskStep } from './capabilities/AskStep'
import { AutopilotCardStep, AutopilotDecisionStep } from './capabilities/AutopilotStep'
import { PlanStep } from './capabilities/PlanStep'
import { ReviewStep } from './capabilities/ReviewStep'
import { SubagentStep } from './capabilities/SubagentStep'
import { TerminalStep } from './capabilities/TerminalStep'
import { TodoStep } from './capabilities/TodoStep'
import { ThinkingBlock } from './ThinkingBlock'
import { Gutter, ToolRow } from './ToolRow'
import { useViewState } from './viewState'

/** User-run `!command`: `$ command` then its output, clipped like a tool result. */
function BashExecution({ id, message }: { id: string, message: Extract<Step, { kind: 'bash' }>['message'] }) {
    const t = useT()
    const [full, setFull] = useViewState(id, false)
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
                    <div className="mt-0.5 rounded-md bg-ide-block px-3 py-2 text-[12px]">
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

function NoteBlock({ id, variant, title: customTitle, text }: { id: string, variant: 'compaction' | 'branch' | 'custom', title: string, text: string }) {
    const t = useT()
    const title = variant === 'compaction' ? t.compacted : variant === 'branch' ? t.branchSummary : customTitle
    const [open, setOpen] = useViewState(id, false)
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
                // A summary is reference text, not a document: headings at body size so "Goal" does
                // not read as a page title in the middle of the conversation.
                <div className="mt-2 rounded-md bg-ide-block px-4 py-3 text-[13px] text-gray-700 [&_h1]:!mt-3 [&_h1]:!border-0 [&_h1]:!pb-0 [&_h1]:!text-[13.5px] [&_h1]:!leading-6 [&_h2]:!mt-3 [&_h2]:!border-0 [&_h2]:!pb-0 [&_h2]:!text-[13.5px] [&_h2]:!leading-6 [&_h3]:!text-[13px]">
                    <Markdown content={text} className="[&>*:first-child]:!mt-0 [&>*:last-child]:mb-0" />
                </div>
            )}
        </div>
    )
}

export const StepView = memo(({ step }: { step: Step }) => {
    const t = useT()
    switch (step.kind) {
        case 'thinking':
            return <ThinkingBlock id={step.key} text={step.text} streaming={step.streaming} redacted={step.redacted} ms={step.ms} />
        case 'text':
            // Assistant prose hangs off a ● like the TUI's ⏺ bullet.
            return (
                <Gutter mark="●" markClassName="h-5 text-[10px] text-gray-900">
                    <Markdown content={step.text} streaming={step.streaming} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                </Gutter>
            )
        case 'tool':
            if (step.call.name === 'todo')
                return <TodoStep call={step.call} result={step.result} running={step.running} />
            if (step.call.name === 'ask')
                return <AskStep call={step.call} result={step.result} running={step.running} />
            if (step.call.name === 'propose_plan')
                return <PlanStep call={step.call} result={step.result} running={step.running} />
            if (step.call.name === 'subagent')
                return <SubagentStep call={step.call} result={step.result} running={step.running} />
            if (step.call.name.startsWith('terminal_'))
                return <TerminalStep call={step.call} result={step.result} running={step.running} startedAt={step.startedAt} ms={step.ms} />
            return <ToolRow call={step.call} result={step.result} running={step.running} startedAt={step.startedAt} ms={step.ms} />
        case 'bash':
            return <BashExecution id={step.key} message={step.message} />
        case 'review':
            return <ReviewStep id={step.key} report={step.report} applied={step.applied} />
        case 'autopilot':
            return <AutopilotDecisionStep id={step.key} decision={step.decision} settled={step.settled} />
        case 'autopilot-card':
            return <AutopilotCardStep card={step.card} answer={step.answer} />
        case 'note':
            return <NoteBlock id={step.key} variant={step.variant} title={step.title} text={step.text} />
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
