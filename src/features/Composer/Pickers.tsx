import type { PiModel, ThinkingLevel } from '@shared/pi'
import type { KeyboardEvent } from 'react'
import type { Thread, ThreadMode } from '@/store/thread'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatTokens } from '@/lib/utils'
import { Brain, Check, ChevronDown, ClipboardList, Cpu, FilePen, ShieldCheck, Zap } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useRef, useState } from 'react'

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

/**
 * Thinking effort as a stepped slider, like the Codex app: drag the knob or click a stop; with focus,
 * arrows / Home / End step through levels. Only the released position is sent to pi.
 */
function EffortSlider({ levels, value, onChange }: { levels: ThinkingLevel[], value?: ThinkingLevel, onChange: (level: ThinkingLevel) => Promise<void> }) {
    const trackRef = useRef<HTMLDivElement>(null)
    const [drag, setDrag] = useState<number | null>(null)
    // Holds the released stop until pi confirms, so the knob does not jump back meanwhile.
    const [pending, setPending] = useState<number | null>(null)
    const last = levels.length - 1
    const index = Math.max(0, value ? levels.indexOf(value) : 0)
    const shown = drag ?? pending ?? index
    const pct = (i: number) => `${(i / last) * 100}%`

    const stopAt = (clientX: number) => {
        const rect = trackRef.current!.getBoundingClientRect()
        return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * last)
    }
    const commit = (i: number) => {
        if (levels[i] === value)
            return
        setPending(i)
        void onChange(levels[i]).finally(() => setPending(null))
    }
    const onKeyDown = (e: KeyboardEvent) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]
        const next = step !== undefined ? shown + step : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
        if (next === null)
            return
        e.preventDefault()
        commit(Math.min(last, Math.max(0, next)))
    }

    return (
        <div className="select-none">
            <div className="text-[12px] text-gray-500">思考强度</div>
            <div
                role="slider"
                tabIndex={0}
                aria-label="思考强度"
                aria-valuemin={0}
                aria-valuemax={last}
                aria-valuenow={shown}
                aria-valuetext={levelLabel[levels[shown]] ?? levels[shown]}
                className="group relative mt-2 h-6 cursor-pointer touch-none outline-none"
                onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    setDrag(stopAt(e.clientX))
                }}
                onPointerMove={e => drag !== null && setDrag(stopAt(e.clientX))}
                onPointerUp={(e) => {
                    if (drag === null)
                        return
                    commit(stopAt(e.clientX))
                    setDrag(null)
                }}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={onKeyDown}
            >
                <div ref={trackRef} className="absolute inset-x-[7px] top-1/2 h-1 -translate-y-1/2 rounded-full bg-black/[0.08]">
                    {levels.map((level, i) => (
                        <span key={level} className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/[0.2]" style={{ left: pct(i) }} />
                    ))}
                    <div className="absolute inset-y-0 left-0 rounded-full bg-ide-accent transition-[width] duration-100" style={{ width: pct(shown) }} />
                    <span
                        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-always-white shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.3)] transition-[left] duration-100 group-focus-visible:ring-2 group-focus-visible:ring-ide-accent/50"
                        style={{ left: pct(shown) }}
                    />
                </div>
            </div>
            <div aria-hidden className="relative mx-[7px] h-4 text-[11px]">
                {levels.map((level, i) => (
                    <span
                        key={level}
                        className={cn('absolute -translate-x-1/2 cursor-pointer whitespace-nowrap transition-colors', i === shown ? 'text-gray-900' : 'text-gray-400 hover:text-gray-700')}
                        style={{ left: pct(i) }}
                        onClick={() => commit(i)}
                    >
                        {levelLabel[level] ?? level}
                    </span>
                ))}
            </div>
        </div>
    )
}

export const ThinkingPicker = observer(({ thread }: { thread: Thread }) => {
    const levels = thread.thinkingLevels
    const current = thread.state?.thinkingLevel
    if (levels.length <= 1)
        return null
    return (
        <Popover>
            <PopoverTrigger className={pill}>
                <Brain size={13} />
                <span>{current ? levelLabel[current] ?? current : '思考'}</span>
                <ChevronDown size={12} />
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-[300px] px-4 pt-3 pb-2.5">
                <EffortSlider levels={levels} value={current} onChange={level => thread.setThinkingLevel(level)} />
            </PopoverContent>
        </Popover>
    )
})

const MODES: { mode: ThreadMode, label: string, hint: string, icon: typeof Zap }[] = [
    { mode: 'ask', label: '每次确认', hint: '改文件、跑命令前都先问你', icon: ShieldCheck },
    { mode: 'edits', label: '自动编辑', hint: '项目里的文件改动直接做，命令仍先问你', icon: FilePen },
    { mode: 'auto', label: '全自动', hint: '不再询问', icon: Zap },
    { mode: 'plan', label: '计划', hint: '只读探索，写出计划等你批准后再动手', icon: ClipboardList },
]

/**
 * Approval mode and plan mode in one menu: plan is a stage before any approval matters, so they
 * read as one "how much may pi do" choice. Entries appear for the capabilities this thread loaded.
 */
export const ModePicker = observer(({ thread }: { thread: Thread }) => {
    const current = thread.mode
    const hasApproval = thread.approvalMode !== undefined
    const hasPlan = thread.guiCommands.includes('gui-plan')
    // Without approval, 全自动 is how plan mode is left.
    const options = MODES.filter(m => m.mode === 'plan' ? hasPlan : hasApproval || (m.mode === 'auto' && hasPlan))
    if (!options.length)
        return null
    // Plan loaded without approval: outside plan mode pi runs everything, like 全自动.
    const active = MODES.find(m => m.mode === (current ?? 'auto'))!
    const Icon = active.icon
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={cn(pill, current === 'plan' && 'text-ide-accent hover:text-ide-accent')} title={active.hint}>
                <Icon size={13} />
                <span>{active.label}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
                {options.map(({ mode, label, hint, icon: ItemIcon }) => (
                    <DropdownMenuItem key={mode} onSelect={() => void thread.setMode(mode)} className="h-auto items-start py-1.5">
                        <ItemIcon size={14} className="mt-0.5 shrink-0 text-gray-500" />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span>{label}</span>
                            <span className="text-[11.5px] text-gray-500">{hint}</span>
                        </span>
                        {mode === current && <Check size={14} className="mt-0.5 text-ide-accent" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})
