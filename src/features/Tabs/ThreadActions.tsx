// Thread actions (rename, compact, reveal, close, delete). Rendered both in the tab's right-click
// menu and the tab bar's ⋯ menu, so the item components are passed in.
import type { Thread } from '@/store/thread'
import { confirm } from '@/lib/confirm'
import { promptText } from '@/lib/promptText'
import { appStore } from '@/store/app'
import { Archive, FolderOpen, Pencil, Trash2, X, XCircle } from 'lucide-react'
import { observer } from 'mobx-react-lite'

interface MenuParts {
    Item: React.ComponentType<{ onSelect?: () => void, disabled?: boolean, className?: string, children: React.ReactNode }>
    Separator: React.ComponentType
}

export async function closeTabWithConfirm(thread: Thread) {
    if (thread.running) {
        const ok = await confirm({ title: '关闭标签', description: `「${thread.title}」还在运行，关闭会中断它。`, confirmText: '中断并关闭' })
        if (!ok)
            return
    }
    await appStore.closeTab(thread.key)
}

async function closeOthers(thread: Thread) {
    const others = appStore.tabsOf(thread.cwd).filter(t => t !== thread)
    const running = others.filter(t => t.running).length
    if (running) {
        const ok = await confirm({ title: '关闭其他标签', description: `有 ${running} 个线程还在运行，关闭会中断它们。`, confirmText: '中断并关闭' })
        if (!ok)
            return
    }
    for (const t of others)
        await appStore.closeTab(t.key)
}

export const ThreadActions = observer(({ thread, parts: { Item, Separator } }: { thread: Thread, parts: MenuParts }) => {
    const session = thread.sessionPath ? appStore.sessions.find(s => s.path === thread.sessionPath) : undefined
    const hasOthers = appStore.tabsOf(thread.cwd).length > 1
    return (
        <>
            {!thread.isEmpty && (
                <>
                    <Item onSelect={async () => {
                        const name = await promptText({ title: '重命名线程', initial: thread.title })
                        if (name != null)
                            await thread.rename(name.trim())
                        void appStore.refreshSessions()
                    }}
                    >
                        <Pencil size={14} />
                        重命名
                    </Item>
                    <Item disabled={thread.running} onSelect={() => void thread.compact()}>
                        <Archive size={14} />
                        压缩上下文
                    </Item>
                </>
            )}
            <Item onSelect={() => void window.pi.openFolder(thread.cwd)}>
                <FolderOpen size={14} />
                在 Finder 中打开
            </Item>
            <Separator />
            <Item onSelect={() => void closeTabWithConfirm(thread)}>
                <X size={14} />
                <span className="flex-1">关闭标签</span>
                <span className="text-[11px] text-gray-400">⌘W</span>
            </Item>
            <Item disabled={!hasOthers} onSelect={() => void closeOthers(thread)}>
                <XCircle size={14} />
                关闭其他标签
            </Item>
            {session && (
                <Item
                    className="text-red-600 focus:text-red-600"
                    onSelect={async () => {
                        const ok = await confirm({ title: '删除线程', description: `「${thread.title}」的会话文件会移到废纸篓。`, confirmText: '删除' })
                        if (ok)
                            await appStore.deleteSession(session)
                    }}
                >
                    <Trash2 size={14} />
                    删除线程
                </Item>
            )}
        </>
    )
})
