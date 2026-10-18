// "文件" view of the project tool window, WebStorm's Project view: each project of the window is a
// root folder, folders list on expand, git colours files and the folders above them. Single click
// selects, double click (or Enter) opens a file in an editor tab or folds a folder, like WebStorm.
import type { TreeRow } from '@/store/fileTree'
import type { FileMark } from '@/lib/fileMarks'
import { FileIcon } from '@/components/FileIcon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { fileMarks } from '@/lib/fileMarks'
import { tr } from '@/lib/i18n'
import { cn, shortPath } from '@/lib/utils'
import { appStore } from '@/store/app'
import { codeIntel } from '@/store/codeIntel'
import { fileTreeStore } from '@/store/fileTree'
import { useVirtualizer } from '@tanstack/react-virtual'
import copy from 'copy-to-clipboard'
import { ChevronRight, ClipboardCopy, ExternalLink, File, Folder, FolderOpen, Link2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { useGitStatus } from '../Review/useGitStatus'
import { ProjectBadge } from '../Toolbar/ProjectBadge'
import { insideOf, showInFolderLabel } from '@/platform'

const ROW = 24
/** Typed letters jump to a matching row (JetBrains speed search); a pause starts a new prefix. */
const SPEED_SEARCH_MS = 900

const MARK_TEXT: Record<FileMark, string> = {
    modified: 'text-blue-600',
    added: 'text-green-600',
    conflict: 'text-amber-600',
}

/** Fetches git status for a project root and hands the tree its colours. */
const GitMarks = observer(({ root }: { root: string }) => {
    const tick = fileTreeStore.gitTick + appStore.tabsOf(root).reduce((n, t) => n + t.changeTick, 0)
    const { status } = useGitStatus(root, tick)
    useEffect(() => {
        // git reports the root with symlinks resolved; a project reached through a link gets no colours.
        const inside = status?.isRepo && (status.root === root || insideOf(root, status.root) !== undefined)
        const marks = inside && status.isRepo ? fileMarks(status.root, status.files, root.includes('\\') ? '\\' : '/') : new Map<string, FileMark>()
        fileTreeStore.setMarks(root, marks)
    }, [status, root])
    return null
})

function open(row: TreeRow) {
    if (row.more)
        return
    if (row.dir)
        fileTreeStore.toggle(row.path)
    else
        appStore.openFile(row.path, row.root)
}

const Row = observer(({ row, onMenu }: { row: TreeRow, onMenu: (row: TreeRow) => void }) => {
    const selected = fileTreeStore.selected === row.path
    const mark = fileTreeStore.marks.get(row.root)?.get(row.path)
    // Errors the editor found in the project (Settings → Editor → Full) show red over the git colour.
    const failing = codeIntel.hasProblem(row.path)
    const project = row.isRoot ? appStore.windowProjectList.find(p => p.cwd === row.root) : undefined
    if (row.more) {
        return (
            <div className="flex h-6 items-center text-[12px] text-gray-400" style={{ paddingLeft: 6 + row.depth * 16 + 20 }}>
                {tr(`还有 ${row.more} 项未列出`, `${row.more} more not listed`)}
            </div>
        )
    }
    return (
        <div
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={selected}
            aria-expanded={row.dir ? row.expanded : undefined}
            data-tree-path={row.path}
            title={row.isRoot ? row.path : row.link ? `${row.name} → ${tr('符号链接', 'symbolic link')}` : row.name}
            onClick={() => fileTreeStore.select(row.path)}
            onDoubleClick={() => open(row)}
            onContextMenu={() => {
                fileTreeStore.select(row.path)
                onMenu(row)
            }}
            className={cn(
                'flex h-6 cursor-default items-center gap-1.5 rounded-md pr-1.5 text-[13px]',
                selected ? 'bg-ide-sel-muted group-focus-within/tree:bg-ide-sel' : 'hover:bg-ide-hover',
            )}
            style={{ paddingLeft: 4 + row.depth * 16 }}
        >
            {row.dir
                ? (
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-label={row.expanded ? tr('折叠', 'Collapse') : tr('展开', 'Expand')}
                            onClick={(e) => {
                                e.stopPropagation()
                                fileTreeStore.select(row.path)
                                fileTreeStore.toggle(row.path)
                            }}
                            className="flex h-5 w-4 shrink-0 items-center justify-center text-gray-500"
                        >
                            <ChevronRight size={14} className={cn('transition-transform duration-100', row.expanded && 'rotate-90')} />
                        </button>
                    )
                : <span className="w-4 shrink-0" />}
            {row.isRoot
                ? <ProjectBadge name={row.name} size={16} className="rounded-[4px]" />
                : row.dir
                    ? (row.expanded ? <FolderOpen size={14} className="shrink-0 text-gray-500" aria-hidden /> : <Folder size={14} className="shrink-0 text-gray-500" aria-hidden />)
                    : <FileIcon name={row.name} />}
            {row.isRoot
                ? (
                        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                            <span className={cn('shrink-0 truncate', mark ? MARK_TEXT[mark] : 'text-gray-900', row.root === appStore.activeProject && 'font-semibold')}>{project?.name ?? row.name}</span>
                            <span className="min-w-0 truncate text-[12px] text-gray-500">{shortPath(row.path)}</span>
                        </span>
                    )
                : <span className={cn('min-w-0 flex-1 truncate', failing ? 'text-red-600 dark:text-red-400' : mark ? MARK_TEXT[mark] : row.ignored ? 'text-gray-400' : 'text-gray-900')} title={failing && !row.dir ? tr(`${codeIntel.problemCount(row.path)} 个错误`, `${codeIntel.problemCount(row.path)} error(s)`) : undefined}>{row.name}</span>}
            {row.link && <Link2 size={12} className="shrink-0 text-gray-400" aria-hidden />}
            {fileTreeStore.errors.has(row.path) && <span className="shrink-0 text-[11px] text-gray-400">{tr('无法读取', 'Unreadable')}</span>}
        </div>
    )
})

/** Up/Down move, Right expands or steps in, Left folds or steps out, Enter opens; letters jump. */
function useTreeKeys(rows: TreeRow[], scrollTo: (index: number) => void) {
    const typed = useRef({ text: '', at: 0 })
    return (e: React.KeyboardEvent) => {
        const index = rows.findIndex(r => r.path === fileTreeStore.selected)
        const row = rows[index]
        const select = (i: number) => {
            const target = rows[Math.max(0, Math.min(rows.length - 1, i))]
            if (!target)
                return
            fileTreeStore.select(target.path)
            scrollTo(rows.indexOf(target))
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            select(index === -1 ? 0 : index + (e.key === 'ArrowDown' ? 1 : -1))
        }
        else if (e.key === 'ArrowRight' && row?.dir) {
            e.preventDefault()
            if (!row.expanded)
                fileTreeStore.toggle(row.path, true)
            else if (rows[index + 1]?.depth > row.depth)
                select(index + 1)
        }
        else if (e.key === 'ArrowLeft' && row) {
            e.preventDefault()
            if (row.dir && row.expanded) {
                fileTreeStore.toggle(row.path, false)
                return
            }
            for (let i = index - 1; i >= 0; i--) {
                if (rows[i].depth < row.depth) {
                    select(i)
                    break
                }
            }
        }
        else if (e.key === 'Enter' && row) {
            e.preventDefault()
            open(row)
        }
        else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault()
            select(e.key === 'Home' ? 0 : rows.length - 1)
        }
        else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
            const now = Date.now()
            typed.current = { text: now - typed.current.at > SPEED_SEARCH_MS ? e.key : typed.current.text + e.key, at: now }
            const prefix = typed.current.text.toLowerCase()
            const start = index === -1 ? 0 : prefix.length === 1 ? index + 1 : index
            for (let k = 0; k < rows.length; k++) {
                const i = (start + k) % rows.length
                if (!rows[i].more && rows[i].name.toLowerCase().startsWith(prefix)) {
                    select(i)
                    break
                }
            }
        }
    }
}

export const FileTree = observer(() => {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [menuRow, setMenuRow] = useState<TreeRow | null>(null)
    const rows = fileTreeStore.rows

    // First look at a project's files: its folder opens. Folders expanded later list as they show.
    useEffect(() => {
        const active = appStore.activeProject
        if (active && !fileTreeStore.roots.some(r => fileTreeStore.expanded.has(r)))
            fileTreeStore.toggle(active, true)
    }, [])
    useEffect(() => {
        fileTreeStore.ensureLoaded()
    })

    const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 12 })
    const onKeyDown = useTreeKeys(rows, i => virtualizer.scrollToIndex(i, { align: 'auto' }))

    // The tree's selection moved without a click (locate opened file): bring it into view.
    const selectedIndex = rows.findIndex(r => r.path === fileTreeStore.selected)
    useEffect(() => {
        if (selectedIndex !== -1 && fileTreeStore.revealing) {
            virtualizer.scrollToIndex(selectedIndex, { align: 'center' })
            fileTreeStore.revealDone()
        }
    }, [selectedIndex, fileTreeStore.revealing])

    const relative = (row: TreeRow) => insideOf(row.path, row.root) ?? row.name
    return (
        <>
            {appStore.windowProjects.map(root => <GitMarks key={root} root={root} />)}
            <ContextMenu onOpenChange={o => !o && setMenuRow(null)}>
                <ContextMenuTrigger asChild>
                    <div
                        ref={scrollRef}
                        role="tree"
                        tabIndex={0}
                        aria-label={tr('项目文件', 'Project files')}
                        onKeyDown={onKeyDown}
                        className="group/tree min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 outline-none scrollbar-trigger"
                    >
                        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                            {virtualizer.getVirtualItems().map(item => (
                                <div key={rows[item.index].path} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)`, height: ROW }}>
                                    <Row row={rows[item.index]} onMenu={setMenuRow} />
                                </div>
                            ))}
                        </div>
                    </div>
                </ContextMenuTrigger>
                {menuRow && (
                    <ContextMenuContent className="w-56">
                        {!menuRow.dir && (
                            <>
                                <ContextMenuItem onSelect={() => appStore.openFile(menuRow.path, menuRow.root)}>
                                    <File size={14} />
                                    {tr('打开', 'Open')}
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                            </>
                        )}
                        <ContextMenuItem onSelect={() => copy(menuRow.path)}>
                            <ClipboardCopy size={14} />
                            {tr('复制路径', 'Copy path')}
                        </ContextMenuItem>
                        {!menuRow.isRoot && (
                            <ContextMenuItem onSelect={() => copy(relative(menuRow))}>
                                <ClipboardCopy size={14} />
                                {tr('复制相对路径', 'Copy relative path')}
                            </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => void window.pi.revealPath(menuRow.path)}>
                            <FolderOpen size={14} />
                            {showInFolderLabel()}
                        </ContextMenuItem>
                        {!menuRow.dir && (
                            <ContextMenuItem onSelect={() => void window.pi.openFolder(menuRow.path)}>
                                <ExternalLink size={14} />
                                {tr('用默认应用打开', 'Open in default app')}
                            </ContextMenuItem>
                        )}
                    </ContextMenuContent>
                )}
            </ContextMenu>
        </>
    )
})

/** Header button: expands the tree down to the focused editor's file and selects it. */
export function locateActiveFile() {
    const file = appStore.activeFile
    if (!file)
        return
    void fileTreeStore.reveal(file.path, file.cwd)
}
