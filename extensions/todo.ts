// todo: the model keeps a task list for multi-step work. Each call replaces the whole list, so the
// tool is stateless; the GUI reads the latest result's details on the active branch.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { TodoDetails, TodoItem } from '../shared/capabilities'
import { Type } from 'typebox'

const TodoParams = Type.Object({
    items: Type.Array(Type.Object({
        text: Type.String({ description: 'Short imperative description of the step' }),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('done')]),
    }), { description: 'The complete list. Steps not included are removed.' }),
})

function summary(items: TodoItem[]): string {
    if (!items.length)
        return 'Todo list cleared.'
    const done = items.filter(i => i.status === 'done').length
    const current = items.find(i => i.status === 'in_progress')
    return [`Todo list updated: ${done}/${items.length} done.`, current && `In progress: ${current.text}`].filter(Boolean).join(' ')
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: 'todo',
        label: 'Todo',
        description: 'Write the task list for the current work. Send the full list every time; it replaces the previous one. The user sees it as a progress bar.',
        promptSnippet: 'Track progress on multi-step work with a task list',
        promptGuidelines: [
            'For work with 3 or more distinct steps, write a todo list before starting, keep exactly one step in_progress, and mark steps done as soon as they are finished.',
            'Skip the todo list for single-step requests and questions.',
        ],
        parameters: TodoParams,
        annotations: { readOnlyHint: true },

        async execute(_toolCallId, params) {
            const items: TodoItem[] = params.items.map(i => ({ text: i.text.trim(), status: i.status })).filter(i => i.text)
            const details: TodoDetails = { kind: 'todo', items }
            return { content: [{ type: 'text', text: summary(items) }], details }
        },
    })
}
