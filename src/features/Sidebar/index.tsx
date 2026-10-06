// "项目" tool window, laid out like WebStorm's Project view: each project is a root node with its
// path next to the name, and expands into its threads. Clicking a thread opens (or focuses) its tab.
import type { SessionSummary } from '@shared/ipc'
import type { Project } from '@/store/app'
import type { Thread } from '@/store/thread'
import { ActivityBadge, PiGlyph, StatusDot } from '@/components/StatusIcons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatElapsed } from '@/lib/threadActivity'
import { cn, relativeTime, shortPath } from '@/lib/utils'
import { appStore } from '@/store/app'
import { ChevronRight, ChevronsDownUp, EyeOff, FolderOpen, FolderPlus, Minus, MoreHorizontal, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { ProjectBadge } from '../Toolbar/ProjectBadge'

/** Threads listed per project before a "show more" row. */
const PAGE = 12

const toolBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 outline-none hover:bg-black/[0.06] hover:text-gray-800 data-[state=open]:bg-black/[0.08]'

// Row look shared by both levels. The tree container is `group/tree`: selection is blue while the
// tree has keyboard focus and gray otherwise, as in JetBrains IDEs.
const rowBase = 'group/row flex h-6 cursor-default items-center gap-1.5 rounded-md pr-1.5 text-[13px] outline-none'
const rowSelected = 'bg-ide-sel-muted group-focus-within/tree:bg-ide-sel'

/** Up/Down walk the visible rows; Left/Right collapse/expand projects (handled per row). */
function moveFocus(from: HTMLElement, step: number) {
    const tree = from.closest('[role="tree"]')
    if (!tree)
        return
    const rows = [...tree.querySelectorAll<HTMLElement>('[data-tree-row]')]
    rows[rows.indexOf(from) + step]?.focus()
}

function sessionTitle(session: SessionSummary): string {
    return appStore.threads.get(session.path)?.title ?? session.name ?? session.firstPrompt?.split('\n')[0] ?? '新线程'
}

/** A run with no pi event for this long gets a "no output" hint. */
const STALL_MS = 60_000

/** Re-renders every second while `active`, for elapsed times. */
function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        if (!active)
            return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [active])
    return now
}

const PHASE_TEXT = {
    waiting: 'text-amber-600 dark:text-amber-400',
    running: 'text-gray-500',
    error: 'text-red-500',
    idle: '',
} as const

/** Second line of a busy thread: what it is doing (or waiting on / failed with) and todo progress. */
const ActivityLine = observer(({ thread, now }: { thread: Thread, now: number }) => {
    const { phase, text, progress } = thread.activity
    const stalled = phase === 'running' && thread.lastEventAt > 0 && now - thread.lastEventAt > STALL_MS
    return (
        <div className="flex h-[18px] min-w-0 items-center gap-1.5 pl-5 text-[12px] leading-none">
            <span className={cn('min-w-0 flex-1 truncate', PHASE_TEXT[phase])}>
                {text}
                {stalled && <span className="text-amber-600 dark:text-amber-400">{` · ${Math.floor((now - thread.lastEventAt) / 60_000)} 分钟无输出`}</span>}
            </span>
            {progress && <span className="shrink-0 tabular-nums text-gray-400" title="任务清单进度">{`${progress.done}/${progress.total}`}</span>}
        </div>
    )
})

const ThreadRow = observer(({ thread, session, selected }: { thread?: Thread, session?: SessionSummary, selected: boolean }) => {
    const open = () => {
        if (thread && appStore.tabsOf(thread.cwd).includes(thread))
            appStore.focus(thread.key, true)
        else if (session)
            appStore.openSession(session)
    }
    const title = thread ? (thread.isEmpty && !thread.persisted ? '新线程' : thread.title) : sessionTitle(session!)
    const updated = session?.updatedAt
    const activity = thread?.activity
    const busy = !!activity && activity.phase !== 'idle'
    const running = !!thread?.running
    const now = useNow(running)
    return (
        <div
            role="treeitem"
            aria-level={2}
            aria-selected={selected}
            tabIndex={-1}
            data-tree-row
            title={busy ? `${title}\n${activity!.text}` : title}
            onClick={open}
            onKeyDown={(e) => {
                if (e.key === 'Enter')
                    open()
                else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
                }
            }}
            className={cn(rowBase, 'pl-[30px]', busy && 'h-auto flex-col items-stretch gap-0 pb-1', selected ? rowSelected : 'hover:bg-ide-hover')}
        >
            <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5">
                {thread ? <StatusDot thread={thread} /> : <PiGlyph dim />}
                <span className={cn('min-w-0 flex-1 truncate', thread ? 'text-gray-900' : 'text-gray-700')}>{title}</span>
                {running
                    ? <span className="shrink-0 text-[11px] tabular-nums text-gray-500" title="已运行">{formatElapsed(now - thread!.runStartedAt)}</span>
                    : updated != null && <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{relativeTime(updated)}</span>}
            </div>
            {busy && <ActivityLine thread={thread!} now={now} />}
        </div>
    )
})

const ProjectNode = observer(({ project, index, expanded, onToggle }: { project: Project, index: number, expanded: boolean, onToggle: (open?: boolean) => void }) => {
    const [menuOpen, setMenuOpen] = useState(false)
    const [all, setAll] = useState(false)
    const active = appStore.activeProject === project.cwd
    const activity = appStore.activity(project.cwd)
    const tabs = appStore.tabsOf(project.cwd)
    const activeKey = active ? appStore.activeKey : null

    // Unsaved new tabs first, then every session (most recent first); open sessions use their Thread.
    const drafts = tabs.filter(t => !t.persisted && !project.sessions.some(s => s.path === t.key))
    const shown = all ? project.sessions : project.sessions.slice(0, PAGE)

    const select = () => {
        appStore.selectProject(project.cwd)
        onToggle(true)
    }

    return (
        <div role="group">
            <div
                role="treeitem"
                aria-level={1}
                aria-expanded={expanded}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-tree-row
                title={index < 9 ? `${project.cwd}（⌃${index + 1}）` : project.cwd}
                onClick={select}
                onDoubleClick={() => onToggle()}
                onKeyDown={(e) => {
                    if (e.key === 'Enter')
                        select()
                    else if (e.key === 'ArrowRight')
                        onToggle(true)
                    else if (e.key === 'ArrowLeft')
                        onToggle(false)
                    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
                    }
                }}
                className={cn(rowBase, 'pl-1', active && !activeKey ? rowSelected : 'hover:bg-ide-hover')}
            >
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={expanded ? '折叠' : '展开'}
                    onClick={(e) => {
                        e.stopPropagation()
                        onToggle()
                    }}
                    className="flex h-5 w-4 shrink-0 items-center justify-center text-gray-500"
                >
                    <ChevronRight size={14} className={cn('transition-transform duration-100', expanded && 'rotate-90')} />
                </button>
                <ProjectBadge name={project.name} size={16} className="rounded-[4px]" />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className={cn('shrink-0 truncate text-gray-900', active && 'font-semibold')}>{project.name}</span>
                    <span className="min-w-0 truncate text-[12px] text-gray-500">{shortPath(project.cwd).replace(/\/[^/]+$/, '') || '/'}</span>
                </span>
                <span className={cn('flex shrink-0 items-center', menuOpen ? 'hidden' : 'group-hover/row:hidden')}>
                    <ActivityBadge activity={activity} />
                </span>
                <span className={cn('shrink-0 items-center', menuOpen ? 'flex' : 'hidden group-hover/row:flex')}>
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`在 ${project.name} 中新建线程`}
                        title="新线程"
                        onClick={(e) => {
                            e.stopPropagation()
                            appStore.newThread(project.cwd)
                            onToggle(true)
                        }}
                        className={cn(toolBtn, 'h-5 w-5')}
                    >
                        <Plus size={13} />
                    </button>
                    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                        <DropdownMenuTrigger tabIndex={-1} aria-label="项目操作" onClick={e => e.stopPropagation()} className={cn(toolBtn, 'h-5 w-5')}>
                            <MoreHorizontal size={13} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" onClick={e => e.stopPropagation()}>
                            <DropdownMenuItem onSelect={() => appStore.newThread(project.cwd)}>
                                <Plus size={14} />
                                新线程
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void window.pi.openFolder(project.cwd)}>
                                <FolderOpen size={14} />
                                在 Finder 中打开
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => void appStore.removeProject(project.cwd)}>
                                <EyeOff size={14} />
                                从列表移除
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </span>
            </div>
            {expanded && (
                <div role="group">
                    {drafts.map(t => <ThreadRow key={t.key} thread={t} selected={t.key === activeKey} />)}
                    {shown.map(s => (
                        <ThreadRow key={s.path} session={s} thread={tabs.find(t => t.key === s.path)} selected={s.path === activeKey} />
                    ))}
                    {project.sessions.length > PAGE && (
                        <button
                            type="button"
                            onClick={() => setAll(v => !v)}
                            className="flex h-6 w-full items-center rounded-md pl-[30px] text-left text-[12px] text-gray-500 hover:bg-ide-hover hover:text-gray-800"
                        >
                            {all ? '收起' : `显示全部 ${project.sessions.length} 个线程`}
                        </button>
                    )}
                    {!drafts.length && !project.sessions.length && (
                        <div className="flex h-6 items-center pl-[30px] text-[12px] text-gray-400">还没有线程</div>
                    )}
                </div>
            )}
        </div>
    )
})

export const Sidebar = observer(() => {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(appStore.activeProject ? [appStore.activeProject] : []))
    const active = appStore.activeProject

    // Switching project from elsewhere (⌘P, ⌃1–9) reveals it in the tree.
    useEffect(() => {
        if (active)
            setExpanded(s => (s.has(active) ? s : new Set(s).add(active)))
    }, [active])

    const toggle = (cwd: string, open?: boolean) => setExpanded((s) => {
        const next = new Set(s)
        if (open ?? !next.has(cwd))
            next.add(cwd)
        else
            next.delete(cwd)
        return next
    })

    return (
        <nav className="ide-island flex w-[272px] shrink-0 flex-col bg-ide-panel" aria-label="项目">
            <div className="flex h-[34px] shrink-0 items-center gap-0.5 pl-3 pr-1.5">
                <span className="flex-1 text-[13px] font-semibold text-gray-900">项目</span>
                <button type="button" aria-label="添加项目" title="添加项目" onClick={() => void appStore.addProject()} className={toolBtn}>
                    <FolderPlus size={14} />
                </button>
                <button type="button" aria-label="全部折叠" title="全部折叠" onClick={() => setExpanded(new Set())} className={toolBtn}>
                    <ChevronsDownUp size={14} />
                </button>
                <button type="button" aria-label="隐藏项目面板" title="隐藏（⌘B）" onClick={appStore.toggleSidebar} className={toolBtn}>
                    <Minus size={14} />
                </button>
            </div>
            <div role="tree" aria-label="项目和线程" className="group/tree flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-trigger">
                {appStore.projects.map((project, i) => (
                    <ProjectNode
                        key={project.cwd}
                        project={project}
                        index={i}
                        expanded={expanded.has(project.cwd)}
                        onToggle={open => toggle(project.cwd, open)}
                    />
                ))}
                {appStore.projects.length === 0 && (
                    <button
                        type="button"
                        onClick={() => void appStore.addProject()}
                        className="mx-1.5 mt-2 w-[calc(100%-0.75rem)] rounded-lg border border-dashed border-gray-300 px-3 py-6 text-[12px] text-gray-500 hover:border-gray-400 hover:text-gray-700"
                    >
                        添加一个项目文件夹开始
                    </button>
                )}
            </div>
        </nav>
    )
})
