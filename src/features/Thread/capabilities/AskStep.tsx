// The ask capability inline in the transcript: an answer form while pi waits, then a compact Q → A
// record. Answers go back through /gui-ask-answer (Thread.answerAsk).
import type { AskAnswer, AskDetails, AskQuestion } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { ToolResultView } from '@/lib/timeline'
import { Button } from '@/components/ui/button'
import { Check, fieldClass } from '@/components/ui/form'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import { useId, useState } from 'react'
import { useThread } from '../ThreadContext'
import { Gutter, StatusMark } from '../ToolRow'

function answerText(a?: AskAnswer): string {
    const parts = [...(a?.selected ?? []), ...(a?.text?.trim() ? [a.text.trim()] : [])]
    return parts.join('；')
}

function QuestionField({ index, question, answer, onChange }: { index: number, question: AskQuestion, answer: AskAnswer, onChange: (a: AskAnswer) => void }) {
    const id = useId()
    const toggle = (option: string) => {
        if (!question.multiple)
            return onChange({ ...answer, selected: [option] })
        const selected = answer.selected.includes(option) ? answer.selected.filter(o => o !== option) : [...answer.selected, option]
        onChange({ ...answer, selected })
    }
    return (
        <fieldset className="flex flex-col gap-1">
            <legend className="mb-1.5 flex items-baseline gap-2 text-[13px] text-gray-900">
                <span className="font-mono text-[12px] text-gray-400">{index + 1}</span>
                <span className="font-medium">{question.question}</span>
                {question.multiple && <span className="text-[12px] text-[var(--jb-comment)]">可多选</span>}
            </legend>
            {question.options.map(option => (
                <Check
                    key={option}
                    type={question.multiple ? 'checkbox' : 'radio'}
                    name={id}
                    checked={answer.selected.includes(option)}
                    onChange={() => toggle(option)}
                >
                    {option}
                </Check>
            ))}
            <input
                value={answer.text ?? ''}
                onChange={e => onChange({ ...answer, text: e.target.value })}
                placeholder="其他，自己填写…"
                aria-label={`${question.question}：自己填写`}
                className={cn(fieldClass, 'mt-1 ml-[22px] max-w-md')}
            />
        </fieldset>
    )
}

const AskForm = observer(({ toolCallId, questions }: { toolCallId: string, questions: AskQuestion[] }) => {
    const thread = useThread()
    const [answers, setAnswers] = useState<Record<string, AskAnswer>>(() => Object.fromEntries(questions.map(q => [q.id, { selected: [] }])))
    const [sending, setSending] = useState(false)
    const answered = questions.filter(q => answerText(answers[q.id])).length

    const send = async (response: Parameters<NonNullable<typeof thread>['answerAsk']>[1]) => {
        if (!thread || sending)
            return
        setSending(true)
        await thread.answerAsk(toolCallId, response)
        setSending(false)
    }
    const submit = () => void send({ answers })

    return (
        <form
            aria-label="回答 pi 的问题"
            onSubmit={(e) => {
                e.preventDefault()
                submit()
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    submit()
                }
            }}
            className="mt-1 mb-1.5 flex max-w-2xl flex-col gap-4 rounded-[6px] border border-[var(--jb-dialog-border)] bg-[var(--jb-dialog-side)] px-4 pt-3 pb-3"
        >
            {questions.map((q, i) => (
                <QuestionField key={q.id} index={i} question={q} answer={answers[q.id]} onChange={a => setAnswers(prev => ({ ...prev, [q.id]: a }))} />
            ))}
            <div className="flex items-center gap-2 border-t border-[var(--jb-separator)] pt-3">
                <span className="flex-1 text-[12px] text-[var(--jb-comment)] tabular-nums">
                    {questions.length > 1 ? `已回答 ${answered}/${questions.length}` : ''}
                </span>
                <Button type="button" variant="outline" disabled={sending} onClick={() => void send({ cancelled: true })}>跳过</Button>
                <Button type="submit" variant="primary" disabled={sending || !answered} title="提交（⌘↩）" className="min-w-[72px]">提交</Button>
            </div>
        </form>
    )
})

export const AskStep = observer(({ call, result, running }: { call: ToolCall, result?: ToolResultView, running: boolean }) => {
    const t = useT()
    const details = result?.details as AskDetails | undefined
    const status = details?.kind === 'ask' ? details.status : undefined
    // A pending ask from an earlier process can no longer be answered.
    const live = running && status === 'pending'

    if (live) {
        return (
            <Gutter mark={<span className="text-amber-500">?</span>}>
                <div className="flex h-6 items-center gap-1.5 text-[12.5px]">
                    <span className="font-mono font-semibold text-gray-900">Ask</span>
                    <span className="text-amber-600 dark:text-amber-400">{t.askWaiting}</span>
                </div>
                <AskForm toolCallId={call.id} questions={details!.questions} />
            </Gutter>
        )
    }

    const questions = details?.questions ?? []
    const answers = details?.status === 'answered' ? details.answers : undefined
    const label = running ? t.pending : status === 'answered' ? t.askAnswered : t.askCancelled
    return (
        <Gutter mark={running ? <StatusMark status="running" /> : status === 'answered' ? <StatusMark status="success" /> : <span className="text-gray-400">⎿</span>}>
            <div className="flex h-6 items-center gap-1.5 text-[12.5px]">
                <span className="font-mono font-semibold text-gray-900">Ask</span>
                <span className="text-gray-500">{label}</span>
            </div>
            {questions.length > 0 && (
                <dl className="mb-1 flex flex-col gap-0.5 text-[12.5px] leading-[20px]">
                    {questions.map(q => (
                        <div key={q.id} className="flex min-w-0 gap-1.5">
                            <dt className="shrink-0 text-gray-500">{q.question}</dt>
                            <dd className={cn('min-w-0 [overflow-wrap:anywhere]', answers ? 'text-gray-900' : 'text-gray-400')}>
                                {answers ? `→ ${answerText(answers[q.id]) || '—'}` : ''}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </Gutter>
    )
})
