// todo: the model keeps a task list for multi-step work. Each call replaces the whole list, so the
// tool is stateless; the GUI reads the latest result's details on the active branch. In the terminal
// the list draws like Claude Code's: ☐ pending, bold ☐ in progress, struck-through ☒ done.
import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import type { TodoDetails, TodoItem } from '../protocol'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { hang, header } from '../tui/render'

const TodoParams = Type.Object({
    items: Type.Array(Type.Object({
        text: Type.String({ description: 'Short imperative description of the step' }),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('done')]),
        activeForm: Type.Optional(Type.String({ description: 'Present continuous form shown while in progress, e.g. "Running tests"' })),
    }), { description: 'The complete list. Steps not included are removed.' }),
})

function summary(items: TodoItem[]): string {
    if (!items.length)
        return 'Todo list cleared.'
    const done = items.filter(i => i.status === 'done').length
    const current = items.find(i => i.status === 'in_progress')
    return [`Todo list updated: ${done}/${items.length} done.`, current && `In progress: ${current.text}`].filter(Boolean).join(' ')
}

const STRIKE = (s: string) => `\x1b[9m${s}\x1b[29m`

export function todoLine(theme: Theme, item: TodoItem): string {
    if (item.status === 'done')
        return theme.fg('dim', `☒ ${STRIKE(item.text)}`)
    return item.status === 'in_progress' ? theme.bold(`☐ ${item.text}`) : `☐ ${item.text}`
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: 'todo',
        label: 'Todo',
        description: 'Write the task list for the current work. Send the full list every time; it replaces the previous one. The user sees the list and its progress.',
        promptSnippet: 'Track progress on multi-step work with a task list',
        promptGuidelines: [
            'For work with 3 or more distinct steps, write a todo list before starting, keep exactly one step in_progress, and mark steps done as soon as they are finished.',
            'Skip the todo list for single-step requests and questions.',
        ],
        parameters: TodoParams,
        annotations: { readOnlyHint: true },

        async execute(_toolCallId, params) {
            const items: TodoItem[] = params.items
                .map(i => ({ text: i.text.trim(), status: i.status, ...(i.activeForm?.trim() ? { activeForm: i.activeForm.trim() } : {}) }))
                .filter(i => i.text)
            const details: TodoDetails = { kind: 'todo', items }
            return { content: [{ type: 'text', text: summary(items) }], details }
        },

        renderShell: 'self',
        renderCall(_args, theme, context) {
            return header(theme, context, 'Update Todos')
        },
        renderResult(result, _options, theme, context) {
            const items = (result.details as TodoDetails | undefined)?.items
            if (context.isError)
                return hang(theme, [theme.fg('error', result.content.find(c => c.type === 'text')?.text ?? 'Error')])
            if (!items)
                return new Text('', 0, 0)
            return hang(theme, items.length ? items.map(i => todoLine(theme, i)) : [theme.fg('dim', '(no todos)')])
        },
    })
}
