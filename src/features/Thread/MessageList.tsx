import type { SubagentRun } from '@/lib/subagents'
import type { Thread } from '@/store/thread'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { estimateRow } from '@/lib/rowEstimate'
import { runTurns } from '@/lib/subagents'
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
/** How close to the very bottom counts as "at the bottom" for re-pinning: scrolling down must actually arrive, not just come near. */
const PIN_DISTANCE = 4
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
 * arrives unless the user scrolled up. With `subagent` it shows that child's transcript instead.
 */
export const MessageList = observer(({ thread, subagent }: { thread: Thread, subagent?: SubagentRun }) => {
    const scrollRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(null)
    /** Rows still at their estimated height: their first measurement is coming. */
    const estimated = useRef(new Set<string>())
    /**
     * Whether a row resizing above the top of the viewport moves scrollTop with it. Pinned, never: the
     * bottom is the anchor, and the correction would stack on the bottom-following and bounce the view.
     * Scrolled up, a row's first measurement is corrected if the row starts above the top (it mounted
     * there while scrolling up), but later growth only if the whole row is above: a partly visible row
     * that grows is the streaming reply getting longer at its end, and correcting for it moved the view
     * down a line per token, right back to the bottom.
     */
    const adjustForResize = useCallback((item: { key: unknown, start: number, end: number }, _delta: number, v: Virtualizer<HTMLDivElement, Element>) => {
        const first = estimated.current.delete(item.key as string)
        if (stick.current)
            return false
        const top = v.scrollElement?.scrollTop ?? 0
        return first ? item.start < top : item.end <= top
    }, [])
    /** Pins to the bottom or lets go. */
    const follow = useCallback((on: boolean) => {
        stick.current = on
    }, [])
    const [, rerender] = useReducer((n: number) => n + 1, 0)
    const [showJump, setShowJump] = useState(false)
    const viewKey = subagent ? `${thread.key}#${subagent.id}` : thread.key
    const childTurns = useMemo(() => subagent && runTurns(subagent), [subagent?.details, subagent?.status])
    const turns = childTurns ?? thread.turns
    // Finished turns the user unfolded, per view.
    const [unfolded, setUnfolded] = useState(() => ({ view: viewKey, keys: new Set<string>() as ReadonlySet<string> }))
    const openTurns = unfolded.view === viewKey ? unfolded.keys : NO_TURNS
    const compacting = !subagent && thread.compacting
    const rows = useMemo(() => transcriptRows(turns, openTurns, compacting), [turns, openTurns, compacting])
    // Expanding grows the list; don't let bottom-pinning scroll the clicked row away. Scrolling back
    // to the bottom pins again (onScroll).
    const unpin = useCallback(() => follow(false), [follow])
    const toggleFold = useCallback((key: string) => {
        unpin()
        setUnfolded((prev) => {
            const keys = new Set(prev.view === viewKey ? prev.keys : [])
            if (!keys.delete(key))
                keys.add(key)
            return { view: viewKey, keys }
        })
    }, [viewKey, unpin])
    // Expanded / show-all toggles survive rows scrolling out of view (and back).
    const viewState = useMemo(() => new Map<string, unknown>(), [viewKey])

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        getItemKey: i => rows[i].key,
        estimateSize: (i) => {
            estimated.current.add(rows[i].key)
            return estimateRow(rows[i], scrollRef.current?.clientWidth ?? 0)
        },
        overscan: 6,
        paddingStart: PAD_TOP,
        paddingEnd: PAD_BOTTOM,
        // Scroll-driven range changes render before the next paint, so newly exposed rows are never blank.
        useFlushSync: true,
        // A row resized (streaming text, a result coming in): render before this frame paints, so the
        // list's height and the bottom-following below land in it rather than a frame late.
        onChange: (_, sync) => {
            if (!sync && stick.current)
                queueMicrotask(() => flushSync(rerender))
        },
    })
    if (!virtualizerRef.current) {
        virtualizerRef.current = virtualizer
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjustForResize
    }

    /**
     * The bottom-following scrolls count as scrolling to the virtualizer, which then leaves newly
     * mounted rows at their estimate until the next frame (a streamed message turning into its row
     * flashed at the wrong height). Pinned, they are measured as they mount.
     */
    const measureRow = useCallback((node: HTMLDivElement | null) => {
        virtualizer.measureElement(node)
        if (node && stick.current && virtualizer.isScrolling)
            virtualizer.resizeItem(virtualizer.indexFromElement(node), node.offsetHeight)
    }, [virtualizer])

    const toBottom = () => {
        const el = scrollRef.current
        if (el)
            el.scrollTop = el.scrollHeight
    }

    // Open a thread (or subagent) at its latest message.
    useLayoutEffect(() => {
        follow(true)
        setShowJump(false)
        toBottom()
    }, [viewKey, follow])

    // Pinned: every render that changed the list's height scrolls with it before paint.
    useLayoutEffect(() => {
        if (stick.current)
            toBottom()
    })

    useEffect(() => {
        const el = scrollRef.current
        const list = listRef.current
        if (!el || !list)
            return
        // Letting go is decided by the user's input, not by how far from the bottom the view is:
        // a wheel tick moves a few dozen px, still "near the bottom", and the next streamed token
        // would pull it straight back. Only scrolling down to the very bottom pins again.
        let lastTop = el.scrollTop
        let dragging = false
        const onScroll = () => {
            const top = el.scrollTop
            const distance = el.scrollHeight - top - el.clientHeight
            // Moving up short of the bottom is the user: content shrinking only clamps to the bottom.
            if (top < lastTop - 1 && distance > 1)
                follow(false)
            else if (!dragging)
                follow(distance < PIN_DISTANCE)
            lastTop = top
            setShowJump(distance >= STICK_THRESHOLD * 2)
        }
        // Wheel and keys arrive before the scroll they cause, so a render in between can't undo them.
        const scrollsInside = (target: EventTarget | null) => {
            for (let node = target as HTMLElement | null; node && node !== el; node = node.parentElement) {
                if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight)
                    return true
            }
            return false
        }
        const onWheel = (e: WheelEvent) => {
            if (e.deltaY < 0 && el.scrollHeight > el.clientHeight && !scrollsInside(e.target))
                follow(false)
        }
        const onKey = (e: KeyboardEvent) => {
            const editable = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
            if (!editable && (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home'))
                follow(false)
        }
        // The scrollbar: let go while it's held, pin again on release if it ended at the bottom.
        const onPointerDown = (e: PointerEvent) => {
            if (e.target !== el)
                return
            dragging = true
            follow(false)
            window.addEventListener('pointerup', () => {
                dragging = false
                follow(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_DISTANCE)
            }, { once: true })
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
        el.addEventListener('wheel', onWheel, { passive: true })
        el.addEventListener('keydown', onKey)
        el.addEventListener('pointerdown', onPointerDown)
        return () => {
            observer.disconnect()
            el.removeEventListener('scroll', onScroll)
            el.removeEventListener('wheel', onWheel)
            el.removeEventListener('keydown', onKey)
            el.removeEventListener('pointerdown', onPointerDown)
        }
    }, [follow])

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
        if (!reveal || reveal.key !== viewKey || revealed.current === reveal.n)
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
        follow(false)
        virtualizer.scrollToIndex(index, { align: 'center' })
        // Rows above get measured as they mount; a second pass lands exactly.
        requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: 'center' }))
        setFlash(rows[index].key)
    }, [reveal, rows, turns, openTurns, thread, toggleFold, virtualizer, follow])
    useEffect(() => {
        if (!flash)
            return
        const timer = setTimeout(() => setFlash(null), 1600)
        return () => clearTimeout(timer)
    }, [flash])

    const items = virtualizer.getVirtualItems()

    return (
        <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} data-transcript className="absolute inset-0 overflow-y-auto scrollbar-trigger [overflow-anchor:none] [scrollbar-gutter:stable]">
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
                                                            ref={measureRow}
                                                            data-index={item.index}
                                                            data-row-kind={rows[item.index].kind}
                                                            data-revealed={flash === rows[item.index].key || undefined}
                                                            className="rounded-md transition-colors duration-700 data-[revealed]:bg-amber-400/15"
                                                        >
                                                            <TranscriptRowView row={rows[item.index]} thread={thread} subagent={subagent} top={item.index === 0} />
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
                        follow(true)
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
