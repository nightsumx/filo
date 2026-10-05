import type { Thread } from '@/store/thread'
import { StatusDot } from '@/components/StatusIcons'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn, relativeTime } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Check, ChevronDown, MoreHorizontal, Plus, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { closeTabWithConfirm, ThreadActions } from './ThreadActions'

const iconBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800 outline-none data-[state=open]:bg-black/[0.08]'

export { closeTabWithConfirm }

const contextParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator }
const dropdownParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator }

const Tab = observer(({ thread, index, visible }: { thread: Thread, index: number, visible: boolean }) => {
    const active = appStore.activeKey === thread.key
    const ref = useRef<HTMLDivElement>(null)
    const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null)

    useEffect(() => {
        if (active)
            ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [active])

    return (
        <ContextMenu onOpenChange={o => o && appStore.focus(thread.key)}>
            <ContextMenuTrigger asChild>
        <div
            ref={ref}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            title={thread.title}
            draggable
            onDragStart={e => e.dataTransfer.setData('application/x-pi-tab', thread.key)}
            onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('application/x-pi-tab'))
                    return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setDropSide(e.clientX < rect.left + rect.width / 2 ? 'left' : 'right')
            }}
            onDragLeave={() => setDropSide(null)}
            onDrop={(e) => {
                const key = e.dataTransfer.getData('application/x-pi-tab')
                const side = dropSide
                setDropSide(null)
                if (!key || key === thread.key)
                    return
                e.preventDefault()
                const from = appStore.tabs.findIndex(t => t.key === key)
                let to = index + (side === 'right' ? 1 : 0)
                if (from < to)
                    to--
                appStore.moveTab(key, to)
            }}
            onMouseDown={(e) => {
                // Middle click closes, like a browser tab.
                if (e.button === 1) {
                    e.preventDefault()
                    void closeTabWithConfirm(thread)
                }
            }}
            onClick={() => appStore.focus(thread.key, true)}
            onKeyDown={e => e.key === 'Enter' && appStore.focus(thread.key, true)}
            className={cn(
                // WebStorm Islands tabs: the selected one is a raised chip; tabs shown in another split
                // pane get a faint fill so it is clear which tabs are on screen. Tabs share the strip's
                // width equally (basis-0 + flex-1) and only scroll once they hit min-w.
                'group relative flex h-[26px] min-w-[120px] flex-1 basis-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[13px] cursor-default outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ide-accent/50',
                active
                    ? 'bg-ide-tab text-gray-900 shadow-[0_1px_2px_rgb(0_0_0/0.06)] dark:shadow-[0_0_0_1px_rgb(var(--gray-200))]'
                    : visible
                        ? 'bg-black/[0.04] text-gray-800 hover:bg-black/[0.06]'
                        : 'text-gray-600 hover:bg-black/[0.05] hover:text-gray-900',
            )}
        >
            {dropSide && <span className={cn('absolute top-0.5 bottom-0.5 w-0.5 rounded bg-ide-accent', dropSide === 'left' ? '-left-[3px]' : '-right-[3px]')} />}
            <StatusDot thread={thread} />
            <span className="min-w-0 flex-1 truncate">
                {thread.isEmpty && !thread.persisted ? '新线程' : thread.title}
            </span>
            <button
                type="button"
                aria-label={`关闭 ${thread.title}`}
                title={index < 9 ? `关闭（⌘W）` : '关闭'}
                onClick={(e) => {
                    e.stopPropagation()
                    void closeTabWithConfirm(thread)
                }}
                className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-gray-500 hover:bg-black/[0.08] hover:text-gray-900', active ? 'visible' : 'invisible group-hover:visible')}
            >
                <X size={13} />
            </button>
        </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
                <ThreadActions thread={thread} parts={contextParts} />
            </ContextMenuContent>
        </ContextMenu>
    )
})

/** ⋯ at the end of the tab bar: the same actions for the focused tab. */
const ActiveThreadMenu = observer(() => {
    const thread = appStore.active
    if (!thread)
        return null
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={iconBtn} aria-label="线程操作" title="线程操作（也可右键标签）">
                <MoreHorizontal size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                <ThreadActions thread={thread} parts={dropdownParts} />
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

/** Every session of the active project; open ones are checked. */
const HistoryMenu = observer(() => {
    const project = appStore.project
    if (!project)
        return null
    const open = new Set(appStore.tabs.map(t => t.key))
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={iconBtn} aria-label="全部线程" title="全部线程">
                <ChevronDown size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 max-h-[480px]">
                <DropdownMenuLabel>{`${project.name} 的线程`}</DropdownMenuLabel>
                {project.sessions.length === 0 && <div className="px-2 py-1.5 text-[12px] text-gray-500">还没有线程</div>}
                {project.sessions.map(session => (
                    <DropdownMenuItem key={session.path} onSelect={() => appStore.openSession(session)}>
                        <span className="min-w-0 flex-1 truncate">{appStore.threads.get(session.path)?.title ?? session.name ?? session.firstPrompt?.split('\n')[0] ?? '新线程'}</span>
                        <span className="shrink-0 text-[11px] text-gray-400 tabular-nums">{relativeTime(session.updatedAt)}</span>
                        <span className="w-3.5 shrink-0">{open.has(session.path) && <Check size={14} className="text-ide-accent" />}</span>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => appStore.newThread(project.cwd)}>
                    <Plus size={14} />
                    新线程
                    <span className="ml-auto text-[11px] text-gray-400">⌘T</span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

/** Editor tab strip at the top of the editor island. */
export const TabBar = observer(() => {
    const visible = new Set(appStore.visibleTabs.map(t => t.key))
    return (
        <div className="flex h-[36px] shrink-0 items-center gap-1 bg-ide-panel px-1.5 dark:border-b dark:border-ide-line">
            <div role="tablist" aria-label="线程标签" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-px py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {appStore.tabs.map((thread, i) => (
                    <Tab key={thread.key} thread={thread} index={i} visible={visible.has(thread.key) && appStore.tabs.length > 1} />
                ))}
            </div>
            {appStore.project && (
                <button type="button" aria-label="新线程" title="新线程（⌘T）" onClick={() => appStore.newThread(appStore.project!.cwd)} className={iconBtn}>
                    <Plus size={15} />
                </button>
            )}
            <HistoryMenu />
            <ActiveThreadMenu />
        </div>
    )
})
