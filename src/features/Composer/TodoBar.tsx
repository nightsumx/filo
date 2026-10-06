// The thread's current todo list as a progress strip above the composer; click to see every step.
// Hidden once all steps are done and the run has settled.
import type { Thread } from '@/store/thread'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { TodoList } from '../Thread/capabilities/TodoStep'

export const TodoBar = observer(({ thread }: { thread: Thread }) => {
    const [open, setOpen] = useState(false)
    const items = thread.todo?.items ?? []
    const done = items.filter(i => i.status === 'done').length
    if (!items.length || (done === items.length && !thread.running))
        return null
    const current = items.find(i => i.status === 'in_progress') ?? items.find(i => i.status === 'pending')
    const percent = Math.round((done / items.length) * 100)

    return (
        <div className="mb-2 overflow-hidden rounded-lg bg-ide-block">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                aria-label={`任务清单，已完成 ${done}/${items.length}`}
                className="flex h-8 w-full items-center gap-2.5 px-3 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ide-accent/50"
            >
                <span className="shrink-0 tabular-nums text-gray-500">{`${done}/${items.length}`}</span>
                <span aria-hidden className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                    <span className="block h-full rounded-full bg-ide-success transition-[width] duration-300" style={{ width: `${percent}%` }} />
                </span>
                <span className={cn('min-w-0 flex-1 truncate', current ? 'text-gray-800' : 'text-gray-500')}>
                    {current ? current.text : '全部完成'}
                </span>
                <ChevronDown size={14} className={cn('shrink-0 text-gray-400 transition-transform', open && 'rotate-180')} />
            </button>
            {open && <TodoList items={items} className="max-h-60 overflow-y-auto border-t border-ide-line px-3 py-1.5 text-[12.5px]" />}
        </div>
    )
})
