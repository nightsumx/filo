import type { GitFileChange, GitFileDiff } from '@shared/ipc'
import type { ChangeNode } from '@/lib/changeTree'
import type { Thread } from '@/store/thread'
import { DiffBlock } from '@/components/toolPrimitives'
import { buildChangeTree, dirPaths } from '@/lib/changeTree'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, Folder, FolderTree, GitBranch, List, Loader2, RefreshCw, Rows2, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useMemo, useState } from 'react'
import { useGitStatus } from './useGitStatus'
import { tr } from '@/lib/i18n'

function statusBadge(status: string): { letter: string, className: string, nameClass: string, label: string } {
    if (status === '??')
        return { letter: 'U', className: 'text-red-500', nameClass: 'text-red-600', label: tr('未跟踪', 'Untracked') }
    if (status.includes('A'))
        return { letter: 'A', className: 'text-emerald-600', nameClass: 'text-emerald-700', label: tr('新增', 'Added') }
    if (status.includes('D'))
        return { letter: 'D', className: 'text-gray-500', nameClass: 'text-gray-500 line-through', label: tr('删除', 'Deleted') }
    if (status.includes('R'))
        return { letter: 'R', className: 'text-blue-500', nameClass: 'text-blue-600', label: tr('重命名', 'Renamed') }
    return { letter: 'M', className: 'text-blue-500', nameClass: 'text-blue-600', label: tr('修改', 'Modified') }
}

/*
 * Rendering cost: every open file is diffed and syntax-highlighted on the main thread, so files start
 * collapsed (only small change sets open by themselves) and large diffs wait for an explicit click.
 */
/** Open everything on first show when the whole change set is at most this many lines. */
const AUTO_OPEN_LINES = 400
/** Above this many changed lines (or bytes of text) a file asks before rendering. */
const LARGE_DIFF_LINES = 1500
const LARGE_DIFF_BYTES = 300 * 1024
/** Highlighting is the slowest part; skip it for big files even after the user opts in. */
const HIGHLIGHT_MAX_BYTES = 120 * 1024

/** Tree rows: chevron column plus this much per level, so a file lines up under its folder's name. */
const INDENT = 16
const rowHover = 'hover:bg-[color-mix(in_srgb,var(--ide-panel),rgb(var(--black))_5%)]'

function Totals({ additions, deletions }: { additions: number, deletions: number }) {
    return (
        <span className="shrink-0 font-mono text-[12px] tabular-nums">
            {additions > 0 && <span className="text-emerald-600">{`+${additions}`}</span>}
            {deletions > 0 && <span className="ml-1 text-red-500">{`−${deletions}`}</span>}
        </span>
    )
}

/**
 * One changed file: a header row that unfolds its diff. In the list the folder follows the name;
 * in the tree (`depth` set) the row is indented under its folder instead. The diff always spans the
 * full panel width, since the panel is narrow.
 */
function FileDiff({ cwd, file, tick, mode, defaultOpen, depth }: { cwd: string, file: GitFileChange, tick: number, mode: 'unified' | 'split', defaultOpen: boolean, depth?: number }) {
    const [open, setOpen] = useState(defaultOpen)
    const [diff, setDiff] = useState<GitFileDiff | null>(null)
    const [error, setError] = useState('')
    const [forced, setForced] = useState(false)
    const badge = statusBadge(file.status)
    const slash = file.path.lastIndexOf('/')
    const changedLines = file.additions + file.deletions
    const size = diff ? diff.oldText.length + diff.newText.length : 0
    const large = changedLines > LARGE_DIFF_LINES || size > LARGE_DIFF_BYTES

    useEffect(() => {
        // Large files are not even fetched until the user asks for them.
        if (!open || file.binary || (changedLines > LARGE_DIFF_LINES && !forced))
            return
        let cancelled = false
        window.pi.gitFileDiff(cwd, file.path, file.status)
            .then(d => !cancelled && setDiff(d))
            .catch(e => !cancelled && setError(String(e?.message ?? e)))
        return () => {
            cancelled = true
        }
    }, [cwd, file.path, file.status, open, tick, file.binary, changedLines, forced])

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                style={depth ? { paddingLeft: 8 + depth * INDENT } : undefined}
                className={cn('sticky top-0 z-[1] flex h-7 w-full items-center gap-1.5 bg-ide-panel px-2 text-left text-[13px]', rowHover)}
            >
                <ChevronRight size={14} className={cn('shrink-0 text-gray-500 transition-transform duration-100', open && 'rotate-90')} />
                <span className={cn('w-3 shrink-0 text-center font-mono text-[12px] font-semibold', badge.className)} title={badge.label}>{badge.letter}</span>
                {/* JetBrains file-status colours: name tinted by status, directory dimmed after it. */}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className={cn('shrink-0 truncate', badge.nameClass)}>{file.path.slice(slash + 1)}</span>
                    {slash > 0 && depth === undefined && <span className="min-w-0 truncate text-[12px] text-gray-500">{file.path.slice(0, slash)}</span>}
                </span>
                <Totals additions={file.additions} deletions={file.deletions} />
            </button>
            {open && (
                <div className="px-2 pb-2 pt-0.5">
                    {file.binary
                        ? <div className="px-1 py-2 text-[12px] text-gray-400">{tr('二进制文件', 'Binary file')}</div>
                        : error
                            ? <div className="px-1 py-2 text-[12px] text-red-500">{error}</div>
                            : large && !forced
                                ? (
                                        <div className="flex items-center gap-3 px-1 py-2 text-[12px] text-gray-400">
                                            <span>{tr(`改动较大（${changedLines} 行），显示可能会卡顿`, `Large change (${changedLines} lines); showing it may be slow`)}</span>
                                            <button type="button" onClick={() => setForced(true)} className="rounded-md px-2 py-1 text-gray-600 hover:bg-black/5 hover:text-gray-800">{tr('仍然显示', 'Show anyway')}</button>
                                        </div>
                                    )
                                : diff
                                    ? <DiffBlock path={file.path} oldStr={diff.oldText} newStr={diff.newText} mode={mode} highlight={size <= HIGHLIGHT_MAX_BYTES} />
                                    : <div className="px-1 py-2 text-[12px] text-gray-400">{tr('加载中…', 'Loading…')}</div>}
                </div>
            )}
        </div>
    )
}

/** Changed files by folder, like the JetBrains Commit tool window; a file row unfolds its diff in place. */
function ChangeTree({ nodes, depth, collapsed, onToggle, cwd, tick, mode, generation }: {
    nodes: ChangeNode[]
    depth: number
    collapsed: ReadonlySet<string>
    onToggle: (path: string) => void
    cwd: string
    tick: number
    mode: 'unified' | 'split'
    generation: number
}) {
    return nodes.map((node) => {
        if (node.kind === 'file')
            return <FileDiff key={`${generation}:${node.file.path}`} cwd={cwd} file={node.file} tick={tick} mode={mode} defaultOpen={false} depth={depth} />
        const open = !collapsed.has(node.path)
        return (
            <div key={node.path} role="group">
                <button
                    type="button"
                    onClick={() => onToggle(node.path)}
                    aria-expanded={open}
                    title={node.path}
                    style={{ paddingLeft: 8 + depth * INDENT }}
                    className={cn('flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[13px]', rowHover)}
                >
                    <ChevronRight size={14} className={cn('shrink-0 text-gray-500 transition-transform duration-100', open && 'rotate-90')} />
                    <Folder size={14} className="shrink-0 text-gray-500" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate text-gray-800">{node.name}</span>
                        <span className="shrink-0 text-[12px] text-gray-500">{tr(`${node.count} 个文件`, `${node.count} ${node.count === 1 ? 'file' : 'files'}`)}</span>
                    </span>
                    <Totals additions={node.additions} deletions={node.deletions} />
                </button>
                {open && <ChangeTree nodes={node.children} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} cwd={cwd} tick={tick} mode={mode} generation={generation} />}
            </div>
        )
    })
}

const headerBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800'

/** Right-hand review pane: uncommitted changes in the thread's folder, as a folder tree or a flat list. */
export const ReviewPanel = observer(({ thread, onClose }: { thread: Thread, onClose: () => void }) => {
    const { status, loading, refresh, totals } = useGitStatus(thread.cwd, thread.changeTick)
    const [mode, setMode] = useState<'unified' | 'split'>('unified')
    const files = status?.isRepo ? status.files : []
    const view = appStore.reviewView
    const tree = useMemo(() => buildChangeTree(files), [files])
    const autoOpen = totals.add + totals.del <= AUTO_OPEN_LINES
    const [allOpen, setAllOpen] = useState<boolean | null>(null)
    // Expand / collapse all remounts the rows with the new default.
    const [generation, setGeneration] = useState(0)
    // Tree: folders start expanded, so new ones show up open; this holds the ones the user folded.
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
    const toggleDir = (path: string) => setCollapsed((c) => {
        const next = new Set(c)
        if (!next.delete(path))
            next.add(path)
        return next
    })
    // List: expand / collapse every diff. Tree: every folder (diffs open one by one).
    const expanded = view === 'tree' ? collapsed.size === 0 : (allOpen ?? autoOpen)
    const canToggleAll = view === 'tree' ? dirPaths(tree).length > 0 : files.length > 1
    const toggleAll = () => {
        if (view === 'tree') {
            setCollapsed(expanded ? new Set(dirPaths(tree)) : new Set())
            return
        }
        setAllOpen(!expanded)
        setGeneration(g => g + 1)
    }

    return (
        <aside className="flex h-full w-full flex-col bg-ide-panel" aria-label={tr('代码改动', 'Code changes')}>
            <div className="flex h-[34px] shrink-0 items-center gap-2 pl-3 pr-1.5">
                <span className="text-[13px] font-semibold text-gray-900">{tr('改动', 'Changes')}</span>
                {status?.isRepo && (
                    <>
                        <span className="flex min-w-0 items-center gap-1 truncate text-[12px] text-gray-500">
                            <GitBranch size={12} />
                            {status.branch}
                        </span>
                        <span className="font-mono text-[12px] tabular-nums">
                            <span className="text-emerald-600">{`+${totals.add}`}</span>
                            <span className="ml-1 text-red-500">{`−${totals.del}`}</span>
                        </span>
                    </>
                )}
                <span className="flex-1" />
                <button
                    type="button"
                    aria-label={view === 'tree' ? tr('改为列表显示', 'Show as list') : tr('改为文件树显示', 'Show as tree')}
                    title={view === 'tree' ? tr('改为列表显示', 'Show as list') : tr('改为文件树显示', 'Show as tree')}
                    onClick={() => appStore.setReviewView(view === 'tree' ? 'list' : 'tree')}
                    className={headerBtn}
                >
                    {view === 'tree' ? <List size={14} /> : <FolderTree size={14} />}
                </button>
                {canToggleAll && (
                    <button type="button" aria-label={expanded ? tr('全部收起', 'Collapse all') : tr('全部展开', 'Expand all')} title={expanded ? tr('全部收起', 'Collapse all') : tr('全部展开', 'Expand all')} onClick={toggleAll} className={headerBtn}>
                        {expanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                )}
                <button type="button" aria-label={mode === 'unified' ? tr('并排显示', 'Side by side') : tr('合并显示', 'Unified')} title={mode === 'unified' ? tr('并排显示', 'Side by side') : tr('合并显示', 'Unified')} onClick={() => setMode(m => (m === 'unified' ? 'split' : 'unified'))} className={headerBtn}>
                    {mode === 'unified' ? <Columns2 size={14} /> : <Rows2 size={14} />}
                </button>
                <button type="button" aria-label={tr('刷新', 'Refresh')} title={tr('刷新', 'Refresh')} onClick={refresh} className={headerBtn}>
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
                <button type="button" aria-label={tr('关闭改动面板', 'Close changes panel')} onClick={onClose} className={headerBtn}>
                    <X size={15} />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto px-1 pb-2">
                {status && !status.isRepo && (
                    <div className="px-6 py-10 text-center text-[13px] text-gray-500">{tr('这个文件夹不是 git 仓库', 'This folder is not a git repository')}</div>
                )}
                {status?.isRepo && files.length === 0 && (
                    <div className="px-6 py-10 text-center text-[13px] text-gray-500">{tr('没有未提交的改动', 'No uncommitted changes')}</div>
                )}
                {view === 'tree' && <ChangeTree nodes={tree} depth={0} collapsed={collapsed} onToggle={toggleDir} cwd={thread.cwd} tick={thread.changeTick} mode={mode} generation={generation} />}
                {view === 'list' && files.map(file => (
                    <FileDiff
                        key={`${generation}:${file.path}`}
                        cwd={thread.cwd}
                        file={file}
                        tick={thread.changeTick}
                        mode={mode}
                        // "Expand all" still leaves large files behind their own click.
                        defaultOpen={allOpen ?? autoOpen}
                    />
                ))}
            </div>
        </aside>
    )
})
