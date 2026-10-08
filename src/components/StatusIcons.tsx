import type { ProjectActivity } from '@/store/app'
import type { Thread } from '@/store/thread'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { Presence } from '@shared/capabilities'
import type { SubagentStatus } from '@/lib/subagents'
import { Ban, Check, Loader2, SquareTerminal, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'

/** Per-thread status used by tabs and the project tree: waiting > running > error > unread > idle π. */
export const StatusDot = observer(({ thread, dim }: { thread: Thread, dim?: boolean }) => {
    if (thread.waitingForUser)
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-label={tr('等待处理', 'Needs you')} />
    if (thread.running)
        return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-gray-300 border-t-ide-accent" aria-label={tr('运行中', 'Running')} />
    if (thread.activity.phase === 'error')
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label={tr('出错', 'Error')} />
    if (thread.unread)
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-ide-accent" aria-label={tr('有新回复', 'New reply')} />
    return <PiGlyph dim={dim} />
})

/**
 * A pi running in a terminal on this session (pi-cc-tui's presence extension): amber while it waits
 * for an answer there, a spinner while it works, a terminal glyph while idle.
 */
export const TerminalStatus = observer(function TerminalStatus({ presence }: { presence: Presence }) {
    const where = tr('终端中的 pi', 'pi in a terminal')
    if (presence.state === 'waiting')
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-amber-500" role="img" aria-label={`${where}: ${tr('等待处理', 'needs you')}`} />
    if (presence.state === 'running')
        return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-gray-300 border-t-gray-500" role="img" aria-label={`${where}: ${tr('运行中', 'running')}`} />
    return <SquareTerminal size={14} strokeWidth={1.6} className="shrink-0 text-gray-500" role="img" aria-label={`${where}: ${tr('空闲', 'idle')}`} />
})

/** A subagent in the project tree: amber while its call waits on you, a spinner while it works, then how it ended. */
export function SubagentMark({ status, waiting }: { status: SubagentStatus, waiting?: boolean }) {
    if (waiting)
        return <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-amber-500" role="img" aria-label={tr('等待处理', 'Needs you')} />
    if (status === 'starting' || status === 'running')
        return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-gray-300 border-t-ide-accent" role="img" aria-label={tr('运行中', 'Running')} />
    if (status === 'done')
        return <Check size={14} strokeWidth={2.25} className="shrink-0 text-ide-success" role="img" aria-label={tr('完成', 'Done')} />
    if (status === 'failed')
        return <X size={14} strokeWidth={2.25} className="shrink-0 text-red-500" role="img" aria-label={tr('失败', 'Failed')} />
    return <Ban size={12} strokeWidth={2} className="mx-px shrink-0 text-gray-400" role="img" aria-label={status === 'cancelled' ? tr('已取消', 'Cancelled') : tr('已中断', 'Interrupted')} />
}

export function PiGlyph({ dim }: { dim?: boolean }) {
    return <span aria-hidden className={cn('w-3.5 shrink-0 text-center font-serif text-[14px] italic leading-none select-none', dim ? 'text-gray-400' : 'text-gray-500')}>π</span>
}

/** Project-level summary: amber = needs input, spinner = running, blue = unread. */
export const ActivityBadge = observer(function ActivityBadge({ activity }: { activity: ProjectActivity }) {
    if (activity.waiting)
        return <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-label={tr(`${activity.waiting} 个线程等待处理`, `${activity.waiting} waiting`)} />
    if (activity.running) {
        return (
            <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-gray-500" aria-label={tr(`${activity.running} 个线程运行中`, `${activity.running} running`)}>
                <Loader2 size={12} className="animate-spin" />
                {activity.running > 1 && activity.running}
            </span>
        )
    }
    if (activity.unread)
        return <span className="h-2 w-2 shrink-0 rounded-full bg-ide-accent" aria-label={tr(`${activity.unread} 个线程有新回复`, `${activity.unread} with new replies`)} />
    return null
})
