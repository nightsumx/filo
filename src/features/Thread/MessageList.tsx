import type { Thread } from '@/store/thread'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { estimateRow } from '@/lib/rowEstimate'
import type { TranscriptRow } from '@/lib/transcriptRows'
import { transcriptRows } from '@/lib/transcriptRows'
import { TRANSCRIPT_TEXT, TranscriptTextContext } from '@/lib/transcriptText'
import { appStore } from '@/store/app'
import { ThreadContext } from './ThreadContext'
import { CwdContext } from './ToolRow'
import { FoldRow, TranscriptRowView, TurnFoldContext } from './TurnView'
import { UnpinContext, ViewStateContext } from './viewState'
import { tr } from '@/lib/i18n'

const STICK_THRESHOLD = 80
const PAD_TOP = 4
const PAD_BOTTOM = 24
const NO_TURNS: ReadonlySet<string> = new Set()
/** The fold button: the bottom 24px (h-6) of its row, under the row's top padding. */
const FOLD_HEIGHT = 24
/** Where the pinned copy draws that button (py-1), and the opaque band it sits in. */
const PIN_TOP = 4
const PINNED_HEIGHT = FOLD_HEIGHT + 2 * PIN_TOP

/** Open folds as row ranges: the fold row and the last row of its unfolded process. */
function openFolds(rows: TranscriptRow[]): { fold: number, last: number }[] {
    const ranges: { fold: number, last: number }[] = []
    rows.forEach((row, i) => {
        if (row.kind !== 'fold' || !row.open)
            return
        let last = i
        while (rows[last + 1]?.kind === 'item' && (rows[last + 1] as { inFold?: boolean }).inFold)
            last++
        if (last > i)
            ranges.push({ fold: i, last })
    })
    return ranges
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
    // Expanding grows the list; don't let bottom-pinning scroll the clicked row away. Scrolling back
    // to the bottom pins again (onScroll).
    const unpin = useCallback(() => {
        stick.current = false
    }, [])
    const toggleFold = useCallback((key: string) => {
        unpin()
        setUnfolded((prev) => {
            const keys = new Set(prev.thread === thread ? prev.keys : [])
            if (!keys.delete(key))
                keys.add(key)
            return { thread, keys }
        })
    }, [thread, unpin])
    // Expanded / show-all toggles survive rows scrolling out of view (and back).
    const viewState = useMemo(() => new Map<string, unknown>(), [thread])

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        getItemKey: i => rows[i].key,
        estimateSize: i => estimateRow(rows[i], scrollRef.current?.clientWidth ?? 0),
        overscan: 6,
        paddingStart: PAD_TOP,
        paddingEnd: PAD_BOTTOM,
        // Scroll-driven range changes render before the next paint, so newly exposed rows are never blank.
        useFlushSync: true,
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

    // Unfolded process scrolled past its "Ran …" row: pin that row on top, so collapsing it never
    // means scrolling back up hundreds of steps to find it.
    const folds = useMemo(() => openFolds(rows), [rows])
    // Behaves like position: sticky. The copy takes over the moment the real button reaches its
    // spot, so the two line up exactly, and the end of the process pushes it off rather than it
    // vanishing. The push offset is written straight to the DOM: no re-render per scroll event.
    const [pinned, setPinned] = useState<{ index: number, gutter: number } | null>(null)
    const pinRef = useRef<HTMLDivElement>(null)
    const pinOffset = useRef(0)
    const updatePinned = useCallback(() => {
        const el = scrollRef.current
        if (!el)
            return
        const top = el.scrollTop
        const sizes = virtualizer.measurementsCache
        // Where the real button is: from the DOM while its row is mounted (the cache can be a few px
        // off), else the row is far away and the cache is plenty.
        const buttonTop = (fold: number) => {
            const button = el.querySelector(`[data-index="${fold}"] button`)
            return button
                ? button.getBoundingClientRect().top - el.getBoundingClientRect().top
                : sizes[fold].end - FOLD_HEIGHT - top
        }
        const hit = folds.find(({ fold, last }) => sizes[fold] && sizes[last] && sizes[last].end > top && buttonTop(fold) <= PIN_TOP)
        pinOffset.current = hit ? Math.min(0, sizes[hit.last].end - top - PINNED_HEIGHT) : 0
        if (pinRef.current)
            pinRef.current.style.transform = `translateY(${pinOffset.current}px)`
        const next = hit ? { index: hit.fold, gutter: el.offsetWidth - el.clientWidth } : null
        setPinned(prev => (prev?.index === next?.index && prev?.gutter === next?.gutter ? prev : next))
    }, [folds, virtualizer])
    useEffect(() => {
        updatePinned()
        const el = scrollRef.current
        el?.addEventListener('scroll', updatePinned, { passive: true })
        return () => el?.removeEventListener('scroll', updatePinned)
    }, [updatePinned])
    const pinnedRow = pinned && rows[pinned.index]?.kind === 'fold' ? rows[pinned.index] as Extract<TranscriptRow, { kind: 'fold' }> : null
    const collapsePinned = () => {
        const el = scrollRef.current
        const start = pinned && virtualizer.measurementsCache[pinned.index]?.start
        if (!el || !pinnedRow || start == null)
            return
        // Land on the fold row itself, which is where the collapsed turn's next rows follow.
        el.scrollTop = Math.max(0, start - 8)
        toggleFold(pinnedRow.turn.key)
    }

    // Search opened this thread at a message: scroll there (unfolding its turn if the message is in
    // a folded process) and flash it.
    const reveal = appStore.reveal
    const revealed = useRef(0)
    const [flash, setFlash] = useState<string | null>(null)
    useEffect(() => {
        if (!reveal || reveal.key !== thread.key || revealed.current === reveal.n)
            return
        const prefix = `${reveal.entryId}:`
        const matches = (key: string) => key.startsWith(prefix) || key.startsWith(`group:${prefix}`)
        const index = rows.findIndex(r => matches(r.key))
        if (index === -1) {
            const turn = turns.find(t => t.key === reveal.entryId || t.steps.some(st => st.key.startsWith(prefix)))
            if (turn && !openTurns.has(turn.key)) {
                toggleFold(turn.key)
                return
            }
            // Not on screen yet (still loading), or not on the active branch.
            if (thread.loaded)
                revealed.current = reveal.n
            return
        }
        revealed.current = reveal.n
        stick.current = false
        virtualizer.scrollToIndex(index, { align: 'center' })
        // Rows above get measured as they mount; a second pass lands exactly.
        requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: 'center' }))
        setFlash(rows[index].key)
    }, [reveal, rows, turns, openTurns, thread, toggleFold, virtualizer])
    useEffect(() => {
        if (!flash)
            return
        const timer = setTimeout(() => setFlash(null), 1600)
        return () => clearTimeout(timer)
    }, [flash])

    const items = virtualizer.getVirtualItems()

    return (
        <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} data-transcript className="absolute inset-0 overflow-y-auto scrollbar-trigger [overflow-anchor:none]">
                <div className="mx-auto w-full max-w-5xl px-5">
                    <TranscriptTextContext value={TRANSCRIPT_TEXT[appStore.transcriptLang]}>
                        <CwdContext value={thread.cwd}>
                            <ThreadContext value={thread}>
                                <ViewStateContext value={viewState}>
                                    <UnpinContext value={unpin}>
                                        <TurnFoldContext value={toggleFold}>
                                            <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                                                {/*
                                                  * Rows sit in normal flow under one offset wrapper rather than each at its own
                                                  * translateY. When a row turns out taller than its estimate (typically one
                                                  * mounting above the viewport while scrolling up), the rows below move with it in
                                                  * the same layout, and the virtualizer's scrollTop correction lands in that same
                                                  * frame. With per-row transforms the correction was painted a frame before React
                                                  * re-positioned the rows, so content overlapped and jumped: the flicker.
                                                  */}
                                                <div className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}>
                                                    {items.map(item => (
                                                        <div
                                                            key={item.key}
                                                            ref={virtualizer.measureElement}
                                                            data-index={item.index}
                                                            data-row-kind={rows[item.index].kind}
                                                            data-revealed={flash === rows[item.index].key || undefined}
                                                            className="rounded-md transition-colors duration-700 data-[revealed]:bg-amber-400/15"
                                                        >
                                                            <TranscriptRowView row={rows[item.index]} thread={thread} top={item.index === 0} />
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </TurnFoldContext>
                                    </UnpinContext>
                                </ViewStateContext>
                            </ThreadContext>
                        </CwdContext>
                    </TranscriptTextContext>
                </div>
            </div>
            {pinnedRow && (
                <div
                    ref={pinRef}
                    className="absolute top-0 left-0 z-10"
                    style={{ right: pinned!.gutter, transform: `translateY(${pinOffset.current}px)` }}
                >
                    <div className="bg-ide-editor">
                        <div className="mx-auto w-full max-w-5xl px-5" style={{ paddingBlock: PIN_TOP }}>
                            <TranscriptTextContext value={TRANSCRIPT_TEXT[appStore.transcriptLang]}>
                                <FoldRow row={pinnedRow} onToggle={collapsePinned} />
                            </TranscriptTextContext>
                        </div>
                    </div>
                    {/* Fades the rows scrolling under it instead of a hard edge. */}
                    <div aria-hidden className="pointer-events-none h-3 bg-gradient-to-b from-[var(--ide-editor)] to-transparent" />
                </div>
            )}
            {/* Scroll-to-bottom pill: same styling as chat's MessageList. */}
            {showJump && (
                <button
                    type="button"
                    onClick={() => {
                        stick.current = true
                        toBottom()
                    }}
                    className="absolute bottom-3 left-1/2 z-10 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-md border border-gray-200 light:border-transparent bg-elevated text-gray-600 shadow-md transition-all duration-200 animate-in fade-in slide-in-from-bottom-2 hover:text-gray-900"
                    aria-label={tr('滚动到底部', 'Scroll to bottom')}
                >
                    <ArrowDown size={15} strokeWidth={1.8} />
                </button>
            )}
        </div>
    )
})
