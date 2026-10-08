// Transcript row for a todo call: "✓ Todo 2/5 done · current step". The live list sits above the
// composer (TodoBar), so the row stays one line and expands into the list it wrote.
import type { TodoDetails, TodoItem } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { ToolResultView } from '@/lib/timeline'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { Check, Circle, CircleDot } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { memo } from 'react'
import { Gutter, StatusMark } from '../ToolRow'
import { useViewState } from '../viewState'
import { tr } from '@/lib/i18n'

/** Items from the result, or from the streamed arguments while the call is still running. */
function itemsOf(call: ToolCall, result?: ToolResultView): TodoItem[] {
    const details = result?.details as TodoDetails | undefined
    if (details?.kind === 'todo')
        return details.items
    const args = call.arguments?.items
    return Array.isArray(args) ? args.filter(i => typeof i?.text === 'string') : []
}

export const TodoList = observer(({ items, className }: { items: TodoItem[], className?: string }) => {
    return (
        <ul className={cn('flex flex-col', className)}>
            {items.map((item, i) => (
                <li key={i} className="flex min-h-[22px] items-start gap-2 leading-[22px]">
                    <span
                        aria-label={item.status === 'done' ? tr('已完成', 'Done') : item.status === 'in_progress' ? tr('进行中', 'In progress') : tr('待办', 'To do')}
                        className={cn('flex h-[22px] w-3.5 shrink-0 select-none items-center justify-center', item.status === 'done' ? 'text-ide-success' : item.status === 'in_progress' ? 'text-ide-accent' : 'text-gray-400')}
                    >
                        {item.status === 'done'
                            ? <Check size={14} strokeWidth={2.5} aria-hidden />
                            : item.status === 'in_progress'
                                ? <CircleDot size={13} strokeWidth={2.25} aria-hidden />
                                : <Circle size={13} strokeWidth={1.75} aria-hidden />}
                    </span>
                    <span className={cn('min-w-0 [overflow-wrap:anywhere]', item.status === 'done' ? 'text-gray-400 line-through decoration-gray-300' : item.status === 'in_progress' ? 'font-medium text-gray-900' : 'text-gray-700')}>
                        {item.text}
                    </span>
                </li>
            ))}
        </ul>
    )
})

export const TodoStep = memo(({ call, result, running }: { call: ToolCall, result?: ToolResultView, running: boolean }) => {
    const t = useT()
    const [expanded, setExpanded] = useViewState(`todo:${call.id}`, false)
    const items = itemsOf(call, result)
    const done = items.filter(i => i.status === 'done').length
    const current = items.find(i => i.status === 'in_progress')
    const status = result?.isError ? 'error' : running ? 'running' : 'success'

    return (
        <Gutter mark={<StatusMark status={status} />}>
            <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} className="group/res flex h-6 w-full min-w-0 items-center gap-1.5 text-left">
                <span className="shrink-0 font-mono text-[12.5px] font-semibold text-gray-900">Todo</span>
                <span className="min-w-0 truncate text-[12.5px] text-gray-500">
                    {items.length ? t.todoProgress(done, items.length) : t.todoCleared}
                    {current && <span className="text-gray-700">{` · ${current.text}`}</span>}
                    {items.length > 0 && <span className="text-gray-400 group-hover/res:text-gray-800">{` · ${expanded ? t.collapse : t.expand}`}</span>}
                </span>
            </button>
            {expanded && items.length > 0 && <TodoList items={items} className="mt-0.5 mb-1 text-[12.5px]" />}
        </Gutter>
    )
})
