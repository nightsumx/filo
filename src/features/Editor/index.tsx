// An editor tab's content: lite-monaco over the file, plus a line on top when the file and the editor
// disagree (changed under unsaved edits, deleted, a failed save). Several render side by side in
// split layout, next to threads.
import type { FileTab } from '@/store/fileTab'
import type { core } from 'lite-monaco'
import type { EditorKit } from './litcode'
import { Button } from '@/components/ui/button'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { AlertTriangle, ExternalLink, FileWarning, FolderOpen, Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { showInFolderLabel } from '@/platform'
import { theme } from '@/lib/theme'
import { mountEditor, prepare } from './litcode'

export function formatSize(bytes: number): string {
    if (bytes < 1024)
        return `${bytes} B`
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const notice = 'flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5 text-[12.5px]'

/** What stands between the editor and the disk, with the ways out. */
const DiskNotice = observer(({ tab }: { tab: FileTab }) => {
    if (tab.conflict) {
        return (
            <div role="alert" className={`${notice} bg-amber-500/[0.08] text-amber-700 dark:text-amber-300`}>
                <AlertTriangle size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">{tr('磁盘上的文件被改动了（可能是 agent），和你未保存的修改冲突。', 'The file changed on disk (an agent, maybe) while you had unsaved edits.')}</span>
                <Button size="sm" variant="secondary" onClick={tab.takeDisk}>{tr('载入磁盘版本', 'Load disk version')}</Button>
                <Button size="sm" variant="secondary" onClick={() => void tab.keepMine()}>{tr('保留我的修改', 'Keep my edits')}</Button>
            </div>
        )
    }
    if (tab.deleted) {
        return (
            <div role="status" className={`${notice} bg-black/[0.03] text-gray-600`}>
                <FileWarning size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">{tr('文件已从磁盘删除。', 'The file was deleted from disk.')}</span>
                <Button size="sm" variant="secondary" onClick={() => void tab.save('explicit')}>{tr('重新保存', 'Save again')}</Button>
                <Button size="sm" variant="secondary" onClick={() => void appStore.closeTab(tab.key)}>{tr('关闭', 'Close')}</Button>
            </div>
        )
    }
    if (tab.saveError) {
        return (
            <div role="alert" className={`${notice} bg-black/[0.03] text-red-600 dark:text-red-400`}>
                <AlertTriangle size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 select-text">{tab.saveError}</span>
                <Button size="sm" variant="secondary" onClick={() => void tab.save('explicit')}>{tr('重试', 'Retry')}</Button>
            </div>
        )
    }
    return null
})

/** Binary or too large: no editor, but the system can open it. */
const NotEditable = observer(({ tab }: { tab: FileTab }) => {
    const disk = tab.disk
    const why = disk?.kind === 'tooLarge'
        ? tr(`文件太大（${formatSize(disk.size)}），不在编辑器里打开。`, `Too large to edit here (${formatSize(disk.size)}).`)
        : disk?.kind === 'binary'
            ? tr(`二进制文件（${formatSize(disk.size)}），不能作为文本编辑。`, `Binary file (${formatSize(disk.size)}); it cannot be edited as text.`)
            : tr('文件不存在。', 'The file does not exist.')
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-gray-500">
            <span>{why}</span>
            <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void window.pi.openFolder(tab.path)}>
                    <ExternalLink size={13} />
                    {tr('用默认应用打开', 'Open in default app')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void window.pi.revealPath(tab.path)}>
                    <FolderOpen size={13} />
                    {showInFolderLabel()}
                </Button>
            </div>
        </div>
    )
})

/** lite-monaco on the tab's document; the state goes back to the tab on unmount (undo, caret, scroll). */
const CodeView = observer(({ tab }: { tab: FileTab }) => {
    const host = useRef<HTMLDivElement>(null)
    const viewRef = useRef<core.EditorView | null>(null)
    const [kit, setKit] = useState<EditorKit | null>(null)
    // Light and dark are different Shiki themes: the view is rebuilt on the same state.
    const dark = theme.dark

    useEffect(() => {
        let live = true
        void prepare(tab.name).then(k => live && setKit(k))
        return () => {
            live = false
        }
    }, [tab])

    useEffect(() => {
        if (!host.current || !kit)
            return
        const view = mountEditor(host.current, tab, kit, dark)
        viewRef.current = view
        if (appStore.composerFocus.key === tab.key)
            view.focus()
        return () => {
            viewRef.current = null
            view.destroy()
        }
    }, [tab, kit, dark])

    // ⌘1–9, a click in the tree, ⌃Tab...: the keyboard goes into the editor.
    const request = appStore.composerFocus
    useEffect(() => {
        if (request.key === tab.key)
            viewRef.current?.focus()
    }, [request, tab.key])

    return <div ref={host} className="litcode-host min-h-0 flex-1 overflow-hidden" data-editor-path={tab.path} />
})

export const EditorPane = observer(({ tab, focused }: { tab: FileTab, focused: boolean }) => {
    const text = tab.disk?.kind === 'text'
    return (
        <section
            aria-label={tab.path}
            onMouseDownCapture={() => {
                if (!focused)
                    appStore.focus(tab.key)
            }}
            className="flex h-full min-w-0 flex-1 basis-0 flex-col bg-ide-editor"
        >
            <DiskNotice tab={tab} />
            {!tab.loaded
                ? <div className="flex flex-1 items-center justify-center"><Loader2 size={18} className="animate-spin text-gray-300" /></div>
                : text ? <CodeView tab={tab} /> : <NotEditable tab={tab} />}
        </section>
    )
})
