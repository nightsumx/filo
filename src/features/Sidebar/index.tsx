// "项目" tool window, laid out like WebStorm's Project view: the window's project is the root node,
// with its path next to the name, and expands into its threads. A merged window lists each of its
// projects as a root. Clicking a thread opens (or focuses) its tab.
import type { SessionSummary } from '@shared/ipc'
import { agentLabel, agentOfKey } from '@shared/agents'
import type { Project } from '@/store/app'
import type { Thread } from '@/store/thread'
import { ConflictMark } from '@/components/ConflictMark'
import type { SubagentRun } from '@/lib/subagents'
import { ActivityBadge, PiGlyph, StatusDot, SubagentMark, TerminalStatus } from '@/components/StatusIcons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { childToolCount, subagentActivity, subagentLive } from '@/lib/subagents'
import { formatElapsed } from '@/lib/threadActivity'
import { cn, relativeTime, shortPath } from '@/lib/utils'
import { appStore } from '@/store/app'
import { AppWindow, ChevronRight, ChevronsDownUp, ChevronsUpDown, EyeOff, FolderOpen, FolderPlus, Minus, MoreHorizontal, Plus, X } from 'lucide-react'
import { confirm } from '@/lib/confirm'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { ProjectBadge } from '../Toolbar/ProjectBadge'
import { newThreadLabel, tr } from '@/lib/i18n'

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
    return appStore.threads.get(session.path)?.title ?? session.name ?? session.firstPrompt?.split('\n')[0] ?? newThreadLabel()
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
                {stalled && <span className="text-amber-600 dark:text-amber-400">{tr(` · ${Math.floor((now - thread.lastEventAt) / 60_000)} 分钟无输出`, ` · no output for ${Math.floor((now - thread.lastEventAt) / 60_000)}m`)}</span>}
            </span>
            {progress && <span className="shrink-0 tabular-nums text-gray-400" title={tr('任务清单进度', 'Todo progress')}>{`${progress.done}/${progress.total}`}</span>}
        </div>
    )
})

const ThreadRow = observer(({ thread, session, selected }: { thread?: Thread, session?: SessionSummary, selected: boolean }) => {
    const open = () => {
        thread?.showSubagent(null)
        if (thread && appStore.tabsOf(thread.cwd).includes(thread))
            appStore.focus(thread.key, true)
        else if (session)
            appStore.openSession(session)
    }
    const title = thread ? (thread.isEmpty && !thread.persisted ? newThreadLabel() : thread.title) : sessionTitle(session!)
    const updated = session?.updatedAt
    const activity = thread?.activity
    const busy = !!activity && activity.phase !== 'idle'
    const running = !!thread?.running
    // A terminal pi on this session: unless one of this window's threads is driving it too.
    const path = thread?.sessionPath ?? session?.path
    const terminal = path && !thread?.agentId ? appStore.terminalSessions.get(path) : undefined
    const terminalBusy = !!terminal && terminal.state !== 'idle'
    const now = useNow(running || terminalBusy)
    const agent = thread?.agent ?? agentOfKey(session?.path)
    return (
        <>
            <div
                role="treeitem"
                aria-level={2}
                aria-selected={selected}
                tabIndex={-1}
                data-tree-row
                title={busy ? `${title}\n${activity!.text}` : terminal ? `${title}\n${tr('终端中的 pi', 'pi in a terminal')}` : title}
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
                    {terminal ? <TerminalStatus presence={terminal} /> : thread ? <StatusDot thread={thread} /> : <PiGlyph dim />}
                    <span className={cn('min-w-0 flex-1 truncate', thread ? 'text-gray-900' : 'text-gray-700')}>{title}</span>
                    {agent !== 'pi' && <span className="shrink-0 text-[11px] text-gray-400">{agentLabel(agent)}</span>}
                    <ConflictMark cwd={thread?.cwd ?? session!.cwd} session={thread?.sessionPath ?? session?.path} />
                    {running
                        ? <span className="shrink-0 text-[11px] tabular-nums text-gray-500" title={tr('已运行', 'Running for')}>{formatElapsed(now - thread!.runStartedAt)}</span>
                        : terminalBusy
                            ? <span className="shrink-0 text-[11px] tabular-nums text-gray-500" title={terminal!.state === 'waiting' ? tr('在终端等待你', 'Waiting in the terminal') : tr('终端运行中', 'Running in the terminal')}>{formatElapsed(now - terminal!.since)}</span>
                            : updated != null && <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{relativeTime(updated)}</span>}
                </div>
                {busy && <ActivityLine thread={thread!} now={now} />}
            </div>
            {thread && <SubagentRows thread={thread} />}
        </>
    )
})

/**
 * The subagents of a thread's run, one level under it: shown while the run goes on (finished ones
 * stay until it ends, so parallel work reads as a set), and the one open in the pane always.
 */
const SubagentRows = observer(({ thread }: { thread: Thread }) => {
    const open = thread.openSubagent
    const runs = thread.running || open ? thread.subagents : []
    const shown = open && !runs.some(r => r.id === open.id) ? [...runs, open] : runs
    const selected = appStore.activeKey === thread.key ? open?.id : undefined
    return shown.map(run => <SubagentRow key={run.id} thread={thread} run={run} selected={run.id === selected} />)
})

const SubagentRow = observer(({ thread, run, selected }: { thread: Thread, run: SubagentRun, selected: boolean }) => {
    const live = subagentLive(run)
    const waiting = live && thread.subagentWaiting(run)
    const now = useNow(live)
    const details = run.details
    const elapsed = details ? (details.endedAt ?? (live ? now : details.startedAt)) - details.startedAt : 0
    const tools = childToolCount(details)
    const activity = waiting ? tr('等你确认', 'Waiting for approval') : live ? subagentActivity(run, thread.cwd) : ''
    const open = () => {
        // View first: the focus request then lands on the subagent's composer.
        thread.showSubagent(run.id)
        appStore.focus(thread.key, true)
    }
    return (
        <div
            role="treeitem"
            aria-level={3}
            aria-selected={selected}
            tabIndex={-1}
            data-tree-row
            title={activity ? `${run.title}\n${activity}` : run.title}
            onClick={open}
            onKeyDown={(e) => {
                if (e.key === 'Enter')
                    open()
                else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
                }
            }}
            className={cn(rowBase, 'pl-[48px]', live && 'h-auto flex-col items-stretch gap-0 pb-1', selected ? rowSelected : 'hover:bg-ide-hover')}
        >
            <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5">
                <SubagentMark status={run.status} waiting={waiting} />
                <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', live ? 'text-gray-900' : 'text-gray-600')}>{run.title}</span>
                {elapsed >= 1000 && <span className={cn('shrink-0 text-[11px] tabular-nums', live ? 'text-gray-500' : 'text-gray-400')}>{formatElapsed(elapsed)}</span>}
            </div>
            {live && (
                <div className="flex h-[18px] min-w-0 items-center gap-1.5 pl-5 text-[12px] leading-none">
                    <span className={cn('min-w-0 flex-1 truncate', waiting ? PHASE_TEXT.waiting : PHASE_TEXT.running)}>{activity}</span>
                    {tools > 0 && <span className="shrink-0 tabular-nums text-gray-400" title={tr('工具调用次数', 'Tool calls')}>{tools}</span>}
                </div>
            )}
        </div>
    )
})

/** Closing stops the project's pi processes; running ones are confirmed first, like closing a tab. */
async function closeProject(cwd: string, remove: boolean) {
    const running = appStore.activity(cwd).running
    if (running) {
        const ok = await confirm({
            title: remove ? tr('从列表移除', 'Remove from list') : tr('关闭项目', 'Close project'),
            description: tr(`有 ${running} 个线程还在运行，关闭会中断它们。`, `${running} ${running === 1 ? 'thread is' : 'threads are'} still running; closing stops them.`),
            confirmText: tr('中断并关闭', 'Stop and close'),
        })
        if (!ok)
            return
    }
    await (remove ? appStore.removeProject(cwd) : appStore.closeProject(cwd))
}

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
                    aria-label={expanded ? tr('折叠', 'Collapse') : tr('展开', 'Expand')}
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
                        aria-label={tr(`在 ${project.name} 中新建线程`, `New thread in ${project.name}`)}
                        title={newThreadLabel()}
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
                        <DropdownMenuTrigger tabIndex={-1} aria-label={tr('项目操作', 'Project actions')} onClick={e => e.stopPropagation()} className={cn(toolBtn, 'h-5 w-5')}>
                            <MoreHorizontal size={13} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" onClick={e => e.stopPropagation()}>
                            <DropdownMenuItem onSelect={() => appStore.newThread(project.cwd)}>
                                <Plus size={14} />
                                {newThreadLabel()}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void window.pi.openFolder(project.cwd)}>
                                <FolderOpen size={14} />
                                {tr('在 Finder 中打开', 'Show in Finder')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {appStore.windowProjects.length > 1 && (
                                <DropdownMenuItem onSelect={() => void appStore.detachProject(project.cwd)}>
                                    <AppWindow size={14} />
                                    {tr('移到新窗口', 'Move to new window')}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => void closeProject(project.cwd, false)}>
                                <X size={14} />
                                {tr('关闭项目', 'Close project')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void closeProject(project.cwd, true)}>
                                <EyeOff size={14} />
                                {tr('从列表移除', 'Remove from list')}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </span>
            </div>
            {expanded && (
                <div role="group">
                    {drafts.map(t => <ThreadRow key={t.key} thread={t} selected={t.key === activeKey && !t.openSubagent} />)}
                    {shown.map(s => (
                        <ThreadRow key={s.path} session={s} thread={tabs.find(t => t.key === s.path)} selected={s.path === activeKey && !tabs.find(t => t.key === s.path)?.openSubagent} />
                    ))}
                    {project.sessions.length > PAGE && (
                        <button
                            type="button"
                            onClick={() => setAll(v => !v)}
                            className="flex h-6 w-full items-center rounded-md pl-[30px] text-left text-[12px] text-gray-500 hover:bg-ide-hover hover:text-gray-800"
                        >
                            {all ? tr('收起', 'Show less') : tr(`显示全部 ${project.sessions.length} 个线程`, `Show all ${project.sessions.length} threads`)}
                        </button>
                    )}
                    {!drafts.length && !project.sessions.length && (
                        <div className="flex h-6 items-center pl-[30px] text-[12px] text-gray-400">{tr('还没有线程', 'No threads yet')}</div>
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

    // One button toggles: collapse all if anything is open, otherwise expand all.
    const anyExpanded = appStore.windowProjectList.some(p => expanded.has(p.cwd))
    const toggleAll = () => setExpanded(anyExpanded ? new Set() : new Set(appStore.windowProjectList.map(p => p.cwd)))
    const toggleAllLabel = anyExpanded ? tr('全部折叠', 'Collapse all') : tr('全部展开', 'Expand all')

    return (
        <nav className="ide-island flex w-[272px] shrink-0 flex-col bg-ide-side" aria-label={tr('项目', 'Projects')}>
            <div className="flex h-[34px] shrink-0 items-center gap-0.5 pl-3 pr-1.5">
                <span className="flex-1 text-[13px] font-semibold text-gray-900">{tr('项目', 'Projects')}</span>
                <button type="button" aria-label={tr('添加项目到此窗口', 'Add project to this window')} title={tr('添加项目到此窗口', 'Add project to this window')} onClick={() => void appStore.addProjectHere()} className={toolBtn}>
                    <FolderPlus size={14} />
                </button>
                <button type="button" aria-label={toggleAllLabel} title={toggleAllLabel} onClick={toggleAll} className={toolBtn}>
                    {anyExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                </button>
                <button type="button" aria-label={tr('隐藏项目面板', 'Hide projects panel')} title={tr('隐藏（⌘B）', 'Hide (⌘B)')} onClick={appStore.toggleSidebar} className={toolBtn}>
                    <Minus size={14} />
                </button>
            </div>
            <div role="tree" aria-label={tr('项目和线程', 'Projects and threads')} className="group/tree flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-trigger">
                {appStore.windowProjectList.map(project => (
                    <ProjectNode
                        key={project.cwd}
                        project={project}
                        index={appStore.projects.findIndex(p => p.cwd === project.cwd)}
                        expanded={expanded.has(project.cwd)}
                        onToggle={open => toggle(project.cwd, open)}
                    />
                ))}
            </div>
        </nav>
    )
})
