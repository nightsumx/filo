import type { Thread } from '@/store/thread'
import { TRANSCRIPT_TEXT, TranscriptTextContext } from '@/lib/transcriptText'
import { cn, relativeTime, shortPath } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Loader2, SquareTerminal } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import appIcon from '@/assets/logo.png'
import { Composer } from '../Composer'
import { ExtensionRequest } from './ExtensionRequest'
import { MessageList } from './MessageList'
import { SubagentComposer, SubagentHeader } from './SubagentPane'
import { newThreadLabel, tr } from '@/lib/i18n'
import { keys } from '@/platform'

/** Shortcut hints shown on empty editors, like WebStorm's empty editor area. */
export const ShortcutHints = observer(function ShortcutHints({ className }: { className?: string }) {
    const rows: [string, string][] = [
        [newThreadLabel(), keys('⌘T')],
        [tr('切换项目', 'Switch project'), keys('⌘P')],
        [tr('切换标签', 'Switch tab'), keys('⌃Tab')],
        [tr('项目面板', 'Projects panel'), keys('⌘B')],
        [tr('分栏 / 单栏', 'Split / single'), keys('⌘\\')],
    ]
    return (
        <dl className={cn('grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-[13px]', className)}>
            {rows.map(([label, key]) => (
                <div key={label} className="contents">
                    <dt className="text-right text-gray-500">{label}</dt>
                    <dd className="text-ide-accent">{key}</dd>
                </div>
            ))}
        </dl>
    )
})

/** Empty state for a fresh thread: the project it runs in plus a few recent threads to reopen. */
const Hero = observer(({ thread }: { thread: Thread }) => {
    const project = appStore.projects.find(p => p.cwd === thread.cwd)
    const open = new Set(appStore.tabs.map(t => t.key))
    const recent = (project?.sessions ?? []).filter(s => !open.has(s.path)).slice(0, 5)
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-6 pb-6">
            <img src={appIcon} alt="" className="h-12 w-12 select-none" draggable={false} />
            <h2 className="!mt-1 !text-[17px] !font-semibold text-gray-900">{tr('开始构建', 'Start building')}</h2>
            <p className="max-w-full truncate font-mono text-[12px] text-gray-500" title={thread.cwd}>{shortPath(thread.cwd)}</p>
            {recent.length > 0 && (
                <div className="mt-5 flex w-full max-w-md flex-col">
                    <span className="px-2 pb-1 text-[12px] text-gray-500">{tr('最近的线程', 'Recent threads')}</span>
                    {recent.map(session => (
                        <button
                            key={session.path}
                            type="button"
                            onClick={() => appStore.openSession(session)}
                            className="flex h-7 items-center gap-3 rounded-md px-2 text-left text-[13px] text-gray-800 hover:bg-ide-hover"
                        >
                            <span className="min-w-0 flex-1 truncate">{session.name ?? session.firstPrompt?.split('\n')[0] ?? newThreadLabel()}</span>
                            <span className="shrink-0 text-[11px] text-gray-400 tabular-nums">{relativeTime(session.updatedAt)}</span>
                        </button>
                    ))}
                </div>
            )}
            {!recent.length && <ShortcutHints className="mt-6" />}
        </div>
    )
})

/**
 * The same session is open in a terminal pi too. Joined over pi-cc-tui's bridge, both are one
 * process and stay in step. Otherwise both processes append to the file, each from its own view of
 * it, so the turns land as separate branches: worth knowing before sending from here.
 */
const TerminalNotice = observer(({ thread }: { thread: Thread }) => {
    const terminal = thread.sessionPath ? appStore.terminalSessions.get(thread.sessionPath) : undefined
    if (thread.terminalPid) {
        return (
            <div role="status" className="mx-auto flex w-full max-w-5xl items-center gap-1.5 px-5 pb-1 text-[12px] text-gray-500">
                <SquareTerminal size={13} className="shrink-0" />
                <span className="min-w-0 truncate">
                    {tr(`已连接终端里的 pi（进程 ${thread.terminalPid}），两边是同一个会话，在这里发送也会在终端里运行。`, `Joined the pi in your terminal (process ${thread.terminalPid}): one session on both sides, and what you send here runs there.`)}
                </span>
            </div>
        )
    }
    if (!terminal)
        return null
    const text = terminal.state === 'idle'
        ? tr('这个会话也在终端里打开着（pi 进程 ', 'This session is also open in a terminal (pi process ')
        : tr('这个会话正在终端里运行（pi 进程 ', 'This session is running in a terminal (pi process ')
    return (
        <div role="status" className="mx-auto flex w-full max-w-5xl items-center gap-1.5 px-5 pb-1 text-[12px] text-amber-600 dark:text-amber-400">
            <SquareTerminal size={13} className="shrink-0" />
            <span className="min-w-0 truncate">
                {text}
                {terminal.pid}
                {tr('），两边同时发送会让对话分叉。', '); sending from both sides splits the conversation.')}
            </span>
        </div>
    )
})

/** One tab's content. Several render side by side in split layout. */
export const ThreadPane = observer(({ thread, focused }: { thread: Thread, focused: boolean }) => {
    // A pane on screen gets a live pi process and counts as read.
    useEffect(() => {
        if (thread.loaded)
            void thread.ensureAgent().catch(() => {})
    }, [thread, thread.loaded])
    useEffect(() => {
        thread.unread = false
    }, [thread, thread.unread])
    // A terminal pi on this session: join it (bridge) or follow the file it writes.
    const terminal = thread.sessionPath ? appStore.terminalSessions.get(thread.sessionPath) : undefined
    useEffect(() => {
        if (!thread.loaded)
            return
        thread.onTerminalPresence(terminal)
    }, [thread, thread.loaded, terminal?.pid, terminal?.bridge])
    useEffect(() => () => thread.onTerminalPresence(undefined), [thread])
    // Search opened a message of this thread: show the thread, not a subagent.
    const reveal = appStore.reveal
    useEffect(() => {
        if (reveal?.key === thread.key)
            thread.showSubagent(null)
    }, [reveal, thread])

    // A subagent opened from the tree or its card takes the transcript's place.
    const subagent = thread.openSubagent
    return (
        <section
            aria-label={subagent ? `${thread.title} / ${subagent.title}` : thread.title}
            onMouseDownCapture={() => {
                if (!focused)
                    appStore.focus(thread.key)
            }}
            onKeyDown={(e) => {
                const target = e.target as HTMLElement
                if (subagent && e.key === 'Escape' && !e.defaultPrevented && !target.closest('input, textarea, [contenteditable="true"]')) {
                    e.preventDefault()
                    thread.showSubagent(null)
                }
            }}
            className="flex h-full min-w-0 flex-1 basis-0 flex-col bg-ide-editor"
        >
            {subagent && <SubagentHeader thread={thread} run={subagent} />}
            {!thread.loaded
                ? <div className="flex flex-1 items-center justify-center"><Loader2 size={18} className="animate-spin text-gray-300" /></div>
                : subagent
                    ? <MessageList thread={thread} subagent={subagent} />
                    : thread.isEmpty && !thread.persisted ? <Hero thread={thread} /> : <MessageList thread={thread} />}
            {/* Requests normally render in the transcript's live row; without a running turn there is none. */}
            {!subagent && !(thread.running && thread.turns.length > 0) && thread.uiRequests.length > 0 && (
                <div className="mx-auto w-full max-w-5xl px-5 pb-3">
                    <TranscriptTextContext value={TRANSCRIPT_TEXT[appStore.transcriptLang]}>
                        <ExtensionRequest thread={thread} />
                    </TranscriptTextContext>
                </div>
            )}
            <TerminalNotice thread={thread} />
            {subagent ? <SubagentComposer key={subagent.id} thread={thread} run={subagent} /> : <Composer thread={thread} />}
        </section>
    )
})
