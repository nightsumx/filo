// The agent's own TUI in the thread (Claude Code): the same process the transcript projects, shown
// as itself. It takes the place of the transcript and the composer; typing goes straight to it.

import type { Thread } from '@/store/thread'
import { cn, shortPath } from '@/lib/utils'
import { tr } from '@/lib/i18n'
import { Loader2, MessageSquareText, SquareTerminal, TriangleAlert } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { agentViewOf, dropAgentView } from '../Terminal/views'

export const TuiView = observer(({ id }: { id: string }) => {
    const host = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const el = host.current
        if (!el)
            return
        const view = agentViewOf(id)
        view.mount(el)
        view.focus()
        let frame = 0
        const refit = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => view.fit())
        }
        const observer = new ResizeObserver(refit)
        observer.observe(el)
        // Another display scale changes the cell size, not the host's (as in Terminal/index.tsx).
        let scale: MediaQueryList | null = null
        const onScale = () => {
            watchScale()
            refit()
        }
        const watchScale = () => {
            scale?.removeEventListener('change', onScale)
            scale = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
            scale.addEventListener('change', onScale)
        }
        watchScale()
        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            scale?.removeEventListener('change', onScale)
            view.unmount()
        }
    }, [id])
    return <div ref={host} className="min-h-0 flex-1 bg-ide-panel px-2 pt-2" />
})

/** Drops the view when the agent's terminal goes (the process ended, the thread closed). */
export function useTuiViewCleanup(id: string | undefined) {
    useEffect(() => {
        if (!id)
            return
        return () => dropAgentView(id)
    }, [id])
}

/** Transcript / terminal switch: over the pane's top-right corner, or `inline` in a row of its own. */
export const TuiToggle = observer(({ thread, inline = false }: { thread: Thread, inline?: boolean }) => {
    const items = [
        { tui: false, label: tr('对话', 'Chat'), Icon: MessageSquareText },
        { tui: true, label: tr('终端', 'Terminal'), Icon: SquareTerminal },
    ]
    return (
        <div role="tablist" aria-label={tr('显示方式', 'View')} className={cn('flex shrink-0 gap-0.5 rounded-md bg-ide-panel p-0.5', !inline && 'absolute right-3 top-2 z-10')}>
            {items.map(({ tui, label, Icon }) => (
                <button
                    key={label}
                    type="button"
                    role="tab"
                    aria-selected={thread.tuiShown === tui}
                    title={label}
                    onClick={() => thread.showTui(tui)}
                    className={cn(
                        'flex h-6 items-center gap-1 rounded px-1.5 text-[12px] outline-none',
                        thread.tuiShown === tui ? 'bg-ide-hover text-gray-900' : 'text-gray-500 hover:text-gray-800',
                    )}
                >
                    <Icon size={13} />
                    <span>{label}</span>
                </button>
            ))}
        </div>
    )
})

/**
 * Claude Code's hooks will not come, so the transcript only follows the session file and the GUI
 * cannot answer its dialogs: why, and the way back when Filo has one (hooks on for its threads).
 */
export const HooksNotice = observer(({ thread, children }: { thread: Thread, children?: React.ReactNode }) => {
    const issue = thread.state?.tuiHooks
    const [busy, setBusy] = useState(false)
    if (!issue || !thread.tuiTerminal)
        return null
    const where = issue.files.map(shortPath).join(tr('、', ', '))
    const fixable = issue.cause === 'disabled' || (issue.cause === 'silent' && !issue.tried)
    const text = issue.cause === 'disabled'
        ? tr(`Claude Code 的 hooks 被关掉了（${where} 里的 disableAllHooks），对话视图跟不上终端，审批也只能在终端里做。`, `Claude Code's hooks are off (disableAllHooks in ${where}), so the chat view falls behind the terminal and approvals happen there.`)
        : issue.cause === 'policy'
            ? tr(`管理员的策略关掉了 Claude Code 的 hooks（${where}），这个线程请在终端里用。`, `An administrator's policy turns Claude Code's hooks off (${where}); use this thread in the terminal.`)
            : issue.tried
                ? tr('已经为 Filo 打开了 hooks，Claude Code 仍然没有回报，可能是管理员通过 MDM 或服务端下发的策略关掉了。在终端里运行 /hooks 可以查看。这个线程请在终端里用。', 'Hooks are on for Filo, yet Claude Code still reports nothing: an administrator\'s policy (MDM or server-managed) may turn them off; /hooks in the terminal shows them. Use this thread in the terminal.')
                : tr('Claude Code 没有回报状态（hooks 没在运行），对话视图跟不上终端。', 'Claude Code reports nothing (its hooks are not running), so the chat view falls behind the terminal.')
    const enable = async () => {
        setBusy(true)
        try {
            await thread.request({ type: 'claude_enable_hooks' })
            await thread.syncState()
        }
        catch (error: any) {
            toast.error(error.message)
        }
        finally {
            setBusy(false)
        }
    }
    return (
        <div role="alert" className="flex items-center gap-3 bg-amber-500/10 py-1.5 pl-4 pr-3 text-[12px] text-amber-700 dark:text-amber-300">
            <TriangleAlert size={14} className="shrink-0" />
            <span className="min-w-0 flex-1">
                {text}
                {fixable && <span className="text-gray-500">{tr(' 打开后只对 Filo 启动的 Claude Code 生效，不改你的设置文件。', ' This applies to the Claude Code Filo starts only; your settings files stay as they are.')}</span>}
            </span>
            {fixable && (
                <button
                    type="button"
                    disabled={busy || thread.running}
                    onClick={() => void enable()}
                    className="flex h-6 shrink-0 items-center gap-1 rounded bg-ide-accent px-2 text-[12px] text-always-white hover:bg-ide-accent-hover disabled:opacity-50"
                >
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    {tr('为 Filo 打开 hooks', 'Turn hooks on for Filo')}
                </button>
            )}
            {children}
        </div>
    )
})
