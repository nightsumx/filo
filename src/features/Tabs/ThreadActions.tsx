// Thread actions (rename, compact, reveal, close, delete). Rendered both in the tab's right-click
// menu and the tab bar's ⋯ menu, so the item components are passed in.
import type { Thread } from '@/store/thread'
import type { SessionSummary } from '@shared/ipc'
import { confirm } from '@/lib/confirm'
import { appStore } from '@/store/app'
import { AppWindow, Archive, ArrowRightToLine, EyeOff, FolderOpen, GitFork, Pencil, Trash2, X, XCircle } from 'lucide-react'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { tr } from '@/lib/i18n'
import { keys, showInFolderLabel } from '@/platform'

interface MenuParts {
    Item: React.ComponentType<{ onSelect?: () => void, disabled?: boolean, className?: string, children: React.ReactNode }>
    Separator: React.ComponentType
}

/** Tab currently showing its inline title editor (set by the 重命名 action, read by the tab). */
export const renaming = observable({ key: null as string | null })

export async function closeTabWithConfirm(thread: Thread) {
    if (thread.running) {
        const ok = await confirm({ title: tr('关闭标签', 'Close tab'), description: tr(`「${thread.title}」还在运行，关闭会中断它。`, `“${thread.title}” is still running; closing stops it.`), confirmText: tr('中断并关闭', 'Stop and close') })
        if (!ok)
            return
    }
    await appStore.closeTab(thread.key)
}

/** An ACP session copied whole by its agent; the copy opens next to it. */
async function forkSession(thread: Thread) {
    const key = await thread.forkSession()
    if (key)
        await appStore.revealHere(key)
}

/** pi: the session file goes to the Trash. ACP: off the list, or out of the agent's history too. */
async function deleteThread(thread: Thread, session: SessionSummary, history: boolean) {
    const agent = thread.agentLabel
    const ok = thread.agent === 'pi'
        ? await confirm({ title: tr('删除线程', 'Delete thread'), description: tr(`「${thread.title}」的会话文件会移到废纸篓。`, `The session file of “${thread.title}” goes to the Trash.`), confirmText: tr('删除', 'Delete') })
        : history
            ? await confirm({ title: tr(`从 ${agent} 删除`, `Delete from ${agent}`), description: tr(`「${thread.title}」会从 ${agent} 自己的会话记录里删除，无法恢复。`, `“${thread.title}” is deleted from ${agent}'s own session history. This cannot be undone.`), confirmText: tr('删除', 'Delete') })
            : await confirm({ title: tr('移出列表', 'Remove from list'), description: tr(`「${thread.title}」不再显示在这里；${agent} 自己的会话记录保留。`, `“${thread.title}” no longer shows here; ${agent} keeps its own session history.`), confirmText: tr('移出', 'Remove') })
    if (ok)
        await appStore.deleteSession(session, { history })
}

async function closeOthers(thread: Thread) {
    const others = appStore.tabsOf(thread.cwd).filter(t => t !== thread)
    const running = others.filter(t => t.running).length
    if (running) {
        const ok = await confirm({ title: tr('关闭其他标签', 'Close other tabs'), description: tr(`有 ${running} 个线程还在运行，关闭会中断它们。`, `${running} ${running === 1 ? 'thread is' : 'threads are'} still running; closing stops them.`), confirmText: tr('中断并关闭', 'Stop and close') })
        if (!ok)
            return
    }
    for (const t of others)
        await appStore.closeTab(t.key)
}

export const ThreadActions = observer(({ thread, parts: { Item, Separator } }: { thread: Thread, parts: MenuParts }) => {
    const session = thread.sessionPath ? appStore.sessions.find(s => s.path === thread.sessionPath) : undefined
    const hasOthers = appStore.tabsOf(thread.cwd).length > 1
    // The window's only tab would just take the window along.
    const canTearOff = hasOthers || appStore.windowProjects.length > 1
    const caps = thread.state?.agentCaps ?? session?.agentCaps
    const acp = thread.agent !== 'pi'
    return (
        <>
            {!thread.isEmpty && (
                <>
                    <Item onSelect={() => runInAction(() => (renaming.key = thread.key))}>
                        <Pencil size={14} />
                        {tr('重命名', 'Rename')}
                    </Item>
                    {thread.features.compaction && (
                        <Item disabled={thread.running} onSelect={() => void thread.compact()}>
                            <Archive size={14} />
                            {tr('压缩上下文', 'Compact context')}
                        </Item>
                    )}
                    {acp && caps?.fork && thread.sessionPath && (
                        <Item disabled={thread.running} onSelect={() => void forkSession(thread)}>
                            <GitFork size={14} />
                            {tr('分叉线程', 'Fork thread')}
                        </Item>
                    )}
                </>
            )}
            <Item onSelect={() => void window.pi.openFolder(thread.cwd)}>
                <FolderOpen size={14} />
                {showInFolderLabel()}
            </Item>
            <Separator />
            {/* Same as dragging the tab out of the window, or onto another window's tab bar. */}
            <Item disabled={!canTearOff} onSelect={() => void appStore.moveTabToWindow(thread.key, null)}>
                <AppWindow size={14} />
                {tr('移到新窗口', 'Move to new window')}
            </Item>
            {appStore.otherWindows.map(w => (
                <Item key={w.id} onSelect={() => void appStore.moveTabToWindow(thread.key, w.id)}>
                    <ArrowRightToLine size={14} />
                    <span className="min-w-0 flex-1 truncate">{tr(`移到窗口：${w.label}`, `Move to window: ${w.label}`)}</span>
                </Item>
            ))}
            <Separator />
            <Item onSelect={() => void closeTabWithConfirm(thread)}>
                <X size={14} />
                <span className="flex-1">{tr('关闭标签', 'Close tab')}</span>
                <span className="text-[11px] text-gray-400">{keys('⌘W')}</span>
            </Item>
            <Item disabled={!hasOthers} onSelect={() => void closeOthers(thread)}>
                <XCircle size={14} />
                {tr('关闭其他标签', 'Close other tabs')}
            </Item>
            {session && acp && (
                <Item onSelect={() => void deleteThread(thread, session, false)}>
                    <EyeOff size={14} />
                    {tr('移出列表', 'Remove from list')}
                </Item>
            )}
            {session && (!acp || caps?.delete) && (
                <Item className="text-red-600 focus:text-red-600" onSelect={() => void deleteThread(thread, session, acp)}>
                    <Trash2 size={14} />
                    {acp ? tr(`从 ${thread.agentLabel} 删除`, `Delete from ${thread.agentLabel}`) : tr('删除线程', 'Delete thread')}
                </Item>
            )}
        </>
    )
})
