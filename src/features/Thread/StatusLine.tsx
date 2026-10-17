// Per-thread status line under the composer, a port of pi-cc-tui's cc-statusline footer:
//   ➜ pi-cc-tui █░░░░ 23% 238k/1000k cache 96% ⚡ 1.2ktok 20/s $103.00 +7882 -15 Opus 5.5 (high) ⏱ 1m19s   74% until auto-compact
import type { CompactionInfo } from '@shared/ipc'
import type { Thread } from '@/store/thread'
import { cacheStats, EXPECTED_MISSES } from 'pi-capabilities/lib/promptCache.ts'
import { basename } from '@/lib/utils'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { CacheFigure } from './CachePanel'
import { SpendFigure } from './SpendPanel'
import { tr } from '@/lib/i18n'

// xterm-256 colours cc-statusline uses (108, 110, 141, 244, 179, 174); light theme gets darker twins in index.css.
const OK = 'text-[var(--sl-ok)]'
const DIR = 'text-[var(--sl-dir)]'
const MODEL = 'text-[var(--sl-model)]'
const MUTED = 'text-[var(--sl-muted)]'
const WARN = 'text-[var(--sl-warn)]'
const DANGER = 'text-[var(--sl-danger)]'

const k = (n: number) => `${Math.round(n / 1000)}k`
const ago = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`)

/** Session totals from the messages, the same way cc-statusline walks session entries. */
function tally(thread: Thread, now: number) {
    let add = 0
    let del = 0
    let recentOut = 0
    const messages = [...thread.items, ...thread.live].map(i => i.message)
    for (const m of messages) {
        if (m.role === 'assistant') {
            if (now - m.timestamp < 60_000)
                recentOut += m.usage?.output || 0
            for (const part of m.content) {
                if (part.type === 'toolCall' && part.name === 'write' && typeof part.arguments?.content === 'string') {
                    const c = part.arguments.content as string
                    add += c.split('\n').length - (c.endsWith('\n') ? 1 : 0)
                }
            }
        }
        if (m.role === 'toolResult' && m.toolName === 'edit' && typeof m.details?.diff === 'string') {
            for (const line of (m.details.diff as string).split('\n')) {
                if (line[0] === '+')
                    add++
                if (line[0] === '-')
                    del++
            }
        }
    }
    const cache = cacheStats(messages, thread.cacheTtl)
    return { cost: cache.cost, add, del, recentOut, cache }
}

/** pi's resolved auto-compaction settings for this project and model (re-read when usage or settings change). */
function useCompaction(thread: Thread): CompactionInfo | null {
    const model = thread.state?.model
    const modelKey = model ? `${model.provider}/${model.id}` : undefined
    const [info, setInfo] = useState<CompactionInfo | null>(null)
    const tokens = thread.stats?.contextUsage?.tokens
    const epoch = appStore.piSettingsEpoch
    useEffect(() => {
        let cancelled = false
        window.pi.compactionInfo(thread.cwd, modelKey)
            .then(i => !cancelled && setInfo(i))
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [thread.cwd, modelKey, tokens, epoch])
    return info
}

export const StatusLine = observer(({ thread }: { thread: Thread }) => {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [])
    const compaction = useCompaction(thread)
    const totals = tally(thread, now)
    const { add, del, recentOut, cache } = totals
    // pi's own session total also covers abandoned branches, like cc-statusline's walk over every entry;
    // the loaded messages are only the active branch, so they are the fallback before pi has started.
    const cost = thread.stats?.cost ?? totals.cost
    const usage = thread.stats?.contextUsage
    const model = thread.state?.model
    const level = model?.reasoning ? thread.state?.thinkingLevel ?? 'off' : 'off'

    const parts: React.ReactNode[] = [
        <span key="arrow" className={OK}>➜</span>,
        <span key="dir" className={DIR} title={thread.cwd}>{basename(thread.cwd) || thread.cwd}</span>,
    ]

    if (usage?.tokens && usage.contextWindow) {
        const ratio = usage.tokens / usage.contextWindow
        const pct = Math.floor(ratio * 100)
        const filled = Math.min(5, Math.floor(ratio * 5 + 0.5))
        const color = pct >= 80 ? DANGER : pct >= 50 ? WARN : OK
        const figure = (
            <>
                <span className={color}>{'█'.repeat(filled)}</span>
                <span className={MUTED}>{'░'.repeat(5 - filled)}</span>
                {' '}
                <span className={color}>{`${pct}%`}</span>
                {' '}
                <span className={MUTED}>{`${k(usage.tokens)}/${k(usage.contextWindow)}`}</span>
            </>
        )
        // The terminal's /compact, one click away from the figure it shrinks.
        parts.push(thread.features.compaction
            ? (
                    <button
                        key="ctx"
                        type="button"
                        disabled={thread.running || thread.compacting}
                        title={thread.compacting ? tr('正在压缩上下文', 'Compacting context') : tr('上下文用量，点击压缩', 'Context usage; click to compact')}
                        onClick={() => void thread.compact()}
                        className="rounded-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-gray-400 disabled:no-underline"
                    >
                        {figure}
                    </button>
                )
            : <span key="ctx" title={tr('上下文用量', 'Context usage')}>{figure}</span>)
    }

    // The conversation's prompt-cache hit rate; a turn's own is in its footer's card. A significant miss on the latest
    // request turns it amber (the user caused it, or a re-billed tail) or red (the cache was lost for no
    // visible reason); click for the list.
    if (cache.rate !== null) {
        const miss = cache.lastMiss?.significant ? cache.lastMiss : null
        const color = miss ? (EXPECTED_MISSES.has(miss.reason) || miss.reason === 'partial' ? WARN : DANGER) : cache.rate >= 0.5 ? OK : MUTED
        parts.push(<CacheFigure key="cache" thread={thread} stats={cache} className={color} />)
    }

    if (recentOut) {
        parts.push(
            <span key="rate" title={tr('最近 60 秒输出', 'Output over the last 60s')}>
                <span className={OK}>{`⚡ ${recentOut >= 1000 ? `${(recentOut / 1000).toFixed(1)}k` : recentOut}tok`}</span>
                {' '}
                <span className={MUTED}>{`${Math.round(recentOut / 60)}/s`}</span>
            </span>,
        )
    }

    if (cost)
        parts.push(<SpendFigure key="cost" cost={cost} className={cost >= 5 ? DANGER : cost >= 1 ? WARN : MUTED} />)

    if (add || del) {
        parts.push(
            <span key="lines" title={tr('本会话改动行数', 'Lines changed this session')}>
                <span className={OK}>{`+${add}`}</span>
                {' '}
                <span className={DANGER}>{`-${del}`}</span>
            </span>,
        )
    }

    if (model) {
        const name = model.name.split(' (')[0].replace('Claude ', '')
        parts.push(['high', 'xhigh', 'max'].includes(level)
            ? (
                    <span key="model" title={`${model.provider}/${model.id}`}>
                        <span className={MODEL}>{name}</span>
                        {' '}
                        <span className={MUTED}>(</span>
                        <span className={WARN}>{level}</span>
                        <span className={MUTED}>)</span>
                    </span>
                )
            : <span key="model" className={MODEL} title={`${model.provider}/${model.id}`}>{name}</span>)
    }

    if (cache.usedAt) {
        // Since the cache was last used, by a reply or pi warming it: amber in its last minute, red once it has likely expired.
        const ttl = thread.cacheTtl / 1000
        const s = Math.max(0, Math.floor((now - cache.usedAt) / 1000))
        parts.push(
            <span key="ago" className={s >= ttl ? DANGER : s >= ttl - 60 ? WARN : OK} title={tr(`距上次用到提示缓存（回复或 pi 保温），约 ${ttl / 60} 分钟后过期`, `Since the prompt cache was last used (a reply or pi warming it); it expires after about ${ttl / 60} minutes`)}>
                {`${s >= ttl ? '✗' : '⏱'} ${ago(s)}`}
            </span>,
        )
    }

    // cc-statusline reads only compaction.reserveTokens; this also applies compaction.modelOverrides
    // like pi itself, so the figure matches when auto-compaction actually fires.
    let right: string | null = null
    if (thread.features.autoCompaction && usage?.tokens && usage.contextWindow && compaction?.enabled) {
        const until = Math.max(0, Math.floor(((usage.contextWindow - compaction.reserveTokens - usage.tokens) / usage.contextWindow) * 100))
        right = `${until}% until auto-compact`
    }

    return (
        <div className="mt-1.5 flex h-5 min-w-0 items-center gap-4 px-1 font-mono text-[12px] tabular-nums select-none">
            <div className="flex min-w-0 flex-1 items-center gap-[1ch] overflow-hidden whitespace-nowrap">
                {parts}
            </div>
            {right && <span className={`shrink-0 ${MUTED}`}>{right}</span>}
        </div>
    )
})
