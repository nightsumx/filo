import type { TranscriptRow } from '@/lib/transcriptRows'
import type { Thread } from '@/store/thread'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { transcriptRows } from '@/lib/transcriptRows'
import { TRANSCRIPT_TEXT, TranscriptTextContext } from '@/lib/transcriptText'
import { appStore } from '@/store/app'
import { ThreadContext } from './ThreadContext'
import { CwdContext } from './ToolRow'
import { TranscriptRowView, TurnFoldContext } from './TurnView'
import { ViewStateContext } from './viewState'

const STICK_THRESHOLD = 80
const PAD_TOP = 4
const PAD_BOTTOM = 24
const NO_TURNS: ReadonlySet<string> = new Set()

/** First-paint height guess per row; real heights are measured once a row renders. */
function estimateRow(row: TranscriptRow): number {
    switch (row.kind) {
        case 'user':
            return 56 + Math.min(400, Math.floor(row.user.text.length / 100) * 20)
        case 'live':
        case 'fold':
        case 'footer':
            return 36
        case 'item': {
            if (row.item.kind === 'group')
                return 36
            const step = row.item.step
            if (step.kind === 'text' || step.kind === 'thinking')
                return 40 + Math.min(1600, Math.floor(step.text.length / 110) * 24)
            if (step.kind === 'tool' && ['edit', 'write', 'apply_patch'].includes(step.call.name))
                return 320
            return 36
        }
    }
}

/**
 * Virtualized transcript: only rows near the viewport are mounted, so a session with hundreds of
 * tool calls renders and updates as cheaply as a short one. Sticks to the bottom while output
 * arrives unless the user scrolled up.
 */
export const MessageList = observer(({ thread }: { thread: Thread }) => {
    const scrollRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const [showJump, setShowJump] = useState(false)
    const turns = thread.turns
    // Finished turns the user unfolded, per thread.
    const [unfolded, setUnfolded] = useState(() => ({ thread, keys: new Set<string>() as ReadonlySet<string> }))
    const openTurns = unfolded.thread === thread ? unfolded.keys : NO_TURNS
    const rows = useMemo(() => transcriptRows(turns, openTurns), [turns, openTurns])
    const toggleFold = useCallback((key: string) => {
        // Unfolding grows the list; don't let bottom-pinning scroll the clicked row away.
        stick.current = false
        setUnfolded((prev) => {
            const keys = new Set(prev.thread === thread ? prev.keys : [])
            if (!keys.delete(key))
                keys.add(key)
            return { thread, keys }
        })
    }, [thread])
    // Expanded / show-all toggles survive rows scrolling out of view (and back).
    const viewState = useMemo(() => new Map<string, unknown>(), [thread])

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        getItemKey: i => rows[i].key,
        estimateSize: i => estimateRow(rows[i]),
        overscan: 6,
        paddingStart: PAD_TOP,
        paddingEnd: PAD_BOTTOM,
        useFlushSync: false,
    })

    const toBottom = () => {
        const el = scrollRef.current
        if (el)
            el.scrollTop = el.scrollHeight
    }

    // Open a thread at its latest message.
    useLayoutEffect(() => {
        stick.current = true
        setShowJump(false)
        toBottom()
    }, [thread.key])

    useEffect(() => {
        const el = scrollRef.current
        const list = listRef.current
        if (!el || !list)
            return
        const onScroll = () => {
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight
            stick.current = distance < STICK_THRESHOLD
            setShowJump(distance >= STICK_THRESHOLD * 2)
        }
        // The list's height is the virtualizer's total size: it grows as rows are measured or output
        // streams in. While pinned, follow it.
        const observer = new ResizeObserver(() => {
            if (stick.current)
                toBottom()
        })
        observer.observe(list)
        observer.observe(el)
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            observer.disconnect()
            el.removeEventListener('scroll', onScroll)
        }
    }, [])

    const items = virtualizer.getVirtualItems()

    return (
        <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} data-transcript className="absolute inset-0 overflow-y-auto scrollbar-trigger [overflow-anchor:none]">
                <div className="mx-auto w-full max-w-5xl px-5">
                    <TranscriptTextContext value={TRANSCRIPT_TEXT[appStore.transcriptLang]}>
                        <CwdContext value={thread.cwd}>
                            <ThreadContext value={thread}>
                                <ViewStateContext value={viewState}>
                                    <TurnFoldContext value={toggleFold}>
                                        <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                                            {items.map(item => (
                                                <div
                                                    key={item.key}
                                                    ref={virtualizer.measureElement}
                                                    data-index={item.index}
                                                    data-row-kind={rows[item.index].kind}
                                                    className="absolute left-0 top-0 w-full"
                                                    style={{ transform: `translateY(${item.start}px)` }}
                                                >
                                                    <TranscriptRowView row={rows[item.index]} thread={thread} top={item.index === 0} />
                                                </div>
                                            ))}
                                        </div>
                                    </TurnFoldContext>
                                </ViewStateContext>
                            </ThreadContext>
                        </CwdContext>
                    </TranscriptTextContext>
                </div>
            </div>
            {/* Scroll-to-bottom pill: same styling as chat's MessageList. */}
            {showJump && (
                <button
                    type="button"
                    onClick={() => {
                        stick.current = true
                        toBottom()
                    }}
                    className="absolute bottom-3 left-1/2 z-10 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-md border border-gray-200 bg-elevated text-gray-600 shadow-md transition-all duration-200 animate-in fade-in slide-in-from-bottom-2 hover:text-gray-900"
                    aria-label="滚动到底部"
                >
                    <ArrowDown size={15} strokeWidth={1.8} />
                </button>
            )}
        </div>
    )
})
