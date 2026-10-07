// Per-thread status line under the composer, a port of pi-cc-tui's cc-statusline footer:
//   ➜ pi-cc-tui █░░░░ 23% 238k/1000k ⚡ 1.2ktok 20/s $103.00 +7882 -15 Opus 5.5 (high) ⏱ 1m19s   74% until auto-compact
import type { CompactionInfo } from '@shared/ipc'
import type { Thread } from '@/store/thread'
import { basename } from '@/lib/utils'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
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
    let cost = 0
    let add = 0
    let del = 0
    let recentOut = 0
    let lastReply = 0
    for (const { message: m } of [...thread.items, ...thread.live]) {
        if (m.role === 'assistant') {
            cost += m.usage?.cost?.total || 0
            lastReply = m.timestamp
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
    return { cost, add, del, recentOut, lastReply }
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
    const { add, del, recentOut, lastReply } = totals
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
        parts.push(
            <span key="ctx" title={tr('上下文用量', 'Context usage')}>
                <span className={color}>{'█'.repeat(filled)}</span>
                <span className={MUTED}>{'░'.repeat(5 - filled)}</span>
                {' '}
                <span className={color}>{`${pct}%`}</span>
                {' '}
                <span className={MUTED}>{`${k(usage.tokens)}/${k(usage.contextWindow)}`}</span>
            </span>,
        )
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
        parts.push(<span key="cost" className={cost >= 5 ? DANGER : cost >= 1 ? WARN : MUTED} title={tr('会话花费', 'Session cost')}>{`$${cost.toFixed(2)}`}</span>)

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

    if (lastReply) {
        // Anthropic's prompt cache lives 5 minutes: amber from 4m, red once it has likely expired.
        const s = Math.max(0, Math.floor((now - lastReply) / 1000))
        parts.push(
            <span key="ago" className={s >= 300 ? DANGER : s >= 240 ? WARN : OK} title={tr('距上次回复（提示缓存约 5 分钟过期）', 'Since the last reply (the prompt cache expires after about 5 minutes)')}>
                {`${s >= 300 ? '✗' : '⏱'} ${ago(s)}`}
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
