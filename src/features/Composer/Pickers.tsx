import type { PiModel, ThinkingLevel } from '@shared/pi'
import type { Thread } from '@/store/thread'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatCost, formatTokens } from '@/lib/utils'
import { Brain, Check, ChevronDown, Cpu, Gauge } from 'lucide-react'
import { observer } from 'mobx-react-lite'

const pill = 'flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-gray-600 outline-none transition-colors hover:bg-black/[0.06] hover:text-gray-900 data-[state=open]:bg-black/[0.08] disabled:opacity-50'

const levelLabel: Record<ThinkingLevel, string> = {
    off: '关闭',
    minimal: '最低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
}

export const ModelPicker = observer(({ thread }: { thread: Thread }) => {
    const current = thread.state?.model
    const groups = new Map<string, PiModel[]>()
    for (const model of thread.models) {
        const list = groups.get(model.provider) ?? []
        list.push(model)
        groups.set(model.provider, list)
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill} disabled={!thread.models.length}>
                <Cpu size={13} />
                <span className="max-w-[180px] truncate">{current?.name ?? (thread.agentStatus === 'starting' ? '加载中…' : '选择模型')}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 max-h-[420px]">
                {[...groups.entries()].map(([provider, models]) => (
                    <div key={provider}>
                        <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                        {models.map(model => (
                            <DropdownMenuItem key={`${provider}/${model.id}`} onSelect={() => void thread.setModel(model)}>
                                <span className="flex-1 truncate">{model.name}</span>
                                {model.contextWindow ? <span className="text-[11px] text-gray-400">{formatTokens(model.contextWindow)}</span> : null}
                                {current?.provider === model.provider && current.id === model.id && <Check size={14} className="text-ide-accent" />}
                            </DropdownMenuItem>
                        ))}
                    </div>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

export const ThinkingPicker = observer(({ thread }: { thread: Thread }) => {
    const levels = thread.thinkingLevels
    const current = thread.state?.thinkingLevel
    if (levels.length <= 1)
        return null
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill}>
                <Brain size={13} />
                <span>{current ? levelLabel[current] ?? current : '思考'}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuLabel>思考强度</DropdownMenuLabel>
                {levels.map(level => (
                    <DropdownMenuItem key={level} onSelect={() => void thread.setThinkingLevel(level)}>
                        <span className="flex-1">{levelLabel[level] ?? level}</span>
                        <span className="text-[11px] text-gray-400">{level}</span>
                        {current === level && <Check size={14} className="text-ide-accent" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

// Visual taken from chat's ContextBar (Gauge + colored percent); a popover replaces the tooltip
// so the compact action is clickable.
export const ContextGauge = observer(({ thread }: { thread: Thread }) => {
    const usage = thread.stats?.contextUsage
    if (!usage?.contextWindow)
        return null
    const percent = usage.percent ?? 0
    const color = percent > 80 ? 'text-red-400' : percent > 50 ? 'text-amber-500' : 'text-gray-500'
    const Row = ({ label, value }: { label: string, value: string }) => (
        <div className="flex justify-between gap-6">
            <span className="text-gray-400">{label}</span>
            <span>{value}</span>
        </div>
    )
    return (
        <Popover>
            <PopoverTrigger className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] tabular-nums outline-none hover:bg-black/[0.06]', color)} aria-label="上下文用量">
                <Gauge size={14} />
                <span>{usage.percent == null ? '—' : `${Math.round(percent)}%`}</span>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-[220px] p-0 text-xs tabular-nums">
                <div className="px-3 pt-2.5 pb-2 border-b border-black/5 flex items-baseline justify-between">
                    <span className="text-gray-400">上下文用量</span>
                    <span className="font-semibold text-[15px] text-gray-900">{usage.percent == null ? '—' : `${Math.round(percent)}%`}</span>
                </div>
                <div className="px-3 py-2 space-y-1 text-gray-700">
                    <Row label="已使用" value={usage.tokens == null ? '压缩后待更新' : formatTokens(usage.tokens)} />
                    <Row label="模型窗口" value={formatTokens(usage.contextWindow)} />
                    {thread.stats?.cost != null && <Row label="会话花费" value={formatCost(thread.stats.cost)} />}
                </div>
                <div className="px-2 pb-2">
                    <button
                        type="button"
                        disabled={thread.running || thread.compacting}
                        onClick={() => void thread.compact()}
                        className="h-7 w-full rounded-md border border-gray-300 text-gray-800 hover:bg-black/[0.04] disabled:opacity-50 dark:border-gray-200"
                    >
                        {thread.compacting ? '正在压缩…' : '立即压缩上下文'}
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    )
})
