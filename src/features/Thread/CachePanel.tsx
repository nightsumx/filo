// The status line's `cache 83%`, and the panel it opens: every request of the thread that billed its
// prefix again instead of reading it from the prompt cache, why, and what it cost. A row scrolls the
// conversation to that request. pi-cc-tui's /cache lists the same (packages/capabilities/lib/promptCache.ts).
import type { Thread } from '@/store/thread'
import type { CacheMiss, CacheStats, MissReason } from 'pi-capabilities/lib/promptCache.ts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { contentText } from '@/lib/timeline'
import { TRANSCRIPT_TEXT } from '@/lib/transcriptText'
import { cn, formatCost, formatCount } from '@/lib/utils'
import { appStore } from '@/store/app'
import { runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { cacheMisses, channelFault, EXPECTED_MISSES, isNotable, missesByReason } from 'pi-capabilities/lib/promptCache.ts'
import { useState } from 'react'

interface Row {
    key: string
    at: number
    miss: CacheMiss
    /** The prompt whose run made the request. */
    prompt: string
}

const reasonColor = (reason: MissReason) => (EXPECTED_MISSES.has(reason) ? 'bg-gray-400' : reason === 'partial' ? 'bg-[var(--sl-warn)]' : 'bg-[var(--sl-danger)]')

// The status line sits outside the transcript's language context, so both read the setting itself.
const Panel = observer(({ thread, stats, close }: { thread: Thread, stats: CacheStats, close: () => void }) => {
    const t = TRANSCRIPT_TEXT[appStore.transcriptLang]
    const [reason, setReason] = useState<MissReason | null>(null)
    const [small, setSmall] = useState(false)
    const list = [...thread.items, ...thread.live]
    const misses = cacheMisses(list.map(m => m.message), thread.cacheTtl)
    const rows: Row[] = []
    let prompt = ''
    list.forEach(({ key, message }, i) => {
        if (message.role === 'user')
            prompt = contentText(message.content)
        const miss = misses[i]
        if (miss)
            rows.push({ key, at: message.timestamp, miss, prompt })
    })
    const groups = missesByReason(misses)
    const channel = channelFault(misses, stats.requests)
    const matching = rows.filter(r => !reason || r.miss.reason === reason)
    const shown = matching.filter(r => small || r.miss.significant).reverse()
    const pct = stats.rate === null ? 0 : Math.floor(stats.rate * 100)
    const saving = stats.extraCost + stats.warming

    const reveal = (key: string) => {
        close()
        runInAction(() => {
            appStore.reveal = { key: thread.key, entryId: key, n: (appStore.reveal?.n ?? 0) + 1 }
        })
    }

    return (
        <div className="flex max-h-[min(560px,70vh)] flex-col gap-3 text-[12.5px] tabular-nums">
            <header className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-gray-900">{t.cacheTitle}</span>
                {stats.cost > 0 && (
                    <span className="text-gray-900" title={t.cacheFloorHint}>
                        {t.cacheFloor(formatCost(stats.cost), formatCost(stats.cost - saving))}
                        {saving >= 0.01 && <span className="font-medium text-[var(--sl-warn)]">{t.cacheSaving(formatCost(saving), Math.round(saving / stats.cost * 100))}</span>}
                    </span>
                )}
                <span className="text-gray-500">{t.cacheSession(pct, formatCount(stats.read), formatCount(stats.prompt))}</span>
                {stats.misses > 0 && <span className="text-gray-500">{t.cacheWaste(formatCount(stats.missedTokens), stats.misses)}</span>}
                {stats.warming >= 0.01 && <span className="text-gray-500">{t.cacheWarming(formatCost(stats.warming))}</span>}
            </header>
            {channel && <p className="leading-snug text-[var(--sl-warn)]">{t.cacheChannel(channel.count, stats.requests, channel.extraCost ? formatCost(channel.extraCost) : '')}</p>}

            {groups.length === 0
                ? <p className="text-gray-500">{t.cacheNoMisses}</p>
                : (
                        <>
                            <div role="radiogroup" aria-label={t.statCacheMisses} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-px">
                                {groups.map(g => (
                                    <button
                                        key={g.reason}
                                        type="button"
                                        role="radio"
                                        aria-checked={reason === g.reason}
                                        title={t.missReasonHint[g.reason]}
                                        onClick={() => setReason(reason === g.reason ? null : g.reason)}
                                        className={cn(
                                            'col-span-4 grid grid-cols-subgrid items-center rounded px-1.5 py-0.5 text-left outline-none hover:bg-black/[0.06] focus-visible:ring-1 focus-visible:ring-gray-400',
                                            reason === g.reason && 'bg-black/[0.08]',
                                        )}
                                    >
                                        <span aria-hidden className={cn('size-2 rounded-full', reasonColor(g.reason))} />
                                        <span className="text-gray-700">
                                            {t.missReason[g.reason]}
                                            <span className="text-gray-400">{` ×${g.count}`}</span>
                                        </span>
                                        <span className="text-right text-gray-800">{t.missedTokens(formatCount(g.missed))}</span>
                                        <span className="w-14 text-right text-gray-500">{g.extraCost ? `+${formatCost(g.extraCost)}` : ''}</span>
                                    </button>
                                ))}
                            </div>
                            {reason && <p className="text-[11.5px] leading-snug text-gray-500">{t.missReasonHint[reason]}</p>}

                            <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-2 text-[11.5px] text-gray-500">
                                <span>{t.cacheRequests(shown.length, matching.length)}</span>
                                {matching.some(r => !r.miss.significant) && (
                                    <label className="flex cursor-pointer items-center gap-1.5">
                                        <input type="checkbox" checked={small} onChange={e => setSmall(e.target.checked)} className="accent-[var(--ide-accent,#3574f0)]" />
                                        {t.cacheShowAll}
                                    </label>
                                )}
                            </div>
                            <ol aria-label={t.statCacheMisses} className="-mx-1.5 -mt-1 flex min-h-0 list-none flex-col pl-0 overflow-y-auto">
                                {shown.map(r => (
                                    <li key={r.key}>
                                        <button
                                            type="button"
                                            title={t.cacheJump}
                                            onClick={() => reveal(r.key)}
                                            className="flex w-full flex-col gap-px rounded px-1.5 py-1 text-left outline-none hover:bg-black/[0.06] focus-visible:ring-1 focus-visible:ring-gray-400"
                                        >
                                            <span className="flex items-center gap-2">
                                                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', reasonColor(r.miss.reason))} />
                                                <span className={cn('min-w-0 flex-1 truncate', isNotable(r.miss) ? 'text-gray-900' : 'text-gray-700')}>
                                                    {r.miss.reason === 'idle' ? `${t.missReason.idle} ${t.duration(r.miss.idleMs)}` : t.missReason[r.miss.reason]}
                                                </span>
                                                <span className="shrink-0 text-gray-800">{t.missedTokens(formatCount(r.miss.missed))}</span>
                                                <span className="w-14 shrink-0 text-right text-gray-500">{r.miss.extraCost ? `+${formatCost(r.miss.extraCost)}` : ''}</span>
                                            </span>
                                            <span className="flex gap-2 pl-4 text-[11.5px] text-gray-500">
                                                <span className="shrink-0">{`${t.clock(r.at)} · ${t.cacheRead(formatCount(r.miss.read), formatCount(r.miss.expected))}`}</span>
                                                {r.prompt && <span className="min-w-0 truncate text-gray-400">{r.prompt}</span>}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ol>
                        </>
                    )}
        </div>
    )
})

/** `cache 83%`: the conversation's hit rate, coloured by the latest request's miss; opens the panel. */
export const CacheFigure = observer(({ thread, stats, className }: { thread: Thread, stats: CacheStats, className: string }) => {
    const t = TRANSCRIPT_TEXT[appStore.transcriptLang]
    const [open, setOpen] = useState(false)
    const pct = Math.floor((stats.rate ?? 0) * 100)
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                aria-label={`${t.cacheTitle}: cache ${pct}%`}
                className={cn('rounded-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-gray-400', className)}
            >
                {`cache ${pct}%`}
            </PopoverTrigger>
            {/* No focus ring on the first reason when it opens; Tab still reaches them. */}
            <PopoverContent side="top" align="start" className="w-[420px] p-3" onOpenAutoFocus={e => e.preventDefault()}>
                <Panel thread={thread} stats={stats} close={() => setOpen(false)} />
            </PopoverContent>
        </Popover>
    )
})
