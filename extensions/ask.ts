// ask: the model asks the user multiple-choice questions instead of guessing. The tool publishes the
// questions as pending details and waits; the GUI answers with `/gui-ask-answer <toolCallId> <json>`.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AskAnswer, AskDetails, AskQuestion, AskResponse, GuiCommands } from '../shared/capabilities'
import { Type } from 'typebox'

const ANSWER_COMMAND: GuiCommands['askAnswer'] = 'gui-ask-answer'

const AskParams = Type.Object({
    questions: Type.Array(Type.Object({
        question: Type.String({ description: 'One clear question' }),
        options: Type.Array(Type.String(), { description: '2-5 short, distinct choices. The user can also type a custom answer.' }),
        multiple: Type.Optional(Type.Boolean({ description: 'Allow choosing several options' })),
    }), { minItems: 1, maxItems: 4 }),
})

const waiting = new Map<string, (response: AskResponse) => void>()

function formatAnswers(questions: AskQuestion[], answers: Record<string, AskAnswer>): string {
    return questions.map((q) => {
        const a = answers[q.id]
        const parts = [...(a?.selected ?? []), ...(a?.text?.trim() ? [a.text.trim()] : [])]
        return `Q: ${q.question}\nA: ${parts.length ? parts.join('; ') : '(no answer)'}`
    }).join('\n\n')
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: 'ask',
        label: 'Ask',
        description: 'Ask the user up to 4 multiple-choice questions and wait for the answers.',
        promptSnippet: 'Ask the user clarifying multiple-choice questions',
        promptGuidelines: [
            'Use ask when a decision is genuinely ambiguous and a wrong guess would waste significant work; otherwise make a reasonable choice and state it.',
            'Batch related questions into one ask call.',
        ],
        parameters: AskParams,
        annotations: { readOnlyHint: true },
        // Questions must not race each other in parallel tool batches.
        executionMode: 'sequential',

        async execute(toolCallId, params, signal, onUpdate) {
            const questions: AskQuestion[] = params.questions.map((q, i) => ({
                id: `q${i + 1}`,
                question: q.question,
                options: q.options,
                multiple: q.multiple || undefined,
            }))
            const pending: AskDetails = { kind: 'ask', status: 'pending', questions }
            onUpdate?.({ content: [{ type: 'text', text: 'Waiting for the user to answer.' }], details: pending })

            const response = await new Promise<AskResponse>((resolve) => {
                const finish = (r: AskResponse) => {
                    waiting.delete(toolCallId)
                    signal?.removeEventListener('abort', onAbort)
                    resolve(r)
                }
                const onAbort = () => finish({ cancelled: true })
                if (signal?.aborted)
                    return finish({ cancelled: true })
                signal?.addEventListener('abort', onAbort, { once: true })
                waiting.set(toolCallId, finish)
            })

            if ('cancelled' in response) {
                const details: AskDetails = { kind: 'ask', status: 'cancelled', questions }
                return { content: [{ type: 'text', text: 'The user dismissed the questions without answering. Do not ask again; proceed with your best judgement and say what you assumed.' }], details }
            }
            const details: AskDetails = { kind: 'ask', status: 'answered', questions, answers: response.answers }
            return { content: [{ type: 'text', text: formatAnswers(questions, response.answers) }], details }
        },
    })

    pi.registerCommand(ANSWER_COMMAND, {
        description: 'Internal: answer a pending ask call',
        handler: async (args, ctx) => {
            const space = args.indexOf(' ')
            const id = space < 0 ? args.trim() : args.slice(0, space)
            const finish = waiting.get(id)
            if (!finish)
                return ctx.ui.notify('这个问题已经结束了', 'warning')
            let response: AskResponse
            try {
                response = JSON.parse(args.slice(space + 1))
            }
            catch {
                return ctx.ui.notify('回答格式无效', 'error')
            }
            finish('cancelled' in response ? { cancelled: true } : { answers: response.answers ?? {} })
        },
    })
}
