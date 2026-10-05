// Diff view in the style of pi's TUI (pi-cc-extensions): line-number gutters, a coloured bar on
// changed rows, word-level emphasis, syntax colours, and a "… N more" footer when clipped.
import type { DiffLine, DiffModel, SplitRow, UnifiedRow } from '@/lib/diffModel'
import type { Token } from '@/lib/highlightLines'
import { splitRows, unifiedRows } from '@/lib/diffModel'
import { highlightLines } from '@/lib/highlightLines'
import { useT } from '@/lib/transcriptText'
import { langOf } from '@/lib/toolMeta'
import { cn } from '@/lib/utils'
import { memo, useMemo } from 'react'

const MAX_HIGHLIGHT_ROWS = 3000

const rowBg = { del: 'bg-red-500/[0.09]', add: 'bg-emerald-500/[0.09]', ctx: '' } as const
const markBg = { del: 'rounded-[2px] bg-red-500/[0.26]', add: 'rounded-[2px] bg-emerald-500/[0.26]', ctx: '' } as const
const numColor = { del: 'text-red-500', add: 'text-emerald-600', ctx: 'text-gray-400' } as const
const barColor = { del: 'bg-red-500', add: 'bg-emerald-500', ctx: '' } as const

/** Token spans for one line, cut further where word-level marks start and end. */
function LineText({ line, tokens }: { line: DiffLine, tokens?: Token[] }) {
    const toks = tokens ?? [{ text: line.text, cls: '' }]
    const marks = line.marks ?? []
    if (!marks.length)
        return <>{toks.map((t, i) => <span key={i} className={t.cls || undefined}>{t.text}</span>)}</>
    const out: React.ReactNode[] = []
    let pos = 0
    let m = 0
    for (const t of toks) {
        let start = 0
        while (start < t.text.length) {
            const abs = pos + start
            while (m < marks.length && marks[m][1] <= abs)
                m++
            const inMark = m < marks.length && marks[m][0] <= abs
            const boundary = inMark ? marks[m][1] : m < marks.length ? marks[m][0] : Number.POSITIVE_INFINITY
            const end = Math.min(t.text.length, boundary - pos)
            out.push(<span key={out.length} className={cn(t.cls, inMark && markBg[line.kind])}>{t.text.slice(start, end)}</span>)
            start = end
        }
        pos += t.text.length
    }
    return <>{out}</>
}

/** Highlight each hunk's old side (context + removed) and new side (context + added) as whole snippets. */
function useTokens(model: DiffModel, path: string, enabled: boolean) {
    return useMemo(() => {
        const map = new Map<DiffLine, Token[]>()
        const lang = langOf(path)
        if (!enabled || lang === 'plaintext')
            return map
        for (const lines of model.hunks) {
            const oldSide = lines.filter(l => l.kind !== 'add')
            const newSide = lines.filter(l => l.kind !== 'del')
            const oldTokens = highlightLines(oldSide.map(l => l.text), lang)
            const newTokens = highlightLines(newSide.map(l => l.text), lang)
            oldSide.forEach((l, i) => oldTokens && map.set(l, oldTokens[i]))
            // Context lines take the new side's colours; both sides are identical text anyway.
            newSide.forEach((l, i) => newTokens && map.set(l, newTokens[i]))
        }
        return map
    }, [model, path, enabled])
}

const cell = 'py-px leading-[1.6]'
const num = `${cell} select-none px-2 text-right tabular-nums`
const text = `${cell} min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] pl-1.5 pr-3`

function Side({ line, tokens }: { line?: DiffLine, tokens: Map<DiffLine, Token[]> }) {
    if (!line) {
        return (
            <>
                <span />
                <span className={cn(num, 'bg-gray-500/[0.04]')} />
                <span className={cn(text, 'bg-gray-500/[0.04]')} />
            </>
        )
    }
    const no = line.kind === 'del' ? line.oldNo : line.newNo
    return (
        <>
            <span className={barColor[line.kind]} />
            <span className={cn(num, numColor[line.kind], rowBg[line.kind])}>{no}</span>
            <span className={cn(text, rowBg[line.kind])}><LineText line={line} tokens={tokens.get(line)} /></span>
        </>
    )
}

function SplitGrid({ rows, tokens }: { rows: SplitRow[], tokens: Map<DiffLine, Token[]> }) {
    return (
        <div className="grid grid-cols-[2px_max-content_minmax(0,1fr)_2px_max-content_minmax(0,1fr)]">
            <span />
            <span className={cn(num, 'pt-1 text-gray-400')}>old</span>
            <span />
            <span className="border-l border-ide-line" />
            <span className={cn(num, 'pt-1 text-gray-400')}>new</span>
            <span />
            {rows.map((row, i) => row.gap
                ? (
                        <div key={i} className="contents text-gray-400">
                            <span />
                            <span className={num}>⋮</span>
                            <span />
                            <span className="border-l border-ide-line" />
                            <span className={num}>⋮</span>
                            <span />
                        </div>
                    )
                : (
                        <div key={i} className="contents">
                            <Side line={row.left} tokens={tokens} />
                            {/* the right side's bar cell doubles as the centre divider */}
                            <div className="contents [&>span:first-child]:border-l [&>span:first-child]:border-ide-line">
                                <Side line={row.right} tokens={tokens} />
                            </div>
                        </div>
                    ))}
        </div>
    )
}

function UnifiedGrid({ rows, tokens }: { rows: UnifiedRow[], tokens: Map<DiffLine, Token[]> }) {
    return (
        <div className="grid grid-cols-[2px_max-content_max-content_minmax(0,1fr)] pt-1">
            {rows.map((row, i) => {
                if (row.gap) {
                    return (
                        <div key={i} className="contents text-gray-400">
                            <span />
                            <span className={num}>⋮</span>
                            <span className={num} />
                            <span />
                        </div>
                    )
                }
                const { line } = row
                const k = line.kind
                return (
                    <div key={i} className="contents">
                        <span className={barColor[k]} />
                        <span className={cn(num, 'pr-1', numColor[k], rowBg[k])}>{line.oldNo}</span>
                        <span className={cn(num, 'pl-1', numColor[k], rowBg[k])}>{line.newNo}</span>
                        <span className={cn(text, rowBg[k])}>
                            <span className={cn('select-none', numColor[k])}>{k === 'add' ? '+ ' : k === 'del' ? '- ' : '  '}</span>
                            <LineText line={line} tokens={tokens.get(line)} />
                        </span>
                    </div>
                )
            })}
        </div>
    )
}

export const TuiDiff = memo(({ model, path, mode, limit, onShowMore }: {
    model: DiffModel
    path: string
    mode: 'split' | 'unified'
    /** Show at most this many rows; the rest sit behind a "… N more" footer. */
    limit?: number
    onShowMore?: () => void
}) => {
    const split = useMemo(() => (mode === 'split' ? splitRows(model) : null), [model, mode])
    const unified = useMemo(() => (mode === 'unified' ? unifiedRows(model) : null), [model, mode])
    const total = (split ?? unified)!.length
    const hidden = limit != null ? Math.max(0, total - limit) : 0
    const tokens = useTokens(model, path, total <= MAX_HIGHLIGHT_ROWS)
    const t = useT()

    return (
        <div className="overflow-hidden rounded-md bg-[var(--bg-side)] font-mono text-[12px] text-gray-800 select-text dark:border dark:border-gray-100">
            {split
                ? <SplitGrid rows={limit != null ? split.slice(0, limit) : split} tokens={tokens} />
                : <UnifiedGrid rows={limit != null ? unified!.slice(0, limit) : unified!} tokens={tokens} />}
            {hidden > 0
                ? (
                        <button
                            type="button"
                            onClick={onShowMore}
                            className="block w-full px-3 py-1.5 text-left font-sans text-gray-500 hover:text-gray-900"
                        >
                            {`${t.moreDiffLines(hidden)} · ${t.expand}`}
                        </button>
                    )
                : <div className="h-1" />}
        </div>
    )
})
