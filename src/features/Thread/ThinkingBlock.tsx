// Thinking is printed inline in dim italics, the way pi's TUI shows it, rather than behind a toggle.
// Long thoughts are clipped to five lines: while streaming the clip follows the newest text, once
// done it shows the first lines with a "… N more lines" toggle.
import { Markdown } from '@/components/Markdown'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { Gutter } from './ToolRow'
import { useViewState } from './viewState'

const MAX_LINES = 5
/** Five lines of .markdown-body text (line-height 1.65); used while streaming, when lines are not measured. */
const STREAM_HEIGHT = `calc(var(--app-font-size) * 1.65 * ${MAX_LINES})`
const FADE_BOTTOM = 'linear-gradient(to bottom, black calc(100% - 1.6em), transparent)'
const FADE_TOP = 'linear-gradient(to top, black calc(100% - 1.6em), transparent)'

/** Rendered line boxes of an element's text, top to bottom, relative to the element. */
function lineBoxes(el: HTMLElement): { top: number, bottom: number }[] {
    const origin = el.getBoundingClientRect().top
    const rects: DOMRect[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0)
                rects.push(rect)
        }
    }
    rects.sort((a, b) => a.top - b.top)
    // Fragments on one visual line (text, inline code) overlap vertically; merge them.
    const lines: { top: number, bottom: number }[] = []
    for (const rect of rects) {
        const mid = (rect.top + rect.bottom) / 2 - origin
        const last = lines.at(-1)
        if (last && mid >= last.top && mid <= last.bottom)
            last.bottom = Math.max(last.bottom, rect.bottom - origin)
        else
            lines.push({ top: rect.top - origin, bottom: rect.bottom - origin })
    }
    return lines
}

export const ThinkingBlock = memo(({ id, text, streaming, redacted }: { id: string, text: string, streaming: boolean, redacted: boolean }) => {
    const t = useT()
    const [expanded, setExpanded] = useViewState(`${id}:thinking`, false)
    // Height that shows exactly MAX_LINES lines, and how many lines that hides; null when it all fits.
    const [clip, setClip] = useState<{ height: number, hidden: number } | null>(null)
    const boxRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
        const box = boxRef.current
        const content = contentRef.current
        if (!box || !content)
            return
        const update = () => {
            if (streaming) {
                // Follow the newest thought while it streams.
                box.scrollTop = box.scrollHeight
                setClip(content.offsetHeight > box.clientHeight + 1 ? { height: 0, hidden: 0 } : null)
                return
            }
            const lines = lineBoxes(content)
            setClip(lines.length > MAX_LINES ? { height: Math.ceil(lines[MAX_LINES - 1].bottom) + 2, hidden: lines.length - MAX_LINES } : null)
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(content)
        return () => observer.disconnect()
    }, [streaming, text])

    if (redacted || !text) {
        return (
            <Gutter>
                <div className={cn('flex h-6 items-center text-[13px] italic text-gray-500', streaming && 'text-shimmer')}>
                    {redacted ? t.thinkingRedacted : t.thinking}
                </div>
            </Gutter>
        )
    }

    const clipped = !expanded && (streaming || clip)
    const mask = clipped && clip ? (streaming ? FADE_TOP : FADE_BOTTOM) : undefined
    return (
        <Gutter>
            <div
                ref={boxRef}
                className="overflow-hidden"
                style={{
                    maxHeight: !clipped ? undefined : streaming ? STREAM_HEIGHT : clip!.height,
                    maskImage: mask,
                    WebkitMaskImage: mask,
                }}
            >
                <div ref={contentRef}>
                    <Markdown content={text} streaming={streaming} className="italic !text-gray-500 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:not-italic" />
                </div>
            </div>
            {!streaming && clip && (
                <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(v => !v)}
                    className="mt-0.5 text-[12.5px] text-gray-400 hover:text-gray-800"
                >
                    {expanded ? t.showLess : `${t.moreLines(clip.hidden)} · ${t.expand}`}
                </button>
            )}
        </Gutter>
    )
})
