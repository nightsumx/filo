import type { Thread } from '@/store/thread'
import { TRANSCRIPT_TEXT, TranscriptTextContext } from '@/lib/transcriptText'
import { cn, relativeTime, shortPath } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import appIcon from '@/assets/logo.png'
import { Composer } from '../Composer'
import { ExtensionRequest } from './ExtensionRequest'
import { MessageList } from './MessageList'

/** Shortcut hints shown on empty editors, like WebStorm's empty editor area. */
export function ShortcutHints({ className }: { className?: string }) {
    const rows: [string, string][] = [
        ['新线程', '⌘T'],
        ['切换项目', '⌘P'],
        ['切换标签', '⌃Tab'],
        ['项目面板', '⌘B'],
        ['分栏 / 单栏', '⌘\\'],
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
}

/** Empty state for a fresh thread: the project it runs in plus a few recent threads to reopen. */
const Hero = observer(({ thread }: { thread: Thread }) => {
    const project = appStore.projects.find(p => p.cwd === thread.cwd)
    const open = new Set(appStore.tabs.map(t => t.key))
    const recent = (project?.sessions ?? []).filter(s => !open.has(s.path)).slice(0, 5)
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-6 pb-6">
            <img src={appIcon} alt="" className="h-12 w-12 select-none" draggable={false} />
            <h2 className="!mt-1 !text-[17px] !font-semibold text-gray-900">开始构建</h2>
            <p className="max-w-full truncate font-mono text-[12px] text-gray-500" title={thread.cwd}>{shortPath(thread.cwd)}</p>
            {recent.length > 0 && (
                <div className="mt-5 flex w-full max-w-md flex-col">
                    <span className="px-2 pb-1 text-[12px] text-gray-500">最近的线程</span>
                    {recent.map(session => (
                        <button
                            key={session.path}
                            type="button"
                            onClick={() => appStore.openSession(session)}
                            className="flex h-7 items-center gap-3 rounded-md px-2 text-left text-[13px] text-gray-800 hover:bg-ide-hover"
                        >
                            <span className="min-w-0 flex-1 truncate">{session.name ?? session.firstPrompt?.split('\n')[0] ?? '新线程'}</span>
                            <span className="shrink-0 text-[11px] text-gray-400 tabular-nums">{relativeTime(session.updatedAt)}</span>
                        </button>
                    ))}
                </div>
            )}
            {!recent.length && <ShortcutHints className="mt-6" />}
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

    return (
        <section
            aria-label={thread.title}
            onMouseDownCapture={() => {
                if (!focused)
                    appStore.focus(thread.key)
            }}
            className="flex h-full min-w-0 flex-1 basis-0 flex-col bg-ide-editor"
        >
            {!thread.loaded
                ? <div className="flex flex-1 items-center justify-center"><Loader2 size={18} className="animate-spin text-gray-300" /></div>
                : thread.isEmpty && !thread.persisted ? <Hero thread={thread} /> : <MessageList thread={thread} />}
            {/* Requests normally render in the transcript's live row; without a running turn there is none. */}
            {!(thread.running && thread.turns.length > 0) && thread.uiRequests.length > 0 && (
                <div className="mx-auto w-full max-w-5xl px-5 pb-3">
                    <TranscriptTextContext value={TRANSCRIPT_TEXT[appStore.transcriptLang]}>
                        <ExtensionRequest thread={thread} />
                    </TranscriptTextContext>
                </div>
            )}
            <Composer thread={thread} />
        </section>
    )
})
