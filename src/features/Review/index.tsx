import type { GitFileChange, GitFileDiff } from '@shared/ipc'
import type { Thread } from '@/store/thread'
import { DiffBlock } from '@/components/toolPrimitives'
import { cn } from '@/lib/utils'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, GitBranch, Loader2, RefreshCw, Rows2, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
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

function FileDiff({ cwd, file, tick, mode, defaultOpen }: { cwd: string, file: GitFileChange, tick: number, mode: 'unified' | 'split', defaultOpen: boolean }) {
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
                className="sticky top-0 z-[1] flex h-7 w-full items-center gap-1.5 bg-ide-panel px-2 text-left text-[13px] hover:bg-[color-mix(in_srgb,var(--ide-panel),rgb(var(--black))_5%)]"
            >
                <ChevronRight size={14} className={cn('shrink-0 text-gray-500 transition-transform duration-100', open && 'rotate-90')} />
                <span className={cn('w-3 shrink-0 text-center font-mono text-[12px] font-semibold', badge.className)} title={badge.label}>{badge.letter}</span>
                {/* JetBrains file-status colours: name tinted by status, directory dimmed after it. */}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className={cn('shrink-0 truncate', badge.nameClass)}>{file.path.slice(slash + 1)}</span>
                    {slash > 0 && <span className="min-w-0 truncate text-[12px] text-gray-500">{file.path.slice(0, slash)}</span>}
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums">
                    {file.additions > 0 && <span className="text-emerald-600">{`+${file.additions}`}</span>}
                    {file.deletions > 0 && <span className="ml-1 text-red-500">{`−${file.deletions}`}</span>}
                </span>
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

/** Right-hand review pane: uncommitted changes in the thread's folder, like Codex's diff panel. */
export const ReviewPanel = observer(({ thread, onClose }: { thread: Thread, onClose: () => void }) => {
    const { status, loading, refresh, totals } = useGitStatus(thread.cwd, thread.changeTick)
    const [mode, setMode] = useState<'unified' | 'split'>('unified')
    const files = status?.isRepo ? status.files : []
    const autoOpen = totals.add + totals.del <= AUTO_OPEN_LINES
    const [allOpen, setAllOpen] = useState<boolean | null>(null)
    // Expand / collapse all remounts the rows with the new default.
    const [generation, setGeneration] = useState(0)
    const toggleAll = () => {
        setAllOpen(!(allOpen ?? autoOpen))
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
                {files.length > 1 && (
                    <button type="button" aria-label={(allOpen ?? autoOpen) ? tr('全部收起', 'Collapse all') : tr('全部展开', 'Expand all')} title={(allOpen ?? autoOpen) ? tr('全部收起', 'Collapse all') : tr('全部展开', 'Expand all')} onClick={toggleAll} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800">
                        {(allOpen ?? autoOpen) ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                )}
                <button type="button" aria-label={mode === 'unified' ? tr('并排显示', 'Side by side') : tr('合并显示', 'Unified')} title={mode === 'unified' ? tr('并排显示', 'Side by side') : tr('合并显示', 'Unified')} onClick={() => setMode(m => (m === 'unified' ? 'split' : 'unified'))} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800">
                    {mode === 'unified' ? <Columns2 size={14} /> : <Rows2 size={14} />}
                </button>
                <button type="button" aria-label={tr('刷新', 'Refresh')} title={tr('刷新', 'Refresh')} onClick={refresh} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800">
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
                <button type="button" aria-label={tr('关闭改动面板', 'Close changes panel')} onClick={onClose} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800">
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
                {files.map(file => (
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
