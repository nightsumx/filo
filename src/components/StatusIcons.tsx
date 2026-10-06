import type { ProjectActivity } from '@/store/app'
import type { Thread } from '@/store/thread'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'

/** Per-thread status used by tabs and the project tree: waiting > running > unread > idle π. */
export const StatusDot = observer(({ thread, dim }: { thread: Thread, dim?: boolean }) => {
    if (thread.waitingForUser)
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-label="等待处理" />
    if (thread.running)
        return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-gray-300 border-t-ide-accent" aria-label="运行中" />
    if (thread.unread)
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-ide-accent" aria-label="有新回复" />
    return <PiGlyph dim={dim} />
})

export function PiGlyph({ dim }: { dim?: boolean }) {
    return <span aria-hidden className={cn('w-3.5 shrink-0 text-center font-serif text-[14px] italic leading-none select-none', dim ? 'text-gray-400' : 'text-gray-500')}>π</span>
}

/** Project-level summary: amber = needs input, spinner = running, blue = unread. */
export function ActivityBadge({ activity }: { activity: ProjectActivity }) {
    if (activity.waiting)
        return <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-label={`${activity.waiting} 个线程等待处理`} />
    if (activity.running) {
        return (
            <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-gray-500" aria-label={`${activity.running} 个线程运行中`}>
                <Loader2 size={12} className="animate-spin" />
                {activity.running > 1 && activity.running}
            </span>
        )
    }
    if (activity.unread)
        return <span className="h-2 w-2 shrink-0 rounded-full bg-ide-accent" aria-label={`${activity.unread} 个线程有新回复`} />
    return null
}
