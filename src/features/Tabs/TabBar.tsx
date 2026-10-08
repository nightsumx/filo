import type { Thread } from '@/store/thread'
import { ConflictMark } from '@/components/ConflictMark'
import { StatusDot } from '@/components/StatusIcons'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn, relativeTime } from '@/lib/utils'
import type { TabDrag } from '@/store/app'
import { appStore } from '@/store/app'
import { Check, ChevronDown, MoreHorizontal, Plus, X } from 'lucide-react'
import { runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { closeTabWithConfirm, renaming, ThreadActions } from './ThreadActions'
import { newThreadLabel, tr } from '@/lib/i18n'
import { keys } from '@/platform'

const iconBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800 outline-none data-[state=open]:bg-black/[0.08]'

export { closeTabWithConfirm }

const contextParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

const TAB_MIME = 'application/x-pi-tab'

function readDrag(e: React.DragEvent): TabDrag | null {
    try {
        const drag = JSON.parse(e.dataTransfer.getData(TAB_MIME))
        return typeof drag?.key === 'string' && typeof drag.cwd === 'string' && Number.isInteger(drag.window) ? drag : null
    }
    catch {
        return null
    }
}

/** A drop at `index` of the active project's tabs: reorder, or pull the tab in from its window. */
function dropTab(drag: TabDrag, index: number) {
    if (drag.window !== appStore.windowId) {
        void appStore.pullTab(drag, index)
        return
    }
    const from = appStore.tabs.findIndex(t => t.key === drag.key)
    appStore.moveTab(drag.key, from !== -1 && from < index ? index - 1 : index)
}

/**
 * Let go outside every window: the tab tears off into a window of its own, like a browser tab. A drop
 * on another window of the app pulls it there instead (that window's drop handler), so wait a moment
 * and only tear off if it is still here.
 */
function tearOff(thread: Thread, e: React.DragEvent) {
    const { screenX: x, screenY: y } = e
    const inside = x >= window.screenX && x <= window.screenX + window.outerWidth && y >= window.screenY && y <= window.screenY + window.outerHeight
    // The only tab of the window's only project: tearing it off would just move the window.
    const alone = appStore.windowProjects.length === 1 && appStore.tabsOf(thread.cwd).length === 1
    if (e.dataTransfer.dropEffect !== 'none' || inside || alone)
        return
    setTimeout(() => {
        if (appStore.threads.get(thread.key) === thread)
            void appStore.moveTabToWindow(thread.key, null, { at: { x, y } })
    }, 250)
}
const dropdownParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator }

/** In-place title editor: same text, no chrome. Enter / blur saves, Esc cancels. */
const TitleEditor = observer(function TitleEditor({ thread }: { thread: Thread }) {
    const ref = useRef<HTMLInputElement>(null)
    const done = useRef(false)
    useEffect(() => {
        // The menu that started the rename hands focus back to its trigger as it closes; take it after.
        const id = requestAnimationFrame(() => ref.current?.select())
        return () => cancelAnimationFrame(id)
    }, [])
    const finish = async (save: boolean) => {
        if (done.current)
            return
        done.current = true
        const name = ref.current?.value.trim() ?? ''
        runInAction(() => (renaming.key = null))
        if (save && name && name !== thread.title) {
            await thread.rename(name)
            void appStore.refreshSessions()
        }
    }
    return (
        <input
            ref={ref}
            defaultValue={thread.title}
            aria-label={tr('线程名称', 'Thread name')}
            spellCheck={false}
            onBlur={() => void finish(true)}
            onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                    void finish(true)
                else if (e.key === 'Escape')
                    void finish(false)
            }}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            className="min-w-0 flex-1 bg-transparent p-0 text-inherit outline-none selection:bg-ide-accent/25"
        />
    )
})

const Tab = observer(({ thread, index, visible }: { thread: Thread, index: number, visible: boolean }) => {
    const active = appStore.activeKey === thread.key
    const ref = useRef<HTMLDivElement>(null)
    const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null)
    const editing = renaming.key === thread.key

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
            draggable={!editing}
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(TAB_MIME, JSON.stringify({ window: appStore.windowId, key: thread.key, cwd: thread.cwd } satisfies TabDrag))
            }}
            onDragEnd={e => tearOff(thread, e)}
            onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TAB_MIME))
                    return
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                setDropSide(e.clientX < rect.left + rect.width / 2 ? 'left' : 'right')
            }}
            onDragLeave={() => setDropSide(null)}
            onDrop={(e) => {
                const drag = readDrag(e)
                const side = dropSide
                setDropSide(null)
                e.stopPropagation()
                if (!drag || drag.key === thread.key)
                    return
                e.preventDefault()
                dropTab(drag, index + (side === 'right' ? 1 : 0))
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
                // pane get a faint fill so it is clear which tabs are on screen. Every tab has the same
                // fixed width, like WebStorm's: they line up from the left and the strip scrolls once
                // they overflow, so a tab never moves or resizes when others open or close.
                'group relative flex h-[26px] w-[200px] shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[13px] cursor-default outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ide-accent/50',
                active
                    ? 'bg-ide-tab text-gray-900 shadow-[var(--ide-tab-shadow)]'
                    : visible
                        ? 'bg-black/[0.04] text-gray-800 hover:bg-black/[0.06]'
                        : 'text-gray-600 hover:bg-black/[0.05] hover:text-gray-900',
            )}
        >
            {dropSide && <span className={cn('absolute top-0.5 bottom-0.5 w-0.5 rounded bg-ide-accent', dropSide === 'left' ? '-left-[3px]' : '-right-[3px]')} />}
            <StatusDot thread={thread} />
            {editing
                ? <TitleEditor thread={thread} />
                : (
                        <span className="min-w-0 flex-1 truncate">
                            {thread.isEmpty && !thread.persisted ? newThreadLabel() : thread.title}
                        </span>
                    )}
            <ConflictMark cwd={thread.cwd} session={thread.sessionPath} />
            <button
                type="button"
                aria-label={tr(`关闭 ${thread.title}`, `Close ${thread.title}`)}
                title={index < 9 ? tr(`关闭（${keys('⌘W')}）`, `Close (${keys('⌘W')})`) : tr('关闭', 'Close')}
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
            <ContextMenuContent className="w-48" onCloseAutoFocus={e => renaming.key && e.preventDefault()}>
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
            <DropdownMenuTrigger className={iconBtn} aria-label={tr('线程操作', 'Thread actions')} title={tr('线程操作（也可右键标签）', 'Thread actions (or right-click a tab)')}>
                <MoreHorizontal size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" onCloseAutoFocus={e => renaming.key && e.preventDefault()}>
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
            <DropdownMenuTrigger className={iconBtn} aria-label={tr('全部线程', 'All threads')} title={tr('全部线程', 'All threads')}>
                <ChevronDown size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 max-h-[480px]">
                <DropdownMenuLabel>{tr(`${project.name} 的线程`, `Threads in ${project.name}`)}</DropdownMenuLabel>
                {project.sessions.length === 0 && <div className="px-2 py-1.5 text-[12px] text-gray-500">{tr('还没有线程', 'No threads yet')}</div>}
                {project.sessions.map(session => (
                    <DropdownMenuItem key={session.path} onSelect={() => appStore.openSession(session)}>
                        <span className="min-w-0 flex-1 truncate">{appStore.threads.get(session.path)?.title ?? session.name ?? session.firstPrompt?.split('\n')[0] ?? newThreadLabel()}</span>
                        <span className="shrink-0 text-[11px] text-gray-400 tabular-nums">{relativeTime(session.updatedAt)}</span>
                        <span className="w-3.5 shrink-0">{open.has(session.path) && <Check size={14} className="text-ide-accent" />}</span>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => appStore.newThread(project.cwd)}>
                    <Plus size={14} />
                    {newThreadLabel()}
                    <span className="ml-auto text-[11px] text-gray-400">{keys('⌘T')}</span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

/** Editor tab strip at the top of the editor island. */
export const TabBar = observer(() => {
    const visible = new Set(appStore.visibleTabs.map(t => t.key))
    const listRef = useRef<HTMLDivElement>(null)
    // Tabs keep their width, so a narrower window can push the selected one out of view: bring it back.
    useEffect(() => {
        const list = listRef.current
        if (!list)
            return
        const ro = new ResizeObserver(() => list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        ro.observe(list)
        return () => ro.disconnect()
    }, [])
    return (
        <div className="flex h-[36px] shrink-0 items-center gap-1 bg-ide-panel px-1.5">
            <div
                ref={listRef}
                role="tablist"
                aria-label={tr('线程标签', 'Thread tabs')}
                // Space after the last tab: drops land at the end.
                onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(TAB_MIME))
                        return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                    const drag = readDrag(e)
                    if (!drag)
                        return
                    e.preventDefault()
                    dropTab(drag, appStore.tabs.length)
                }}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-px py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {appStore.tabs.map((thread, i) => (
                    <Tab key={thread.id} thread={thread} index={i} visible={visible.has(thread.key) && appStore.tabs.length > 1} />
                ))}
            </div>
            {appStore.project && (
                <button type="button" aria-label={newThreadLabel()} title={tr(`新线程（${keys('⌘T')}）`, `New thread (${keys('⌘T')})`)} onClick={() => appStore.newThread(appStore.project!.cwd)} className={iconBtn}>
                    <Plus size={15} />
                </button>
            )}
            <HistoryMenu />
            <ActiveThreadMenu />
        </div>
    )
})
