// The autopilot capability in the transcript: one line per supervisor decision (expandable to the
// commands it ran and its own transcript), and the cards only the user decides, answered inline.
// Answers go back through /gui-autopilot-answer (Thread.answerCard); the switch is AutopilotToggle.
import type { AutopilotAnswerEntry, AutopilotCard, AutopilotDecision } from '@shared/capabilities'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { flatFieldClass } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { useT } from '@/lib/transcriptText'
import { cn, formatCost } from '@/lib/utils'
import { Check, ChevronRight, File, FileImage, Plane, TriangleAlert } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { useThread } from '../ThreadContext'
import { Gutter, StatusMark } from '../ToolRow'
import { useViewState } from '../viewState'
import { Transcript } from './SubagentStep'

const Sep = () => <span className="shrink-0 text-gray-400">·</span>

const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i
/** Opened in their default app; anything else (scripts, apps) only shows its folder. */
const VIEWABLE = /\.(?:png|jpe?g|webp|gif|svg|pdf|txt|md|log|json|diff|patch|html?)$/i

function openEvidence(file: string) {
    const target = VIEWABLE.test(file) ? file : file.slice(0, Math.max(1, file.lastIndexOf('/')))
    void window.pi.openFolder(target).catch(() => {})
}

export const AutopilotDecisionStep = observer(({ id, decision, settled }: { id: string, decision: AutopilotDecision, settled?: boolean }) => {
    const t = useT()
    const [open, setOpen] = useViewState(`autopilot:${id}`, false)
    const [process, setProcess] = useViewState(`autopilot-run:${id}`, false)
    const failed = decision.status !== 'done'
    // A wait the user already answered no longer waits.
    const waiting = !failed && decision.next === 'wait' && !settled
    const verb = decision.status === 'failed' ? t.apFailed : decision.status === 'cancelled' ? t.apCancelled : decision.next === 'wait' && settled ? t.apWaited : t.apNext[decision.next]
    const verbClass = failed
        ? 'text-red-500'
        : waiting ? 'text-amber-600 dark:text-amber-400' : decision.next === 'done' ? 'text-ide-success' : 'text-gray-500'
    const elapsed = decision.endedAt - decision.startedAt
    const cost = decision.run?.usage?.cost
    const meta = [
        decision.commands.length ? t.apCommands(decision.commands.length) : '',
        elapsed > 0 ? t.elapsed(elapsed) : '',
        cost ? formatCost(cost) : '',
    ].filter(Boolean).join(' · ')
    const expandable = decision.commands.length > 0 || !!decision.run || !!decision.peers?.length
    return (
        <Gutter mark={<Plane size={12} className={failed ? 'text-red-500' : waiting ? 'text-amber-500' : 'text-gray-400'} />}>
            <button
                type="button"
                onClick={() => expandable && setOpen(v => !v)}
                aria-expanded={expandable ? open : undefined}
                className={cn('group/ap flex h-6 w-full min-w-0 items-center gap-1.5 text-left text-[12.5px]', !expandable && 'cursor-default')}
            >
                <span className="shrink-0 font-mono font-semibold text-gray-900">Autopilot</span>
                <Sep />
                <span className={cn('shrink-0', verbClass)}>{verb}</span>
                {decision.rules.length > 0 && (
                    <>
                        <Sep />
                        <span className="shrink-0 font-mono text-[11.5px] text-gray-500">{decision.rules.join(' ')}</span>
                    </>
                )}
                {meta && <span className="min-w-0 truncate tabular-nums text-gray-400">{`· ${meta}`}</span>}
                {expandable && <ChevronRight size={12} className={cn('shrink-0 text-gray-400 transition-transform group-hover/ap:text-gray-800', open && 'rotate-90')} />}
            </button>
            {decision.reason && <div className="text-[12.5px] leading-5 text-gray-600 [overflow-wrap:anywhere] select-text">{decision.reason}</div>}
            {decision.valve && (
                <div className="flex min-w-0 items-start gap-1.5 text-[12.5px] leading-5 text-amber-600 dark:text-amber-400">
                    <TriangleAlert size={12} className="mt-1 shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{decision.valve}</span>
                </div>
            )}
            {decision.error && <div className="text-[12.5px] leading-5 text-red-600 [overflow-wrap:anywhere] dark:text-red-400">{decision.error}</div>}
            {open && (
                <div className="mt-1 mb-1 flex flex-col gap-1">
                    {decision.commands.length > 0 && (
                        <div className="rounded-md bg-ide-block px-3 py-1.5 font-mono text-[12px] leading-5">
                            {decision.commands.map((c, i) => (
                                <div key={i} className="flex min-w-0 items-baseline gap-2">
                                    <span className="min-w-0 flex-1 truncate text-gray-800 select-text" title={c.command}>{`$ ${c.command}`}</span>
                                    <span className={cn('shrink-0 font-sans text-[11.5px]', c.exitCode ? 'text-red-500' : 'text-gray-500')}>
                                        {c.exitCode === undefined ? tr('未结束', 'unfinished') : t.exitCode(c.exitCode)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {decision.peers?.map((p, i) => (
                        <div key={i} className="text-[12.5px] leading-5 text-gray-600 [overflow-wrap:anywhere]">
                            <span className="text-gray-500">{`${t.apPeerNote(p.session.slice(0, 8))}: `}</span>
                            {p.text}
                        </div>
                    ))}
                    {decision.run && (
                        <>
                            <button type="button" onClick={() => setProcess(v => !v)} aria-expanded={process} className="flex h-6 items-center gap-1 self-start text-[12px] text-gray-500 hover:text-gray-800">
                                <ChevronRight size={12} className={cn('transition-transform', process && 'rotate-90')} />
                                {t.apHowDecided}
                            </button>
                            {process && (
                                <div className="mb-1 border-l-2 border-ide-line pl-3">
                                    <Transcript details={decision.run} running={false} />
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </Gutter>
    )
})

/** The option an answer picked, and any words that came with it, in one line. */
function answerLine(card: AutopilotCard, answer: AutopilotAnswerEntry): string {
    const label = card.options.find(o => o.id === answer.choice)?.label ?? answer.choice ?? ''
    return [label, answer.text].filter(Boolean).join(' · ')
}

/** What a card asks beyond its question: the held call, the proposed rulebook, the held message. */
const CardContext = observer(function CardContext({ card }: { card: AutopilotCard }) {
    const t = useT()
    const [rulesOpen, setRulesOpen] = useViewState(`autopilot-rules:${card.id}`, false)
    return (
        <>
            {card.gate && (
                <div className="mt-1 rounded-md bg-ide-block px-3 py-1.5 font-mono text-[12px] leading-5 text-gray-800 [overflow-wrap:anywhere] select-text">
                    {`${card.gate.tool === 'bash' ? '$ ' : `${card.gate.tool} `}${card.gate.summary}`}
                </div>
            )}
            {card.rules && (
                <>
                    {card.rules.summary && <div className="mt-1 text-[12.5px] leading-5 text-gray-700"><Markdown content={card.rules.summary} className="text-[12.5px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" /></div>}
                    <button type="button" onClick={() => setRulesOpen(v => !v)} aria-expanded={rulesOpen} className="flex h-6 items-center gap-1 text-[12px] text-gray-500 hover:text-gray-800">
                        <ChevronRight size={12} className={cn('transition-transform', rulesOpen && 'rotate-90')} />
                        {t.apRulebook}
                    </button>
                    {rulesOpen && (
                        <div className="mb-1 max-h-[320px] overflow-y-auto rounded-md bg-ide-block px-3 py-2 text-[12.5px]">
                            <Markdown content={card.rules.text} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                        </div>
                    )}
                </>
            )}
            {card.held && (
                <div className="text-[12.5px] leading-5 text-gray-500 [overflow-wrap:anywhere]">
                    {t.apHeld}
                    <span className="text-gray-700">{card.held}</span>
                </div>
            )}
        </>
    )
})

const Evidence = observer(function Evidence({ files }: { files: string[] }) {
    const cwd = useThread()?.cwd
    const shown = (file: string) => cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file
    return (
        <div className="mt-1 flex flex-col">
            {files.map(file => (
                <button
                    key={file}
                    type="button"
                    onClick={() => openEvidence(file)}
                    title={file}
                    className="flex h-5 min-w-0 items-center gap-1.5 self-start text-left font-mono text-[11.5px] text-gray-500 hover:text-gray-900"
                >
                    {IMAGE.test(file) ? <FileImage size={12} className="shrink-0" /> : <File size={12} className="shrink-0" />}
                    <span className="min-w-0 truncate">{shown(file)}</span>
                </button>
            ))}
        </div>
    )
})

/** A pending card: question, options as flat rows (a click decides), own words, evidence, fallback. */
const CardForm = observer(function CardForm({ card }: { card: AutopilotCard }) {
    const t = useT()
    const thread = useThread()
    const [text, setText] = useViewState(`autopilot-text:${card.id}`, '')
    const [sending, setSending] = useState(false)
    const send = async (choice?: string) => {
        const words = text.trim()
        if (!thread || sending || (!choice && !words))
            return
        setSending(true)
        if (await thread.answerCard(card.id, { ...(choice ? { choice } : {}), ...(words ? { text: words } : {}) }))
            setText('')
        setSending(false)
    }
    return (
        <div className="mt-1 mb-1 flex max-w-3xl flex-col">
            <ul className="m-0 flex list-none flex-col p-0" aria-label={card.title}>
                {card.options.map(option => (
                    <li key={option.id}>
                        <button
                            type="button"
                            disabled={sending}
                            onClick={() => void send(option.id)}
                            className="flex min-h-7 w-full min-w-0 items-baseline gap-2 rounded-[4px] px-2 py-1 text-left text-[12.5px] leading-5 outline-none hover:bg-black/[0.05] focus-visible:bg-black/[0.05] disabled:opacity-50"
                        >
                            <span className="min-w-4 shrink-0 font-mono text-gray-500">{option.id}</span>
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                                <span className="text-gray-900">{option.label}</span>
                                {option.id === card.recommended && <span className="ml-1.5 text-[11.5px] text-ide-accent">{t.apRecommended}</span>}
                                {option.detail && <span className="text-gray-500">{` — ${option.detail}`}</span>}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            <form
                className="mt-1 flex items-center gap-2 pl-2"
                onSubmit={(e) => {
                    e.preventDefault()
                    void send()
                }}
            >
                <input
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder={t.apOwnAnswer}
                    aria-label={tr(`${card.title}：自己写`, `${card.title}: your own answer`)}
                    className={cn(flatFieldClass, 'h-7 min-w-0 flex-1 text-[12.5px] focus:shadow-none')}
                />
                <Button type="submit" size="sm" disabled={sending || !text.trim()}>{t.apSend}</Button>
            </form>
        </div>
    )
})

export const AutopilotCardStep = observer(({ card, answer }: { card: AutopilotCard, answer?: AutopilotAnswerEntry }) => {
    const t = useT()
    const [open, setOpen] = useViewState(`autopilot-card:${card.id}`, false)
    const category = t.apCategory[card.category] ?? card.category

    if (answer) {
        return (
            <Gutter mark={<StatusMark status="success" />}>
                <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="group/card flex h-6 w-full min-w-0 items-center gap-1.5 text-left text-[12.5px]">
                    <span className="shrink-0 truncate font-medium text-gray-900">{card.title}</span>
                    <Sep />
                    <span className="shrink-0 text-gray-500">{category}</span>
                    <span className="min-w-0 truncate text-gray-900">{`→ ${answerLine(card, answer)}`}</span>
                    <ChevronRight size={12} className={cn('shrink-0 text-gray-400 transition-transform group-hover/card:text-gray-800', open && 'rotate-90')} />
                </button>
                {open && (
                    <div className="mb-1 flex flex-col gap-0.5 text-[12.5px] leading-5">
                        <div className="whitespace-pre-wrap text-gray-700 [overflow-wrap:anywhere] select-text">{card.question}</div>
                        <CardContext card={card} />
                        {card.options.map(option => (
                            <div key={option.id} className="flex min-w-0 items-baseline gap-2 px-2">
                                <span className="min-w-4 shrink-0 font-mono text-gray-500">{option.id}</span>
                                <span className={cn('min-w-0 [overflow-wrap:anywhere]', option.id === answer.choice ? 'text-gray-900' : 'text-gray-500')}>{option.label}</span>
                                {option.id === answer.choice && <Check size={12} className="shrink-0 self-center text-ide-success" />}
                            </div>
                        ))}
                        {card.evidence?.length ? <Evidence files={card.evidence} /> : null}
                    </div>
                )}
            </Gutter>
        )
    }

    return (
        <Gutter mark={<span className="text-amber-500">◆</span>}>
            <div className="flex h-6 min-w-0 items-center gap-1.5 text-[12.5px]">
                <span className="min-w-0 truncate font-medium text-gray-900">{card.title}</span>
                <Sep />
                <span className="shrink-0 text-gray-500">{category}</span>
                <Sep />
                <span className="shrink-0 text-amber-600 dark:text-amber-400">{t.apWaiting}</span>
            </div>
            <div className="whitespace-pre-wrap text-[12.5px] leading-5 text-gray-700 [overflow-wrap:anywhere] select-text">{card.question}</div>
            <CardContext card={card} />
            {card.evidence?.length ? <Evidence files={card.evidence} /> : null}
            <CardForm card={card} />
            {card.fallback && <div className="pl-2 text-[12px] leading-5 text-gray-400">{`${t.apFallback}${card.fallback}`}</div>}
        </Gutter>
    )
})
