import type { Thread } from '@/store/thread'
import { ArrowDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TRANSCRIPT_TEXT, TranscriptTextContext } from '@/lib/transcriptText'
import { appStore } from '@/store/app'
import { ThreadContext } from './ThreadContext'
import { CwdContext } from './ToolRow'
import { TurnView } from './TurnView'

const STICK_THRESHOLD = 80

/** Scrolling transcript. Sticks to the bottom while new output arrives unless the user scrolled up. */
export const MessageList = observer(({ thread }: { thread: Thread }) => {
    const scrollRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const [showJump, setShowJump] = useState(false)
    const turns = thread.turns

    // Open a thread at its latest message.
    useLayoutEffect(() => {
        stick.current = true
        const el = scrollRef.current
        if (el)
            el.scrollTop = el.scrollHeight
    }, [thread.key])

    useEffect(() => {
        const el = scrollRef.current
        const content = contentRef.current
        if (!el || !content)
            return
        const onScroll = () => {
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight
            stick.current = distance < STICK_THRESHOLD
            setShowJump(distance >= STICK_THRESHOLD * 2)
        }
        const observer = new ResizeObserver(() => {
            if (stick.current)
                el.scrollTop = el.scrollHeight
        })
        observer.observe(content)
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            observer.disconnect()
            el.removeEventListener('scroll', onScroll)
        }
    }, [])

    return (
        <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} className="absolute inset-0 overflow-y-auto scrollbar-trigger">
                <div ref={contentRef} className="mx-auto w-full max-w-5xl px-5 pb-6 pt-1">
                    <TranscriptTextContext value={TRANSCRIPT_TEXT[appStore.transcriptLang]}>
                        <CwdContext value={thread.cwd}>
                            <ThreadContext value={thread}>
                                {turns.map((turn, i) => (
                                    <TurnView key={turn.key} turn={turn} thread={thread} isLast={i === turns.length - 1} />
                                ))}
                            </ThreadContext>
                        </CwdContext>
                    </TranscriptTextContext>
                </div>
            </div>
            {/* Scroll-to-bottom pill: same styling as chat's MessageList. */}
            {showJump && (
                <button
                    type="button"
                    onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
                    className="absolute bottom-3 left-1/2 z-10 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-md border border-gray-200 bg-elevated text-gray-600 shadow-md transition-all duration-200 animate-in fade-in slide-in-from-bottom-2 hover:text-gray-900"
                    aria-label="滚动到底部"
                >
                    <ArrowDown size={15} strokeWidth={1.8} />
                </button>
            )}
        </div>
    )
})
