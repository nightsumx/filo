import type { FileEditor, GitFileChange, GitFileDiff } from '@shared/ipc'
import type { ChangeDir, ChangeNode } from '@/lib/changeTree'
import type { Thread } from '@/store/thread'
import { DiffBlock } from '@/components/toolPrimitives'
import { buildChangeTree, dirPaths } from '@/lib/changeTree'
import { confirm } from '@/lib/confirm'
import { editedBy } from '@/lib/edits'
import { previewOf, TEXT_PREVIEWS } from '@/lib/filePreview'
import { cn, relativeTime } from '@/lib/utils'
import { appStore } from '@/store/app'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, Folder, FolderTree, GitBranch, List, Loader2, RefreshCw, Rows2, TriangleAlert, Undo2, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FilePreview } from './FilePreview'
import { Segmented } from './previewParts'
import { TextPreview } from './TextPreview'
import { useGitStatus } from './useGitStatus'
import { newThreadLabel, tr } from '@/lib/i18n'
import { keys } from '@/platform'

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
const headerBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800'
const rowAction = 'hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-black/[0.08] hover:text-gray-800 group-hover/row:flex'

function Totals({ additions, deletions }: { additions: number, deletions: number }) {
    return (
        <span className="shrink-0 font-mono text-[12px] tabular-nums">
            {additions > 0 && <span className="text-emerald-600">{`+${additions}`}</span>}
            {deletions > 0 && <span className="ml-1 text-red-500">{`−${deletions}`}</span>}
        </span>
    )
}

/** Commit selection box; `mixed` for a folder with some files picked. */
function Check({ checked, mixed, onChange, label }: { checked: boolean, mixed?: boolean, onChange: (checked: boolean) => void, label: string }) {
    const ref = useRef<HTMLInputElement>(null)
    useLayoutEffect(() => {
        if (ref.current)
            ref.current.indeterminate = !!mixed
    }, [mixed])
    return (
        <input
            ref={ref}
            type="checkbox"
            checked={checked}
            aria-label={label}
            onClick={e => e.stopPropagation()}
            onChange={e => onChange(e.target.checked)}
            className="size-[13px] shrink-0 cursor-default accent-[var(--ide-accent)] outline-none"
        />
    )
}

/** What the panel knows about each file besides git: who else changed it, whether it is picked. */
interface RowContext {
    cwd: string
    tick: number
    mode: 'unified' | 'split'
    /** Other sessions that edited the file (the thread's own excluded); empty when it is not shared. */
    othersOf: (path: string) => FileEditor[]
    isChecked: (path: string) => boolean
    setChecked: (paths: string[], checked: boolean) => void
    discard: (files: GitFileChange[]) => void
}

function othersTitle(others: FileEditor[]): string {
    const names = others.map(o => `「${o.title || newThreadLabel()}」${relativeTime(o.at)}`).join('\n')
    return tr(`也被其他线程改过：\n${names}`, `Also changed by:\n${names}`)
}

/**
 * One changed file: a header row that unfolds its diff. In the list the folder follows the name;
 * in the tree (`depth` set) the row is indented under its folder instead. The diff always spans the
 * full panel width, since the panel is narrow.
 */
const FileDiff = observer(function FileDiff({ file, ctx, defaultOpen, depth }: { file: GitFileChange, ctx: RowContext, defaultOpen: boolean, depth?: number }) {
    const { cwd, tick, mode } = ctx
    const [open, setOpen] = useState(defaultOpen)
    const [diff, setDiff] = useState<GitFileDiff | null>(null)
    const [error, setError] = useState('')
    const [forced, setForced] = useState(false)
    const badge = statusBadge(file.status)
    const slash = file.path.lastIndexOf('/')
    const changedLines = file.additions + file.deletions
    const size = diff ? diff.oldText.length + diff.newText.length : 0
    const large = changedLines > LARGE_DIFF_LINES || size > LARGE_DIFF_BYTES
    const others = ctx.othersOf(file.path)
    // Binary formats show as themselves; text formats (Markdown, SVG, CSV, RTF...) switch between
    // their diff and the rendered file. So does a text file under a QuickLook name (a PEM .key).
    const preview = previewOf(file.path)
    const switchable = !!preview && !file.binary && (TEXT_PREVIEWS.has(preview.kind) || preview.kind === 'quicklook')
    const [view, setView] = useState<'diff' | 'preview'>(preview?.kind === 'svg' || preview?.kind === 'notebook' ? 'preview' : 'diff')
    const textDiff = !file.binary && (!preview || switchable)
    const showPreview = !!preview && (!switchable || view === 'preview')
    const showDiff = textDiff && (!switchable || view === 'diff')

    useEffect(() => {
        // Large files are not even fetched until the user asks for them (or for their rendering).
        if (!open || !textDiff || (changedLines > LARGE_DIFF_LINES && !forced && !(switchable && view === 'preview')))
            return
        let cancelled = false
        window.pi.gitFileDiff(cwd, file.path, file.status)
            .then(d => !cancelled && setDiff(d))
            .catch(e => !cancelled && setError(String(e?.message ?? e)))
        return () => {
            cancelled = true
        }
    }, [cwd, file.path, file.status, open, tick, textDiff, changedLines, forced, switchable, view])

    return (
        <div>
            <div
                role="button"
                tabIndex={0}
                onClick={() => setOpen(v => !v)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpen(v => !v)
                    }
                }}
                aria-expanded={open}
                title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                style={depth ? { paddingLeft: 8 + depth * INDENT } : undefined}
                className={cn('group/row sticky top-0 z-[1] flex h-7 w-full cursor-default items-center gap-1.5 bg-ide-panel px-2 text-left text-[13px] outline-none', rowHover)}
            >
                <ChevronRight size={14} className={cn('shrink-0 text-gray-500 transition-transform duration-100', open && 'rotate-90')} />
                <Check checked={ctx.isChecked(file.path)} onChange={c => ctx.setChecked([file.path], c)} label={tr(`提交 ${file.path}`, `Commit ${file.path}`)} />
                <span className={cn('w-3 shrink-0 text-center font-mono text-[12px] font-semibold', badge.className)} title={badge.label}>{badge.letter}</span>
                {/* JetBrains file-status colours: name tinted by status, directory dimmed after it. */}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className={cn('shrink-0 truncate', badge.nameClass)}>{file.path.slice(slash + 1)}</span>
                    {slash > 0 && depth === undefined && <span className="min-w-0 truncate text-[12px] text-gray-500">{file.path.slice(0, slash)}</span>}
                </span>
                {others.length > 0 && (
                    <span className="flex shrink-0 items-center text-amber-600 dark:text-amber-400" title={othersTitle(others)} aria-label={othersTitle(others)}>
                        <TriangleAlert size={13} />
                    </span>
                )}
                <button
                    type="button"
                    aria-label={tr(`回滚 ${file.path}`, `Roll back ${file.path}`)}
                    title={tr('回滚', 'Roll back')}
                    onClick={(e) => {
                        e.stopPropagation()
                        ctx.discard([file])
                    }}
                    className={rowAction}
                >
                    <Undo2 size={13} />
                </button>
                <Totals additions={file.additions} deletions={file.deletions} />
            </div>
            {open && (
                <div className="flex flex-col gap-2 px-2 pb-2 pt-0.5">
                    {switchable && (
                        <Segmented
                            options={[{ value: 'diff', label: tr('改动', 'Changes') }, { value: 'preview', label: tr('预览', 'Preview') }]}
                            value={view}
                            onChange={setView}
                            label={tr('显示方式', 'Show as')}
                        />
                    )}
                    {showPreview && preview && (preview.kind === 'svg' || !TEXT_PREVIEWS.has(preview.kind)
                        ? <FilePreview cwd={cwd} file={file} kind={preview.kind} mime={preview.mime} tick={tick} />
                        : error
                            ? <div className="px-1 py-2 text-[12px] text-red-500">{error}</div>
                            : diff
                                ? <TextPreview kind={preview.kind} name={file.path.slice(slash + 1)} diff={diff} added={file.status === '??' || file.status[0] === 'A'} deleted={file.status.includes('D')} />
                                : <div className="px-1 py-2 text-[12px] text-gray-400">{tr('加载中…', 'Loading…')}</div>)}
                    {!preview && file.binary && <div className="px-1 py-2 text-[12px] text-gray-400">{tr('二进制文件', 'Binary file')}</div>}
                    {showDiff && (error
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
                                    : <div className="px-1 py-2 text-[12px] text-gray-400">{tr('加载中…', 'Loading…')}</div>)}
                </div>
            )}
        </div>
    )
})

function filesUnder(dir: ChangeDir): GitFileChange[] {
    return dir.children.flatMap(n => (n.kind === 'file' ? [n.file] : filesUnder(n)))
}

/** Changed files by folder, like the JetBrains Commit tool window; a file row unfolds its diff in place. */
const ChangeTree = observer(function ChangeTree({ nodes, depth, collapsed, onToggle, ctx, generation }: {
    nodes: ChangeNode[]
    depth: number
    collapsed: ReadonlySet<string>
    onToggle: (path: string) => void
    ctx: RowContext
    generation: number
}) {
    return nodes.map((node) => {
        if (node.kind === 'file')
            return <FileDiff key={`${generation}:${node.file.path}`} file={node.file} ctx={ctx} defaultOpen={false} depth={depth} />
        const open = !collapsed.has(node.path)
        const files = filesUnder(node)
        const picked = files.filter(f => ctx.isChecked(f.path)).length
        return (
            <div key={node.path} role="group">
                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onToggle(node.path)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onToggle(node.path)
                        }
                    }}
                    aria-expanded={open}
                    title={node.path}
                    style={{ paddingLeft: 8 + depth * INDENT }}
                    className={cn('group/row flex h-7 w-full cursor-default items-center gap-1.5 pr-2 text-left text-[13px] outline-none', rowHover)}
                >
                    <ChevronRight size={14} className={cn('shrink-0 text-gray-500 transition-transform duration-100', open && 'rotate-90')} />
                    <Check
                        checked={picked === files.length}
                        mixed={picked > 0 && picked < files.length}
                        onChange={c => ctx.setChecked(files.map(f => f.path), c)}
                        label={tr(`提交 ${node.path} 下的文件`, `Commit files in ${node.path}`)}
                    />
                    <Folder size={14} className="shrink-0 text-gray-500" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate text-gray-800">{node.name}</span>
                        <span className="shrink-0 text-[12px] text-gray-500">{tr(`${node.count} 个文件`, `${node.count} ${node.count === 1 ? 'file' : 'files'}`)}</span>
                    </span>
                    <button
                        type="button"
                        aria-label={tr(`回滚 ${node.path}`, `Roll back ${node.path}`)}
                        title={tr('回滚此文件夹', 'Roll back this folder')}
                        onClick={(e) => {
                            e.stopPropagation()
                            ctx.discard(files)
                        }}
                        className={rowAction}
                    >
                        <Undo2 size={13} />
                    </button>
                    <Totals additions={node.additions} deletions={node.deletions} />
                </div>
                {open && <ChangeTree nodes={node.children} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} ctx={ctx} generation={generation} />}
            </div>
        )
    })
})

/** Rollback asks first: tracked changes are gone for good, new files go to the Trash. */
async function confirmDiscard(files: GitFileChange[]): Promise<boolean> {
    const fresh = files.filter(f => f.status === '??' || f.status[0] === 'A' || f.status[0] === 'R' || f.status[0] === 'C').length
    const tracked = files.length - fresh
    const what = files.length === 1 ? `「${files[0].path}」` : tr(`${files.length} 个文件`, `${files.length} files`)
    const parts = [
        tracked && tr('已跟踪的改动会恢复到上次提交，无法撤销。', 'Tracked changes go back to the last commit; this cannot be undone.'),
        fresh && tr('新文件会移到废纸篓。', 'New files are moved to the Trash.'),
    ].filter(Boolean)
    return confirm({
        title: tr(`回滚${what}？`, `Roll back ${what}?`),
        description: parts.join(' '),
        confirmText: tr('回滚', 'Roll back'),
    })
}

type Scope = 'all' | 'thread'

/** Right-hand review pane: uncommitted changes in the thread's folder, as a folder tree or a flat list. */
export const ReviewPanel = observer(({ thread, onClose }: { thread: Thread, onClose: () => void }) => {
    const { status, loading, refresh } = useGitStatus(thread.cwd, thread.changeTick)
    const [mode, setMode] = useState<'unified' | 'split'>('unified')
    const [scope, setScope] = useState<Scope>('all')
    const allFiles = status?.isRepo ? status.files : []
    const editors = appStore.edits.get(thread.cwd)
    const own = useMemo(() => editedBy(editors, thread.sessionPath), [editors, thread.sessionPath])
    const files = useMemo(() => (scope === 'thread' ? allFiles.filter(f => own.has(f.path)) : allFiles), [scope, allFiles, own])
    const totals = files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 })
    const view = appStore.reviewView
    const tree = useMemo(() => buildChangeTree(files), [files])
    const autoOpen = totals.add + totals.del <= AUTO_OPEN_LINES
    const [allOpen, setAllOpen] = useState<boolean | null>(null)
    // Expand / collapse all remounts the rows with the new default.
    const [generation, setGeneration] = useState(0)
    // Tree: folders start expanded, so new ones show up open; this holds the ones the user folded.
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
    // Commit selection: everything is picked unless unticked, so files that appear later are in.
    const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
    const [message, setMessage] = useState('')
    const [committing, setCommitting] = useState(false)
    const picked = files.filter(f => !unchecked.has(f.path))

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

    const changed = () => {
        refresh()
        appStore.refreshEdits(thread.cwd)
    }
    const discard = async (list: GitFileChange[]) => {
        if (!list.length || !(await confirmDiscard(list)))
            return
        try {
            await window.pi.gitDiscard(thread.cwd, list.map(f => ({ path: f.path, status: f.status, origPath: f.origPath })))
        }
        catch (error: any) {
            toast.error(tr('回滚失败', 'Rollback failed'), { description: error.message })
        }
        changed()
    }
    const commit = async () => {
        if (!picked.length || !message.trim() || committing)
            return
        setCommitting(true)
        try {
            const paths = picked.flatMap(f => (f.origPath ? [f.path, f.origPath] : [f.path]))
            const hash = await window.pi.gitCommit(thread.cwd, message, paths)
            setMessage('')
            toast.success(tr(`已提交 ${hash}`, `Committed ${hash}`), { description: tr(`${picked.length} 个文件`, `${picked.length} ${picked.length === 1 ? 'file' : 'files'}`) })
        }
        catch (error: any) {
            toast.error(tr('提交失败', 'Commit failed'), { description: error.message })
        }
        finally {
            setCommitting(false)
            changed()
        }
    }

    const ctx: RowContext = {
        cwd: thread.cwd,
        tick: thread.changeTick,
        mode,
        // Flagged once two sessions changed a file; the tooltip names the ones other than this thread.
        othersOf: (path) => {
            const list = editors?.[path] ?? []
            return list.length > 1 ? list.filter(e => e.session !== thread.sessionPath) : []
        },
        isChecked: path => !unchecked.has(path),
        setChecked: (paths, checked) => setUnchecked((u) => {
            const next = new Set(u)
            for (const p of paths) {
                if (checked)
                    next.delete(p)
                else
                    next.add(p)
            }
            return next
        }),
        discard: list => void discard(list),
    }
    const scopeBtn = (value: Scope, label: string, count: number) => (
        <button
            type="button"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            className={cn('flex h-[22px] items-center gap-1 rounded-md px-2 text-[12px]', scope === value ? 'bg-black/[0.07] text-gray-900' : 'text-gray-500 hover:text-gray-800')}
        >
            {label}
            <span className="tabular-nums text-gray-500">{count}</span>
        </button>
    )
    const sharedCount = files.filter(f => (editors?.[f.path]?.length ?? 0) > 1).length

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
                <button type="button" aria-label={tr('刷新', 'Refresh')} title={tr('刷新', 'Refresh')} onClick={changed} className={headerBtn}>
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
                <button type="button" aria-label={tr('关闭改动面板', 'Close changes panel')} onClick={onClose} className={headerBtn}>
                    <X size={15} />
                </button>
            </div>
            {status?.isRepo && allFiles.length > 0 && (
                <div className="flex h-7 shrink-0 items-center gap-0.5 px-2">
                    {scopeBtn('all', tr('全部', 'All'), allFiles.length)}
                    {scopeBtn('thread', tr('本线程', 'This thread'), own.size)}
                    <span className="flex-1" />
                    {sharedCount > 0 && (
                        <span className="flex items-center gap-1 text-[12px] text-amber-600 dark:text-amber-400" title={tr('自上次提交以来，这些文件被不止一个线程改过，提交前看一下', 'More than one thread changed these files since the last commit; check before committing')}>
                            <TriangleAlert size={12} />
                            {tr(`${sharedCount} 个文件被多个线程改过`, `${sharedCount} changed by several threads`)}
                        </span>
                    )}
                </div>
            )}
            <div className="flex-1 overflow-y-auto px-1 pb-2">
                {status && !status.isRepo && (
                    <div className="px-6 py-10 text-center text-[13px] text-gray-500">{tr('这个文件夹不是 git 仓库', 'This folder is not a git repository')}</div>
                )}
                {status?.isRepo && allFiles.length === 0 && (
                    <div className="px-6 py-10 text-center text-[13px] text-gray-500">{tr('没有未提交的改动', 'No uncommitted changes')}</div>
                )}
                {status?.isRepo && allFiles.length > 0 && files.length === 0 && (
                    <div className="px-6 py-10 text-center text-[13px] text-gray-500">{tr('这个线程还没改过文件（只统计 edit / write 工具）', 'This thread has not changed any files yet (edit / write tools only)')}</div>
                )}
                {view === 'tree' && <ChangeTree nodes={tree} depth={0} collapsed={collapsed} onToggle={toggleDir} ctx={ctx} generation={generation} />}
                {view === 'list' && files.map(file => (
                    // "Expand all" still leaves large files behind their own click.
                    <FileDiff key={`${generation}:${file.path}`} file={file} ctx={ctx} defaultOpen={allOpen ?? autoOpen} />
                ))}
            </div>
            {status?.isRepo && files.length > 0 && (
                <div className="shrink-0 px-2 pb-2 pt-1">
                    <textarea
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault()
                                void commit()
                            }
                        }}
                        rows={3}
                        aria-label={tr('提交说明', 'Commit message')}
                        placeholder={tr('提交说明', 'Commit message')}
                        className="block w-full resize-none rounded-md bg-ide-editor px-2 py-1.5 text-[13px] text-gray-900 outline-none placeholder:text-gray-400 light:bg-ide-block"
                    />
                    <div className="mt-1.5 flex items-center gap-2">
                        <span className="text-[12px] tabular-nums text-gray-500">{tr(`已选 ${picked.length} / ${files.length} 个文件`, `${picked.length} of ${files.length} files`)}</span>
                        <span className="flex-1" />
                        {picked.length > 0 && (
                            <button type="button" onClick={() => void discard(picked)} className="h-7 rounded-md px-2.5 text-[12px] text-gray-600 hover:bg-black/[0.06] hover:text-gray-900">
                                {tr('回滚所选', 'Roll back')}
                            </button>
                        )}
                        <button
                            type="button"
                            disabled={!picked.length || !message.trim() || committing}
                            onClick={() => void commit()}
                            title={tr(`提交所选文件（${keys('⌘↩')}）`, `Commit the selected files (${keys('⌘↩')})`)}
                            className="flex h-7 items-center gap-1.5 rounded-md bg-ide-accent px-3 text-[12px] font-medium text-white hover:bg-ide-accent-hover disabled:opacity-40 disabled:hover:bg-ide-accent light:disabled:bg-[var(--jb-fill)] light:disabled:text-[var(--jb-disabled-fg)] light:disabled:opacity-100 light:disabled:hover:bg-[var(--jb-fill)]"
                        >
                            {committing && <Loader2 size={12} className="animate-spin" />}
                            {tr('提交', 'Commit')}
                        </button>
                    </div>
                </div>
            )}
        </aside>
    )
})
