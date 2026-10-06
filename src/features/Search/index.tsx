// ⌘⇧F: full-text search over every pi session, terminal ones included, laid out like JetBrains'
// Find in Files popup: query on top, matches below, Enter opens the thread at the message.
import type { SearchResult } from '@shared/ipc'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { basename, cn, relativeTime } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Loader2, Search } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { newThreadLabel, tr } from '@/lib/i18n'

const DEBOUNCE_MS = 150

/** The snippet with every query word marked. */
function Highlighted({ text, words }: { text: string, words: string[] }) {
    if (!words.length)
        return text
    const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    return text.split(pattern).map((part, i) => (i % 2 ? <mark key={i} className="rounded-[2px] bg-amber-300/40 text-inherit">{part}</mark> : <Fragment key={i}>{part}</Fragment>))
}

/** One selectable row: a session's title row (opens at its end) or one of its matching messages. */
interface Row {
    result: SearchResult
    entryId?: string
}

export const SearchDialog = observer(() => {
    const open = appStore.searchOpen
    const [query, setQuery] = useState('')
    const [here, setHere] = useState(false)
    const [results, setResults] = useState<SearchResult[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [index, setIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    const words = useMemo(() => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))], [query])
    const project = appStore.activeProject

    useEffect(() => {
        if (!words.length) {
            setResults(null)
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        const timer = setTimeout(() => {
            window.pi.searchSessions(query)
                .then((r) => {
                    if (!cancelled) {
                        setResults(r)
                        setError('')
                        setIndex(0)
                    }
                })
                .catch(e => !cancelled && setError(String(e?.message ?? e)))
                .finally(() => !cancelled && setLoading(false))
        }, DEBOUNCE_MS)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [query, words.length])

    const shown = useMemo(() => (results ?? []).filter(r => !here || r.cwd === project), [results, here, project])
    const rows: Row[] = useMemo(() => shown.flatMap(result => [{ result }, ...result.hits.map(h => ({ result, entryId: h.entryId }))]), [shown])

    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [index])

    const pick = (row: Row | undefined) => {
        if (!row)
            return
        appStore.setSearchOpen(false)
        appStore.openSearchResult(row.result, row.entryId)
    }

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setIndex(i => (rows.length ? (i + step + rows.length) % rows.length : 0))
        }
        else if (e.key === 'Enter') {
            e.preventDefault()
            pick(rows[index])
        }
    }

    let rowIndex = -1
    return (
        <Dialog open={open} onOpenChange={appStore.setSearchOpen}>
            <DialogContent hideClose className="max-w-[720px] gap-0 self-start p-0 mt-[10vh]" aria-describedby={undefined} onKeyDown={onKeyDown}>
                <DialogTitle className="sr-only">{tr('搜索线程', 'Search threads')}</DialogTitle>
                <div className="flex h-10 items-center gap-2 border-b border-[var(--jb-dialog-border)] px-3">
                    {loading ? <Loader2 size={15} className="shrink-0 animate-spin text-gray-500" /> : <Search size={15} className="shrink-0 text-gray-500" />}
                    <input
                        autoFocus
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        aria-label={tr('搜索内容', 'Search text')}
                        placeholder={tr('搜索所有线程的提问和回复', 'Search prompts and replies in every thread')}
                        className="min-w-0 flex-1 bg-transparent text-[14px] text-gray-900 outline-none placeholder:text-gray-400"
                    />
                    {project && (
                        <button
                            type="button"
                            aria-pressed={here}
                            onClick={() => setHere(v => !v)}
                            title={tr('只看当前项目', 'Current project only')}
                            className={cn('h-6 shrink-0 rounded-md px-2 text-[12px]', here ? 'bg-black/[0.08] text-gray-900' : 'text-gray-500 hover:text-gray-800')}
                        >
                            {basename(project)}
                        </button>
                    )}
                </div>
                <div ref={listRef} role="listbox" aria-label={tr('搜索结果', 'Search results')} className="max-h-[min(560px,calc(100vh-200px))] overflow-y-auto p-1">
                    {error && <div className="px-3 py-3 text-[12.5px] text-red-500">{error}</div>}
                    {!words.length && <div className="px-3 py-3 text-[12.5px] text-gray-500">{tr('输入关键词，多个词之间用空格隔开（需要同时出现）。工具输出不参与搜索。', 'Type words separated by spaces (all must appear). Tool output is not searched.')}</div>}
                    {results && !shown.length && !loading && <div className="px-3 py-3 text-[12.5px] text-gray-500">{tr('没有找到', 'No matches')}</div>}
                    {shown.map((result) => {
                        const head = ++rowIndex
                        return (
                            <div key={result.session} role="group" className="pb-1">
                                <div
                                    role="option"
                                    aria-selected={head === index}
                                    data-active={head === index}
                                    onMouseMove={() => setIndex(head)}
                                    onClick={() => pick(rows[head])}
                                    className={cn('flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px]', head === index && 'bg-ide-sel')}
                                >
                                    <span className="min-w-0 flex-1 truncate text-gray-900">
                                        <Highlighted text={result.title || newThreadLabel()} words={words} />
                                    </span>
                                    <span className="shrink-0 text-[12px] text-gray-500">{basename(result.cwd)}</span>
                                    {result.total > result.hits.length && <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{tr(`${result.total} 处`, `${result.total} hits`)}</span>}
                                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-gray-400">{relativeTime(result.updatedAt)}</span>
                                </div>
                                {result.hits.map((hit) => {
                                    const i = ++rowIndex
                                    return (
                                        <div
                                            key={hit.entryId}
                                            role="option"
                                            aria-selected={i === index}
                                            data-active={i === index}
                                            onMouseMove={() => setIndex(i)}
                                            onClick={() => pick(rows[i])}
                                            className={cn('flex cursor-default gap-2 rounded-md py-1 pl-4 pr-2 text-[12.5px] leading-[18px]', i === index && 'bg-ide-sel')}
                                        >
                                            <span className="w-3 shrink-0 text-center text-gray-400" title={hit.role === 'user' ? tr('提问', 'Prompt') : tr('回复', 'Reply')}>{hit.role === 'user' ? '›' : 'π'}</span>
                                            <span className="line-clamp-2 min-w-0 flex-1 break-words text-gray-700">
                                                <Highlighted text={hit.snippet} words={words} />
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                        )
                    })}
                </div>
            </DialogContent>
        </Dialog>
    )
})
