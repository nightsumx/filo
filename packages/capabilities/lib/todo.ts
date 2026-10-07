// The todo list a session currently has, read from its branch: the todo extension (to remind the
// model) and pi-cc-tui (to draw it under the working line) both need it. The desktop app reads the
// same details from its parsed transcript instead (src/store/thread.ts).
import type { TodoDetails, TodoItem } from '../protocol'

/**
 * Items of the last todo result on the branch; every call carries the full list. Compacted entries
 * stay on the branch, so this still finds a list the model no longer sees.
 */
export function latestTodos(branch: readonly { type: string, message?: any }[]): TodoItem[] {
    let items: TodoItem[] = []
    for (const entry of branch) {
        if (entry.type !== 'message' || entry.message?.role !== 'toolResult' || entry.message.toolName !== 'todo')
            continue
        const details = entry.message.details as TodoDetails | undefined
        if (Array.isArray(details?.items))
            items = details.items
    }
    return items
}
