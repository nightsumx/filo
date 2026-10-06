// WebStorm-style main toolbar in the window title bar: project widget, VCS branch widget, and the
// layout toggles on the right. The whole strip drags the window; buttons opt out via .app-drag rules.
import type { Project } from '@/store/app'
import { ActivityBadge } from '@/components/StatusIcons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, shortPath } from '@/lib/utils'
import { appStore } from '@/store/app'
import { ChevronDown, Columns3, FolderOpen, FolderPlus, GitBranch, Merge, PanelLeft, PanelRight, Plus, Search, Square, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { useGitStatus } from '../Review/useGitStatus'
import { ProjectBadge } from './ProjectBadge'
import { newThreadLabel, tr } from '@/lib/i18n'

export const toolbarBtn = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-gray-800 outline-none transition-colors hover:bg-black/[0.06] data-[state=open]:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-ide-accent/50 disabled:opacity-40 disabled:hover:bg-transparent'
const iconBtn = cn(toolbarBtn, 'w-7 justify-center px-0 text-gray-600')

const rowAction = 'flex h-5 w-5 items-center justify-center rounded text-gray-500 hover:bg-black/[0.08] hover:text-gray-900'

/** One project in the popup: badge, name, path and branch on three lines, like WebStorm's widget. */
export function ProjectItem({ project, branch, active, current, shortcut, onPick, onHover, onRemove, onAttach }: {
    project: Project
    branch: string | null | undefined
    active: boolean
    current: boolean
    shortcut?: number
    onPick: () => void
    onHover: () => void
    onRemove?: () => void
    /** Bring the project into this window instead of opening its own. */
    onAttach?: () => void
}) {
    const hasActions = !!(onRemove || onAttach)
    return (
        <div
            role="option"
            aria-selected={active}
            data-active={active}
            onMouseMove={onHover}
            onClick={onPick}
            className={cn('group/item relative flex cursor-default gap-2.5 rounded-md px-2 py-[7px]', active && 'bg-ide-sel')}
        >
            <ProjectBadge name={project.name} size={22} className="mt-px rounded-[5px]" />
            <div className="min-w-0 flex-1 leading-[19px]">
                <div className="flex items-center gap-2">
                    <span className={cn('truncate text-[13px] text-gray-900', current && 'font-semibold')}>{project.name}</span>
                    <ActivityBadge activity={appStore.activity(project.cwd)} />
                </div>
                <div className="truncate text-[12.5px] text-gray-500">{shortPath(project.cwd)}</div>
                {branch && (
                    <div className="flex items-center gap-1.5 text-[12.5px] text-gray-500">
                        <GitBranch size={12} className="shrink-0" />
                        <span className="truncate">{branch}</span>
                    </div>
                )}
            </div>
            {shortcut != null && <span className={cn('shrink-0 pt-px text-[11px] text-gray-400', hasActions && 'group-hover/item:invisible')}>{`⌃${shortcut}`}</span>}
            {hasActions && (
                <span className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-hover/item:flex">
                    {onAttach && (
                        <button
                            type="button"
                            aria-label={tr(`把 ${project.name} 移入此窗口`, `Move ${project.name} into this window`)}
                            title={tr('移入此窗口', 'Move into this window')}
                            onClick={(e) => {
                                e.stopPropagation()
                                onAttach()
                            }}
                            className={rowAction}
                        >
                            <Merge size={13} />
                        </button>
                    )}
                    {onRemove && (
                        <button
                            type="button"
                            aria-label={tr(`从列表移除 ${project.name}`, `Remove ${project.name} from list`)}
                            title={tr('从列表移除', 'Remove from list')}
                            onClick={(e) => {
                                e.stopPropagation()
                                onRemove()
                            }}
                            className={rowAction}
                        >
                            <X size={13} />
                        </button>
                    )}
                </span>
            )}
        </div>
    )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return <div className="px-2 pb-1 pt-2 text-[12.5px] font-semibold text-gray-500">{children}</div>
}

/**
 * Project widget popup, laid out like WebStorm's: actions on top, then projects open in some window,
 * then the rest. Picking one brings its window forward (or opens one). No search field; typing
 * filters the list (JetBrains "speed search"). ⌘P toggles it.
 */
const ProjectSwitcher = observer(() => {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [index, setIndex] = useState(0)
    const [branches, setBranches] = useState<Record<string, string | null>>({})
    const listRef = useRef<HTMLDivElement>(null)
    const project = appStore.project
    const all = appStore.projects
    const q = query.trim().toLowerCase()
    const matches = q ? all.filter(p => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q)) : all
    const isOpen = (p: Project) => appStore.isOpen(p.cwd)
    const here = appStore.windowProjects
    const otherWindows = appStore.openProjects.some(p => !here.includes(p.cwd))
    const openProjects = matches.filter(isOpen)
    const recentProjects = matches.filter(p => !isOpen(p))

    // Keyboard order: actions first (when not searching), then open projects, then recent ones.
    const actions = q
        ? []
        : [
                { key: 'new', label: newThreadLabel(), hint: '⌘T', Icon: Plus, run: () => project && appStore.newThread(project.cwd), disabled: !project },
                { key: 'open', label: tr('打开文件夹…', 'Open folder…'), hint: '', Icon: FolderOpen, run: () => void appStore.addProject(), disabled: false },
                ...(otherWindows && here.length ? [{ key: 'merge', label: tr('合并所有窗口', 'Merge all windows'), hint: '', Icon: Merge, run: () => void appStore.mergeAllWindows(), disabled: false }] : []),
            ]
    const items = [...actions.map(a => ({ kind: 'action' as const, a })), ...[...openProjects, ...recentProjects].map(p => ({ kind: 'project' as const, p }))]

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'p') {
                e.preventDefault()
                setOpen(v => !v)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    useEffect(() => {
        if (!open)
            return
        setQuery('')
        // Start on the current project, like WebStorm.
        const ordered = [...all.filter(isOpen), ...all.filter(p => !isOpen(p))]
        setIndex(actions.length + Math.max(0, ordered.findIndex(p => p.cwd === appStore.activeProject)))
        let cancelled = false
        void window.pi.gitBranches(all.map(p => p.cwd)).then(b => !cancelled && setBranches(b))
        return () => {
            cancelled = true
        }
    // Only when the popup opens; the project list is read once per open.
    }, [open])

    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [index, open, query])

    const run = (i: number) => {
        const item = items[i]
        if (!item || (item.kind === 'action' && item.a.disabled))
            return
        setOpen(false)
        if (item.kind === 'action')
            item.a.run()
        else
            appStore.selectProject(item.p.cwd)
    }

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setIndex(i => (i + step + items.length) % Math.max(1, items.length))
        }
        else if (e.key === 'Enter') {
            e.preventDefault()
            run(index)
        }
        else if (e.key === 'Backspace') {
            setQuery(v => v.slice(0, -1))
            setIndex(0)
        }
        else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            setQuery(v => v + e.key)
            setIndex(0)
        }
    }

    const position = (p: Project) => all.indexOf(p)
    const projectRow = (p: Project, i: number) => (
        <ProjectItem
            key={p.cwd}
            project={p}
            branch={branches[p.cwd]}
            active={i === index}
            current={p.cwd === appStore.activeProject}
            shortcut={position(p) < 9 ? position(p) + 1 : undefined}
            onHover={() => setIndex(i)}
            onPick={() => run(i)}
            onRemove={isOpen(p) ? undefined : () => void appStore.removeProject(p.cwd)}
            onAttach={here.length && !here.includes(p.cwd)
                ? () => {
                        setOpen(false)
                        void appStore.attachProject(p.cwd)
                    }
                : undefined}
        />
    )

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger className={cn(toolbarBtn, 'max-w-[280px] pl-1.5 font-semibold')} title={tr('切换项目（⌘P）', 'Switch project (⌘P)')}>
                {project ? <ProjectBadge name={project.name} /> : <FolderPlus size={15} className="text-gray-500" />}
                <span className="truncate">{project?.name ?? tr('选择项目', 'Choose project')}</span>
                <ChevronDown size={13} className="shrink-0 text-gray-500" />
            </PopoverTrigger>
            <PopoverContent
                align="start"
                sideOffset={4}
                className="w-[400px] p-0"
                // Radix sees Escape first (capture phase): with a search typed, Esc only clears it.
                onEscapeKeyDown={(e) => {
                    if (query) {
                        e.preventDefault()
                        setQuery('')
                        setIndex(0)
                    }
                }}
                onOpenAutoFocus={(e) => {
                    e.preventDefault()
                    listRef.current?.focus()
                }}
            >
                <div ref={listRef} tabIndex={-1} role="listbox" aria-label={tr('项目', 'Projects')} onKeyDown={onKeyDown} className="max-h-[min(640px,calc(100vh-80px))] overflow-y-auto p-1 outline-none">
                    {query && (
                        <div className="mb-1 flex h-7 items-center gap-2 rounded-md bg-gray-50 px-2 text-[13px] text-gray-900">
                            <Search size={13} className="text-gray-500" />
                            <span className="truncate">{query}</span>
                        </div>
                    )}
                    {actions.map((a, i) => (
                        <div
                            key={a.key}
                            role="option"
                            aria-selected={i === index}
                            aria-disabled={a.disabled || undefined}
                            data-active={i === index}
                            onMouseMove={() => setIndex(i)}
                            onClick={() => run(i)}
                            className={cn('flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px] text-gray-900', i === index && 'bg-ide-sel', a.disabled && 'opacity-40')}
                        >
                            <a.Icon size={15} className="text-gray-600" />
                            <span className="flex-1">{a.label}</span>
                            {a.hint && <span className="text-[11px] text-gray-400">{a.hint}</span>}
                        </div>
                    ))}
                    {openProjects.length > 0 && (
                        <>
                            {actions.length > 0 && <div className="mx-2 my-1 h-px bg-gray-200" />}
                            <SectionTitle>{tr('打开的项目', 'Open projects')}</SectionTitle>
                            {openProjects.map((p, i) => projectRow(p, actions.length + i))}
                        </>
                    )}
                    {recentProjects.length > 0 && (
                        <>
                            {(actions.length > 0 || openProjects.length > 0) && <div className="mx-2 my-1 h-px bg-gray-200" />}
                            <SectionTitle>{tr('最近的项目', 'Recent projects')}</SectionTitle>
                            {recentProjects.map((p, i) => projectRow(p, actions.length + openProjects.length + i))}
                        </>
                    )}
                    {q && matches.length === 0 && <div className="px-2 py-3 text-[12.5px] text-gray-500">{tr('没有匹配的项目', 'No matching projects')}</div>}
                </div>
            </PopoverContent>
        </Popover>
    )
})

/** Current git branch of the project; clicking it opens the changes panel. */
const BranchWidget = observer(({ cwd }: { cwd: string }) => {
    const { status, totals } = useGitStatus(cwd, appStore.active?.changeTick ?? 0)
    if (!status?.isRepo)
        return null
    const dirty = status.files.length > 0
    return (
        <button
            type="button"
            onClick={appStore.toggleReview}
            disabled={!appStore.active}
            aria-pressed={appStore.reviewOpen}
            title={dirty ? tr(`${status.files.length} 个文件有未提交的改动`, `${status.files.length} ${status.files.length === 1 ? 'file has' : 'files have'} uncommitted changes`) : tr('没有未提交的改动', 'No uncommitted changes')}
            className={cn(toolbarBtn, 'max-w-[260px]', appStore.reviewOpen && 'bg-black/[0.08]')}
        >
            <GitBranch size={14} className="shrink-0 text-gray-500" />
            <span className="truncate">{status.branch || 'HEAD'}</span>
            {dirty && (
                <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
                    <span className="text-emerald-600">{`+${totals.add}`}</span>
                    <span className="ml-1 text-red-500">{`−${totals.del}`}</span>
                </span>
            )}
        </button>
    )
})

export const MainToolbar = observer(() => {
    const split = appStore.layout === 'split'
    const project = appStore.project
    return (
        <header className="app-drag flex h-[38px] shrink-0 items-center gap-1 pl-[78px] pr-2">
            <ProjectSwitcher />
            {project && <BranchWidget cwd={project.cwd} />}
            <span className="min-w-4 flex-1 self-stretch" />
            <button type="button" aria-label={tr('搜索线程', 'Search threads')} title={tr('搜索线程（⌘⇧F）', 'Search threads (⌘⇧F)')} onClick={() => appStore.setSearchOpen(true)} className={iconBtn}>
                <Search size={15} />
            </button>
            <button
                type="button"
                aria-pressed={split}
                aria-label={split ? tr('切换为单栏', 'Switch to single pane') : tr('切换为自动分栏', 'Switch to auto split')}
                title={split ? tr(`自动分栏：当前 ${appStore.visibleTabs.length} 栏（⌘\\）`, `Auto split: ${appStore.visibleTabs.length} panes now (⌘\\)`) : tr('单栏（⌘\\ 切换自动分栏）', 'Single pane (⌘\\ for auto split)')}
                onClick={appStore.toggleLayout}
                className={cn(toolbarBtn, 'text-gray-600')}
            >
                {split ? <Columns3 size={15} /> : <Square size={14} />}
                <span className="text-[12.5px]">{split ? tr('分栏', 'Split') : tr('单栏', 'Single')}</span>
            </button>
            <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-200" />
            <button type="button" aria-pressed={appStore.sidebarOpen} aria-label={tr('项目面板', 'Projects panel')} title={tr('项目面板（⌘B）', 'Projects panel (⌘B)')} onClick={appStore.toggleSidebar} className={cn(iconBtn, appStore.sidebarOpen && 'text-gray-900')}>
                <PanelLeft size={16} />
            </button>
            <button type="button" aria-pressed={appStore.reviewOpen} aria-label={tr('改动面板', 'Changes panel')} title={tr('改动面板', 'Changes panel')} disabled={!appStore.active} onClick={appStore.toggleReview} className={cn(iconBtn, appStore.reviewOpen && 'text-gray-900')}>
                <PanelRight size={16} />
            </button>
        </header>
    )
})
