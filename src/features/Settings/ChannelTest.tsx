// Settings → 供应商, an open provider's 缓存测试 line: does this channel really cache prompts?
// The run is pi-capabilities/lib/channelTest.ts in main (the same script as pi-cc-tui's
// /channel-test), sent through the user's pi; its result is saved in pi's agent dir, so the terminal
// shows the same. Next to it, the past week's cache record of the model, from pi's session files.
import type { ChannelHealth, ChannelModel, ChannelRun, ChannelTestUpdate } from '@shared/providers'
import type { ModelHistory } from 'pi-capabilities/lib/channelStore.ts'
import type { ChannelResult, StepKind, StepResult, StepStatus, Verdict } from 'pi-capabilities/lib/channelTest.ts'
import { Button } from '@/components/ui/button'
import { flatFieldClass, Switch } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn, formatCost, formatTokens, timeAgo } from '@/lib/utils'
import { estimateCost, IDLE_MS } from 'pi-capabilities/lib/channelTest.ts'
import { AlertTriangle, Check, CircleHelp, CircleSlash, Loader2, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useId, useState } from 'react'

const LABEL = 'w-20 shrink-0 text-[12px] text-gray-700'
const INDENT = 'pl-[88px]'
const key = (provider: string, model: string) => `${provider}/${model}`
/** Small counts as they are: formatTokens writes 0 as "0.0K". */
const tok = (n: number) => (n < 1000 ? String(n) : formatTokens(n))

const VERDICTS: Record<Verdict, { label: () => string, color: string, Icon: typeof Check }> = {
    healthy: { label: () => tr('缓存正常', 'Cache works'), color: 'text-[var(--sl-ok)]', Icon: Check },
    partial: { label: () => tr('缓存部分失效', 'Cache partly lost'), color: 'text-[var(--sl-warn)]', Icon: AlertTriangle },
    none: { label: () => tr('只写不读', 'Written, never read'), color: 'text-[var(--sl-warn)]', Icon: CircleSlash },
    unreported: { label: () => tr('没有缓存数据', 'No cache figures'), color: 'text-[var(--jb-comment)]', Icon: CircleHelp },
    fabricated: { label: () => tr('数据对不上', 'Figures don\'t add up'), color: 'text-[var(--sl-danger)]', Icon: AlertTriangle },
    failed: { label: () => tr('测试失败', 'Test failed'), color: 'text-[var(--sl-danger)]', Icon: X },
}

const STEP_LABELS: Record<StepKind, () => string> = {
    first: () => tr('首次', 'first'),
    repeat: () => tr('重发', 'repeat'),
    append: () => tr('追加', 'append'),
    idle: () => tr('空闲后', 'after idle'),
}

const STATUS_LABELS: Record<StepStatus, { label: () => string, color: string }> = {
    fresh: { label: () => '—', color: 'text-[var(--jb-comment)]' },
    hit: { label: () => tr('命中', 'read'), color: 'text-[var(--sl-ok)]' },
    partial: { label: () => tr('部分', 'partly'), color: 'text-[var(--sl-warn)]' },
    miss: { label: () => tr('未命中', 'missed'), color: 'text-[var(--sl-warn)]' },
    excess: { label: () => tr('超出', 'too much'), color: 'text-[var(--sl-danger)]' },
}

function explain(result: ChannelResult): string {
    const checked = result.steps.filter(s => s.kind !== 'first')
    const short = checked.filter(s => s.status === 'partial' || s.status === 'miss')
    const unread = short.reduce((n, s) => n + s.unread, 0)
    const extra = result.extraCost ? tr(`，多花约 ${formatCost(result.extraCost)}`, `, about ${formatCost(result.extraCost)} extra`) : ''
    switch (result.verdict) {
        case 'healthy':
            return tr('每次请求都从缓存读回了上一次的提示词。', 'Every request read the previous prompt back from the cache.')
        case 'partial': {
            const idle = short.length === 1 && short[0].kind === 'idle'
            if (idle)
                return tr(`其余正常，但空闲 ${Math.round((result.idleMs ?? 0) / 60_000)} 分钟后缓存已经没了${extra}。`, `The cache worked, but was gone after ${Math.round((result.idleMs ?? 0) / 60_000)} minutes idle${extra}.`)
            return tr(`${checked.length} 次该读缓存的请求里有 ${short.length} 次读少了，${tok(unread)} 按原价重新计费${extra}。`, `${short.length} of ${checked.length} requests read less than they should; ${tok(unread)} billed again${extra}.`)
        }
        case 'none':
            return tr('供应商报告了缓存写入，但没有一次请求读到，每次都按全价计费。', 'The provider reports cache writes, but no request read them: every request pays full price.')
        case 'unreported':
            return tr('供应商没有报告任何缓存读写：可能不支持缓存，也可能是中转把数据丢了。', 'The provider reported no cache reads or writes: it may not cache, or a relay drops the figures.')
        case 'fabricated':
            return tr('从没发过的提示词也报告了缓存命中，或者读到的比发过的还多：这些数字多半是按比例估的，不是真的缓存。', 'Cache reads were reported on a prompt never sent before, or beyond what was sent: the figures are likely billed by ratio, not measured.')
        case 'failed':
            return result.error ?? ''
    }
}

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`)

function metrics(result: ChannelResult) {
    return [
        result.cost !== null ? tr(`花费 ${formatCost(result.cost)}`, `spent ${formatCost(result.cost)}`) : '',
        result.hitRate !== null ? tr(`缓存读 ${Math.round(result.hitRate * 100)}%`, `${Math.round(result.hitRate * 100)}% read from cache`) : '',
        result.ttftMs !== null ? tr(`首字 ${seconds(result.ttftMs)}`, `first token ${seconds(result.ttftMs)}`) : '',
        result.outputTps !== null ? tr(`${Math.round(result.outputTps)} tokens/秒`, `${Math.round(result.outputTps)} tokens/s`) : '',
    ].filter(Boolean).join(' · ')
}

function historyText(h: ModelHistory | undefined, model: string) {
    if (!h)
        return tr(`过去 7 天没有用 ${model} 的请求。`, `No requests on ${model} in the past 7 days.`)
    const head = tr(`过去 7 天：${h.requests.toLocaleString()} 次请求`, `Past 7 days: ${h.requests.toLocaleString()} requests`)
    if (!h.cachedRequests)
        return `${head}${tr('，没有缓存数据。', ', no cache figures.')}`
    const rate = Math.round(h.read / Math.max(1, h.prompt) * 100)
    const extra = h.extraCost >= 0.01
    const misses = h.misses
        ? tr(
                `；${h.misses.toLocaleString()} 次意外未命中，${tok(h.missedTokens)} 重新计费${extra ? `，约 ${formatCost(h.extraCost)}` : ''}`,
                `; ${h.misses.toLocaleString()} unexpected ${h.misses === 1 ? 'miss' : 'misses'}, ${tok(h.missedTokens)} billed again${extra ? `, about ${formatCost(h.extraCost)}` : ''}`,
            )
        : tr('；没有意外未命中', '; no unexpected misses')
    return `${head}${tr(`，缓存读 ${rate}%`, `, ${rate}% read from cache`)}${misses}${tr('。', '.')}`
}

/** The requests of a run, one row each. */
function Steps({ steps, pending }: { steps: StepResult[], pending?: { kind: StepKind } }) {
    const th = 'px-1.5 py-0.5 text-right font-normal'
    const td = 'px-1.5 py-0.5 text-right'
    return (
        <table className="w-full max-w-[560px] border-collapse text-[11.5px] tabular-nums text-gray-800">
            <thead className="text-[var(--jb-comment)]">
                <tr>
                    <th className={cn(th, 'pl-0 text-left')}>{tr('请求', 'Request')}</th>
                    <th className={th}>{tr('提示词', 'Prompt')}</th>
                    <th className={th}>{tr('应读', 'Expected')}</th>
                    <th className={th}>{tr('读取', 'Read')}</th>
                    <th className={th}>{tr('写入', 'Written')}</th>
                    <th className={cn(th, 'text-left')}>{tr('结果', 'Result')}</th>
                    <th className={th}>{tr('首字', 'TTFT')}</th>
                </tr>
            </thead>
            <tbody>
                {steps.map((s, i) => {
                    const status = STATUS_LABELS[s.status]
                    return (
                        <tr key={i}>
                            <td className={cn(td, 'pl-0 text-left')}>{`${i + 1} ${STEP_LABELS[s.kind]()}`}</td>
                            <td className={td}>{tok(s.prompt)}</td>
                            <td className={td}>{s.kind === 'first' ? '—' : tok(s.expected)}</td>
                            <td className={td}>{tok(s.cacheRead)}</td>
                            <td className={td}>{tok(s.cacheWrite)}</td>
                            <td className={cn(td, 'text-left', status.color)}>{status.label()}</td>
                            <td className={td}>{seconds(s.ttftMs)}</td>
                        </tr>
                    )
                })}
                {pending && (
                    <tr className="text-[var(--jb-comment)]">
                        <td className={cn(td, 'pl-0 text-left')}>{`${steps.length + 1} ${STEP_LABELS[pending.kind]()}`}</td>
                        <td className={td} colSpan={6} />
                    </tr>
                )}
            </tbody>
        </table>
    )
}

function Countdown({ until }: { until: number }) {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [])
    const left = Math.max(0, Math.round((until - now) / 1000))
    return <>{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</>
}

export const ChannelTestLine = observer(function ChannelTestLine({ provider }: { provider: string }) {
    const [models, setModels] = useState<ChannelModel[] | null>(null)
    const [modelId, setModelId] = useState('')
    const [health, setHealth] = useState<ChannelHealth | null>(null)
    const [run, setRun] = useState<ChannelRun | null>(null)
    const [confirming, setConfirming] = useState(false)
    const [idle, setIdle] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [error, setError] = useState('')
    const selectId = useId()
    const idleId = useId()

    const loadHealth = () => window.pi.channelHealth().then(setHealth).catch(() => {})

    useEffect(() => {
        let cancelled = false
        window.pi.channelModels(provider).then((list) => {
            if (!cancelled)
                setModels(list)
        }).catch(() => !cancelled && setModels([]))
        void window.pi.channelHealth().then((h) => {
            if (cancelled)
                return
            setHealth(h)
            const running = h.running.find(r => r.provider === provider)
            if (running) {
                setRun(running)
                setModelId(running.model)
            }
        }).catch(() => {})
        return () => {
            cancelled = true
        }
    }, [provider])

    // The model used most this week, else the first one.
    useEffect(() => {
        if (!models?.length || modelId)
            return
        const used = Object.values(health?.history ?? {}).filter(h => h.provider === provider && models.some(m => m.id === h.model)).sort((a, b) => b.requests - a.requests)[0]
        setModelId(used?.model ?? models[0].id)
    }, [models, health, provider, modelId])

    useEffect(() => window.pi.onChannelTest((update: ChannelTestUpdate) => {
        if (update.provider !== provider)
            return
        if ('progress' in update) {
            setRun({ test: update.test, provider: update.provider, model: update.model, progress: update.progress })
            return
        }
        setRun(current => (current?.test === update.test ? null : current))
        if ('result' in update) {
            setHealth(h => h && { ...h, results: { ...h.results, [key(update.provider, update.model)]: update.result } })
            setExpanded(true)
            void loadHealth()
        }
        else if (!update.cancelled) {
            setError(update.error)
        }
    }), [provider])

    if (models && !models.length)
        return null
    const model = models?.find(m => m.id === modelId)
    const result = model && health?.results[key(provider, model.id)]
    const history = model && health?.history[key(provider, model.id)]
    const running = run && run.model === modelId ? run : null
    const busy = !!run
    const estimate = model && estimateCost({ provider, id: model.id, cost: model.cost }, { idleMs: idle ? IDLE_MS : undefined })

    const start = async () => {
        if (!model)
            return
        setConfirming(false)
        setError('')
        setExpanded(false)
        try {
            const test = await window.pi.channelTest(provider, model.id, idle ? IDLE_MS : undefined)
            setRun(current => current ?? { test, provider, model: model.id })
        }
        catch (e: any) {
            setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        }
    }

    const verdict = result && VERDICTS[result.verdict]
    return (
        <div className="flex flex-col gap-1">
            <div className="flex min-h-8 items-center gap-2">
                <label htmlFor={selectId} className={LABEL}>{tr('缓存测试', 'Cache test')}</label>
                <select
                    id={selectId}
                    value={modelId}
                    disabled={!models || busy}
                    onChange={(e) => {
                        setModelId(e.target.value)
                        setConfirming(false)
                        setExpanded(false)
                        setError('')
                    }}
                    className={cn(flatFieldClass, 'h-7 min-w-0 max-w-[220px] shrink bg-[var(--jb-dialog-bg)] px-2 text-[12px]')}
                >
                    {!models && <option value="">{tr('读取中…', 'Loading…')}</option>}
                    {models?.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]">
                    {verdict && !running && (
                        <button
                            type="button"
                            className={cn('flex min-w-0 items-center gap-1 rounded-[4px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ide-accent/50', verdict.color)}
                            aria-expanded={expanded}
                            onClick={() => setExpanded(v => !v)}
                            title={tr('显示每次请求', 'Show each request')}
                        >
                            <verdict.Icon size={13} className="shrink-0" aria-hidden />
                            <span className="truncate">{verdict.label()}</span>
                        </button>
                    )}
                    {result && !running && <span className="shrink-0 text-[var(--jb-comment)]">{Date.now() - result.at < 60_000 ? tr('刚刚', 'just now') : timeAgo(result.at)}</span>}
                    {!result && !running && model && <span className="truncate text-[var(--jb-comment)]">{tr('还没测过', 'Not tested yet')}</span>}
                </span>
                {!busy && !confirming && (
                    <Button variant="outline" size="sm" disabled={!model} onClick={() => setConfirming(true)}>{tr('测试', 'Test')}</Button>
                )}
                {running && <Button variant="ghost" size="sm" onClick={() => void window.pi.channelCancel(running.test)}>{tr('停止', 'Stop')}</Button>}
            </div>

            {model && !confirming && !running && (
                <p className={cn(INDENT, 'text-[11.5px] leading-relaxed text-[var(--jb-comment)]')}>
                    {health ? historyText(history, model.name) : tr('正在读取过去 7 天的会话…', 'Reading the past 7 days of sessions…')}
                </p>
            )}

            {confirming && estimate && (
                <div className={cn(INDENT, 'flex flex-col gap-1.5 pb-1 text-[12px] text-gray-800')}>
                    <p className="leading-relaxed">
                        {tr(
                            `用一段脚本对话测这个模型：${estimate.requests} 次请求，共约 ${formatTokens(estimate.promptTokens)} 提示词 tokens。`,
                            `Sends a scripted conversation to this model: ${estimate.requests} requests, about ${formatTokens(estimate.promptTokens)} prompt tokens in all.`,
                        )}
                        {' '}
                        {estimate.healthy !== null && estimate.worst !== null
                            ? tr(`缓存正常时约 ${formatCost(estimate.healthy)}，完全失效时最多约 ${formatCost(estimate.worst)}。`, `About ${formatCost(estimate.healthy)} if the cache works, up to ${formatCost(estimate.worst)} if it does not.`)
                            : tr('这个模型没有设置价格，花费未知。', 'This model has no prices set, so the cost is unknown.')}
                    </p>
                    <div className="flex items-center gap-2">
                        <Switch labelledBy={idleId} checked={idle} onChange={setIdle} />
                        <span id={idleId} className="text-gray-700">{tr(`再等 ${IDLE_MS / 60_000} 分钟，看缓存还在不在（多 1 次请求）`, `Also wait ${IDLE_MS / 60_000} minutes and check the cache is still there (1 more request)`)}</span>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>{tr('取消', 'Cancel')}</Button>
                        <Button variant="primary" size="sm" onClick={() => void start()}>{tr('开始测试', 'Run test')}</Button>
                    </div>
                </div>
            )}

            {running && (
                <div className={cn(INDENT, 'flex flex-col gap-1 pb-1')}>
                    <div className="flex items-center gap-2 text-[12px] text-gray-700" role="status">
                        <Loader2 size={13} className="animate-spin" />
                        {running.progress?.waitUntil
                            ? <span>{tr('空闲等待中，', 'Waiting idle, ')}<Countdown until={running.progress.waitUntil} />{tr(' 后发送最后一次请求', ' until the last request')}</span>
                            : running.progress
                                ? tr(`第 ${running.progress.index + 1}/${running.progress.total} 次请求`, `Request ${running.progress.index + 1} of ${running.progress.total}`)
                                : tr('开始中…', 'Starting…')}
                    </div>
                    {running.progress && <Steps steps={running.progress.done} pending={running.progress} />}
                </div>
            )}

            {error && !running && <p className={cn(INDENT, 'whitespace-pre-wrap text-[12px] text-[var(--sl-danger)]')} role="alert">{error}</p>}

            {result && expanded && !running && !confirming && (
                <div className={cn(INDENT, 'flex flex-col gap-1 pb-1')}>
                    <p className="text-[12px] leading-relaxed text-gray-800">{explain(result)}</p>
                    {result.steps.length > 0 && <Steps steps={result.steps} />}
                    <p className="text-[11.5px] text-[var(--jb-comment)]">{metrics(result)}</p>
                </div>
            )}
        </div>
    )
})
