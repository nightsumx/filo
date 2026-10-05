import type { PiModel, ThinkingLevel } from '@shared/pi'
import type { Thread } from '@/store/thread'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatTokens } from '@/lib/utils'
import { Brain, Check, ChevronDown, Cpu } from 'lucide-react'
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
