// The status line's `$12.34`, and the panel it opens: what pi, Claude Code and Codex sessions cost
// over the last days, by day, agent, project and model, and how much of it cache misses re-billed.
// pi-cc-tui's /cost prints the same (packages/capabilities/lib/ledger.ts). Prices are pi's list
// prices, subscriptions too; a relay may bill otherwise.
import type { Ledger, SpendRow } from 'pi-capabilities/lib/ledger.ts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/form'
import { basename, cn, formatCost } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { tr } from '@/lib/i18n'

const Rows = ({ title, rows, label }: { title: string, rows: SpendRow[], label: (key: string) => string }) => (
    <section className="flex flex-col gap-px">
        <h3 className="mb-0.5 text-[11.5px] text-gray-500">{title}</h3>
        {rows.slice(0, 7).map(r => (
            <div key={r.key} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3">
                <span className="min-w-0 truncate text-gray-700" title={r.key}>{label(r.key)}</span>
                <span className="text-right text-gray-900">{formatCost(r.cost)}</span>
                <span className="w-24 text-right text-[11.5px] text-gray-500">{r.waste >= 0.01 ? tr(`未命中 ${formatCost(r.waste)}`, `missed ${formatCost(r.waste)}`) : ''}</span>
            </div>
        ))}
    </section>
)

export function SpendFigure({ cost, className }: { cost: number, className: string }) {
    const [open, setOpen] = useState(false)
    const [days, setDays] = useState('7')
    const [ledger, setLedger] = useState<Ledger | null>(null)
    useEffect(() => {
        if (!open)
            return
        let cancelled = false
        window.pi.spendLedger(Number(days))
            .then(l => !cancelled && setLedger(l))
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [open, days])

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger aria-label={tr('会话花费', 'Session cost')} className={cn('rounded-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-gray-400', className)}>
                {`$${cost.toFixed(2)}`}
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="flex w-[420px] flex-col gap-3 p-3 text-[12.5px] tabular-nums" onOpenAutoFocus={e => e.preventDefault()}>
                <header className="flex items-center justify-between gap-4">
                    <span className="text-[13px] font-medium text-gray-900">{tr(`这个会话 ${formatCost(cost)}`, `This session ${formatCost(cost)}`)}</span>
                    <Segmented value={days} options={[{ value: '1', label: tr('24 小时', '24h') }, { value: '7', label: tr('7 天', '7 days') }, { value: '30', label: tr('30 天', '30 days') }]} onChange={setDays} />
                </header>
                {!ledger
                    ? <p className="text-gray-500">{tr('正在读取会话…', 'Reading sessions…')}</p>
                    : (
                            <>
                                <div className="flex flex-col gap-0.5">
                                    <span className="text-gray-900">{tr(`${ledger.sessions} 个会话共 ${formatCost(ledger.cost)}`, `${formatCost(ledger.cost)} over ${ledger.sessions} sessions`)}</span>
                                    {ledger.waste >= 0.01 && (
                                        <span className={ledger.channelWaste * 2 >= ledger.waste ? 'text-[var(--sl-warn)]' : 'text-gray-500'}>
                                            {tr(
                                                `缓存未命中重计费 ${formatCost(ledger.waste)}，其中 ${formatCost(ledger.channelWaste)} 发生在对话没变的时候，是渠道的问题`,
                                                `Cache misses re-billed ${formatCost(ledger.waste)}, ${formatCost(ledger.channelWaste)} of it with nothing changed in the conversation: the channel`,
                                            )}
                                        </span>
                                    )}
                                    {ledger.warming >= 0.01 && <span className="text-gray-500">{tr(`缓存保温 ${formatCost(ledger.warming)}`, `Cache warming ${formatCost(ledger.warming)}`)}</span>}
                                </div>
                                {days !== '1' && <Rows title={tr('按天', 'By day')} rows={ledger.byDay} label={key => key} />}
                                {ledger.byAgent.length > 1 && <Rows title={tr('按 Agent', 'By agent')} rows={ledger.byAgent} label={key => key} />}
                                <Rows title={tr('按项目', 'By project')} rows={ledger.byProject} label={key => basename(key) || key} />
                                <Rows title={tr('按模型', 'By model')} rows={ledger.byModel} label={key => key} />
                                <p className="text-[11.5px] leading-snug text-gray-400">{tr('包括 pi、Claude Code 和 Codex 的会话，按 pi 模型列表里的价格估算，订阅也一样算。中转渠道的实际计费可能不同。终端里用 /cost 看同样的数字。', 'pi, Claude Code and Codex sessions, estimated at the prices in pi\'s model list, subscriptions too; a relay may bill differently. /cost in a terminal shows the same figures.')}</p>
                            </>
                        )}
            </PopoverContent>
        </Popover>
    )
}
